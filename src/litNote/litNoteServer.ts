/**
 * Local HTTP server that receives requests from the Zotero companion plugin.
 *
 * Binds to 127.0.0.1 (loopback only) — no external exposure, no auth token
 * required (identical pattern to Zotero's own Local API on port 23119).
 *
 * Supported endpoints:
 *   POST /lit-note   { action: "create", data: ZoteroItemPayload[] }
 *                    → creates lit note(s) in the vault
 *   POST /lit-note   { action: "open", citekey: string }
 *                    → opens/focuses a lit note in Obsidian
 */

import http from "http";
import { App, Notice, normalizePath, TFile, WorkspaceLeaf, MarkdownView } from "obsidian";
import { buildLitNoteBody, buildLitNoteFrontmatter } from "./buildLitNote";
import type { 	LitNoteCreateRequest,
	LitNoteRequest,
	LitNoteResponse,
	ZoteroItemPayload
} from "./types";

export interface LitNoteServerSettings {
	litNotesFolder: string; // vault-relative path, e.g. "lit/lit_notes"
}

// ---------------------------------------------------------------------------
// Handler: create lit note
// ---------------------------------------------------------------------------

async function handleCreate(
	app: App,
	settings: LitNoteServerSettings,
	item: ZoteroItemPayload,
	force: boolean = false
): Promise<LitNoteResponse> {
	const citekey = (item.citekey ?? "").trim();
	if (!citekey) {
		return { success: false, error: "Payload missing citekey" };
	}

	const folderPath = normalizePath(settings.litNotesFolder);
	const notePath = normalizePath(`${folderPath}/${citekey}.md`);

	// Ensure folder exists
	if (!app.vault.getAbstractFileByPath(folderPath)) {
		try {
			await app.vault.createFolder(folderPath);
		} catch {
			// Ignore if it was created by a concurrent request
		}
	}

	const existing = app.vault.getAbstractFileByPath(notePath);
	if (existing instanceof TFile && !force) {
		// Return a specific "exists" error so Zotero can prompt the user
		return { success: false, error: "exists" };
	}

	const body = buildLitNoteBody(app, settings, item);
	const frontmatter = buildLitNoteFrontmatter(item);

	let file: TFile;
	try {
		if (existing instanceof TFile && force) {
			await app.vault.modify(existing, body);
			file = existing;
		} else {
			file = await app.vault.create(notePath, body);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, error: `vault ${force ? "modify" : "create"} failed: ${msg}` };
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

	new Notice(force ? `Overwrote lit note: ${citekey}` : `Created lit note: ${citekey}`);
	
	// Open the note automatically
	return handleOpen(app, settings, citekey);
}

// ---------------------------------------------------------------------------
// Handler: open / focus lit note
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
	console.log(
		`[LitNoteServer] Cursor positioned at line ${targetLine}, ch 0 (lineCount: ${
			typeof editor.lineCount === "function" ? editor.lineCount() : "unknown"
		})`
	);
}

/** Bring the Obsidian Electron window to the foreground using the Electron API. */
function focusObsidianWindow(): void {
	try {
		// Obsidian exposes 'electron' on the global object in its renderer process.
		// Accessing it via (window as any).electron or require('electron') both work.
		const electron = (window as any).electron ?? (typeof require === "function" ? require("electron") : null);
		if (electron?.ipcRenderer) {
			// Use IPC to tell main process to focus the window.
			// Obsidian's main process responds to the "obsidian:focus-window" message.
			// If that doesn't exist, we try calling BrowserWindow.getFocusedWindow or getCurrentWindow.
			console.log("[LitNoteServer] Attempting to focus Obsidian OS window via Electron IPC...");
			try {
				electron.ipcRenderer.invoke("obsidian:focus-window").catch(() => {});
			} catch(_) {}
		}
		// Fallback: use the @electron/remote getCurrentWindow().show() + focus() pattern.
		const remote = (window as any).require?.("@electron/remote") ?? (window as any).__electronRemote;
		if (remote?.getCurrentWindow) {
			console.log("[LitNoteServer] Focusing OS window via @electron/remote.getCurrentWindow().show().focus()...");
			const win = remote.getCurrentWindow();
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
			return;
		}
		// Second fallback: Obsidian 1.5+ sometimes exposes BrowserWindow through app internal.
		const obsApp = (window as any).app;
		if (obsApp?.emulateMobile !== undefined && electron?.remote?.getCurrentWindow) {
			const win = electron.remote.getCurrentWindow();
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
			return;
		}
		console.log("[LitNoteServer] No Electron window focus API found; relying on workspace activation only.");
	} catch (err) {
		console.warn("[LitNoteServer] focusObsidianWindow error:", err);
	}
}

