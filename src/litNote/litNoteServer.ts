/**
 * Local HTTP server that receives requests from the Zotero companion plugin.
 *
 * Binds to 127.0.0.1 (loopback only) — no external exposure, no auth token
 * required (identical pattern to Zotero's own Local API on port 23119).
 *
 * Supported endpoints:
 *   POST /lit-note   { action: "create", data: ZoteroItemPayload[] }
 *                    → creates lit note(s); if any already exist, prompts in
 *                      Obsidian (Overwrite / Open existing / Skip / Cancel)
 *   POST /lit-note   { action: "open", data: ZoteroItemPayload[] }
 *                    → opens lit note(s); if any are missing, prompts in
 *                      Obsidian (Create / Skip / Cancel)
 *                    Legacy form { action: "open", citekey } opens only.
 *
 * Decisions are always shown as an Obsidian modal, so the prompt is never
 * hidden behind Obsidian or another window and looks the same every time.
 */

import http from "http";
import { exec } from "child_process";
import { App, Notice, normalizePath, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { askNoteDecision, type NoteDecision } from "./decisionModal";
import type {
	LitNoteItemResult,
	LitNoteItemStatus,
	LitNoteOpenRequest,
	LitNoteRequest,
	LitNoteResponse,
	ZoteroItemPayload,
} from "./types";

import type { NameStyle } from "./bibtexName";

export interface LitNoteServerSettings {
	litNotesFolder: string; // vault-relative path, e.g. "lit/lit_notes"
	validateAuthorNameFormat?: boolean;
	authorFormatStyle?: NameStyle;
	authorDropVon?: boolean;
	downloadYoutubeTranscripts?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Serialize create/open handling so two requests can't race on the vault. */
let opChain: Promise<unknown> = Promise.resolve();

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = opChain.then(fn, fn);
	opChain = run.catch(() => undefined);
	return run;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function citekeyOf(item: ZoteroItemPayload): string {
	return (item.citekey ?? "").trim();
}

import {
	ensureFolder,
	ensureWorkspaceReady,
	existingFile,
	notePathFor,
	writeLitNote,
	writeNote,
} from "./writeLitNote";
import {
	validateItemAuthorFormats,
	openZoteroItem,
	type AuthorFormatIssue,
} from "./authorFormatValidator";
import {
	askAuthorFormatDecision,
	type AuthorFormatDecision,
} from "./authorFormatModal";


// ---------------------------------------------------------------------------
// Auto-correction helper
// ---------------------------------------------------------------------------

/**
 * Apply parser-suggested corrections to creator name fields in-place.
 *
 * Each issue's `suggestion` is in BibTeX "von Last, Jr, First" form, which is
 * stored directly in the single-field `name` property.  For two-field creators
 * we split on the first comma to restore firstName / lastName fields.
 */
function applyAuthorCorrections(
	items: ZoteroItemPayload[],
	issues: AuthorFormatIssue[]
): void {
	// Build a per-item map: itemCitekey → { creatorIndex → suggestion }
	const correctionMap = new Map<string, Map<number, string>>();
	for (const issue of issues) {
		if (!issue.suggestion) continue;
		if (!correctionMap.has(issue.citekey)) {
			correctionMap.set(issue.citekey, new Map());
		}
		correctionMap.get(issue.citekey)!.set(issue.creatorIndex, issue.suggestion);
	}

	for (const item of items) {
		const citekey = (item.citekey?.trim() || item.itemkey?.trim() || "untitled");
		const byIndex = correctionMap.get(citekey);
		if (!byIndex || !item.creators) continue;

		for (const [idx, suggestion] of byIndex) {
			const creator = item.creators[idx];
			if (!creator) continue;

			if (creator.name !== undefined) {
				// Single-field mode: store the bibtex form directly
				creator.name = suggestion;
			} else {
				// Two-field mode: split "von Last, Jr, First" → lastName + firstName
				const parts = suggestion.split(",").map((s) => s.trim());
				if (parts.length === 3) {
					creator.lastName = parts[0];
					creator.firstName = `${parts[2]} ${parts[1]}`;
				} else if (parts.length === 2) {
					creator.lastName = parts[0];
					creator.firstName = parts[1];
				} else if (parts.length === 1) {
					creator.lastName = parts[0];
					creator.firstName = "";
				}
			}
		}
	}
}

function noticeSummary(results: LitNoteItemResult[], prompted = false): void {
	if (prompted && !results.some((r) => r.status === "error")) {
		return;
	}
	const counts: Record<LitNoteItemStatus, number> = {
		created: 0,
		overwritten: 0,
		opened: 0,
		skipped: 0,
		missing: 0,
		error: 0,
	};
	for (const r of results) counts[r.status] += 1;

	if (results.length === 1) {
		const r = results[0];
		const name = r.citekey ? `@${r.citekey}` : "note";
		if (r.status === "opened") {
			new Notice(`Opened literature note from Zotero: ${name}`, 5000);
			return;
		}
		if (r.status === "created") {
			new Notice(`Created literature note from Zotero: ${name}`, 5000);
			return;
		}
		if (r.status === "overwritten") {
			new Notice(`Updated literature note from Zotero: ${name}`, 5000);
			return;
		}
		if (r.status === "missing") {
			new Notice(`Literature note not found in vault: ${name}`, 5000);
			return;
		}
		if (r.status === "skipped") {
			new Notice(`Skipped literature note from Zotero: ${name}`, 4000);
			return;
		}
		if (r.status === "error") {
			new Notice(`Error with Zotero note ${name}: ${r.error || "unknown error"}`, 6000);
			return;
		}
	}

	const parts: string[] = [];
	if (counts.created) parts.push(`${counts.created} created`);
	if (counts.overwritten) parts.push(`${counts.overwritten} overwritten`);
	if (counts.opened) parts.push(`${counts.opened} opened`);
	if (counts.skipped) parts.push(`${counts.skipped} skipped`);
	if (counts.missing) parts.push(`${counts.missing} missing`);
	if (counts.error) parts.push(`${counts.error} failed`);

	if (counts.opened && !counts.created && !counts.overwritten && !counts.error && !counts.missing) {
		new Notice(`Opened ${counts.opened} literature notes from Zotero`, 5000);
	} else if (counts.created && !counts.opened && !counts.overwritten && !counts.error && !counts.missing) {
		new Notice(`Created ${counts.created} literature notes from Zotero`, 5000);
	} else if (parts.length) {
		new Notice(`Zotero literature notes: ${parts.join(", ")}`, 5000);
	}
}

// ---------------------------------------------------------------------------
// Handler: create lit notes
// ---------------------------------------------------------------------------

async function handleCreateBatch(
	app: App,
	settings: LitNoteServerSettings,
	items: ZoteroItemPayload[]
): Promise<LitNoteItemResult[]> {
	focusObsidianWindow(app);
	await ensureWorkspaceReady(app);
	await ensureFolder(app, settings);

	const entries = items.map((item) => ({ item, citekey: citekeyOf(item) }));
	const existingEntries = entries.filter(
		(e) => e.citekey && existingFile(app, settings, e.citekey)
	);

	let decision: NoteDecision = "overwrite";
	let prompted = false;
	if (existingEntries.length) {
		for (const e of existingEntries) {
			const file = existingFile(app, settings, e.citekey);
			if (file) {
				await openFile(app, file, null, { modifyText: false });
			}
		}

		const citekeys = existingEntries.map((e) => e.citekey).join("\n");
		focusObsidianWindow(app);
		prompted = true;
		decision = await askNoteDecision(
			app,
			existingEntries.length === 1
				? "Lit note already exists"
				: `${existingEntries.length} lit notes already exist`,
			`Already in the Obsidian vault:\n\n${citekeys}\n\nOverwrite with the Zotero data, open the existing note, or skip it?`,
			[
				{ label: "Overwrite", value: "overwrite", warning: true },
				{ label: "Open existing", value: "open-existing" },
				{ label: "Skip", value: "skip" },
				{ label: "Cancel", value: "cancel" },
			]
		);
	}

	const results: LitNoteItemResult[] = [];
	if (decision === "cancel") {
		return entries.map((e) => ({
			citekey: e.citekey,
			status: "skipped" as const,
		}));
	}

	const toWriteEntries = entries.filter((entry) => {
		if (!entry.citekey) return false;
		const existing = existingFile(app, settings, entry.citekey);
		if (existing) {
			return decision === "overwrite";
		}
		return true;
	});

	if (settings.validateAuthorNameFormat && toWriteEntries.length > 0) {
		const allIssues: AuthorFormatIssue[] = [];
		for (const e of toWriteEntries) {
			allIssues.push(...validateItemAuthorFormats(e.item));
		}

		if (allIssues.length > 0) {
			focusObsidianWindow(app);
			prompted = true;
			const formatDecision = await askAuthorFormatDecision(app, allIssues);

			if (formatDecision === "edit") {
				for (const e of toWriteEntries) {
					openZoteroItem(e.item);
				}
				const skippedResults = entries.map((e) => ({
					citekey: e.citekey,
					status: "skipped" as const,
				}));
				if (prompted) noticeSummary(skippedResults, true);
				return skippedResults;
			} else if (formatDecision === "cancel") {
				const skippedResults = entries.map((e) => ({
					citekey: e.citekey,
					status: "skipped" as const,
				}));
				if (prompted) noticeSummary(skippedResults, true);
				return skippedResults;
			} else if (formatDecision === "auto-correct") {
				applyAuthorCorrections(
					toWriteEntries.map((e) => e.item),
					allIssues
				);
			}
			// If "create-anyway", continue to writing notes!
		}
	}

	for (const entry of entries) {
		if (!entry.citekey) {
			results.push({
				citekey: "",
				status: "error",
				error: "Payload missing citekey",
			});
			continue;
		}

		const existing = existingFile(app, settings, entry.citekey);
		try {
			if (existing) {
				if (decision === "skip") {
					results.push({ citekey: entry.citekey, status: "skipped" });
					continue;
				}
				if (decision === "open-existing") {
					await openFile(app, existing);
					results.push({ citekey: entry.citekey, status: "opened" });
					continue;
				}
				await writeNote(app, settings, entry.item, existing);
				await openFile(app, existing);
				results.push({ citekey: entry.citekey, status: "overwritten" });
			} else {
				const created = await writeNote(app, settings, entry.item, null);
				await openFile(app, created);
				results.push({ citekey: entry.citekey, status: "created" });
			}
		} catch (err: unknown) {
			results.push({
				citekey: entry.citekey,
				status: "error",
				error: errorMessage(err),
			});
		}
	}

	noticeSummary(results, prompted);
	return results;
}

// ---------------------------------------------------------------------------
// Handler: open / focus lit notes
// ---------------------------------------------------------------------------

export function positionCursorTwoLinesPastEnd(editor: any, modifyText = true): number {
	if (!editor) return 0;
	if (typeof editor.getValue !== "function") {
		if (typeof editor.setCursor === "function") {
			editor.setCursor({ line: 99999, ch: 0 });
		}
		return 99999;
	}

	// If the note has a # Transcript heading (e.g. from YouTube transcript download),
	// place the cursor on the blank line directly above # Transcript.
	const totalLines = typeof editor.lineCount === "function" ? editor.lineCount() : 0;
	let transcriptLineIdx = -1;
	for (let i = 0; i < totalLines; i++) {
		const line = typeof editor.getLine === "function" ? editor.getLine(i) : "";
		if (line.trim() === "# Transcript" || line.startsWith("# Transcript")) {
			transcriptLineIdx = i;
			break;
		}
	}

	if (transcriptLineIdx > 0) {
		const targetLine = transcriptLineIdx - 1;
		if (typeof editor.setCursor === "function") {
			editor.setCursor({ line: targetLine, ch: 0 });
		}
		if (typeof editor.scrollIntoView === "function") {
			editor.scrollIntoView(
				{ from: { line: targetLine, ch: 0 }, to: { line: targetLine, ch: 0 } },
				true
			);
		}
		return targetLine;
	}

	const text = editor.getValue();
	if (modifyText && !text.endsWith("\n\n")) {
		const needed = text.endsWith("\n") ? "\n" : "\n\n";
		const lastLine = typeof editor.lineCount === "function" ? editor.lineCount() - 1 : 0;
		const lastLineLen = typeof editor.getLine === "function" ? editor.getLine(lastLine).length : 0;
		if (typeof editor.replaceRange === "function") {
			editor.replaceRange(needed, { line: lastLine, ch: lastLineLen });
		}
	}
	const targetLine = typeof editor.lineCount === "function" ? editor.lineCount() - 1 : 0;
	if (typeof editor.setCursor === "function") {
		editor.setCursor({ line: targetLine, ch: 0 });
	}
	return targetLine;
}

/**
 * Bring the Obsidian window to the foreground, un-minimizing it if minimized.
 * Combines DOM/Electron APIs with OS-level commands (Python ctypes / Win32 API,
 * shell protocol URLs, osascript on macOS) so that Windows/macOS/Linux restores
 * minimized windows and brings Obsidian above any obscuring windows.
 */
export function focusObsidianWindow(app?: App): void {
	try {
		const win =
			typeof activeWindow !== "undefined"
				? (activeWindow as any)
				: typeof window !== "undefined"
					? (window as any)
					: null;
		if (win) {
			let electron: any = win.electron;
			if (!electron && typeof win.require === "function") {
				try {
					electron = win.require("electron");
				} catch {
					// Ignore
				}
			}

			let remote: any = win.__electronRemote ?? electron?.remote;
			if (!remote && typeof win.require === "function") {
				try {
					remote = win.require("@electron/remote");
				} catch {
					// Ignore
				}
			}

			if (remote?.getCurrentWindow) {
				const currentWin = remote.getCurrentWindow();
				if (typeof currentWin.isMinimized === "function" && currentWin.isMinimized()) {
					currentWin.restore();
				}
				currentWin.show?.();
				currentWin.focus?.();
			} else if (typeof win.focus === "function") {
				win.focus();
			}
		}
	} catch (err) {
		console.warn("[LitNoteServer] focusObsidianWindow error:", err);
	}

	try {
		if (typeof process !== "undefined" && process.platform) {
			const platform = process.platform;
			if (platform === "win32") {
				// Windows OS foreground lock prevents background processes from un-minimizing
				// or focusing via window.focus(). We execute a targeted Python ctypes Win32
				// script that switches to the interactive desktop, un-minimizes the window
				// via ShowWindow(SW_RESTORE = 9), and brings it above obscuring windows
				// via SetWindowPos(HWND_TOPMOST -> HWND_NOTOPMOST) and SetForegroundWindow.
				const pyScript = [
					"import ctypes, sys",
					"u = ctypes.windll.user32",
					"k = ctypes.windll.kernel32",
					"d = u.OpenDesktopW('Default', 0, False, 0x01FF)",
					"if d: u.SetThreadDesktop(d)",
					"obs_hwnd = None",
					"def cb(h, l):",
					" global obs_hwnd",
					" if not u.IsWindowVisible(h): return True",
					" pid = ctypes.c_ulong()",
					" u.GetWindowThreadProcessId(h, ctypes.byref(pid))",
					" hp = k.OpenProcess(0x1000, False, pid.value)",
					" if hp:",
					"  n = ctypes.create_unicode_buffer(512)",
					"  k.QueryFullProcessImageNameW(hp, 0, n, ctypes.byref(ctypes.c_ulong(512)))",
					"  k.CloseHandle(hp)",
					"  if n.value.lower().endswith('obsidian.exe'):",
					"   c = ctypes.create_unicode_buffer(256)",
					"   u.GetClassNameW(h, c, 256)",
					"   if c.value == 'Chrome_WidgetWin_1':",
					"    obs_hwnd = h",
					"    return False",
					" return True",
					"u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(cb), 0)",
					"if not obs_hwnd: sys.exit(1)",
					"if u.IsIconic(obs_hwnd):",
					" u.ShowWindow(obs_hwnd, 9)",
					"else:",
					" u.ShowWindow(obs_hwnd, 5)",
					"u.SetWindowPos(obs_hwnd, -1, 0, 0, 0, 0, 3)",
					"u.SetWindowPos(obs_hwnd, -2, 0, 0, 0, 0, 3)",
					"u.keybd_event(0x12, 0, 0, 0)",
					"u.keybd_event(0x12, 0, 2, 0)",
					"ret = u.SetForegroundWindow(obs_hwnd)",
					"u.BringWindowToTop(obs_hwnd)",
					"if not ret: u.SwitchToThisWindow(obs_hwnd, True)",
					"sys.exit(0 if u.GetForegroundWindow() == obs_hwnd else 1)",
				].join("\n");
				const b64 = Buffer.from(pyScript).toString("base64");
				exec(
					`python -c "import base64; exec(base64.b64decode('${b64}').decode('utf-8'))"`,
					(err) => {
						if (err) {
							// Fallback if Python is not on PATH or failed to focus: invoke shell URI
							const resolvedApp =
								app ?? (typeof window !== "undefined" ? (window as any).app : null);
							const vaultName = resolvedApp?.vault?.getName?.();
							const uri = vaultName
								? `obsidian://open?vault=${encodeURIComponent(vaultName)}`
								: "obsidian://";
							exec(`start "" "${uri}"`, () => {});
						}
					}
				);
			} else if (platform === "darwin") {
				exec('osascript -e \'tell application "Obsidian" to activate\'', (err) => {
					if (err) {
						const resolvedApp =
							app ?? (typeof window !== "undefined" ? (window as any).app : null);
						const vaultName = resolvedApp?.vault?.getName?.();
						const uri = vaultName
							? `obsidian://open?vault=${encodeURIComponent(vaultName)}`
							: "obsidian://";
						exec(`open "${uri}"`, () => {});
					}
				});
			} else if (platform === "linux") {
				exec('wmctrl -x -a "obsidian" || xdotool search --class "obsidian" windowactivate', (err) => {
					if (err) {
						const resolvedApp =
							app ?? (typeof window !== "undefined" ? (window as any).app : null);
						const vaultName = resolvedApp?.vault?.getName?.();
						const uri = vaultName
							? `obsidian://open?vault=${encodeURIComponent(vaultName)}`
							: "obsidian://";
						exec(`xdg-open "${uri}"`, () => {});
					}
				});
			}
		}
	} catch (err) {
		console.warn("[LitNoteServer] OS focus error:", err);
	}
}

async function openFile(
	app: App,
	file: TFile,
	preferredLeaf?: WorkspaceLeaf | null,
	options?: { modifyText?: boolean }
): Promise<void> {
	if (!file) {
		// Defensive: callers ensure the workspace is ready and writeNote()
		// returns a resolved TFile, so this should be unreachable.
		throw new Error("Cannot open lit note: no file was provided");
	}

	// Bring the Obsidian OS window to the foreground immediately so Chromium activates the view.
	focusObsidianWindow(app);

	// Check for an existing leaf matching this file (including deferred leaves)
	let targetLeaf: WorkspaceLeaf | null = preferredLeaf ?? null;
	if (!targetLeaf && typeof app.workspace.iterateAllLeaves === "function") {
		app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as any;
			const viewFile =
				view?.file?.path ||
				(typeof leaf.getViewState === "function"
					? (leaf.getViewState()?.state as any)?.file
					: undefined);
			if (viewFile === file.path && !targetLeaf) {
				targetLeaf = leaf;
			}
		});
	}

	const cursorState = {
		cursor: {
			from: { line: 99999, ch: 0 },
			to: { line: 99999, ch: 0 },
		},
		line: 99999,
	};

	if (!targetLeaf) {
		targetLeaf = app.workspace.getLeaf("tab");
	}

	await targetLeaf.openFile(file, {
		active: true,
		eState: cursorState,
	});

	if (
		(targetLeaf as any).isDeferred &&
		typeof (targetLeaf as any).loadIfDeferred === "function"
	) {
		await (targetLeaf as any).loadIfDeferred();
	}
	if (typeof app.workspace.revealLeaf === "function") {
		await app.workspace.revealLeaf(targetLeaf);
	}
	if (typeof app.workspace.setActiveLeaf === "function") {
		app.workspace.setActiveLeaf(targetLeaf, { focus: true });
	}
	if (typeof targetLeaf.setEphemeralState === "function") {
		targetLeaf.setEphemeralState(cursorState);
	}

	let editor = (targetLeaf.view as any)?.editor;
	if (!editor) {
		await new Promise((resolve) => window.setTimeout(resolve, 50));
		editor = (targetLeaf.view as any)?.editor;
	}
	if (editor) {
		editor.focus?.();
		const targetLine = positionCursorTwoLinesPastEnd(editor, options?.modifyText ?? true);
		if (typeof targetLeaf.setEphemeralState === "function") {
			targetLeaf.setEphemeralState({
				cursor: {
					from: { line: targetLine, ch: 0 },
					to: { line: targetLine, ch: 0 },
				},
				line: targetLine,
			});
		}
	}

	focusObsidianWindow(app);
}

