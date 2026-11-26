import { FuzzySuggestModal, Notice } from "obsidian";
import type { App, Plugin, TFile } from "obsidian";
import { getMainWindow } from "commons/workspace";
import { setTimeoutIn } from "commons/windows";
import { compareNextDuplicate } from "./duplicateNotes";
import type { DuplicateReviewSettings } from "./duplicateNotes";
import { mergeNotesInteractively, mergeSummary } from "./noteMergeWorkflow";
import { currentInitialReviewScan, pendingRescan, requestRescan } from "./pendingReviews";

const RESCAN_WAIT_MS = 20000;

class MergeSourceModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private keeper: TFile, private onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder(`Choose a note to merge into ${keeper.basename}`);
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((file) => file.path !== this.keeper.path);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

/** Ask Zotero to check every literature note again; warn when the Companion does not respond. */
export function startRescan(app: App): void {
	const scan = currentInitialReviewScan();
	if (scan?.status === "pending" && !scan.recoveryOnly) {
		new Notice("Zotero is already checking all literature notes. The review list updates when the check finishes.", 8000);
		return;
	}
	const token = requestRescan();
	new Notice("Asked Zotero to check all literature notes again. Interrupted recovery finishes first; the review list updates when the check finishes.", 8000);
	const win = getMainWindow(app);
	if (!win) return;
	setTimeoutIn(win, () => {
		if (pendingRescan() === token) {
			new Notice("Zotero has not started the check. Make sure Zotero is running with the updated Zotero Obsidian companion.", 15000);
		}
	}, RESCAN_WAIT_MS);
}

export function registerNoteMerge(plugin: Plugin, settings: DuplicateReviewSettings): void {
	const { app } = plugin;
	plugin.addCommand({
		id: "merge-note-into-current",
		name: "Merge another note into this note",
		checkCallback: (checking) => {
			const keeper = app.workspace.getActiveFile();
			if (!keeper || keeper.extension !== "md") return false;
			if (!checking) {
				new MergeSourceModal(app, keeper, (source) => {
					void mergeNotesInteractively(app, keeper, [source]).then((result) => {
						if (result) new Notice(mergeSummary(keeper, result), result.kept.length ? 0 : 10000);
					});
				}).open();
			}
			return true;
		},
	});
	plugin.addCommand({
		id: "compare-next-duplicate-notes",
		name: "Compare the next set of duplicate literature notes",
		callback: () => {
			if (!compareNextDuplicate(app, settings)) new Notice("No duplicate literature notes are waiting for review.");
		},
	});
	plugin.addCommand({
		id: "recheck-literature-notes",
		name: "Check all literature notes against Zotero again",
		callback: () => startRescan(app),
	});
}
