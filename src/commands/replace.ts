import { App, Editor, MarkdownView, Notice, TFile } from "obsidian";
import { detectAndParse } from "../parsers/detect";
import { buildNoteBody } from "../normalize/buildNote";
import { overwriteDialogNote, stripLeadingFrontmatterIfPresent } from "../normalize/frontmatter";
import { deduplicateDialogCitations, groupLogicalTurns } from "../normalize/turns";
import { HeadlineOptions } from "../normalize/headlines";
import { resolveSourceTitles } from "../scraper";
import { maybeAutoRelinkSources } from "../zotero/autoRelink";
import { resolveLinkAtCursor, isAiDialogNote } from "../utils";

export interface ReplaceDialogResult {
	success: boolean;
	turnsReplaced?: number;
	error?: string;
}

export interface ReplaceDialogOptions {
	autoRelinkSources?: boolean;
	zoteroPort?: number;
	litNotesFolder?: string;
	minTitleMatchScore?: number;
	zoteroClient?: any;
	onProgress?: (message: string) => void;
	collapseBlankLines?: boolean;
	collapsePromptCallouts?: boolean;
	generatedTag?: string;
}

/**
 * Replaces (overwrites) the AI dialog note with fresh content parsed from the clipboard.
 * Preserves pre-existing frontmatter properties on the target file where applicable,
 * while resetting/updating `ai-source-turns-synced`, `ai-source-vendor`, and `ai-source-url`.
 */
export async function replaceDialogFromClipboard(
	app: App,
	file: TFile,
	headlineOptions: HeadlineOptions,
	autoFetchSourceTitles: boolean = true,
	sourceTitleMaxChars: number = 100,
	options?: ReplaceDialogOptions
): Promise<ReplaceDialogResult> {
	const clipboard = await navigator.clipboard.readText();
	if (!clipboard) {
		return { success: false, error: "Clipboard is empty. Copy an AI dialog first." };
	}

	const { body: stripped, existingFrontmatter: clipboardFrontmatter } =
		stripLeadingFrontmatterIfPresent(clipboard);
	const dialog = detectAndParse(stripped);
	if (dialog.turns.length === 0) {
		return { success: false, error: "Clipboard did not contain any recognizable turns." };
	}

	deduplicateDialogCitations(dialog);

	if (autoFetchSourceTitles) {
		await resolveSourceTitles(dialog, {
			autoFetchSourceTitles,
			sourceTitleMaxChars,
		});
	}

	const { body: newBody } = buildNoteBody(dialog, {
		collapseBlankLines: options?.collapseBlankLines,
		collapsePromptCallouts: options?.collapsePromptCallouts,
		headlineOptions,
	});

	let finalBody = newBody;
	if (options?.autoRelinkSources) {
		finalBody = await maybeAutoRelinkSources(
			app,
			finalBody,
			{
				autoRelinkSources: options.autoRelinkSources,
				zoteroPort: options.zoteroPort ?? 23119,
				litNotesFolder: options.litNotesFolder ?? "",
				minTitleMatchScore: options.minTitleMatchScore ?? 95,
			},
			options.zoteroClient,
			options.onProgress
		);
	}

	const cache = app.metadataCache.getFileCache(file);
	const existingFrontmatter: Record<string, unknown> = cache?.frontmatter
		? { ...cache.frontmatter }
		: {};
	delete (existingFrontmatter as Record<string, unknown>).position;

	const logicalTurnCount = groupLogicalTurns(dialog.turns).length;
	const frontmatterFields: Record<string, unknown> = {
		"ai-dialog-format": "v1",
		"ai-source-vendor": dialog.sourceVendor,
		"ai-source-url": dialog.sourceUrl,
		"ai-source-turns-synced": logicalTurnCount,
		...existingFrontmatter,
		...(clipboardFrontmatter ?? {}),
	};

	if (options?.generatedTag && !frontmatterFields.tags) {
		frontmatterFields.tags = [options.generatedTag];
	}

	await overwriteDialogNote(app, file, finalBody, frontmatterFields);

	return {
		success: true,
		turnsReplaced: logicalTurnCount,
	};
}

/**
 * Registers "Replace linked AI dialog from clipboard".
 *
 * Resolves the wikilink/embed under the cursor in the active file and replaces
 * (overwrites) THAT target file with the parsed dialog from the clipboard.
 */
export function registerReplaceViaLinkCommand(
	plugin: {
		app: App;
		addCommand: (cmd: unknown) => unknown;
		headlineOptions: () => HeadlineOptions;
		settings: {
			autoFetchSourceTitles: boolean;
			sourceTitleMaxChars: number;
			autoRelinkSources: boolean;
			zoteroPort: number;
			litNotesFolder: string;
			minTitleMatchScore: number;
			collapseBlankLines: boolean;
			collapsePromptCallouts: boolean;
			generatedTag: string;
		};
		zoteroClient?: any;
	}
): void {
	plugin.addCommand({
		id: "replace-linked-ai-dialog-from-clipboard",
		name: "Replace linked AI dialog from clipboard",
		editorCallback: async (editor: Editor, view: MarkdownView) => {
			const sourceFile = view.file;
			if (!sourceFile) {
				new Notice("No active file.");
				return;
			}

			const noteText = editor.getValue();
			if (isAiDialogNote(noteText)) {
				new Notice("This command cannot be run inside an AI dialog note.");
				return;
			}

			const target = resolveLinkAtCursor(plugin.app, sourceFile, editor);
			if (!target) {
				new Notice("Place the cursor on a link to an AI dialog note, then run this command.");
				return;
			}

			const progressNotice = plugin.settings.autoRelinkSources
				? new Notice("Replacing...", 0)
				: undefined;

			try {
				const result = await replaceDialogFromClipboard(
					plugin.app,
					target,
					plugin.headlineOptions(),
					plugin.settings.autoFetchSourceTitles,
					plugin.settings.sourceTitleMaxChars,
					{
						autoRelinkSources: plugin.settings.autoRelinkSources,
						zoteroPort: plugin.settings.zoteroPort,
						litNotesFolder: plugin.settings.litNotesFolder,
						minTitleMatchScore: plugin.settings.minTitleMatchScore,
						zoteroClient: plugin.zoteroClient,
						onProgress: (msg: string) => progressNotice?.setMessage(msg),
						collapseBlankLines: plugin.settings.collapseBlankLines,
						collapsePromptCallouts: plugin.settings.collapsePromptCallouts,
						generatedTag: plugin.settings.generatedTag,
					}
				);

				if (!result.success) {
					new Notice(result.error ?? "Replace failed.");
					return;
				}

				new Notice(
					`Replaced AI dialog in ${target.basename} (${result.turnsReplaced} turn(s)).`
				);
			} finally {
				progressNotice?.hide();
			}
		},
	});
}