async function restorePreviousLeaf(
	app: App,
	leaf: WorkspaceLeaf | null
): Promise<void> {
	if (!leaf) return;
	try {
		await new Promise((resolve) => window.setTimeout(resolve, 10));

		let isAttached = false;
		if (typeof app.workspace.iterateAllLeaves === "function") {
			app.workspace.iterateAllLeaves((l) => {
				if (l === leaf) isAttached = true;
			});
		} else {
			isAttached = (leaf as any).parent !== null;
		}

		let target: WorkspaceLeaf | null = isAttached ? leaf : null;
		if (!target && typeof app.workspace.getMostRecentLeaf === "function") {
			target = app.workspace.getMostRecentLeaf();
		}
		if (target) {
			if (typeof app.workspace.revealLeaf === "function") {
				await app.workspace.revealLeaf(target);
			}
			if (typeof app.workspace.setActiveLeaf === "function") {
				app.workspace.setActiveLeaf(target, { focus: true });
			}
			const editor = (target.view as any)?.editor;
			editor?.focus?.();
		}
	} catch (err) {
		console.warn("[LitNoteServer] Failed to restore previous leaf:", err);
	}
}

interface OpenEntry {
	citekey: string;
	item?: ZoteroItemPayload;
}

async function handleOpenBatch(
	app: App,
	settings: LitNoteServerSettings,
	entries: OpenEntry[]
): Promise<LitNoteItemResult[]> {
	focusObsidianWindow(app);
	await ensureWorkspaceReady(app);
	const results: LitNoteItemResult[] = [];
	const found: OpenEntry[] = [];
	const missing: OpenEntry[] = [];
	let prompted = false;

	for (const entry of entries) {
		if (!entry.citekey) {
			results.push({
				citekey: "",
				status: "error",
				error: "Missing citekey",
			});
			continue;
		}
		if (existingFile(app, settings, entry.citekey)) {
			found.push(entry);
		} else {
			missing.push(entry);
		}
	}

	for (const entry of found) {
		const file = existingFile(app, settings, entry.citekey);
		if (!file) {
			missing.push(entry);
			continue;
		}
		try {
			await openFile(app, file);
			results.push({ citekey: entry.citekey, status: "opened" });
		} catch (err: unknown) {
			results.push({
				citekey: entry.citekey,
				status: "error",
				error: errorMessage(err),
			});
		}
	}

	if (missing.length) {
		const creatable = missing.filter((e) => e.item);
		let decision: NoteDecision = "skip";
		if (creatable.length) {
			const previousLeaf: WorkspaceLeaf | null =
				(typeof app.workspace.getMostRecentLeaf === "function"
					? app.workspace.getMostRecentLeaf()
					: null) ??
				(app.workspace as any).activeLeaf ??
				null;
			let blankLeaf: WorkspaceLeaf | null = null;
			let blankLeafConsumed = false;
			if (typeof app.workspace.getLeaf === "function") {
				blankLeaf = app.workspace.getLeaf("tab");
				if (typeof app.workspace.revealLeaf === "function") {
					await app.workspace.revealLeaf(blankLeaf);
				}
				if (typeof app.workspace.setActiveLeaf === "function") {
					app.workspace.setActiveLeaf(blankLeaf, { focus: true });
				}
			}

			const citekeys = missing.map((e) => e.citekey).join("\n");
			focusObsidianWindow(app);
			prompted = true;
			try {
				decision = await askNoteDecision(
					app,
					creatable.length === 1
						? "Lit note not found"
						: `${creatable.length} lit notes not found`,
					`Not in the Obsidian vault:\n\n${citekeys}\n\nCreate ${creatable.length === 1 ? "it" : "them"} from the Zotero data?`,
					[
						{ label: "Create", value: "create", cta: true },
						{ label: "Skip", value: "skip" },
						{ label: "Cancel", value: "cancel" },
					]
				);
			} catch (err) {
				if (blankLeaf && typeof blankLeaf.detach === "function") {
					try {
						blankLeaf.detach();
					} catch {
						// Ignore
					}
					await restorePreviousLeaf(app, previousLeaf);
				}
				throw err;
			}

			if (decision === "create") {
				if (settings.validateAuthorNameFormat) {
					const allIssues: AuthorFormatIssue[] = [];
					for (const e of creatable) {
						if (e.item) {
							allIssues.push(...validateItemAuthorFormats(e.item));
						}
					}

					if (allIssues.length > 0) {
						focusObsidianWindow(app);
						let formatDecision: AuthorFormatDecision = "cancel";
						try {
							formatDecision = await askAuthorFormatDecision(app, allIssues);
						} catch (err) {
							if (blankLeaf && typeof blankLeaf.detach === "function") {
								try {
									blankLeaf.detach();
								} catch {
									// Ignore
								}
								await restorePreviousLeaf(app, previousLeaf);
							}
							throw err;
						}

						if (formatDecision === "edit") {
							for (const e of creatable) {
								if (e.item) openZoteroItem(e.item);
							}
							if (blankLeaf && typeof blankLeaf.detach === "function") {
								try {
									blankLeaf.detach();
								} catch {
									// Ignore
								}
								await restorePreviousLeaf(app, previousLeaf);
							}
							for (const e of missing) {
								results.push({ citekey: e.citekey, status: "skipped" });
							}
							if (prompted) noticeSummary(results, true);
							return results;
						} else if (formatDecision === "cancel") {
							if (blankLeaf && typeof blankLeaf.detach === "function") {
								try {
									blankLeaf.detach();
								} catch {
									// Ignore
								}
								await restorePreviousLeaf(app, previousLeaf);
							}
							for (const e of missing) {
								results.push({ citekey: e.citekey, status: "skipped" });
							}
							if (prompted) noticeSummary(results, true);
							return results;
						} else if (formatDecision === "auto-correct") {
							applyAuthorCorrections(
								creatable.map((e) => e.item!).filter(Boolean),
								allIssues
							);
						}
						// If "create-anyway", proceed with note creation!
					}
				}

				await ensureFolder(app, settings);
				for (let i = 0; i < creatable.length; i++) {
					const entry = creatable[i];
					try {
						const file = await writeNote(app, settings, entry.item!, null);
						if (i === 0 && blankLeaf) {
							blankLeafConsumed = true;
							await openFile(app, file, blankLeaf);
						} else {
							await openFile(app, file);
						}
						results.push({ citekey: entry.citekey, status: "created" });
					} catch (err: unknown) {
						results.push({
							citekey: entry.citekey,
							status: "error",
							error: errorMessage(err),
						});
					}
				}
				if (blankLeaf && !blankLeafConsumed && typeof blankLeaf.detach === "function") {
					try {
						blankLeaf.detach();
					} catch {
						// Ignore
					}
					await restorePreviousLeaf(app, previousLeaf);
				}
			} else {
				if (blankLeaf && typeof blankLeaf.detach === "function") {
					try {
						blankLeaf.detach();
					} catch (err: unknown) {
						console.warn("[LitNoteServer] Failed to detach blank leaf:", err);
					}
					await restorePreviousLeaf(app, previousLeaf);
				}
				for (const entry of missing) {
					results.push({ citekey: entry.citekey, status: "missing" });
				}
			}
		} else {
			for (const entry of missing) {
				results.push({ citekey: entry.citekey, status: "missing" });
			}
		}
	}

	noticeSummary(results, prompted);
	return results;
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: LitNoteResponse): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
}

