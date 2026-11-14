import { getMainWindow } from "commons/workspace";
import { setTimeoutIn } from "commons/windows";
import { App, normalizePath, Notice, TFile } from "obsidian";
import type { EventRef } from "obsidian";
import type { ZoteroItemPayload } from "./types";
import { buildLitNoteBody, buildLitNoteFrontmatter } from "./buildLitNote";
import { findLitNoteFile } from "./litNoteFinder";
import { downloadYouTubeTranscript, getYouTubeUrlFromItem } from "./youtubeTranscript";

import type { NameStyle } from "./bibtexName";

export interface LitNoteWriterSettings {
	litNotesFolder: string;
	authorFormatStyle?: NameStyle;
	authorDropVon?: boolean;
	downloadYoutubeTranscripts?: boolean;
	transcriptHeading?: string;
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
	const mainWin = getMainWindow(app) ?? window;
	await new Promise<void>((resolve) => {
		const cancel = setTimeoutIn(mainWin, () => resolve(), 5000);
		app.workspace.onLayoutReady(() => {
			cancel();
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
	let createEventRef: EventRef | null = null;
	const createWait = { cancel: null as (() => void) | null };
	const createdFile = !file && typeof app.vault.on === "function"
		? new Promise<TFile>((resolve) => {
			createEventRef = app.vault.on("create", (abstractFile) => {
				if (abstractFile instanceof TFile && abstractFile.path === normPath) {
					resolve(abstractFile);
				}
			});
		})
		: null;

	try {
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

		// If create() resolves before the vault index catches up, use its create
		// event rather than reporting a successful write as a failure.
		if (!file) {
			const resolved = app.vault.getAbstractFileByPath(normPath);
			file = resolved instanceof TFile ? resolved : null;
			if (!file && createdFile) {
				const timeout = new Promise<TFile | null>((resolve) => {
					createWait.cancel = setTimeoutIn(
						getMainWindow(app) ?? window,
						() => resolve(null),
						1000
					);
				});
				file = await Promise.race([createdFile, timeout]);
			}
		}
	} finally {
		createWait.cancel?.();
		if (createEventRef) app.vault.offref(createEventRef);
	}

	if (!file) {
		throw new Error(`Note was written but could not be resolved in the vault: ${normPath}`);
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

	let transcript: string | undefined;
	const shouldDownload = settings.downloadYoutubeTranscripts ?? true;
	if (shouldDownload) {
		const ytUrl = getYouTubeUrlFromItem(item);
		if (ytUrl) {
			try {
				const fetched = await downloadYouTubeTranscript(ytUrl);
				if (fetched) {
					transcript = fetched;
				} else {
					new Notice(`Warning: No transcript found for YouTube video in '${citekey}'.`);
				}
			} catch (err: unknown) {
				console.warn("[LitNote] Failed to download YouTube transcript:", err);
				new Notice(`Warning: Could not download YouTube transcript for '${citekey}'.`);
			}
		}
	}

	const body = buildLitNoteBody(app, settings, item, transcript);
	const frontmatter = buildLitNoteFrontmatter(item, settings);

	if (!frontmatter.authors || (Array.isArray(frontmatter.authors) && frontmatter.authors.length === 0)) {
		new Notice(`Warning: Unable to create authors file property for note '${citekey}'.`);
	}

	return await writeLitNote(app, notePath, body, frontmatter, existing);
}
