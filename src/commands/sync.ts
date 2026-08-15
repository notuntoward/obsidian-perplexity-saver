import { App, Editor, MarkdownView, Notice, TFile } from "obsidian";
import { detectAndParse } from "../parsers/detect";
import { buildNoteBody, extractSourcesSection } from "../normalize/buildNote";
import { stripLeadingFrontmatterIfPresent, updateFrontMatter } from "../normalize/frontmatter";
import { getNextTurnIndex, groupLogicalTurns, deduplicateDialogCitations } from "../normalize/turns";
import { HeadlineOptions } from "../normalize/headlines";
import { DialogFile } from "../parsers/types";
import { resolveSourceTitles } from "../scraper";
import { maybeAutoRelinkSources } from "../zotero/autoRelink";

export interface SyncDialogResult {
	success: boolean;
	turnsSynced?: number;
	newSources?: number;
	nothingNew?: boolean;
	error?: string;
}

export type AppendDialogResult = SyncDialogResult;

export interface SyncDialogOptions {
	autoRelinkSources?: boolean;
	zoteroPort?: number;
	litNotesFolder?: string;
	minTitleMatchScore?: number;
	zoteroClient?: any;
	onProgress?: (message: string) => void;
	collapseBlankLines?: boolean;
	collapsePromptCallouts?: boolean;
}

/**
 * Sync (or append) new turns to the active note. Decouples the number of
 * conversation turns previously synced using a frontmatter field
 * "ai-source-turns-synced", slices the incoming clipboard logical turns,
 * and appends any newly found turns under new monotonic local anchors.
 */
