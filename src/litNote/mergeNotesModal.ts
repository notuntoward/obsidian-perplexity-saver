import { Modal } from "obsidian";
import type { App } from "obsidian";
import { applyModalAppearance } from "commons/modal";
import { collectVaultMetadata } from "commons/properties/catalog";
import { SelectPropertiesModal } from "commons/properties/review-modal";
import type { ConflictCardContext } from "commons/properties/review-modal";
import { changesProperties, defaultProperties } from "./noteMerge";
import type { MergeChoices, MergePlan } from "./noteMerge";

const PREVIEW_LENGTH = 600;

class MergeNotesModal extends Modal {
	private settled = false;

	constructor(app: App, private readonly plan: MergePlan, private readonly resolve: (choices: MergeChoices | null) => void) {
		super(app);
	}

	onOpen(): void {
		const { plan } = this;
		const keeper = plan.keeper.basename;
		const others = plan.sources.length === 1 ? "The other note is" : `The other ${plan.sources.length} notes are`;
		applyModalAppearance(this, { size: "standard" });
		this.titleEl.setText(`Merge into ${keeper}`);
		const content = this.contentEl;
		content.empty();
		// Only the kept note's name is bold, so the typography never suggests the note being removed is kept.
		const roles = content.createDiv({ cls: "lit-note-merge-roles" });
		const keep = roles.createDiv({ cls: "lit-note-merge-role is-keep" });
		keep.createSpan({ cls: "lit-note-merge-role-label", text: "Keep" });
		keep.createEl("strong", { text: keeper });
		const remove = roles.createDiv({ cls: "lit-note-merge-role is-remove" });
		remove.createSpan({ cls: "lit-note-merge-role-label", text: "Merge in, then trash" });
		remove.createSpan({ text: plan.sources.map((source) => source.file.basename).join(", ") });
		content.createEl("p", {
			cls: "lit-note-decision-message",
			text: `${others} merged into ${keeper} and moved to trash, where your trash settings let you restore them. Links to them are changed to link to ${keeper}. Their titles and aliases are proposed as aliases of ${keeper}, so search still finds it.`,
		});
		const blocks = new Map<string, Set<number>>();
		const trashZoteroItems = new Set<string>();
		for (const source of plan.sources) {
			const path = source.file.path;
			const selected = new Set(source.blocks.map((_, index) => index));
			blocks.set(path, selected);
			const section = content.createDiv({ cls: "lit-note-merge-source" });
			section.createDiv({ cls: "lit-note-merge-source-heading", text: `From ${source.file.basename} (to be trashed)` });
			section.createEl("p", {
				text: source.linkedFrom.length
					? `Links in ${source.linkedFrom.length} ${source.linkedFrom.length === 1 ? "note" : "notes"} will point to ${keeper}.`
					: "No other notes link to it.",
			});
			if (source.blocks.length) {
				section.createEl("p", { text: `Copy this text into ${keeper}. Clear the boxes for text you do not need.` });
				for (const [index, block] of source.blocks.entries()) {
					const row = section.createEl("label", { cls: "lit-note-merge-block" });
					const box = row.createEl("input", { attr: { type: "checkbox" } });
					box.checked = true;
					box.addEventListener("change", () => {
						if (box.checked) selected.add(index);
						else selected.delete(index);
					});
					row.createDiv({
						cls: "lit-note-merge-preview",
						text: block.text.length > PREVIEW_LENGTH ? `${block.text.slice(0, PREVIEW_LENGTH)}…` : block.text,
					});
				}
			} else {
				section.createEl("p", { text: `It has no text of yours that ${keeper} lacks.` });
			}
			const item = source.zoteroItem;
			if (item?.libraryURI) {
				const row = section.createEl("label", { cls: "lit-note-merge-zotero" });
				row.createSpan({ text: `It belongs to another Zotero item, "${item.title}". ` });
				const select = row.createEl("select", { cls: "dropdown" });
				select.createEl("option", { text: "Keep that item in Zotero", attr: { value: "keep" } });
				select.createEl("option", { text: "Move that item to the Zotero trash", attr: { value: "trash" } });
				select.addEventListener("change", () => {
					if (select.value === "trash") trashZoteroItems.add(path);
					else trashZoteroItems.delete(path);
				});
			} else if (item) {
				section.createEl("p", { text: `It belongs to another Zotero item, "${item.title}", which stays in Zotero.` });
			}
		}
		const review = changesProperties(plan.properties);
		content.createEl("p", {
			text: review
				? `Next, check ${keeper}'s properties as they will be after the merge. Nothing changes until you confirm there.`
				: `${keeper} then opens so you can tidy the merged text.`,
		});
		const buttons = content.createDiv({ cls: "perplexity-saver-modal-buttons" });
		const merge = buttons.createEl("button", { text: review ? "Continue" : "Merge", cls: "mod-cta perplexity-saver-confirm-button" });
		merge.addEventListener("click", () => this.finish({ blocks, trashZoteroItems, properties: review ? {} : defaultProperties(plan.properties) }));
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(null));
	}

	onClose(): void {
		this.finish(null);
	}

	private finish(choices: MergeChoices | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(choices);
		this.close();
	}
}

/** Show what a merge will do and let the user choose the text to copy and each Zotero item's fate. */
export function chooseMergeOptions(app: App, plan: MergePlan): Promise<MergeChoices | null> {
	return new Promise((resolve) => new MergeNotesModal(app, plan, resolve).open());
}

/** Notes that hold the property, from the plan's value sources. */
function notesWith(plan: MergePlan, key: string): string[] {
	return [...new Set(Object.values(plan.properties.sources[key] ?? {}).flat().map((source) => source.note))];
}

/**
 * Show the kept note's properties as they will be after the merge, marking each as new, extended, changed or
 * unchanged with the notes its values came from, and let the user approve or change each one. Resolves the
 * approved values, or null when the user cancels.
 */
export function reviewMergedProperties(app: App, plan: MergePlan): Promise<Record<string, unknown> | null> {
	const { proposed, original, conflicts, sources, protectedValues } = plan.properties;
	const context: Record<string, ConflictCardContext> = {};
	for (const key of Object.keys(proposed)) {
		context[key] = {
			valueSources: sources[key] ? { [key]: sources[key] } : undefined,
			...(conflicts.includes(key) ? { conflictNotes: notesWith(plan, key) } : {}),
		};
	}
	return new Promise((resolve) => {
		new SelectPropertiesModal(app, collectVaultMetadata(app), proposed, resolve, () => resolve(null), context, {
			title: "Review merged properties",
			subtitle: plan.keeper.basename,
			conflictNames: conflicts,
			finishText: "Merge",
			classPrefix: "perplexity-saver-property",
			original,
			readOnly: protectedValues,
			readOnlyNote: "Saver keeps these in step with Zotero, so merging never changes them.",
		}).open();
	});
}
