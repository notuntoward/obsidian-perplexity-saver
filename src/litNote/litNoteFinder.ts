import { App, normalizePath, TFile } from "obsidian";
import { notePathFor } from "./writeLitNote";

/**
 * Check if frontmatter has `category: literaturenote` (or `category: [literaturenote, ...]`).
 */
export function hasLiteratureNoteCategory(
	frontmatter: Record<string, unknown> | null | undefined
): boolean {
	if (!frontmatter || typeof frontmatter !== "object") return false;
	const cat = frontmatter.category;
	if (Array.isArray(cat)) {
		return cat.some(
			(c) => typeof c === "string" && c.toLowerCase().trim() === "literaturenote"
		);
	}
	if (typeof cat === "string") {
		return cat.toLowerCase().trim() === "literaturenote";
	}
	return false;
}

/**
 * Check if a file is a Markdown file (ends in .md and not .pdf or other binary extension).
 */
export function isMarkdownFile(file: TFile): boolean {
	if (file.extension && file.extension.toLowerCase() !== "md") return false;
	const normPath = normalizePath(file.path || "").toLowerCase();
	if (normPath && normPath.endsWith(".pdf")) return false;
	if (normPath && !normPath.endsWith(".md")) return false;
	return true;
}

/**
 * Check if a file is directly under the specified folder (never in subdirectories).
 */
export function isDirectChildOfFolder(file: TFile, folderPath?: string): boolean {
	if (!folderPath || !folderPath.trim()) return true;
	const normFolder = normalizePath(folderPath.trim()).toLowerCase();

	const rawParent =
		file.parent?.path ||
		(file.path ? file.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/") : "");
	const parentPath = normalizePath(rawParent).toLowerCase();

	return parentPath === normFolder;
}

/**
 * Determine whether a file qualifies as a Literature Note:
 * 1. Must be a Markdown file (.md).
 * 2. Must be located directly inside the configured literature notes folder (never in subdirectories).
 * 3. Must have `category: literaturenote` in frontmatter (when metadataCache is available).
 */
export function isLiteratureNote(
	app: App,
	file: TFile,
	litNotesFolder?: string
): boolean {
	// 1. Must be a Markdown file
	if (!isMarkdownFile(file)) {
		return false;
	}

	// 2. Must be directly in litNotesFolder (never in subdirectories like ai-searches)
	if (!isDirectChildOfFolder(file, litNotesFolder)) {
		return false;
	}

	// 3. Must have category: literaturenote in frontmatter (when metadataCache is available)
	if (app?.metadataCache?.getFileCache) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = (cache?.frontmatter || (file as any).frontmatter) as
			| Record<string, unknown>
			| undefined;
		if (!hasLiteratureNoteCategory(frontmatter)) {
			return false;
		}
	} else if ((file as any).frontmatter) {
		if (!hasLiteratureNoteCategory((file as any).frontmatter)) {
			return false;
		}
	}

	return true;
}

/**
 * Retrieve all valid literature notes directly in `litNotesFolder`, sorted by recency.
 */
export function getLitNoteFiles(app: App, litNotesFolder: string): TFile[] {
	if (!app?.vault?.getMarkdownFiles || typeof app.vault.getMarkdownFiles !== "function") {
		return [];
	}
	const files = app.vault.getMarkdownFiles();
	const filtered = files.filter((f) => isLiteratureNote(app, f, litNotesFolder));
	return filtered.sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
}

/**
 * Find an existing literature note TFile for a citekey:
 * 1. Checks direct path `litNotesFolder/citekey.md`.
 * 2. If not found by direct path, checks candidate lit notes in litNotesFolder
 *    for matching basename prefix or frontmatter citekey.
 */
export function findLitNoteFile(
	app: App,
	settings: { litNotesFolder: string },
	citekey: string
): TFile | null {
	if (!citekey || !app || !app.vault) return null;

	// 1. Check direct path: litNotesFolder/citekey.md
	const directPath = notePathFor(settings, citekey);
	const directFile = app.vault.getAbstractFileByPath(directPath);
	if (directFile instanceof TFile && isLiteratureNote(app, directFile, settings.litNotesFolder)) {
		return directFile;
	}

	// 2. Scan valid literature notes in litNotesFolder
	const files = getLitNoteFiles(app, settings.litNotesFolder);
	const targetStem = citekey.toLowerCase().trim();

	for (const file of files) {
		const stem = file.basename?.toLowerCase().trim() || "";
		if (
			stem === targetStem ||
			stem.startsWith(targetStem + " ") ||
			stem.startsWith(targetStem + "-")
		) {
			return file;
		}
		const fm = app.metadataCache?.getFileCache(file)?.frontmatter;
		if (fm?.citekey && String(fm.citekey).toLowerCase().trim() === targetStem) {
			return file;
		}
	}

	return null;
}

/**
 * Check whether a Literature Note exists for a given citekey.
 * Returns the matching Markdown file basename if found, or null if not found.
 */
export function findLitNoteForCitekey(
	app: App,
	citekey: string,
	litNotesFolder?: string
): string | null {
	if (!citekey || !app || !app.vault) return null;

	const targetStem = citekey.toLowerCase().trim();
	const files = getLitNoteFiles(app, litNotesFolder || "");

	for (const file of files) {
		const stem = file.basename?.toLowerCase().trim() || "";
		if (
			stem === targetStem ||
			stem.startsWith(targetStem + " ") ||
			stem.startsWith(targetStem + "-")
		) {
			return file.basename;
		}
		const fm = app.metadataCache?.getFileCache(file)?.frontmatter;
		if (fm?.citekey && String(fm.citekey).toLowerCase().trim() === targetStem) {
			return file.basename;
		}
	}

	return null;
}