async function handleOpen(
	app: App,
	settings: LitNoteServerSettings,
	citekey: string
): Promise<LitNoteResponse> {
	console.log(
		`[LitNoteServer] handleOpen requested for citekey: "${citekey}" | document.hasFocus: ${typeof document !== "undefined" ? document.hasFocus() : "n/a"} | visibilityState: ${typeof document !== "undefined" ? document.visibilityState : "n/a"}`
	);

	const folderPath = normalizePath(settings.litNotesFolder);
	const notePath = normalizePath(`${folderPath}/${citekey}.md`);

	const fileOrFolder = app.vault.getAbstractFileByPath(notePath);
	if (!(fileOrFolder instanceof TFile)) {
		console.warn(`[LitNoteServer] Lit note file not found at: "${notePath}"`);
		return {
			success: false,
			error: `Lit note not found: ${notePath}`,
		};
	}

	const file = fileOrFolder;

	// Step 1: Bring the Obsidian OS window to the foreground immediately.
	// This is the main fix: make the OS window visible so Chromium tab switching works.
	focusObsidianWindow();

	// Step 2: Check for an existing leaf matching this file (including deferred leaves)
	let targetLeaf: WorkspaceLeaf | null = null;
	if (typeof app.workspace.iterateAllLeaves === "function") {
		app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as any;
			const viewFile = view?.file?.path ||
				(typeof leaf.getViewState === "function" ? (leaf.getViewState()?.state as any)?.file : undefined);
			if (viewFile === file.path && !targetLeaf) {
				targetLeaf = leaf;
			}
		});
	}
	if (!targetLeaf) {
		const existingLeaves = app.workspace.getLeavesOfType("markdown");
		for (const leaf of existingLeaves) {
			const view = leaf.view as any;
			if (view?.file?.path === file.path) {
				targetLeaf = leaf;
				break;
			}
		}
	}

	console.log(`[LitNoteServer] Target leaf found: ${!!targetLeaf} (isDeferred: ${(targetLeaf as any)?.isDeferred})`);

	const cursorState = {
		cursor: {
			from: { line: 99999, ch: 0 },
			to: { line: 99999, ch: 0 },
		},
		line: 99999,
	};

	if (!targetLeaf) {
		console.log(`[LitNoteServer] Opening new tab leaf for file: ${file.path}`);
		targetLeaf = app.workspace.getLeaf("tab");
	}

	console.log(`[LitNoteServer] Calling targetLeaf.openFile...`);
	await targetLeaf.openFile(file, {
		active: true,
		eState: cursorState,
	});

	const activateLeafAndEditor = async (source: string) => {
		console.log(
			`[LitNoteServer] activateLeafAndEditor triggered via: ${source} | document.hasFocus: ${typeof document !== "undefined" ? document.hasFocus() : "n/a"} | visibilityState: ${typeof document !== "undefined" ? document.visibilityState : "n/a"}`
		);
		if (!targetLeaf) return;

		try {
			if ((targetLeaf as any).isDeferred && typeof (targetLeaf as any).loadIfDeferred === "function") {
				console.log(`[LitNoteServer] Leaf is deferred; calling loadIfDeferred()...`);
				await (targetLeaf as any).loadIfDeferred();
			}
			if (typeof app.workspace.revealLeaf === "function") {
				console.log(`[LitNoteServer] Calling workspace.revealLeaf...`);
				await app.workspace.revealLeaf(targetLeaf);
			}
			if (typeof app.workspace.setActiveLeaf === "function") {
				console.log(`[LitNoteServer] Calling workspace.setActiveLeaf(targetLeaf, { focus: true })...`);
				app.workspace.setActiveLeaf(targetLeaf, { focus: true });
			}
			if (typeof targetLeaf.setEphemeralState === "function") {
				targetLeaf.setEphemeralState(cursorState);
			}

			const v = targetLeaf.view as any;
			if (v?.editor) {
				console.log(`[LitNoteServer] Focusing editor...`);
				v.editor.focus?.();
				positionCursorTwoLinesPastEnd(v.editor);
			} else {
				console.log(`[LitNoteServer] view.editor not available yet (viewType: ${v?.getViewType?.()})`);
			}
		} catch (err) {
			console.error(`[LitNoteServer] Error during activateLeafAndEditor:`, err);
		}
	};

	// 1. Immediate activation
	await activateLeafAndEditor("immediate");

	// 2. Short follow-up activation (after view transition)
	window.setTimeout(() => {
		activateLeafAndEditor("timeout-50ms");
	}, 50);

	// 3. Multi-channel window activation watcher.
	// IMPORTANT: Only trigger on visibilitychange (tab becoming visible) and pointerdown (user clicking).
	// Do NOT use window.focus because that fires from our own blur() calls and from the OS without
	// the page actually becoming visible (visibilityState remains "hidden" when covered by fullscreen).
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		let cleaned = false;
		let focusWindowRetries = 0;

		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			console.log("[LitNoteServer] Window activation watcher cleaned up.");
			document.removeEventListener("visibilitychange", onVisChange);
			document.removeEventListener("pointerdown", onPointerDown, { capture: true });
			document.removeEventListener("click", onClick, { capture: true });
		};

		const onActivationEvent = async (evtName: string) => {
			console.log(
				`[LitNoteServer] Window activation event detected: "${evtName}" | visibilityState: ${document.visibilityState}`
			);
			cleanup();
			await activateLeafAndEditor(`event:${evtName}`);

			// Re-assert check after 150ms in case another plugin or layout handler diverted focus
			window.setTimeout(async () => {
				if (targetLeaf && app.workspace.activeLeaf !== targetLeaf) {
					console.warn(
						`[LitNoteServer] Active leaf diverted from targetLeaf after "${evtName}"; re-asserting!`
					);
					await activateLeafAndEditor("re-assert");
				}
			}, 150);
		};

		// Only trigger on visibility becoming visible (not on spurious focus events)
		const onVisChange = () => {
			if (document.visibilityState === "visible") {
				onActivationEvent("document.visibilitychange");
			}
		};

		const onPointerDown = () => onActivationEvent("document.pointerdown");
		const onClick = () => onActivationEvent("document.click");

		document.addEventListener("visibilitychange", onVisChange);
		document.addEventListener("pointerdown", onPointerDown, { capture: true });
		document.addEventListener("click", onClick, { capture: true });

		// Retry focusObsidianWindow up to 3 times in case the first call didn't work
		// (race condition with fullscreen window getting focus back)
		const retryFocus = () => {
			if (cleaned || focusWindowRetries >= 3) return;
			focusWindowRetries++;
			console.log(`[LitNoteServer] Retrying focusObsidianWindow (attempt ${focusWindowRetries})...`);
			focusObsidianWindow();
			if (!cleaned) {
				window.setTimeout(retryFocus, 300);
			}
		};
		window.setTimeout(retryFocus, 300);

		// Keep watcher active for up to 60 seconds
		window.setTimeout(() => {
			if (!cleaned) {
				console.log("[LitNoteServer] Window activation watcher timed out after 60s.");
				cleanup();
			}
		}, 60000);
	}

	return { success: true, path: notePath };
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
			const force = !!(parsed as LitNoteCreateRequest).force;
			// Process items sequentially to avoid vault race conditions
			let lastResult: LitNoteResponse = { success: true };
			for (const item of items) {
				lastResult = await handleCreate(app, settings, item, force);
				if (!lastResult.success) break;
			}
			const statusCode = lastResult.success ? 200 : (lastResult.error === "exists" ? 200 : 500);
			sendJson(res, statusCode, lastResult);
		} else if (parsed.action === "open") {
			const citekey = (parsed as { action: "open"; citekey: string }).citekey?.trim();
			if (!citekey) {
				sendJson(res, 400, { success: false, error: "citekey is required for open action" });
				return;
			}
			const result = await handleOpen(app, settings, citekey);
			sendJson(res, 200, result);
		} else {
			sendJson(res, 400, { success: false, error: `Unknown action: ${(parsed as { action: string }).action}` });
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
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
export function startLitNoteServer(
	app: App,
	settings: LitNoteServerSettings
): http.Server {
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
