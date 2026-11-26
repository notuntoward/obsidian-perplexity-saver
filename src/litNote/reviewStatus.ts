import { App, Notice } from "obsidian";
import { raiseWindow } from "commons/os";
import { getMainWindow } from "commons/workspace";
import { askNoteDecision } from "./decisionModal";
import { randomUUID } from "crypto";
import { inspectUncertainAttachments } from "./uncertainAttachments";
import { acknowledgeUncertainReview, allReviews, requestAttachmentBatch, requestLibraryBatch, requestNoteBatch, requestReview, requestUncertainAttachmentRepair, requestUncertainAttachmentRepairBatch, setReviewListener } from "./pendingReviews";
import { ReviewOverviewModal } from "./reviewOverviewModal";
import { compareDuplicateReview, isDuplicateReview, watchDuplicateReviews } from "./duplicateNotes";
import type { DuplicateReviewSettings } from "./duplicateNotes";
import type { PendingReview } from "./pendingReviews";

export type ReviewGroup =
	| { kind: "uncertain"; title: string; attachmentMove: boolean; reviews: PendingReview[] }
	| { kind: "awaiting-ack"; title: string; reviews: PendingReview[] }
	| { kind: "library"; title: string; uri: string; reviews: PendingReview[] }
	| { kind: "bulk-update"; title: string; summary: string; reviews: PendingReview[] }
	| { kind: "attachment-move"; title: string; baseDirectory: string; conflict: boolean; reviews: PendingReview[] }
	| { kind: "reason"; title: string; reviews: PendingReview[] };