function resultsResponse(results: LitNoteItemResult[]): LitNoteResponse {
	return {
		success: !results.some((r) => r.status === "error"),
		results,
	};
}

async function handleRequest(
	app: App,
	settings: LitNoteServerSettings,
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	if (req.method === "GET" && req.url === "/lit-notes") {
		const folderPath = normalizePath(settings.litNotesFolder);
		const folder = app.vault.getAbstractFileByPath(folderPath);
		const citekeys: string[] = [];
		if (folder) {
			const files = app.vault.getFiles();
			for (const f of files) {
				if (f.path.startsWith(folderPath + "/") && f.extension === "md") {
					citekeys.push(f.basename);
				}
			}
		}
		sendJson(res, 200, { success: true, citekeys: citekeys } as any);
		return;
	}

	// Only accept POST /lit-note
	if (req.method !== "POST" || req.url !== "/lit-note") {
		sendJson(res, 404, { success: false, error: "Not found" });
		return;
	}

	// Read body
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		// approximate length check
		if (chunks.length > 50000) {
			// 5 MB safety cap
			sendJson(res, 413, { success: false, error: "Payload too large" });
			return;
		}
	}
	const rawBody = Buffer.concat(chunks).toString("utf8");

	let parsed: LitNoteRequest;
	try {
		parsed = JSON.parse(rawBody) as LitNoteRequest;
	} catch {
		sendJson(res, 400, { success: false, error: "Invalid JSON" });
		return;
	}

	try {
		if (parsed.action === "create") {
			const items = parsed.data;
			if (!Array.isArray(items) || items.length === 0) {
				sendJson(res, 400, { success: false, error: "data array is empty or missing" });
				return;
			}
			const results = await runSerialized(() =>
				handleCreateBatch(app, settings, items)
			);
			sendJson(res, 200, resultsResponse(results));
		} else if (parsed.action === "open") {
			const openRequest = parsed as LitNoteOpenRequest;
			const data = Array.isArray(openRequest.data) ? openRequest.data : [];
			const entries: OpenEntry[] = data.length
				? data.map((item) => ({ item, citekey: citekeyOf(item) }))
				: openRequest.citekey
					? [{ citekey: openRequest.citekey.trim() }]
					: [];
			if (!entries.length) {
				sendJson(res, 400, {
					success: false,
					error: "data array or citekey is required for open action",
				});
				return;
			}
			const results = await runSerialized(() =>
				handleOpenBatch(app, settings, entries)
			);
			sendJson(res, 200, resultsResponse(results));
		} else {
			sendJson(res, 400, {
				success: false,
				error: `Unknown action: ${(parsed as { action: string }).action}`,
			});
		}
	} catch (err: unknown) {
		const msg = errorMessage(err);
		console.error("[LitNoteServer] Unhandled error:", err);
		sendJson(res, 500, { success: false, error: msg });
	}
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the lit-note HTTP server.
 * Returns the server instance so the caller can call `stopLitNoteServer` in
 * `onunload()`.
 */
