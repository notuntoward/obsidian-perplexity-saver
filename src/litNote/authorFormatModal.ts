import { App, Modal } from "obsidian";
import type { AuthorFormatIssue } from "./authorFormatValidator";

export type AuthorFormatDecision = "create-anyway" | "auto-correct" | "edit" | "cancel";

// Serialize prompts so two overlapping requests cannot stack modals.
let modalChain: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
	const run = modalChain.then(fn, fn);
	modalChain = run.catch(() => undefined);
	return run;
}

/**
 * Prompt the user when one or more creators are not in the 'Last, First' format.
 *
 * Decision options:
 *   "auto-correct"  – apply the parser's suggestion and create the note
 *   "create-anyway" – ignore the warning and create as-is
 *   "edit"          – open the item in Zotero for manual correction
 *   "cancel"        – abort note creation
 *
 * The "Auto-correct & create" button is shown only when at least one issue
 * carries a non-null suggestion from the BibTeX name parser.
 */
export function askAuthorFormatDecision(
	app: App,
	issues: AuthorFormatIssue[]
): Promise<AuthorFormatDecision> {
	return runExclusive(
		() =>
			new Promise<AuthorFormatDecision>((resolve) => {
				let settled = false;
				const settle = (value: AuthorFormatDecision): void => {
					if (settled) return;
					settled = true;
					resolve(value);
				};

				const hasSuggestion = issues.some((iss) => iss.suggestion != null);

				const modal = new (class extends Modal {
					onOpen(): void {
						this.titleEl.setText("Author name format warning");

						this.contentEl.createEl("p", {
							text: "One or more creator fields are not in the 'last, first' format required for Obsidian bases searches by last name:",
							cls: "author-format-desc",
						});

						const listContainer = this.contentEl.createDiv({
							cls: "author-format-issue-list",
						});

						for (const issue of issues) {
							const itemEl = listContainer.createDiv({
								cls: "author-format-issue-item",
							});

							itemEl.createEl("strong", {
								text: `@${issue.citekey}`,
								cls: "author-format-badge",
							});

							itemEl.createEl("span", {
								text: `[Field: ${issue.creatorType}] `,
							});

							itemEl.createEl("code", {
								text: issue.rawName,
								cls: "author-format-code",
							});

							itemEl.createEl("div", {
								text: issue.detail,
								cls: "setting-item-description",
							});

							if (issue.suggestion) {
								const suggEl = itemEl.createDiv({
									cls: "author-format-suggestion",
								});
								suggEl.createEl("span", { text: "Suggested: " });
								suggEl.createEl("code", {
									text: issue.suggestion,
									cls: "author-format-code",
								});
							}
						}

						if (hasSuggestion) {
							this.contentEl.createEl("p", {
								text: "The parser identified a probable 'last, first' ordering for the highlighted names. You can apply the suggestion automatically, edit in Zotero, or ignore the warning.",
								cls: "author-format-instruction",
							});
						} else {
							this.contentEl.createEl("p", {
								text: "Would you like to edit the entry in Zotero to correct the creator name, or ignore this warning and create the Obsidian note anyway?",
								cls: "author-format-instruction",
							});
						}

						const row = this.contentEl.createDiv({
							cls: "modal-button-container",
						});

						// Option 1 (conditional): Auto-correct & create
						if (hasSuggestion) {
							const autoBtn = row.createEl("button", {
								text: "Auto-correct & create",
								cls: "mod-cta",
							});
							autoBtn.addEventListener("click", () => {
								settle("auto-correct");
								this.close();
							});
						}

						// Option 2: Create anyway
						const createBtn = row.createEl("button", {
							text: "Create anyway",
							cls: hasSuggestion ? "" : "mod-cta",
						});
						createBtn.addEventListener("click", () => {
							settle("create-anyway");
							this.close();
						});

						// Option 3: Edit in Zotero
						const editBtn = row.createEl("button", {
							text: "Edit in Zotero",
						});
						editBtn.addEventListener("click", () => {
							settle("edit");
							this.close();
						});

						// Option 4: Cancel
						const cancelBtn = row.createEl("button", {
							text: "Cancel",
						});
						cancelBtn.addEventListener("click", () => {
							settle("cancel");
							this.close();
						});
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