function groupsFor(reviews: PendingReview[]): ReviewGroup[] {
	const libraries = new Map<string, PendingReview[]>();
	const updates = new Map<string, PendingReview[]>();
	const attachmentMoves = new Map<string, { baseDirectory: string; conflict: boolean; reviews: PendingReview[] }>();
	const reasons = new Map<string, PendingReview[]>();
	const uncertain: PendingReview[] = [];
	const awaitingAck: PendingReview[] = [];
	for (const review of reviews) {
		if (review.uncertain) {
			uncertain.push(review);
			continue;
		}
		if (review.awaitingAcknowledgement) {
			awaitingAck.push(review);
			continue;
		}
		if (review.libraryNotePath && !review.requested) {
			const group = libraries.get(review.libraryURI) ?? [];
			group.push(review);
			libraries.set(review.libraryURI, group);
			continue;
		}
		if (review.proposal && !review.requested) {
			const group = updates.get(review.proposal.summary) ?? [];
			group.push(review);
			updates.set(review.proposal.summary, group);
			continue;
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
		...([true, false] as const).flatMap((attachmentMove) => {
			const reviews = uncertain.filter((entry) => (entry.uncertainOperation === "attachment-move") === attachmentMove);
			return reviews.length ? [{
				kind: "uncertain" as const, reviews, attachmentMove,
				title: attachmentMove ? `Check attachment repairs (${reviews.length})` : `Check Zotero items (${reviews.length})`,
			}] : [];
		}),
		...(awaitingAck.length ? [{ kind: "awaiting-ack" as const, reviews: awaitingAck, title: `Waiting for Zotero to confirm checks (${awaitingAck.length})` }] : []),
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
			duplicates ? `- Move up to ${duplicates} duplicate or replaced empty file${duplicates === 1 ? "" : "s"} to Trash after safety checks.` : "",
			mismatched ? `- Mark ${mismatched} note${mismatched === 1 ? "" : "s"} with unmatched or missing links. Extra files are kept and linked in both apps.` : "",
			attachments.some((attachment) => attachment.resolution === "newest")
				? "- For same-name copies, keep the newest non-empty file." : "",
		].filter(Boolean).join("\n");
		const choice = await askNoteDecision(app, "Move Zotero attachments into the vault?",
			[
				`Move ${fileCount} attachment${fileCount === 1 ? "" : "s"} for ${count} note${count === 1 ? "" : "s"} and link them in Zotero and Obsidian.`,
				`Destination: ${group.baseDirectory}`,
				details,
				"Continue to the backup confirmation. No files will move yet.",
			].filter(Boolean).join("\n\n"),
			[{ label: "Continue to backup", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
		if (choice !== "create") return;
	}
	const confirm = await askNoteDecision(app, "Back up the vault and attachment files",
		`Back up your vault and Zotero attachment files first.\n\nConfirm to start moving and relinking attachments for ${count} note${count === 1 ? "" : "s"}. Conflicting copies are kept as backups.`,
		[{ label: "Move attachments now", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
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

let reviewingUncertain = false;

function openGroup(app: App, group: ReviewGroup): void {
	if (group.kind === "awaiting-ack") {
		new Notice("Start Zotero to finish confirming the checked operations.", 10000);
		return;
	}
	if (group.kind === "uncertain") {
		const eligible = group.reviews.filter((entry) => !entry.requested);
		if (group.attachmentMove && eligible.length > 1) {
			void (async () => {
				const choice = await askNoteDecision(app, "Repair interrupted attachments?",
					`Copy and link the attachments for ${eligible.length} items in Zotero and Obsidian. The original files remain for you to inspect and optionally delete. Any item that cannot be repaired safely stays in the review list.`,
					[{ label: "Copy and repair all", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
				if (choice === "create") {
					try {
						requestUncertainAttachmentRepairBatch(eligible.map((entry) => ({ key: entry.key, repairId: randomUUID() })));
					} catch (error) {
						console.error("Could not start attachment repairs", error);
						new Notice(error instanceof Error ? error.message : String(error), 10000);
					}
				}
			})();
			return;
		}
		if (!group.attachmentMove && eligible.length > 1) {
			if (reviewingUncertain) {
				new Notice("A sequence of Zotero reviews is already open.");
				return;
			}
			reviewingUncertain = true;
			void (async () => {
				try {
					for (const entry of eligible) {
						const current = allReviews().find((review) => review.key === entry.key);
						if (!current?.uncertain || current.requested) continue;
						if (!await reviewUncertainItem(app, current)) break;
					}
				} catch (error) {
					console.error("Could not continue Zotero reviews", error);
					new Notice(`Could not continue Zotero reviews: ${error instanceof Error ? error.message : String(error)}`, 10000);
				} finally {
					reviewingUncertain = false;
				}
			})();
		}
		return;
	}
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
}

async function reviewUncertainItem(app: App, entry: PendingReview): Promise<boolean> {
	const attachmentMove = entry.uncertainOperation === "attachment-move";
	let attachmentDetails: Awaited<ReturnType<typeof inspectUncertainAttachments>> | undefined;
	if (attachmentMove) {
		try {
			attachmentDetails = await inspectUncertainAttachments(app, entry);
		} catch (error) {
			console.error("Could not inspect the Zotero attachment review", error);
			attachmentDetails = { message: `Could not inspect the attachment links: ${error instanceof Error ? error.message : String(error)}`, paths: [] };
		}
	}
	const choice = await askNoteDecision(app, attachmentMove ? "Check the attachment move" : "Check the Zotero item and Obsidian note",
		[
			attachmentMove
				? "Zotero tried to move attachments to the vault and/or link to them, but couldn't verify that the changes finished."
				: "Zotero could not confirm that an update finished. It may have changed the citation key, note details, attachment files, or links.",
			`- In Zotero, open the item and its file attachments. Check that the files open.\n- In Obsidian, open the note and its attachment links. Check that the links open the correct files.${attachmentMove ? "" : "\n- Check that the citation key and note details match the Zotero item."}`,
			attachmentDetails?.message ?? "",
			entry.notePath ? "Opening the note closes this dialog; return to Zotero reviews afterward." : "Obsidian could not identify a matching note. Search Obsidian for the item's title or citation key.",
			attachmentMove
				? "Copy and repair attachment links copies the attachment into the vault and links the copy in Zotero and Obsidian. The original stays in its current location, such as Zotero storage. You can delete it yourself after checking that the copy opens in both apps."
				: "Fix any missing files or broken links before confirming. Do not delete copies until you have checked them. Confirming does not fix files or links; it allows normal updates to resume.",
			entry.uncertainReason ? `Error details: ${entry.uncertainReason}` : "",
		].filter(Boolean).join("\n\n"),
		[
			...(attachmentMove ? [{ label: "Copy and repair attachment links", value: "repair-attachments" as const }] : []),
			{ label: "I've checked the item and note", value: "create" as const, cta: true },
			{ label: "Close", value: "cancel" as const },
		],
		{
			title: entry.title === entry.itemkey ? "Open item in Zotero" : entry.title,
			itemkey: entry.itemkey,
			libraryURI: entry.libraryURI,
			notePath: entry.notePath,
			noteOpenFollowUp: "Return to Zotero reviews after checking the note.",
			...(attachmentDetails ? { recoveryPaths: attachmentDetails.paths } : {}),
		});
	if (choice === "repair-attachments") {
		try {
			requestUncertainAttachmentRepair(entry.key, randomUUID());
			new Notice("Waiting for Zotero to copy and repair the attachment links.", 10000);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error), 10000);
			return false;
		}
		return true;
	}
	if (choice !== "create") return false;
	try {
		acknowledgeUncertainReview(entry.key);
		new Notice("Waiting for Zotero to acknowledge the check. The note will be rechecked.", 10000);
		return true;
	} catch (error) {
		new Notice(error instanceof Error ? error.message : String(error), 10000);
		return false;
	}
}

function requestIndividualReview(entry: PendingReview): void {
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
}

export function setupReviewStatus(app: App, status: HTMLElement, settings?: DuplicateReviewSettings): () => void {
	const button = status.createEl("button", { cls: "lit-note-review-status" });
	let overview: ReviewOverviewModal | undefined;
	const fileOpen = app.workspace.on("file-open", () => overview?.close());
	let count = 0;
	let announced = false;
	let arrival: Notice | undefined;
	let progress: Notice | undefined;
	let scanning: string | undefined;
	setReviewListener((reviews, batch, scan) => {
		reviews = reviews.filter((entry) => !entry.automaticAttachment);
		overview?.update(groupsFor(reviews), reviews.length);
		const scanPending = scan?.status === "pending" && !scan.recoveryOnly;
		const scanFailed = scan?.status === "error";
		// Without this, a requested check that finds nothing ends silently: the status bar item just disappears.
		if (scan?.requested && scanning === scan.scanId && !scanPending) {
			if (scanFailed) new Notice(`Zotero could not finish checking the literature notes${scan.error ? `: ${scan.error}` : "."}`, 15000);
			else if (!reviews.length) new Notice("Zotero finished checking all literature notes. Nothing needs review.", 10000);
			else {
				arrival?.hide();
				announced = false;
			}
		}
		scanning = scanPending ? scan.scanId : undefined;
		status.hidden = !scanPending && !scanFailed && reviews.length === 0;
		const interrupted = batch && batch.kind !== "attachment-repair" ? reviews.filter((entry) => entry.uncertain &&
			(entry.operation === batch.kind || (batch.kind === "library-uri" && entry.operation === "library-recheck"))).length : 0;
		button.setText(scanPending ? "Checking Zotero/Obsidian match..." : scanFailed ? "Zotero/Obsidian check failed" : `Zotero reviews: ${reviews.length}`);
		button.title = scanFailed
			? `Could not check Zotero and Obsidian for inconsistencies${scan.error ? `: ${scan.error}` : ""}. Keep both apps open while Zotero retries.`
			: batch
				? `${batch.completed}/${batch.total} checked${batch.rechecking ? `, ${batch.rechecking} rechecking` : ""}${interrupted ? `, ${interrupted} ${interrupted === 1 ? "needs" : "need"} checking` : ""}`
				: scanPending ? "Checking Zotero and Obsidian for inconsistencies."
					: "Open Zotero reviews";
		if (!scanPending && !scanFailed && reviews.length && !announced) {
			arrival = new Notice("Zotero reviews need attention. Click Zotero reviews in the status bar to see them.", 0);
			announced = true;
		}
		if (!scanPending && !scanFailed && !reviews.length && count && !batch) {
			arrival?.hide();
			arrival = undefined;
			new Notice("All Zotero reviews are complete.", 10000);
		}
		count = reviews.length;
		if (batch) {
			const message = interrupted
				? `${interrupted} update${interrupted === 1 ? " may" : "s may"} be incomplete. Select Zotero reviews in the status bar to check ${interrupted === 1 ? "it" : "them"}. ${batch.completed} of ${batch.total} notes checked; other updates may still be running.`
				: `${batch.kind === "attachment-repair" ? "Copying and linking attachments for" : batch.kind === "attachment-move" ? "Moving or copying attachments and relinking" : "Correcting"} ${batch.total} note${batch.total === 1 ? "" : "s"}: ${batch.completed} of ${batch.total} checked${batch.rechecking ? `; ${batch.rechecking} awaiting recheck` : ""}. Keep the updated Zotero companion running.`;
			if (!progress) progress = new Notice(message, 0);
			else progress.setMessage(message);
			if (batch.completed === batch.total && !batch.rechecking) {
				progress.hide();
				progress = undefined;
				const failed = batch.total - batch.succeeded;
				const result = batch.kind === "library-uri"
					? `Added zotero_library_uri ${batch.label} to ${batch.succeeded} of ${batch.total} notes.`
					: batch.kind === "attachment-move" || batch.kind === "attachment-repair"
						? `Linked Zotero attachments and Obsidian notes for ${batch.succeeded} of ${batch.total} notes.`
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
			if (scanPending) {
				new Notice("Checking Zotero and Obsidian for inconsistencies. The full list will appear when the check finishes.", 10000);
				return;
			}
			if (scanFailed) {
				new Notice(`Could not check Zotero and Obsidian for inconsistencies${scan.error ? `: ${scan.error}` : ""}. Keep both apps open while Zotero retries.`, 0);
				return;
			}
			arrival?.hide();
			arrival = undefined;
			if (overview) return;
			overview = new ReviewOverviewModal(app, (group) => openGroup(app, group), (group, entry) => {
				if (group.kind === "uncertain") {
					void reviewUncertainItem(app, entry).catch((error: unknown) => {
						console.error("Could not open the Zotero review", error);
						new Notice(`Could not open the Zotero review: ${error instanceof Error ? error.message : String(error)}`, 10000);
					});
				}
				else if (settings && isDuplicateReview(entry)) {
					overview?.close();
					void compareDuplicateReview(app, settings, entry);
				}
				else if (group.kind !== "awaiting-ack") requestIndividualReview(entry);
			}, () => { overview = undefined; });
			overview.update(groupsFor(reviews), reviews.length);
			overview.open();
		};
	});
	const stopWatching = settings ? watchDuplicateReviews(app, settings) : undefined;
	return () => {
		stopWatching?.();
		setReviewListener();
		app.workspace.offref(fileOpen);
		overview?.close();
		arrival?.hide();
		progress?.hide();
	};
}