export function startLitNoteServer(app: App, settings: LitNoteServerSettings): http.Server {
	const server = http.createServer((req, res) => {
		handleRequest(app, settings, req, res).catch((err) => {
			console.error("[LitNoteServer] Fatal request error:", err);
			if (!res.headersSent) {
				sendJson(res, 500, { success: false, error: "Internal server error" });
			}
		});
	});

	const HTTP_PORT = 27124;

	server.on("error", (e: NodeJS.ErrnoException) => {
		if (e.code === "EADDRINUSE") {
			console.error(`[LitNoteServer] Port ${HTTP_PORT} is in use.`);
			new Notice(
				`Zotero lit-note listener: port ${HTTP_PORT} is already in use. ` +
					`Is there more than one Obsidian vault running with the perplexity saver plugin enabled?`
			);
		} else {
			console.error("[LitNoteServer] error", e);
		}
	});

	server.listen(HTTP_PORT, "127.0.0.1", () => {
		console.log(`[LitNoteServer] Listening on 127.0.0.1:${HTTP_PORT}`);
	});

	return server;
}

/**
 * Gracefully stop the server. Call from `Plugin.onunload()`.
 */
export function stopLitNoteServer(server: http.Server): void {
	server.close((err) => {
		if (err) {
			console.warn("[LitNoteServer] Error on close:", err);
		} else {
			console.log("[LitNoteServer] Server stopped.");
		}
	});
}
