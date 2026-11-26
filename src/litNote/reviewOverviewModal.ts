import { App, Modal } from "obsidian";
import { applyModalAppearance } from "commons/modal";
import type { PendingReview } from "./pendingReviews";
import type { ReviewGroup } from "./reviewStatus";

export class ReviewOverviewModal extends Modal {
	private groups: ReviewGroup[] = [];
	private filter = "";

	constructor(
		app: App,
		private readonly onGroup: (group: ReviewGroup) => void,
		private readonly onItem: (group: ReviewGroup, item: PendingReview) => void,
		private readonly onDismiss: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		applyModalAppearance(this, { size: "standard" });
		this.render();
	}

	onClose(): void {
		this.onDismiss();
	}

	update(groups: ReviewGroup[], count: number): void {
		this.groups = groups;
		this.titleEl.setText(`Zotero/Obsidian consistency: ${count} remaining`);
		this.render();
	}

	private render(): void {
		const scrollTop = this.contentEl.scrollTop;
		const existingSearch = this.contentEl.querySelector<HTMLInputElement>(".lit-note-review-filter");
		const expanded = new Set(Array.from(this.contentEl.querySelectorAll<HTMLDetailsElement>("details[open]"))
			.map((element) => element.dataset.group));
		for (const child of Array.from(this.contentEl.children)) {
			if (child !== existingSearch) child.remove();
		}
		if (!this.groups.length) {
			existingSearch?.remove();
			this.contentEl.createEl("p", { text: "No reviews remain." });
			return;
		}
		const backupWarning = this.contentEl.createEl("p", {
			text: "Back up your vault and Zotero data before making changes.",
		});
		if (existingSearch) this.contentEl.insertBefore(backupWarning, existingSearch);
		const search = existingSearch ?? this.contentEl.createEl("input", {
			cls: "lit-note-review-filter",
			attr: { type: "search", placeholder: "Find a title or note", "aria-label": "Find a review" },
		});
		search.value = this.filter;
		const noMatches = this.contentEl.createEl("p", { text: "No reviews match your search." });
		const sections: Array<{ element: HTMLElement; details: HTMLDetailsElement; rows: Array<{ element: HTMLElement; text: string }>; action?: HTMLButtonElement }> = [];
		for (const group of this.groups) {
			const key = group.kind === "reason" ? `${group.kind}:${group.reviews[0]?.reason}`
				: group.kind === "library" ? `${group.kind}:${group.uri}`
				: group.kind === "bulk-update" ? `${group.kind}:${group.summary}`
				: group.kind === "attachment-move" ? `${group.kind}:${group.baseDirectory}:${group.conflict}`
				: group.kind === "uncertain" ? `${group.kind}:${group.attachmentMove}` : group.kind;
			const section = this.contentEl.createEl("section", { cls: "lit-note-review-group" });
			const details = section.createEl("details");
			details.dataset.group = key;
			details.open = expanded.has(key);
			details.createEl("summary", { text: group.title });
			const rows: Array<{ element: HTMLElement; text: string }> = [];
			const description = group.kind === "uncertain"
				? group.attachmentMove
					? "Copy and link attachments in both apps. The original files remain for you to check and optionally delete."
					: "Check each item and note in both apps."
				: group.kind === "library" ? group.uri
				: group.kind === "bulk-update" ? group.summary
				: group.kind === "attachment-move" ? group.baseDirectory
				: group.kind === "awaiting-ack" ? "Keep Zotero open while it confirms the checks." : "";
			if (description) details.createEl("p", { text: description });
			for (const entry of group.reviews) {
				const row = details.createDiv({ cls: "lit-note-review-item" });
				const label = entry.title === entry.itemkey ? `Zotero item (${entry.itemkey})` : entry.title;
				const button = row.createEl("button", { text: label, cls: "lit-note-review-item-button" });
				button.disabled = !!entry.requested || !!entry.awaitingAcknowledgement;
				button.addEventListener("click", () => this.onItem(group, entry));
				if (entry.notePath) row.createDiv({ text: entry.notePath, cls: "lit-note-review-item-path" });
				if (entry.requested || entry.awaitingAcknowledgement) row.createDiv({ text: "Waiting for Zotero", cls: "lit-note-review-item-path" });
				rows.push({ element: row, text: `${entry.title} ${entry.notePath ?? ""} ${entry.itemkey}`.toLowerCase() });
			}
			const bulkLabel = group.kind === "uncertain"
				? group.reviews.filter((entry) => !entry.requested).length > 1
					? group.attachmentMove ? "Copy and repair all" : "Review one by one"
					: ""
				: group.kind === "library" ? "Add library to all"
				: group.kind === "bulk-update" ? "Apply changes to all"
				: group.kind === "attachment-move" ? "Move attachments for all" : "";
			let action: HTMLButtonElement | undefined;
			if (bulkLabel) {
				action = section.createEl("button", { text: bulkLabel });
				action.addEventListener("click", () => this.onGroup(group));
			}
			sections.push({ element: section, details, rows, action });
		}
		const applyFilter = (): void => {
			const query = this.filter.trim().toLowerCase();
			let visibleGroups = 0;
			for (const section of sections) {
				let visible = 0;
				for (const row of section.rows) {
					row.element.hidden = !!query && !row.text.includes(query);
					if (!row.element.hidden) visible++;
				}
				section.element.hidden = !!query && visible === 0;
				if (!section.element.hidden) visibleGroups++;
				if (query && visible) section.details.open = true;
				if (section.action) section.action.hidden = !!query;
			}
			noMatches.hidden = visibleGroups > 0;
		};
		search.oninput = () => {
			this.filter = search.value;
			applyFilter();
		};
		applyFilter();
		this.contentEl.scrollTop = scrollTop;
	}
}
