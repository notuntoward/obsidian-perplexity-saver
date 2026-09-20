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
import { App, Notice, normalizePath, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { buildLitNoteBody, buildLitNoteFrontmatter } from "./buildLitNote";
import { askNoteDecision, type NoteDecision } from "./decisionModal";
import type {
	LitNoteItemResult,
	LitNoteItemStatus,
	LitNoteOpenRequest,
	LitNoteRequest,
	LitNoteResponse,
	ZoteroItemPayload,
} from "./types";

export interface LitNoteServerSettings {
	litNotesFolder: string; // vault-relative path, e.g. "lit/lit_notes"
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

function notePathFor(settings: LitNoteServerSettings, citekey: string): string {
	const folderPath = normalizePath(settings.litNotesFolder);
	return normalizePath(`${folderPath}/${citekey}.md`);
}

function existingFile(
	app: App,
	settings: LitNoteServerSettings,
	citekey: string
): TFile | null {
	const file = app.vault.getAbstractFileByPath(notePathFor(settings, citekey));
	return file instanceof TFile ? file : null;
}

async function ensureFolder(app: App, settings: LitNoteServerSettings): Promise<void> {
	const folderPath = normalizePath(settings.litNotesFolder);
	if (!app.vault.getAbstractFileByPath(folderPath)) {
		try {
			await app.vault.createFolder(folderPath);
		} catch {
			// Ignore if it was created by a concurrent request
		}
	}
}

/** Create or overwrite the note body/frontmatter and return the file. */
async function writeNote(
	app: App,
	settings: LitNoteServerSettings,
	item: ZoteroItemPayload,
	existing: TFile | null
): Promise<TFile> {
	const citekey = citekeyOf(item);
	const body = buildLitNoteBody(app, settings, item);
	const frontmatter = buildLitNoteFrontmatter(item);

	let file: TFile;
	if (existing) {
		await app.vault.modify(existing, body);
		file = existing;
	} else {
		file = await app.vault.create(notePathFor(settings, citekey), body);
	}

	try {
		await app.fileManager.processFrontMatter(file, (fm) => {
			for (const [k, v] of Object.entries(frontmatter)) {
				if (v !== undefined) fm[k] = v;
			}
		});
	} catch (err: unknown) {
		// Frontmatter failure is non-fatal — the body is already written.
		console.warn("[LitNoteServer] processFrontMatter failed:", err);
	}

	return file;
}

function noticeSummary(results: LitNoteItemResult[]): void {
	const counts: Record<LitNoteItemStatus, number> = {
		created: 0,
		overwritten: 0,
		opened: 0,
		skipped: 0,
		missing: 0,
		error: 0,
	};
	for (const r of results) counts[r.status] += 1;
	const parts: string[] = [];
	if (counts.created) parts.push(`${counts.created} created`);
	if (counts.overwritten) parts.push(`${counts.overwritten} overwritten`);
	if (counts.opened) parts.push(`${counts.opened} opened`);
	if (counts.skipped) parts.push(`${counts.skipped} skipped`);
	if (counts.missing) parts.push(`${counts.missing} missing`);
	if (counts.error) parts.push(`${counts.error} failed`);
	if (parts.length) new Notice(`Lit notes: ${parts.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Handler: create lit notes
// ---------------------------------------------------------------------------

async function handleCreateBatch(
	app: App,
	settings: LitNoteServerSettings,
	items: ZoteroItemPayload[]
): Promise<LitNoteItemResult[]> {
	await ensureFolder(app, settings);

	const entries = items.map((item) => ({ item, citekey: citekeyOf(item) }));
	const existingEntries = entries.filter(
		(e) => e.citekey && existingFile(app, settings, e.citekey)
	);

	let decision: NoteDecision = "overwrite";
	if (existingEntries.length) {
		const citekeys = existingEntries.map((e) => e.citekey).join("\n");
		focusObsidianWindow();
		decision = await askNoteDecision(
			app,
			existingEntries.length === 1
				? "Lit note already exists"
				: `${existingEntries.length} lit notes already exist`,
			`Already in the Obsidian vault:\n\n${citekeys}\n\nOverwrite with the Zotero data, open the existing note, or skip it?`,
			[
				{ label: "Overwrite", value: "overwrite", cta: true },
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

	noticeSummary(results);
	return results;
}

// ---------------------------------------------------------------------------
// Handler: open / focus lit notes
// ---------------------------------------------------------------------------

function positionCursorTwoLinesPastEnd(editor: any): void {
	if (!editor) return;
	if (typeof editor.getValue !== "function") {
		if (typeof editor.setCursor === "function") {
			editor.setCursor({ line: 99999, ch: 0 });
		}
		return;
	}
	const text = editor.getValue();
	if (!text.endsWith("\n\n")) {
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
}

/** Bring the Obsidian Electron window to the foreground using the Electron API. */
export function focusObsidianWindow(): void {
	try {
		const win =
			typeof activeWindow !== "undefined"
				? (activeWindow as any)
				: typeof window !== "undefined"
					? (window as any)
					: null;
		if (!win) return;

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
			return;
		}

		if (typeof win.focus === "function") {
			win.focus();
		}
	} catch (err) {
		console.warn("[LitNoteServer] focusObsidianWindow error:", err);
	}
}

async function openFile(app: App, file: TFile): Promise<void> {
	// If Obsidian is still starting up, wait for workspace layout to be ready
	// so opening the tab is not overridden when Obsidian finishes loading workspace.json.
	if (
		app.workspace &&
		!app.workspace.layoutReady &&
		typeof app.workspace.onLayoutReady === "function"
	) {
		await new Promise<void>((resolve) => {
			const timeout = window.setTimeout(() => resolve(), 5000);
			app.workspace.onLayoutReady(() => {
				window.clearTimeout(timeout);
				resolve();
			});
		});
	}

	// Bring the Obsidian OS window to the foreground immediately so Chromium activates the view.
	focusObsidianWindow();

	// Check for an existing leaf matching this file (including deferred leaves)
	let targetLeaf: WorkspaceLeaf | null = null;
	if (typeof app.workspace.iterateAllLeaves === "function") {
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
		positionCursorTwoLinesPastEnd(editor);
	}

	focusObsidianWindow();
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
	const results: LitNoteItemResult[] = [];
	const found: OpenEntry[] = [];
	const missing: OpenEntry[] = [];

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
			const citekeys = missing.map((e) => e.citekey).join("\n");
			focusObsidianWindow();
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
		}

		if (decision === "create") {
			await ensureFolder(app, settings);
			for (const entry of creatable) {
				try {
					const file = await writeNote(app, settings, entry.item!, null);
					await openFile(app, file);
					results.push({ citekey: entry.citekey, status: "created" });
				} catch (err: unknown) {
					results.push({
						citekey: entry.citekey,
						status: "error",
						error: errorMessage(err),
					});
				}
			}
		} else {
			for (const entry of missing) {
				results.push({ citekey: entry.citekey, status: "missing" });
			}
		}
	}

	noticeSummary(results);
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
