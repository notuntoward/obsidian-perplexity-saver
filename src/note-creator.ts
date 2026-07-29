import { App, TFile, normalizePath } from "obsidian";
import { detectAndParse } from "./parsers/detect";
import { buildNoteBody } from "./normalize/buildNote";
import { stripLeadingFrontmatterIfPresent, createDialogNote } from "./normalize/frontmatter";
import { HeadlineOptions } from "./normalize/headlines";
import { sanitizeFilename } from "./utils";

interface CreateNoteParams {
	app: App;
	activeFile: TFile;
	clipboardContent: string;
	filename: string;
	searchesFolder: string;
	generatedTag: string;
	collapseBlankLines: boolean;
	headlineOptions: HeadlineOptions;
}

interface CreateNoteSuccess {
	success: true;
	newFile: TFile;
	newNotePath: string;
	linkText: string;
}

interface CreateNoteError {
	success: false;
	error: string;
}

export type CreateNoteResult = CreateNoteSuccess | CreateNoteError;

/**
 * Backward-compat wrapper used by the inline-input widget. Runs the full
 * normalize pipeline: detect vendor, parse, build body, write note.
 * The body is written without any frontmatter text, then frontmatter is
 * added via processFrontMatter (the only safe way to coexist with other
 * frontmatter-writing plugins).
 */
export async function createPerplexityNote(
	params: CreateNoteParams
): Promise<CreateNoteResult> {
	const { app, activeFile, clipboardContent, filename, searchesFolder, generatedTag, collapseBlankLines, headlineOptions } = params;

	const sanitized = sanitizeFilename(filename);
	if (!sanitized) {
		return { success: false, error: "Filename is empty or contains only invalid characters." };
	}

	// Defensively strip any pre-existing frontmatter the clipboard carries.
	const { body: stripped, existingFrontmatter } = stripLeadingFrontmatterIfPresent(clipboardContent);
	const dialog = detectAndParse(stripped);
	const { body } = buildNoteBody(dialog, { collapseBlankLines, headlineOptions });

	const activeFolderPath = activeFile.parent ? activeFile.parent.path : "";
	const folderPath = normalizePath(
		activeFolderPath ? `${activeFolderPath}/${searchesFolder}` : searchesFolder
	);

	const folderExists = app.vault.getAbstractFileByPath(folderPath);
	if (!folderExists) {
		await app.vault.createFolder(folderPath);
	}

	const newNotePath = normalizePath(`${folderPath}/${sanitized}.md`);

	const existingFile = app.vault.getAbstractFileByPath(newNotePath);
	if (existingFile) {
		return { success: false, error: "A note with that name already exists. Pick a different name." };
	}

	const newFile = await createDialogNote(app, newNotePath, body, {
		"ai-dialog-format": "v1",
		"ai-source-vendor": dialog.sourceVendor,
		"ai-source-url": dialog.sourceUrl,
		tags: [generatedTag],
		...(existingFrontmatter ?? {}),
	});

	await navigator.clipboard.writeText("");

	const linkText = app.fileManager.generateMarkdownLink(newFile, activeFile.path);

	return { success: true, newFile, newNotePath, linkText };
}
