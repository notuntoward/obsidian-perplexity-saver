import { App, Editor, MarkdownView, Notice, TFile } from "obsidian";
import { detectAndParse } from "../parsers/detect";
import { buildNoteBody, extractSourcesSection } from "../normalize/buildNote";
import { stripLeadingFrontmatterIfPresent } from "../normalize/frontmatter";
import { getNextTurnIndex } from "../normalize/turns";
import { HeadlineOptions } from "../normalize/headlines";

export interface AppendDialogResult {
	success: boolean;
	turnsAppended?: number;
	newSources?: number;
	error?: string;
}

/**
 * Append new turns to the active note. The note is read, the clipboard is
 * parsed, the new turns are rendered with turn IDs starting after the
 * highest existing one, and the note's # Sources block is wholesale
 * regenerated from (existing sources + new citations) rather than only
 * tail-appended to. Regeneration is required, not optional: if an appended
 * turn re-cites a URL already in # Sources, that existing entry's
 * ownership list must gain the new turn's ID in place, and a pure
 * tail-append could never do that (see buildNoteBody's turnIds semantics).
 */
export async function appendDialogFromClipboard(
	app: App,
	file: TFile,
	headlineOptions: HeadlineOptions
): Promise<AppendDialogResult> {
	const clipboard = await navigator.clipboard.readText();
	if (!clipboard) {
		return { success: false, error: "Clipboard is empty. Copy an AI dialog first." };
	}

	const existingText = await app.vault.read(file);
	const startId = getNextTurnIndex(existingText);
	if (startId === 1) {
		// No existing turns detected - this is not a normalized dialog note.
		// Bail out rather than corrupt the file.
		return {
			success: false,
			error:
				"This note has no ^turn-N-* anchors. Use 'Import AI dialog from clipboard' on a new note instead.",
		};
	}

	const { body: stripped } = stripLeadingFrontmatterIfPresent(clipboard);
	const dialog = detectAndParse(stripped);
	if (dialog.turns.length === 0) {
		return { success: false, error: "Clipboard did not contain any recognizable turns." };
	}

	const existingSources = extractSourcesSection(existingText);
	const existingSourceCount = countSourceLines(existingSources);

	const { body: newBody, sourceLines: allSourceLines } = buildNoteBody(dialog, {
		startTurnId: startId,
		existingSourceText: existingSources,
		headlineOptions,
	});

	// newBody contains only the newly parsed clipboard's turns (plus its own
	// # Dialog/# Sources scaffolding), so everything from the first new turn
	// heading up to # Sources/end-of-string is new content to splice in.
	const newTurnsChunk = extractTurnsBlock(newBody, startId);
	const updated = spliceIntoNote(existingText, newTurnsChunk, allSourceLines);

	await app.vault.modify(file, updated);
	return {
		success: true,
		turnsAppended: dialog.turns.length,
		newSources: Math.max(0, allSourceLines.length - existingSourceCount),
	};
}

function countSourceLines(sourcesText: string): number {
	return sourcesText.split("\n").filter((line) => /^\[\^s\d+\]:/.test(line)).length;
}

/**
 * Pull out the rendered turn blocks starting at turn `startId` from a
 * freshly rendered body. The body is produced from parsing ONLY the new
 * clipboard content, so it contains nothing but the new turns (and
 * optionally their sources); the chunk to splice in is everything from the
 * first new turn heading up to the `# Sources` heading, or end of string
 * if there were no citations.
 */
function extractTurnsBlock(body: string, startId: number): string {
	const startRe = new RegExp(`^## .*?\\^turn-${startId}-(?:prompt|ai)$`, "m");
	const startMatch = body.match(startRe);
	if (!startMatch || startMatch.index === undefined) return "";

	const sourcesIndex = body.indexOf("\n# Sources\n", startMatch.index);
	const endIndex = sourcesIndex >= 0 ? sourcesIndex : body.length;

	return body.slice(startMatch.index, endIndex).trimEnd();
}

/**
 * Splice the new turns chunk into the existing note just before the
 * `# Sources` heading, replacing the ENTIRE existing sources block with
 * `allSourceLines` (the full, regenerated list from buildNoteBody covering
 * every existing source plus every new one). If the note has no # Sources
 * section, the new turns are appended to the end of the file (and a new
 * # Sources block is added only if there are actually any sources at all).
 */
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
	// No # Sources block: append the new turns at the end of the file.
	let out = existingText;
	if (!out.endsWith("\n")) out += "\n";
	out += "\n" + newTurnsChunk;
	if (allSourceLines.length > 0) {
		out += "\n# Sources\n\n" + sourcesBlock;
	}
	return out;
}

export function registerAppendCommand(
	plugin: {
		app: App;
		addCommand: (cmd: unknown) => unknown;
		headlineOptions: () => HeadlineOptions;
	}
): void {
	plugin.addCommand({
		id: "append-ai-dialog-to-active-note",
		name: "Append AI dialog from clipboard to this note",
		editorCallback: async (_editor: Editor, view: MarkdownView) => {
			const file = view.file;
			if (!file) {
				new Notice("No active file.");
				return;
			}
			const result = await appendDialogFromClipboard(plugin.app, file, plugin.headlineOptions());
			if (!result.success) {
				new Notice(result.error ?? "Append failed.");
				return;
			}
			new Notice(
				`Appended ${result.turnsAppended} turn(s)${result.newSources ? ` and ${result.newSources} new source(s)` : ""}.`
			);
		},
	});
}
