import { App, FileSystemAdapter, Modal, Notice, TFile } from "obsidian";
import { applyModalAppearance } from "commons/modal";
import { ownerWindow, writeClipboardIn } from "commons/windows";
import type { AttachmentProblem } from "./buildLitNote";

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
	| "use-obsidian"
	| "use-zotero"
	| "keep-newest"
	| "keep-zotero"
	| "skip-manual"
	| "keep-link"
	| "replace-link"
	| `attachment:${number}`
	| `review:${string}`
	| "cancel";

export interface AttachmentReviewRow {
	kind: "note" | "add" | "body" | "zotero";
	label: string;
	description?: string;
	copyValue?: string;
	options: Array<{ label: string; value: string }>;
	defaultValue: string;
	files?: Array<{ path: string; modified?: number; role?: string }>;
}

export interface CitekeyConflictDetails {
	title: string;
	itemkey: string;
	libraryURI: string;
	notePath?: string;
	noteCitekey?: string;
	zoteroCitekey: string;
	attachmentProblems?: AttachmentProblem[];
	compact?: boolean;
}

export interface DecisionButton {
	label: string;
	value: NoteDecision;
	cta?: boolean;
	warning?: boolean;
}

export interface NoteDecisionSession {
	ask(title: string, message: string, buttons: DecisionButton[], review?: AttachmentReviewRow[], conflict?: CitekeyConflictDetails): Promise<NoteDecision>;
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
	return withNoteDecisionSession(app, (session) => session.ask(title, message, buttons));
}

