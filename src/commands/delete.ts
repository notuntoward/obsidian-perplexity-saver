import { App, Editor, MarkdownView, Notice, SuggestModal, TFile, prepareFuzzySearch, renderResults } from "obsidian";
import { findSourcesWithNoDialog, applyNoDialogRemoval } from "./removeNoDialog";

export interface TurnSuggestion {
	turnNum: number;
	headingText: string;
	displayText: string;
}

export function getTurnsFromNote(noteText: string): TurnSuggestion[] {
	const suggestions: TurnSuggestion[] = [];
	const lines = noteText.split("\n");
	for (const line of lines) {
		const match = line.match(/^## (.*?)\s*\^turn-(\d+)/);
		if (match) {
			const headingText = match[1].trim();
			const turnNum = parseInt(match[2], 10);
			suggestions.push({
				turnNum,
				headingText,
				displayText: `Turn ${turnNum}: ${headingText}`,
			});
		}
	}
	return suggestions;
}

export async function highlightDialogTurn(
	app: App,
	editor: Editor,
	file: TFile,
	turnNum: number
): Promise<void> {
	const noteText = await app.vault.read(file);
	const escapedId = `\\^turn-${turnNum}(?!\\d)`;
	const startRe = new RegExp(`^## .*${escapedId}`, "m");
	const startMatch = noteText.match(startRe);
	if (!startMatch || startMatch.index === undefined) return;

	const startIndex = startMatch.index;
	const searchString = noteText.slice(startIndex + startMatch[0].length);
	const nextHeadingRe = /^(## |# Sources)/m;
	const endMatch = searchString.match(nextHeadingRe);
	const endIndex = endMatch
		? startIndex + startMatch[0].length + endMatch.index!
		: noteText.length;

	const fromPos = editor.offsetToPos(startIndex);
	const toPos = editor.offsetToPos(endIndex);

	editor.setSelection(fromPos, toPos);
	editor.scrollIntoView({ from: fromPos, to: toPos }, true);
}

export class DeleteTurnSuggestModal extends SuggestModal<TurnSuggestion> {
	private items: TurnSuggestion[] = [];

	constructor(
		app: App,
		private editor: Editor,
		private file: TFile,
		private onDelete: (turnNum: number) => Promise<void>
	) {
		super(app);
		this.setPlaceholder("Search turns by number or heading text...");
	}

	async onOpen(): Promise<void> {
		const noteText = await this.app.vault.read(this.file);
		this.items = getTurnsFromNote(noteText);
		super.onOpen();
	}

	getSuggestions(query: string): TurnSuggestion[] {
		if (!query.trim()) {
			return this.items;
		}

		const search = prepareFuzzySearch(query);
		const matched: { item: TurnSuggestion; score: number }[] = [];

		for (const item of this.items) {
			const match = search(item.displayText);
			if (match) {
				matched.push({ item, score: match.score });
			}
		}

		return matched.sort((a, b) => a.score - b.score).map((m) => m.item);
	}

	renderSuggestion(item: TurnSuggestion, el: HTMLElement): void {
		const query = this.inputEl.value.trim();
		if (!query) {
			el.setText(item.displayText);
			return;
		}

		const search = prepareFuzzySearch(query);
		const match = search(item.displayText);
		if (match) {
			renderResults(el, item.displayText, match);
		} else {
			el.setText(item.displayText);
		}
	}

	async onChooseSuggestion(item: TurnSuggestion, evt: MouseEvent | KeyboardEvent): Promise<void> {
		await highlightDialogTurn(this.app, this.editor, this.file, item.turnNum);
		await this.onDelete(item.turnNum);
	}
}

export async function deleteDialogTurn(
	app: App,
	file: TFile,
	turnNum: number
): Promise<{ success: boolean; error?: string; removedCount?: number }> {
	const noteText = await app.vault.read(file);

	// 1. Locate the block
	const escapedId = `\\^turn-${turnNum}(?!\\d)`;
	const startRe = new RegExp(`^## .*${escapedId}`, "m");
	const startMatch = noteText.match(startRe);
	if (!startMatch || startMatch.index === undefined) {
		return { success: false, error: `Could not find turn ${turnNum} in this note.` };
	}

	const startIndex = startMatch.index;
	const searchString = noteText.slice(startIndex + startMatch[0].length);
	const nextHeadingRe = /^(## |# Sources)/m;
	const endMatch = searchString.match(nextHeadingRe);
	const endIndex = endMatch
		? startIndex + startMatch[0].length + endMatch.index!
		: noteText.length;

	// 2. Delete that block
	const updatedBody = noteText.slice(0, startIndex) + noteText.slice(endIndex);

	// Clean up consecutive blank lines
	const cleanedBody = updatedBody.replace(/\n{3,}/g, "\n\n");

	// 3. Scoped Remove
	const allNoDialog = findSourcesWithNoDialog(cleanedBody);
	const prefix = `${turnNum}_`;
	const scopedNoDialog = allNoDialog.filter((src) => src.id.startsWith(prefix));

	// Apply removal of sources with no dialog
	const finalNoteText = applyNoDialogRemoval(cleanedBody, scopedNoDialog);

	// 4. Save to vault
	await app.vault.modify(file, finalNoteText);

	const fullyRemoved = scopedNoDialog.filter((s) => s.survivingTurnIds.length === 0).length;

	return { success: true, removedCount: fullyRemoved };
}

export function registerDeleteTurnCommand(
	plugin: { addCommand: (cmd: unknown) => unknown; app: App }
): void {
	plugin.addCommand({
		id: "delete-ai-dialog-turn",
		name: "Delete AI dialog turn",
		editorCallback: async (editor: Editor, view: MarkdownView) => {
			const file = view.file;
			if (!file) {
				new Notice("No active file.");
				return;
			}

			new DeleteTurnSuggestModal(plugin.app, editor, file, async (turnNum) => {
				const result = await deleteDialogTurn(plugin.app, file, turnNum);
				if (!result.success) {
					new Notice(result.error ?? "Deletion failed.");
					return;
				}
				new Notice(
					`Deleted turn ${turnNum}.${result.removedCount ? ` Removed ${result.removedCount} source(s) with no dialog.` : ""}`
				);
			}).open();
		},
	});
}
