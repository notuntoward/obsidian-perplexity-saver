import { App, Editor, MarkdownView, Notice, normalizePath, TFile } from "obsidian";
import { detectAndParse } from "../parsers/detect";
import { buildNoteBody } from "../normalize/buildNote";
import { stripLeadingFrontmatterIfPresent, createDialogNote } from "../normalize/frontmatter";
import { HeadlineOptions } from "../normalize/headlines";
import { sanitizeFilename } from "../utils";
import { groupLogicalTurns } from "../normalize/turns";

export interface ImportDialogParams {
	app: App;
	clipboardContent: string;
	importFolder: string;
	generatedTag: string;
	collapseBlankLines: boolean;
	headlineOptions: HeadlineOptions;
}

export interface ImportDialogResult {
	success: boolean;
	file?: TFile;
	error?: string;
}

/**
 * Pure-ish import path: parse the clipboard, build a normalized body,
 * write the file. Does NOT prompt the user (the calling command in
 * main.ts owns the inline-textbox UX and calls this after a filename
 * has been chosen).
 */
export async function importDialogFromClipboard(
	params: ImportDialogParams & { filename: string }
): Promise<ImportDialogResult> {
	const { app, clipboardContent, filename, importFolder, generatedTag, collapseBlankLines, headlineOptions } = params;

	const sanitized = sanitizeFilename(filename);
	if (!sanitized) {
		return { success: false, error: "Filename is empty or contains only invalid characters." };
	}

	// Defensively strip any pre-existing frontmatter the clipboard might carry.
	const { body: stripped, existingFrontmatter } = stripLeadingFrontmatterIfPresent(clipboardContent);

	const dialog = detectAndParse(stripped);
	const { body } = buildNoteBody(dialog, { collapseBlankLines, headlineOptions });

	const folderPath = normalizePath(importFolder);
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!folder) {
		await app.vault.createFolder(folderPath);
	}

	const newNotePath = normalizePath(`${folderPath}/${sanitized}.md`);

	if (app.vault.getAbstractFileByPath(newNotePath)) {
		return { success: false, error: "A note with that name already exists. Pick a different name." };
	}

	const file = await createDialogNote(app, newNotePath, body, {
		"ai-dialog-format": "v1",
		"ai-source-vendor": dialog.sourceVendor,
		"ai-source-url": dialog.sourceUrl,
		"ai-source-turns-synced": groupLogicalTurns(dialog.turns).length,
		tags: [generatedTag],
		...(existingFrontmatter ?? {}),
	});

	return { success: true, file };
}

/**
 * Suggest a filename derived from the first prompt of the parsed dialog.
 * Plain truncation, not an AI summary.
 */
export function suggestFilenameFromClipboard(
	clipboardContent: string,
	fallback: string
): string {
	const { body } = stripLeadingFrontmatterIfPresent(clipboardContent);
	const dialog = detectAndParse(body);
	const firstPrompt = dialog.turns.find((t) => t.role === "prompt")?.rawText ?? "";
	if (!firstPrompt.trim()) return fallback;
	const words = firstPrompt.split(/\s+/).slice(0, 8).join(" ");
	return words.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim() || fallback;
}

/**
 * Wire the "Import AI dialog from clipboard" command. The command:
 *   1. Reads clipboard text.
 *   2. If the active editor has a selection, that becomes the default filename
 *      (matching the existing inline-textbox UX); otherwise it's derived
 *      from the first prompt.
 *   3. Opens an inline textbox in the active note (via the same widget
 *      mechanism as the original plugin).
 *   4. On Enter, runs the full import pipeline and inserts a wikilink
 *      to the new note in place of the textbox.
 */
export function registerImportCommand(
	plugin: {
		app: App;
		addCommand: (cmd: unknown) => unknown;
		settings: {
			searchesFolder: string;
			generatedTag: string;
			collapseBlankLines: boolean;
			headlineOptions: HeadlineOptions;
		};
	},
	startInlineImportInput: (params: ImportInlineInputData) => void
): void {
	plugin.addCommand({
		id: "import-ai-dialog-from-clipboard",
		name: "Import AI dialog from clipboard",
		editorCallback: async (editor: Editor, view: MarkdownView) => {
			const activeFile = view.file;
			if (!activeFile) {
				new Notice("No active file.");
				return;
			}
			const clipboard = await navigator.clipboard.readText();
			if (!clipboard) {
				new Notice("Clipboard is empty. Copy an AI dialog first.");
				return;
			}

		const selection = editor.getSelection();
		const defaultFilename = selection
			? selection
			: suggestFilenameFromClipboard(clipboard, "AI Dialog");

		const from = editor.getCursor("from");
		const pos = editor.posToOffset(from);
		startInlineImportInput({
			pos,
			noteContent: clipboard,
			defaultFilename,
			activeFile,
		});
		},
	});
}

export interface ImportInlineInputData {
	pos: number;
	noteContent: string;
	defaultFilename: string;
	activeFile: TFile;
}