export function withNoteDecisionSession<T>(
	app: App,
	run: (session: NoteDecisionSession) => Promise<T>
): Promise<T> {
	return runExclusive(async () => {
		let resolveDecision: ((value: NoteDecision) => void) | undefined;
		let closed = false;
		let opened = false;
		const modal = new (class extends Modal {
			show(title: string, message: string, buttons: DecisionButton[], review?: AttachmentReviewRow[], conflict?: CitekeyConflictDetails): void {
				this.titleEl.setText(title);
				this.contentEl.empty();
				applyModalAppearance(this, { size: "standard" });
				const addCopyButton = (container: HTMLElement, label: string, value: string): void => {
					const copy = container.createEl("button", { text: "Copy", attr: { "aria-label": `Copy ${label}` } });
					copy.addEventListener("click", () => {
						const win = ownerWindow(copy);
						if (!win) {
							new Notice(`Could not copy ${label}.`);
							return;
						}
						void writeClipboardIn(win, value).then((written) => {
							new Notice(written ? `Copied ${label}.` : `Could not copy ${label}.`);
						}).catch((error: unknown) => {
							console.error(`Could not copy ${label}`, error);
							new Notice(`Could not copy ${label}.`);
						});
					});
				};
				if (conflict?.attachmentProblems?.length) {
					const issues = this.contentEl.createDiv({ cls: "lit-note-attachment-problems" });
					for (const entry of conflict.attachmentProblems) {
						const issue = issues.createDiv({ cls: "lit-note-attachment-problem" });
						if (entry.path) {
							const row = issue.createDiv({ cls: "lit-note-copyable-key" });
							row.createEl("strong", { text: "Zotero attachment:" });
							row.createEl("code", { text: entry.path });
							addCopyButton(row, `attachment path ${entry.path}`, entry.path);
						} else if (entry.label) {
							issue.createEl("p").createEl("strong", { text: `Zotero attachment: ${entry.label}` });
						}
						if (conflict.attachmentProblems.length > 1) issue.createEl("strong", { text: entry.title });
						issue.createEl("p", { text: entry.dialogProblem ?? entry.problem });
						issue.createEl("p", { text: entry.action });
					}
				}
				if (message.trim()) {
					const messageEl = this.contentEl.createDiv({ cls: "commons-modal-intro lit-note-decision-message" });
					for (const p of message.split("\n\n")) {
						const trimmed = p.trim();
						if (!trimmed) continue;
						const lines = trimmed.split("\n");
						if (lines.length === 1) {
							messageEl.createEl("p", { text: trimmed });
						} else {
							const pEl = messageEl.createEl("p");
							for (let i = 0; i < lines.length; i++) {
								if (i > 0) pEl.createEl("br");
								pEl.createSpan({ text: lines[i] });
							}
						}
					}
				}
				if (conflict) {
					const details = conflict.compact
						? this.contentEl.createEl("details", { cls: "lit-note-citekey-details" })
						: this.contentEl.createDiv({ cls: "lit-note-citekey-details" });
					if (conflict.compact) details.createEl("summary", { text: "Item and note details" });
					const grid = details.createDiv({ cls: "lit-note-identity-grid" });
					const group = conflict.libraryURI.match(/\/groups\/(\d+)(?:\/|$)/);
					const library = group ? `groups/${group[1]}` : "library";
					const zoteroURI = `zotero://select/${library}/items/${encodeURIComponent(conflict.itemkey)}`;
					grid.createEl("strong", { text: "Zotero item:" });
					const item = grid.createDiv({ cls: "lit-note-identity-value" });
					item.createEl("a", { text: conflict.title, cls: "external-link", attr: { href: zoteroURI, title: "Open in Zotero" } });
					if (conflict.notePath) {
						const notePath = conflict.notePath;
						grid.createEl("strong", { text: "Obsidian note:" });
						const note = grid.createDiv({ cls: "lit-note-identity-value" });
						const noteLink = note.createEl("a", { text: notePath.split("/").pop() || notePath, attr: { href: "#" } });
						note.createDiv({ cls: "lit-note-edit-hint", text: "Opening the note closes this dialog and cancels the current review." });
						noteLink.addEventListener("click", (event) => {
							event.preventDefault();
							const resolve = resolveDecision;
							resolveDecision = undefined;
							resolve?.(buttons.length === 1 && buttons[0].value === "skip" ? "skip" : "cancel");
							this.close();
							void app.workspace.openLinkText(notePath, "", false).then(() => {
								new Notice("After editing, retry the update from Zotero.", 10000);
							}).catch((error: unknown) => {
								console.error("Could not open the Obsidian note", error);
								new Notice("Could not open the Obsidian note. Open it manually, then retry the update from Zotero.", 10000);
							});
						});
					}
					for (const [label, value] of [
						["Obsidian citekey", conflict.noteCitekey],
						["Zotero citekey", conflict.zoteroCitekey],
						["Zotero item key", conflict.itemkey],
					] as const) {
						if (!value) continue;
						grid.createEl("strong", { text: `${label}:` });
						const row = grid.createDiv({ cls: "lit-note-copyable-key lit-note-identity-value" });
						row.createEl("code", { text: value });
						addCopyButton(row, label, value);
					}
				}
				const selections: string[] = [];
				if (review) {
					const search = review.length > 5 ? this.contentEl.createEl("input", {
						attr: { type: "search", placeholder: "Filter review items", "aria-label": "Filter review items" },
					}) : undefined;
					const searchStatus = search ? this.contentEl.createDiv({ cls: "lit-note-attachment-review-search-status" }) : undefined;
					const choices: HTMLInputElement[][] = [];
					const bulk = this.contentEl.createDiv({ cls: "lit-note-attachment-review-bulk" });
					for (const [label, kind, value] of [
						["Add all Zotero item links", "add", "add"],
						["Keep all Obsidian-only links", "note", "keep"],
						["Remove all Obsidian-only links", "note", "remove"],
					] as const) {
						if (!review.some((entry) => entry.kind === kind)) continue;
						const button = bulk.createEl("button", { text: label });
						button.addEventListener("click", () => {
							review.forEach((entry, index) => {
								if (entry.kind === kind) {
									selections[index] = value;
									for (const choice of choices[index]) choice.checked = choice.value === value;
								}
							});
						});
					}
					const list = this.contentEl.createDiv({ cls: "lit-note-attachment-review" });
					const rows = review.map((entry, index) => {
						const row = list.createDiv({ cls: "lit-note-attachment-review-row" });
						const heading = row.createDiv({ text: entry.label, cls: "lit-note-attachment-review-title" });
						if (entry.copyValue) addCopyButton(heading, `link target ${entry.copyValue}`, entry.copyValue);
						if (entry.description) row.createDiv({ text: entry.description });
						selections.push(entry.defaultValue);
						choices.push([]);
						if (entry.files?.length) {
							const files = row.createDiv({ cls: "lit-note-attachment-review-files" });
							for (const candidate of entry.files) {
								const line = files.createDiv();
								if (candidate.role) line.createSpan({ text: `${candidate.role}: ` });
								const link = line.createEl("a", { text: candidate.path, attr: { href: "#", title: "Open with the default application" } });
								if (candidate.modified !== undefined) {
									line.createSpan({ text: ` — Modified ${new Date(candidate.modified).toLocaleString()}` });
								}
								link.addEventListener("click", (event) => {
									event.preventDefault();
									void (async () => {
										try {
											const file = app.vault.getAbstractFileByPath(candidate.path);
											const adapter = app.vault.adapter;
											if (!(file instanceof TFile) || !(adapter instanceof FileSystemAdapter)) {
												throw new Error("The file is no longer available in the vault.");
											}
											type ElectronModule = { shell?: { openPath?: (path: string) => Promise<string> } };
											const win: (Window & { electron?: ElectronModule; require?: (name: string) => ElectronModule }) | null = ownerWindow(link);
											const openPath = win?.electron?.shell?.openPath ?? win?.require?.("electron").shell?.openPath;
											if (!openPath) throw new Error("The system file opener is unavailable.");
											const error = await openPath(adapter.getFullPath(file.path));
											if (error) throw new Error(error);
										} catch (error) {
											console.error("Could not open attachment", error);
											new Notice(`Could not open attachment: ${error instanceof Error ? error.message : String(error)}`);
										}
									})();
								});
							}
						}
						if (entry.options.length > 1) {
							const options = row.createDiv({ cls: "lit-note-attachment-review-options", attr: { role: "radiogroup", "aria-label": entry.label } });
							for (const option of entry.options) {
								const label = options.createEl("label");
								const choice = label.createEl("input", { attr: { type: "radio", name: `lit-note-attachment-choice-${index}`, value: option.value } });
								choice.checked = option.value === entry.defaultValue;
								choice.addEventListener("change", () => { if (choice.checked) selections[index] = option.value; });
								label.createSpan({ text: option.label });
								choices[index].push(choice);
							}
						}
						return row;
					});
					search?.addEventListener("input", () => {
						const query = search.value.toLocaleLowerCase();
						rows.forEach((row, index) => {
							const entry = review[index];
							row.hidden = ![entry.label, entry.description ?? "", ...entry.options.map((option) => option.label), ...(entry.files ?? []).map((file) => file.path)]
								.some((text) => text.toLocaleLowerCase().includes(query));
						});
						searchStatus?.setText(`Showing ${rows.filter((row) => !row.hidden).length} of ${rows.length} items. Choices in hidden items still apply.`);
					});
				}
				const row = this.contentEl.createDiv({
					cls: "modal-button-container commons-modal-actions lit-note-decision-actions",
				});
				for (const button of buttons) {
					const el = row.createEl("button", { text: button.label });
					if (button.cta) el.addClass("mod-cta");
					if (button.warning) el.addClass("mod-warning");
					el.addEventListener("click", () => {
						const resolve = resolveDecision;
						resolveDecision = undefined;
						resolve?.(review && button.value === "create"
							? `review:${JSON.stringify(selections)}`
							: button.value);
					});
				}
			}
			onClose(): void {
				closed = true;
				resolveDecision?.("cancel");
				resolveDecision = undefined;
				this.contentEl.empty();
			}
		})(app);
		try {
			return await run({
				ask: (title, message, buttons, review, conflict) => {
					if (closed) return Promise.resolve("cancel");
					if (!opened) {
						modal.open();
						opened = true;
					}
					modal.show(title, message, buttons, review, conflict);
					return new Promise<NoteDecision>((resolve) => { resolveDecision = resolve; });
				},
			});
		} finally {
			if (opened && !closed) modal.close();
		}
	});
}
