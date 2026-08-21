import { App, Editor, FuzzyMatch, FuzzySuggestModal, MarkdownView } from "obsidian";

export interface TurnItem {
	headingText: string;
	turnId: string;
	headingLine: number;
	aiResponseLine: number;
	isCurrent: boolean;
}

export function parseJumpItems(
	lineCount: number,
	getLine: (i: number) => string,
	cursorLine: number
): { items: TurnItem[]; currentTurnIndex: number } {
	const items: TurnItem[] = [];
	let currentTurnIndex = -1;

	// Pass 1: Find all headings
	for (let i = 0; i < lineCount; i++) {
		const line = getLine(i);
		const match = line.match(/^##\s+(.*?)\s+\^turn-(\d+)$/);
		if (match) {
			items.push({
				headingText: match[1],
				turnId: match[2],
				headingLine: i,
				aiResponseLine: i, // To be resolved in Pass 2
				isCurrent: false,
			});
		}
	}

	if (items.length === 0) {
		return { items, currentTurnIndex };
	}

	// Pass 2: Resolve AI response lines and find current turn
	for (let idx = 0; idx < items.length; idx++) {
		const item = items[idx];
		let aiStartLine = item.headingLine + 1;

		// Scan down past the heading and the callout block to find the actual response
		for (let j = item.headingLine + 1; j < lineCount; j++) {
			const l = getLine(j);
			// If the line starts with '>' (callout) or is completely blank/whitespace, it's not the response yet.
			if (!l.trim().startsWith(">") && l.trim().length > 0) {
				aiStartLine = j;
				break;
			}
		}
		item.aiResponseLine = aiStartLine;

		// Determine if this is the "current" turn (the closest one above the cursor)
		if (item.headingLine <= cursorLine) {
			currentTurnIndex = idx;
		}
	}

	if (currentTurnIndex !== -1) {
		items[currentTurnIndex].isCurrent = true;
	}

	return { items, currentTurnIndex };
}

class TurnJumpModal extends FuzzySuggestModal<TurnItem> {
	private items: TurnItem[];
	private initialSelectionIdx: number;

	constructor(app: App, items: TurnItem[], initialSelectionIdx: number) {
		super(app);
		this.items = items;
		this.initialSelectionIdx = initialSelectionIdx;
		this.setPlaceholder("Jump to a turn...");
	}

	onOpen() {
		super.onOpen();
		// SuggestModal's UI renders synchronously initially or right after open.
		// Wait a tick for the DOM and chooser items to populate before setting selection.
		window.setTimeout(() => {
			if (this.initialSelectionIdx >= 0 && this.initialSelectionIdx < this.items.length) {
				const chooser = (this as unknown as { chooser: { setSelectedItem(idx: number, scroll: boolean): void } }).chooser;
				if (chooser && typeof chooser.setSelectedItem === "function") {
					chooser.setSelectedItem(this.initialSelectionIdx, true);
				}
			}
		}, 10);
	}

	getItems(): TurnItem[] {
		return this.items;
	}

	getItemText(item: TurnItem): string {
		return item.headingText;
	}

	renderSuggestion(match: FuzzyMatch<TurnItem>, el: HTMLElement) {
		super.renderSuggestion(match, el);
		if (match.item.isCurrent) {
			el.style.border = "1px solid var(--text-muted)";
			el.style.borderRadius = "4px";
		}
	}

	onChooseItem(item: TurnItem, evt: MouseEvent | KeyboardEvent): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		
		const editor = view.editor;
		editor.setCursor(item.aiResponseLine, 0);
		editor.scrollIntoView(
			{
				from: { line: item.aiResponseLine, ch: 0 },
				to: { line: item.aiResponseLine, ch: 0 },
			},
			true
		);
	}
}

export function registerJumpCommand(plugin: { app: App; addCommand: (cmd: unknown) => unknown }): void {
	plugin.addCommand({
		id: "jump-to-turn-response",
		name: "Jump to turn response",
		editorCallback: (editor: Editor, view: MarkdownView) => {
			const { items, currentTurnIndex } = parseJumpItems(
				editor.lineCount(),
				(i: number) => editor.getLine(i),
				editor.getCursor().line
			);

			if (items.length === 0) {
				return;
			}
			
			// Select the next turn by default (or the last one if we are at the end)
			const initialSelectionIdx = currentTurnIndex !== -1 
				? Math.min(currentTurnIndex + 1, items.length - 1)
				: 0;

			new TurnJumpModal(plugin.app, items, initialSelectionIdx).open();
		},
	});
}
