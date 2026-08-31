import { App, Editor, Notice, TFile } from "obsidian";
import { parseSourceLine, ParsedSourceLine } from "../zotero/sourceLinkState";
import { extractSourcesSection } from "../normalize/buildNote";
import { isAiDialogNote } from "../utils";

export interface SourceWithNoCite extends ParsedSourceLine {
	rawLine: string;
}

/**
 * Split the note text into blocks for each turn under the # Dialog section.
 */
export function getTurnBlocks(noteText: string): string[] {
	const lines = noteText.split("\n");
	const turnHeadingIndices: number[] = [];
	let sourcesHeadingIndex = lines.length;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("## ") && line.includes("^turn-")) {
			turnHeadingIndices.push(i);
		} else if (line.trim() === "# Sources") {
			sourcesHeadingIndex = i;
		}
	}

	const blocks: string[] = [];
	for (let i = 0; i < turnHeadingIndices.length; i++) {
		const start = turnHeadingIndices[i];
		const end = i + 1 < turnHeadingIndices.length ? turnHeadingIndices[i + 1] : sourcesHeadingIndex;
		blocks.push(lines.slice(start, end).join("\n"));
	}
	return blocks;
}

/**
 * Extract only the AI response portion of a turn block, ignoring the heading
 * and prompt callout block.
 */
export function extractAiResponseFromTurnBlock(blockText: string): string {
	const lines = blockText.split("\n");
	if (lines.length <= 1) return "";

	// Skip the first line which is the heading (e.g. ## ... ^turn-N)
	const contentLines = lines.slice(1);

	// Find the line containing the prompt callout start
	const promptStartIndex = contentLines.findIndex((line) => line.includes("> [!Prompt]"));
	if (promptStartIndex === -1) {
		// If there is no prompt callout, everything else is the AI response
		return contentLines.join("\n");
	}

	// From the prompt callout start, find the first line that is not part of the callout
	let promptEndIndex = promptStartIndex + 1;
	while (promptEndIndex < contentLines.length) {
		const line = contentLines[promptEndIndex];
		if (!line.trim().startsWith(">")) {
			break;
		}
		promptEndIndex++;
	}

	// All lines following the callout are the AI response
	return contentLines.slice(promptEndIndex).join("\n");
}

/**
 * Find all sources in `# Sources` that are not cited in the AI response part
 * of any dialog turn in the note.
 */
export function findSourcesWithNoCite(noteText: string): SourceWithNoCite[] {
	const turnBlocks = getTurnBlocks(noteText);
	const aiResponses = turnBlocks.map(extractAiResponseFromTurnBlock);

	const sourcesText = extractSourcesSection(noteText);
	const out: SourceWithNoCite[] = [];

	for (const line of sourcesText.split("\n")) {
		const parsed = parseSourceLine(line);
		if (!parsed) continue;

		// A footnote citation in the text is written exactly as `[^id]`
		const searchStr = `[^${parsed.id}]`;
		const isCited = aiResponses.some((response) => response.includes(searchStr));

		if (!isCited) {
			out.push({ ...parsed, rawLine: line });
		}
	}
	return out;
}

/**
 * Remove the lines corresponding to sources with no cite and clean up blank lines.
 */
export function applyRemoveSourcesWithNoCite(noteText: string, toRemove: SourceWithNoCite[]): string {
	if (toRemove.length === 0) return noteText;
	const linesToRemove = new Set(toRemove.map((s) => s.rawLine));
	const updated = noteText
		.split("\n")
		.filter((line) => !linesToRemove.has(line))
		.join("\n");
	return updated.replace(/\n{3,}/g, "\n\n");
}

/**
 * Register the "Remove sources with no cite" command on the plugin.
 */
export function registerRemoveSourcesWithNoCiteCommand(
	plugin: { addCommand: (cmd: unknown) => unknown; app: App }
): void {
	plugin.addCommand({
		id: "remove-sources-with-no-cite",
		name: "Remove sources with no cite",
		editorCallback: async (editor: Editor, view: { file?: TFile }) => {
			const file = view.file;
			if (!file) {
				new Notice("No active file.");
				return;
			}
			const noteText = editor.getValue() || (await plugin.app.vault.read(file));
			if (!isAiDialogNote(noteText)) {
				new Notice("This command can only be run within an AI dialog note.");
				return;
			}
			const toRemove = findSourcesWithNoCite(noteText);
			if (toRemove.length === 0) {
				new Notice("No sources with no cite found.");
				return;
			}
			const updated = applyRemoveSourcesWithNoCite(noteText, toRemove);
			await plugin.app.vault.modify(file, updated);
			new Notice(`Removed ${toRemove.length} source(s) with no cite.`);
		},
	});
}
