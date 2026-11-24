import { App, Notice } from "obsidian";
import { ItemSuggestModal } from "commons/modal";
import { raiseWindow } from "commons/os";
import { getMainWindow } from "commons/workspace";
import { askNoteDecision } from "./decisionModal";
import { requestAttachmentBatch, requestLibraryBatch, requestNoteBatch, requestReview, setReviewListener } from "./pendingReviews";
import type { PendingReview } from "./pendingReviews";

type ReviewGroup =
	| { kind: "library"; title: string; uri: string; reviews: PendingReview[] }
	| { kind: "bulk-update"; title: string; summary: string; reviews: PendingReview[] }
	| { kind: "attachment-move"; title: string; baseDirectory: string; conflict: boolean; reviews: PendingReview[] }
	| { kind: "reason"; title: string; reviews: PendingReview[] };

function groupsFor(reviews: PendingReview[]): ReviewGroup[] {
	const libraries = new Map<string, PendingReview[]>();
	const updates = new Map<string, PendingReview[]>();
	const attachmentMoves = new Map<string, { baseDirectory: string; conflict: boolean; reviews: PendingReview[] }>();
	const reasons = new Map<string, PendingReview[]>();
	for (const review of reviews) {
		if (review.libraryNotePath && !review.requested) {
			const group = libraries.get(review.libraryURI) ?? [];
			group.push(review);
			libraries.set(review.libraryURI, group);
		}
		if (review.proposal && !review.requested) {
			const group = updates.get(review.proposal.summary) ?? [];
			group.push(review);
			updates.set(review.proposal.summary, group);
		}
		if (review.attachmentMove && !review.requested) {
			const conflict = review.attachmentMove.attachments.some((attachment) =>
				attachment.resolution === "move" && attachment.conflict && !attachment.identical);
			const groupKey = JSON.stringify([review.attachmentMove.baseDirectory, conflict]);
			const group = attachmentMoves.get(groupKey) ?? {
				baseDirectory: review.attachmentMove.baseDirectory, conflict, reviews: [],
			};
			group.reviews.push(review);
			attachmentMoves.set(groupKey, group);
		}
		if (review.attachmentMove && !review.requested) continue;
		const group = reasons.get(review.reason) ?? [];
		group.push(review);
		reasons.set(review.reason, group);
	}
	return [
		...[...libraries].map(([uri, entries]): ReviewGroup => ({
			kind: "library", uri, reviews: entries, title: `Add missing Zotero library URI (${entries.length})`,
		})),
		...[...updates].map(([summary, entries]): ReviewGroup => ({
			kind: "bulk-update", summary, reviews: entries, title: `Apply note changes (${entries.length})`,
		})),
		...[...attachmentMoves.values()].map(({ baseDirectory, conflict, reviews }): ReviewGroup => ({
			kind: "attachment-move", baseDirectory, conflict, reviews,
			title: conflict
				? `Choose which Zotero attachment files to keep (${reviews.length} notes)`
				: `Move Zotero attachments into the vault (${reviews.length} notes)`,
		})),
		...[...reasons].map(([reason, entries]): ReviewGroup => ({
			kind: "reason", reviews: entries, title: `${reason} (${entries.length})`,
		})),
	];
}

