import { App, Modal } from "obsidian";
import { applyModalAppearance } from "commons/modal";

/**
 * A decision the user can make when a lit note already exists (create flow) or
 * is missing (open flow). Turning a chosen button into a Promise keeps the HTTP
 * handler simple: it awaits the user's choice in Obsidian, where the prompt is
 * guaranteed to be visible because Obsidian owns the foreground window.
 */
export type NoteDecision =
	| "overwrite"
	| "open-existing"
	| "create"
	| "skip"
	| "unlock"
	| "rename"
	| "cancel";

export interface DecisionButton {
	label: string;
	value: NoteDecision;
	cta?: boolean;
	warning?: boolean;
}

// Serialize prompts so two overlapping Zotero requests cannot stack modals.
let decisionChain: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
	const run = decisionChain.then(fn, fn);
	decisionChain = run.catch(() => undefined);
	return run;
}

/**
 * Show a modal with the given buttons and resolve with the chosen value.
 * Dismissing the modal (Esc, click outside, title-bar close) resolves "cancel".
 */
export function askNoteDecision(
	app: App,
	title: string,
	message: string,
	buttons: DecisionButton[]
): Promise<NoteDecision> {
	return runExclusive(
		() =>
			new Promise<NoteDecision>((resolve) => {
				let settled = false;
				const settle = (value: NoteDecision): void => {
					if (settled) return;
					settled = true;
					resolve(value);
				};

				const modal = new (class extends Modal {
					onOpen(): void {
						this.titleEl.setText(title);
						applyModalAppearance(this, { size: "standard" });
						const messageEl = this.contentEl.createDiv({ cls: "commons-modal-intro" });
						for (const p of message.split("\n\n")) {
							const trimmed = p.trim();
							if (!trimmed) continue;
							const lines = trimmed.split("\n");
							if (lines.length === 1) {
								messageEl.createEl("p", { text: trimmed });
							} else {
								const pEl = messageEl.createEl("p");
								for (let i = 0; i < lines.length; i++) {
									if (i > 0) {
										pEl.createEl("br");
									}
									pEl.createEl("span", { text: lines[i] });
								}
							}
						}
						const row = this.contentEl.createDiv({
							cls: "modal-button-container commons-modal-actions",
						});
						for (const button of buttons) {
							const el = row.createEl("button", { text: button.label });
							if (button.cta) el.addClass("mod-cta");
							if (button.warning) el.addClass("mod-warning");
							el.addEventListener("click", () => {
								settle(button.value);
								this.close();
							});
						}
					}

					onClose(): void {
						settle("cancel");
						this.contentEl.empty();
					}
				})(app);

				modal.open();
			})
	);
}
