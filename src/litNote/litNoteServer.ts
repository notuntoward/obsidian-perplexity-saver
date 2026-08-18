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
import { App, Notice, normalizePath, TFile } from "obsidian";
import { buildLitNoteBody, buildLitNoteFrontmatter } from "./buildLitNote";
import type { 	LitNoteCreateRequest,
	LitNoteRequest,
	LitNoteResponse,
	ZoteroItemPayload
} from "./types";

export interface LitNoteServerSettings {
	litNotePort: number;
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
	try {
		require('fs').writeFileSync('C:/Users/scott/.gemini/antigravity-ide/brain/4b7853ee-9a6d-43f0-8aed-4f4e86dbcc6b/scratch/obsidian_payload_dump.json', JSON.stringify(item, null, 2));
	} catch(e) {}

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

	
	// DUMP FOR DEBUGGING
	const fsNode = require("fs");
	try {
		fsNode.writeFileSync("C:\\Users\\scott\\repos\\obsidian-perplexity-saver\\scratch_payload.json", JSON.stringify(item, null, 2), "utf8");
	} catch (e) {
		console.error("Failed to dump payload", e);
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

async function handleOpen(
	app: App,
	settings: LitNoteServerSettings,
	citekey: string
): Promise<LitNoteResponse> {
	const folderPath = normalizePath(settings.litNotesFolder);
	const notePath = normalizePath(`${folderPath}/${citekey}.md`);

	const fileOrFolder = app.vault.getAbstractFileByPath(notePath);
	if (!(fileOrFolder instanceof TFile)) {
		return {
			success: false,
			error: `Lit note not found: ${notePath}`,
		};
	}

	const file = fileOrFolder;

	// If already open in a leaf, focus that leaf rather than opening a new tab.
	const existingLeaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of existingLeaves) {
		const view = leaf.view as any;
		if (view.file?.path === file.path) {
			app.workspace.setActiveLeaf(leaf, { focus: true });
			leaf.setEphemeralState({
				cursor: {
					from: { line: 99999, ch: 0 },
					to: { line: 99999, ch: 0 },
				},
				line: 99999
			});
			return { success: true, path: notePath };
		}
	}

	// Not open — open in a new tab.
	const leaf = app.workspace.getLeaf("tab");
	await leaf.openFile(file);
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

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.error(
				`[LitNoteServer] Port ${settings.litNotePort} already in use. ` +
				"Check that no other process (e.g. the Python webhook) is using it."
			);
			new Notice(
				`Zotero lit-note listener: port ${settings.litNotePort} is already in use. ` +
				"Change the port in Perplexity Saver settings.",
				8000
			);
		} else {
			console.error("[LitNoteServer] Server error:", err);
		}
	});

	server.listen(settings.litNotePort, "127.0.0.1", () => {
		console.log(`[LitNoteServer] Listening on 127.0.0.1:${settings.litNotePort}`);
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