export async function syncDialogFromClipboard(
	app: App,
	file: TFile,
	headlineOptions: HeadlineOptions,
	autoFetchSourceTitles: boolean = true,
	sourceTitleMaxChars: number = 100,
	options?: SyncDialogOptions
): Promise<SyncDialogResult> {
	const clipboard = await navigator.clipboard.readText();
	if (!clipboard) {
		return { success: false, error: "Clipboard is empty. Copy an AI dialog first." };
	}

	const existingText = await app.vault.read(file);
	const nextLocalTurnNumber = getNextTurnIndex(existingText);
	if (nextLocalTurnNumber === 1) {
		// No existing turns detected - this is not a normalized dialog note.
		// Bail out rather than corrupt the file.
		return {
			success: false,
			error:
				"This note has no ^turn-N-* anchors. Use 'Import AI dialog from clipboard' on a new note instead.",
		};
	}

	const cache = app.metadataCache.getFileCache(file);
	const frontmatter = cache?.frontmatter;
	let syncedCount = frontmatter ? frontmatter["ai-source-turns-synced"] : undefined;

	if (syncedCount === undefined) {
		// Fallback for legacy notes lacking the watermark field:
		// count how many turns have been synced so far by using the highest surviving anchor minus 1.
		syncedCount = Math.max(0, nextLocalTurnNumber - 1);
	}

	const { body: stripped } = stripLeadingFrontmatterIfPresent(clipboard);
	const dialog = detectAndParse(stripped);
	if (dialog.turns.length === 0) {
		return { success: false, error: "Clipboard did not contain any recognizable turns." };
	}

	deduplicateDialogCitations(dialog);

	const clipboardLogicalTurns = groupLogicalTurns(dialog.turns);
	const newLogicalTurns = clipboardLogicalTurns.slice(syncedCount);

	if (newLogicalTurns.length === 0) {
		return { success: true, turnsSynced: 0, newSources: 0, nothingNew: true };
	}

	const flatNewTurns = newLogicalTurns.flatMap((lt) => lt.turns);
	const newDialog: DialogFile = {
		...dialog,
		turns: flatNewTurns,
	};

	const existingSources = extractSourcesSection(existingText);
	const existingSourceCount = countSourceLines(existingSources);

	// Resolve titles for new sources, reusing existing ones if possible
	if (autoFetchSourceTitles) {
		await resolveSourceTitles(newDialog, {
			existingSourceText: existingSources,
			autoFetchSourceTitles,
			sourceTitleMaxChars,
		});
	}

	const { body: newBody, sourceLines: allSourceLines } = buildNoteBody(newDialog, {
		startTurnId: nextLocalTurnNumber,
		existingSourceText: existingSources,
		headlineOptions,
		collapseBlankLines: options?.collapseBlankLines,
		collapsePromptCallouts: options?.collapsePromptCallouts,
	});

	const newTurnsChunk = extractTurnsBlock(newBody, nextLocalTurnNumber);
	let updated = spliceIntoNote(existingText, newTurnsChunk, allSourceLines);

	if (options?.autoRelinkSources) {
		updated = await maybeAutoRelinkSources(
			app,
			updated,
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

	await app.vault.modify(file, updated);

	await updateFrontMatter(app, file, {
		"ai-source-turns-synced": syncedCount + newLogicalTurns.length,
	});

	return {
		success: true,
		turnsSynced: newLogicalTurns.length,
		newSources: Math.max(0, allSourceLines.length - existingSourceCount),
	};
}

// Keep a compatibility alias for any existing code or tests
export const appendDialogFromClipboard = syncDialogFromClipboard;

function countSourceLines(sourcesText: string): number {
	return sourcesText.split("\n").filter((line) => /^\[\^/.test(line)).length;
}

function extractTurnsBlock(body: string, startId: number): string {
	const startRe = new RegExp(`^## .*\\^turn-${startId}(?!\\d)`, "m");
	const startMatch = body.match(startRe);
	if (!startMatch || startMatch.index === undefined) return "";

	const sourcesIndex = body.indexOf("\n# Sources\n", startMatch.index);
	const endIndex = sourcesIndex >= 0 ? sourcesIndex : body.length;

	return body.slice(startMatch.index, endIndex).trimEnd();
}

function spliceIntoNote(
	existingText: string,
	newTurnsChunk: string,
	allSourceLines: string[]
): string {
	const sourcesBlock = allSourceLines.length > 0 ? allSourceLines.join("\n") + "\n" : "";
	const sourcesMatch = existingText.match(/(# Sources\s*\n)([\s\S]*)$/);
	if (sourcesMatch) {
		const header = sourcesMatch[1];
		const before = existingText.slice(0, sourcesMatch.index!);
		return `${before}${newTurnsChunk}\n${header}${sourcesBlock}`;
	}
	let out = existingText;
	if (!out.endsWith("\n")) out += "\n";
	out += "\n" + newTurnsChunk;
	if (allSourceLines.length > 0) {
		out += "\n# Sources\n\n" + sourcesBlock;
	}
	return out;
}

export function registerSyncCommand(
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
		};
		zoteroClient?: any;
	}
): void {
	plugin.addCommand({
		id: "sync-ai-dialog-from-clipboard",
		name: "Sync AI dialog from clipboard",
		editorCallback: async (_editor: Editor, view: MarkdownView) => {
			const file = view.file;
			if (!file) {
				new Notice("No active file.");
				return;
			}

			// Only show a persistent progress notice when auto-relinking is
			// enabled, since that's the step that can take noticeably long
			// (a Zotero library-version check every call, and a full fetch
			// on a cold cache). Without this, the Zotero status messages
			// ZoteroClient already reports internally were previously
			// dropped on the floor for this command, leaving the user with
			// no feedback while sync silently waited on Zotero.
			const progressNotice = plugin.settings.autoRelinkSources
				? new Notice("Syncing...", 0)
				: undefined;

			try {
				const result = await syncDialogFromClipboard(
					plugin.app,
					file,
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
					}
				);
				if (!result.success) {
					new Notice(result.error ?? "Sync failed.");
					return;
				}
				if (result.nothingNew) {
					new Notice("Nothing new to sync.");
					return;
				}
				new Notice(
					`Synced ${result.turnsSynced} turn(s)${result.newSources ? ` and ${result.newSources} new source(s)` : ""}.`
				);
			} finally {
				progressNotice?.hide();
			}
		},
	});
}

// Also export registerAppendCommand as an alias to registerSyncCommand for compatibility
export const registerAppendCommand = registerSyncCommand;
