import { App, normalizePath, Notice, TFile } from "obsidian";
import type { ZoteroItemPayload } from "./types";
import { buildLitNoteBody, buildLitNoteFrontmatter } from "./buildLitNote";
import { findLitNoteFile } from "./litNoteFinder";

import type { NameStyle } from "./bibtexName";

export interface LitNoteWriterSettings {
	litNotesFolder: string;
	authorFormatStyle?: NameStyle;
	authorDropVon?: boolean;
}

/**
 * Normalise lit note path from settings and citekey.
 */
export function notePathFor(settings: LitNoteWriterSettings, citekey: string): string {
	const folderPath = normalizePath(settings.litNotesFolder);
	return normalizePath(`${folderPath}/${citekey}.md`);
}

export function existingFile(
	app: App,
	settings: LitNoteWriterSettings,
	citekey: string
): TFile | null {
	const file = app.vault.getAbstractFileByPath(notePathFor(settings, citekey));
	if (file instanceof TFile) return file;
	if (typeof app.vault?.getMarkdownFiles === "function") {
		return findLitNoteFile(app, settings, citekey);
	}
	return null;
}

export async function ensureFolder(app: App, settings: LitNoteWriterSettings): Promise<void> {
	const folderPath = normalizePath(settings.litNotesFolder);
	if (!app.vault.getAbstractFileByPath(folderPath)) {
		try {
			await app.vault.createFolder(folderPath);
		} catch {
			// Ignore if it was created by a concurrent request
		}
	}
}

function citekeyOf(item: ZoteroItemPayload): string {
	return item.citekey?.trim() || item.itemkey?.trim() || "untitled";
}

/**
 * Obsidian's vault index is not reliable until the workspace is ready. Wait for
 * it before checking whether notes exist or writing files, so a cold-start
 * request cannot treat an existing note as new (or the reverse).
 */
export async function ensureWorkspaceReady(app: App): Promise<void> {
	if (app.workspace?.layoutReady) return;
	if (typeof app.workspace?.onLayoutReady !== "function") return;
	await new Promise<void>((resolve) => {
		const timeout = window.setTimeout(() => resolve(), 5000);
		app.workspace.onLayoutReady(() => {
			window.clearTimeout(timeout);
			resolve();
		});
	});
}

/**
 * Ensure the directory for a target file path exists in the vault.
 */
export async function ensureFolderPath(app: App, targetPath: string): Promise<void> {
	const normPath = normalizePath(targetPath);
	const parts = normPath.split("/");
	parts.pop();
	const folderPath = parts.join("/");

	if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
		try {
			await app.vault.createFolder(folderPath);
		} catch {
			// Ignore if it was created concurrently
		}
	}
}

/**
 * Core literature note writer.
 * Handles folder creation, ensureWorkspaceReady, vault create/modify,
 * re-resolving by path to protect against cold-start vault index races,
 * and updating frontmatter via processFrontMatter when frontmatter is provided.
 */
export async function writeLitNote(
	app: App,
	targetPath: string,
	contentOrBody: string,
	frontmatter?: Record<string, unknown>,
	existing?: TFile | null
): Promise<TFile> {
	await ensureWorkspaceReady(app);
	await ensureFolderPath(app, targetPath);

	const normPath = normalizePath(targetPath);
	let file: TFile | null = existing ?? null;

	if (!file) {
		const resolved = app.vault.getAbstractFileByPath(normPath);
		if (resolved instanceof TFile) {
			file = resolved;
		}
	}

	if (file) {
		await app.vault.modify(file, contentOrBody);
	} else {
		file = await app.vault.create(normPath, contentOrBody);
	}

	// create()/modify() can resolve before the vault index catches up (notably
	// during a cold start), leaving `file` null. Re-resolve by path so we never
	// hand a null file to processFrontMatter() or openFile().
	if (!file) {
		const resolved = app.vault.getAbstractFileByPath(normPath);
		file = resolved instanceof TFile ? resolved : null;
	}
	if (!file) {
		throw new Error(
			`Note was written but could not be resolved in the vault: ${normPath}`
		);
	}

	if (frontmatter && Object.keys(frontmatter).length > 0 && app.fileManager?.processFrontMatter) {
		try {
			await app.fileManager.processFrontMatter(file, (fm) => {
				for (const [k, v] of Object.entries(frontmatter)) {
					if (v !== undefined) fm[k] = v;
				}
			});
		} catch (err: unknown) {
			// Frontmatter failure is non-fatal — the body is already written.
			console.warn("[LitNote] processFrontMatter failed:", err);
		}
	}

	return file;
}

/**
 * Create or overwrite the note body/frontmatter from a Zotero entry and return the file.
 * Underlying note writing code used for Zotero integration.
 */
export async function writeNote(
	app: App,
	settings: LitNoteWriterSettings,
	item: ZoteroItemPayload,
	existing: TFile | null
): Promise<TFile> {
	const citekey = citekeyOf(item);
	const notePath = notePathFor(settings, citekey);
	const body = buildLitNoteBody(app, settings, item);
	const frontmatter = buildLitNoteFrontmatter(item, settings);

	if (!frontmatter.authors || (Array.isArray(frontmatter.authors) && frontmatter.authors.length === 0)) {
		new Notice(`Warning: Unable to create authors file property for note '${citekey}'.`);
	}

	return await writeLitNote(app, notePath, body, frontmatter, existing);
}