async function approveAttachmentBatch(app: App, group: Extract<ReviewGroup, { kind: "attachment-move" }>): Promise<void> {
	const count = group.reviews.length;
	const candidates = group.reviews.flatMap((review) => review.attachmentMove ? [review.attachmentMove] : []);
	const attachments = candidates.flatMap((candidate) => candidate.attachments);
	const fileCount = attachments.filter((attachment) => attachment.resolution !== "trash").length;
	const duplicates = attachments.filter((attachment) => attachment.resolution === "trash").length +
		candidates.reduce((total, candidate) => total + candidate.trashNoteFiles.length, 0);
	const mismatched = candidates.filter((candidate) => candidate.extras.length).length;
	const win = getMainWindow(app);
	if (win) raiseWindow(win);
	let strategy: "newest" | "zotero" = "newest";
	if (group.conflict) {
		const conflicts = attachments.filter((attachment) => attachment.resolution === "move" && attachment.conflict && !attachment.identical);
		const paths = conflicts.slice(0, 6).map((attachment) => `${attachment.sourcePath} -> ${attachment.destinationPath}`);
		if (conflicts.length > paths.length) paths.push(`...and ${conflicts.length - paths.length} more file conflicts`);
		const choice = await askNoteDecision(app, "Choose which attachment files to keep",
			`${conflicts.length} files in ${count} notes have matching names but different contents:\n${paths.join("\n")}\nKeep the newest file by default. The other copy will be preserved as a backup.`,
			[
				{ label: "Keep newest (recommended)", value: "keep-newest", cta: true },
				{ label: "Keep Zotero's file", value: "keep-zotero" },
				{ label: "Skip; fix manually", value: "skip-manual" },
			]);
		if (choice === "skip-manual") {
			new Notice("Attachment moves skipped. Fix these file conflicts manually.", 10000);
			return;
		}
		if (choice !== "keep-newest" && choice !== "keep-zotero") return;
		strategy = choice === "keep-zotero" ? "zotero" : "newest";
	} else {
		const details = [
			duplicates ? `${duplicates} identical duplicate${duplicates === 1 ? "" : "s"} will go to the trash; the copy named closest to Zotero's renaming pattern is kept.` : "",
			mismatched ? `${mismatched} note${mismatched === 1 ? "" : "s"} and Zotero item${mismatched === 1 ? "" : "s"} have files the other lacks. Those files are moved into the vault and linked from both; nothing is trashed. Each note gets a red mismatch line and the zotero_note_file_mismatch property.` : "",
			"When a note and Zotero have different files with the same name, the newest non-empty file is kept.",
		].filter(Boolean).join("\n");
		const choice = await askNoteDecision(app, "Move Zotero attachments into the vault?",
			`Move ${fileCount} attachment${fileCount === 1 ? "" : "s"} for ${count} note${count === 1 ? "" : "s"} into the vault (${group.baseDirectory}) and link them from Zotero and the notes.\n${details}`,
			[{ label: "Continue", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
		if (choice !== "create") return;
	}
	const confirm = await askNoteDecision(app, "Back up the vault and attachment files",
		`Back up your vault before continuing. Any unselected conflicting file will also be kept as a backup beside the attachment. Confirm moving and relinking the files for ${count} note${count === 1 ? "" : "s"}.`,
		[{ label: "Move and update links", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
	if (confirm !== "create") return;
	try {
		const selected = group.reviews.map((review) => {
			const candidate = review.attachmentMove;
			if (!candidate || candidate.baseDirectory !== group.baseDirectory)
				throw new Error("The review list changed. Select the group again.");
			return { key: review.key, candidate };
		});
		requestAttachmentBatch(selected, strategy);
	} catch (error) {
		console.error("Could not start Zotero attachment move", error);
		new Notice(error instanceof Error ? error.message : String(error), 10000);
	}
}

async function approveLibraryBatch(app: App, group: Extract<ReviewGroup, { kind: "library" }>): Promise<void> {
	const count = group.reviews.length;
	const win = getMainWindow(app);
	if (win) raiseWindow(win);
	const choice = await askNoteDecision(app, "Add missing Zotero library URI?",
		`Add ${group.uri} to ${count} note${count === 1 ? "" : "s"}? Attachment links and files will not be changed.`,
		[{ label: "Continue", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
	if (choice !== "create") return;
	const confirm = await askNoteDecision(app, "Back up the vault before continuing",
		`Back up your vault, then confirm adding ${group.uri} to ${count} note${count === 1 ? "" : "s"}.`,
		[{ label: "Add URI", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
	if (confirm !== "create") return;
	try {
		requestLibraryBatch(group.uri, group.reviews.map((review) => {
			if (!review.libraryNotePath) throw new Error("The review list changed. Select the group again.");
			return { key: review.key, notePath: review.libraryNotePath };
		}));
	} catch (error) {
		console.error("Could not start Zotero library correction", error);
		new Notice(error instanceof Error ? error.message : String(error), 10000);
	}
}

async function approveNoteBatch(app: App, group: Extract<ReviewGroup, { kind: "bulk-update" }>): Promise<void> {
	const count = group.reviews.length;
	const win = getMainWindow(app);
	if (win) raiseWindow(win);
	const choice = await askNoteDecision(app, "Apply these note changes?",
		`${count} note${count === 1 ? "" : "s"}: ${group.summary}.`,
		[{ label: "Continue", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
	if (choice !== "create") return;
	const confirm = await askNoteDecision(app, "Back up the vault before continuing",
		`Back up your vault, then confirm these changes to ${count} note${count === 1 ? "" : "s"}: ${group.summary}.`,
		[{ label: "Apply changes", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
	if (confirm !== "create") return;
	try {
		requestNoteBatch(group.summary, group.reviews.map((review) => {
			if (!review.proposal) throw new Error("The review list changed. Select the group again.");
			return { key: review.key, proposal: review.proposal };
		}));
	} catch (error) {
		console.error("Could not start bulk Zotero review", error);
		new Notice(error instanceof Error ? error.message : String(error), 10000);
	}
}

function openGroup(app: App, group: ReviewGroup): void {
	if (group.kind === "library") {
		void approveLibraryBatch(app, group);
		return;
	}
	if (group.kind === "bulk-update") {
		void approveNoteBatch(app, group);
		return;
	}
	if (group.kind === "attachment-move") {
		void approveAttachmentBatch(app, group);
		return;
	}
	new ItemSuggestModal(app, group.reviews, (entry) => {
		if (entry.requested) {
			new Notice("This review is waiting for Zotero. Start Zotero if it is closed.");
			return;
		}
		try {
			requestReview(entry.key);
			new Notice("Waiting for Zotero to prepare this review. Start Zotero if it is closed.", 10000);
		} catch (error) {
			console.error("Could not request Zotero review", error);
			new Notice("This review is no longer pending.");
		}
	}, {
		placeholder: group.title,
		getTitle: (entry) => entry.title,
		getSubtitle: (entry) => `${entry.notePath || entry.itemkey}${entry.requested ? " (waiting for Zotero)" : ""}`,
	}).open();
}

export function setupReviewStatus(app: App, status: HTMLElement): () => void {
	const button = status.createEl("button", { cls: "lit-note-review-status" });
	let count = 0;
	let announced = false;
	let arrival: Notice | undefined;
	let progress: Notice | undefined;
	setReviewListener((reviews, batch) => {
		status.hidden = reviews.length === 0;
		button.setText(batch
			? `Zotero reviews: ${reviews.length} (${batch.completed}/${batch.total} checked${batch.rechecking ? `, ${batch.rechecking} rechecking` : ""})`
			: `Zotero reviews: ${reviews.length}`);
		if (reviews.length && !announced) {
			arrival = new Notice("Zotero reviews need attention. Click Zotero reviews in the status bar to see them.", 0);
			announced = true;
		}
		if (!reviews.length && count && !batch) {
			arrival?.hide();
			arrival = undefined;
			new Notice("All Zotero reviews are complete.", 10000);
		}
		count = reviews.length;
		if (batch) {
			const message = `${batch.kind === "attachment-move" ? "Moving and relinking" : "Correcting"} ${batch.total} note${batch.total === 1 ? "" : "s"}: ${batch.completed} of ${batch.total} checked${batch.rechecking ? `; ${batch.rechecking} awaiting recheck` : ""}. Keep the updated Zotero companion running.`;
			if (!progress) progress = new Notice(message, 0);
			else progress.setMessage(message);
			if (batch.completed === batch.total && !batch.rechecking) {
				progress.hide();
				progress = undefined;
				const failed = batch.total - batch.succeeded;
				const result = batch.kind === "library-uri"
					? `Added zotero_library_uri ${batch.label} to ${batch.succeeded} of ${batch.total} notes.`
					: batch.kind === "attachment-move"
						? `Moved Zotero attachment files and updated Obsidian links for ${batch.succeeded} of ${batch.total} notes.`
						: `Updated ${batch.succeeded} of ${batch.total} notes.`;
				const remaining = reviews.length
					? `${reviews.length} review${reviews.length === 1 ? " remains" : "s remain"}. Click Zotero reviews in the status bar to continue.`
					: "All Zotero reviews are complete.";
				if (!reviews.length) {
					arrival?.hide();
					arrival = undefined;
				}
				new Notice(`${result}${failed ? ` ${failed} corrections failed.` : ""}${batch.recheckFailed ? ` ${batch.recheckFailed} recheck${batch.recheckFailed === 1 ? "" : "s"} failed.` : ""} ${remaining}`, 0);
			}
		}
		button.onclick = () => {
			arrival?.hide();
			arrival = undefined;
			new ItemSuggestModal(app, groupsFor(reviews), (group) => openGroup(app, group), {
				placeholder: "Choose a Zotero review type",
				getTitle: (group) => group.title,
				getSubtitle: (group) => group.kind === "library" ? group.uri
					: group.kind === "bulk-update" ? group.summary
					: group.kind === "attachment-move" ? group.baseDirectory
					: "Review notes individually",
			}).open();
		};
	});
	return () => {
		setReviewListener();
		arrival?.hide();
		progress?.hide();
	};
}
