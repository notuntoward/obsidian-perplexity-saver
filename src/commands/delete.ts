import { App, Modal, Setting, Notice, Editor, TFile, MarkdownView } from "obsidian";
import { findPrunableSources, applyPrune } from "./prune";

export class DeleteTurnModal extends Modal {
	private turnNumberInput: string = "";

	constructor(
		app: App,
		private detectedTurn: number | null,
		private onConfirm: (turnNum: number) => void
	) {
		super(app);
		if (detectedTurn !== null) {
			this.turnNumberInput = String(detectedTurn);
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Delete AI dialog turn" });

		new Setting(contentEl)
			.setName("Turn number")
			.setDesc("The number of the turn you want to delete (e.g. 3 for ^turn-3).")
			.addText((text) => {
				text.setValue(this.turnNumberInput);
				text.onChange((value) => {
					this.turnNumberInput = value;
				});
				window.setTimeout(() => {
					text.inputEl.focus();
					text.inputEl.select();
				}, 50);
			});

		const btnRow = contentEl.createDiv({ cls: "modal-button-row" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => this.close();

		const confirmBtn = btnRow.createEl("button", {
			text: "Delete",
			cls: "mod-warning",
		});
		confirmBtn.onclick = () => {
			const turnNum = parseInt(this.turnNumberInput, 10);
			if (isNaN(turnNum) || turnNum <= 0) {
				new Notice("Please enter a valid positive turn number.");
				return;
			}
			this.onConfirm(turnNum);
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export async function deleteDialogTurn(
	app: App,
	file: TFile,
	turnNum: number
): Promise<{ success: boolean; error?: string; prunedCount?: number }> {
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

	// 3. Scoped Prune
	const allPrunable = findPrunableSources(cleanedBody);
	const prefix = `${turnNum}_`;
	const scopedPrunable = allPrunable.filter((src) => src.id.startsWith(prefix));

	// Apply prune
	const finalNoteText = applyPrune(cleanedBody, scopedPrunable);

	// 4. Save to vault
	await app.vault.modify(file, finalNoteText);

	const fullyRemoved = scopedPrunable.filter((s) => s.survivingTurnIds.length === 0).length;

	return { success: true, prunedCount: fullyRemoved };
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

			// Try to detect turn number from cursor position
			let detectedTurn: number | null = null;
			const cursor = editor.getCursor();
			for (let i = cursor.line; i >= 0; i--) {
				const line = editor.getLine(i);
				const match = line.match(/^## .*\^turn-(\d+)/);
				if (match) {
					detectedTurn = parseInt(match[1], 10);
					break;
				}
			}

			new DeleteTurnModal(plugin.app, detectedTurn, async (turnNum) => {
				const result = await deleteDialogTurn(plugin.app, file, turnNum);
				if (!result.success) {
					new Notice(result.error ?? "Deletion failed.");
					return;
				}
				new Notice(
					`Deleted turn ${turnNum}.${result.prunedCount ? ` Pruned ${result.prunedCount} source(s).` : ""}`
				);
			}).open();
		},
	});
}
