import type { ZoteroItemPayload } from "./types";
import type { CitekeyConflictDetails, DecisionButton } from "./decisionModal";

export interface BulkProposal {
	summary: string;
	title: string;
	message: string;
	buttons: DecisionButton[];
	conflict?: CitekeyConflictDetails;
}

export interface AttachmentMoveOperation {
	itemkey: string;
	mode: "linked" | "stored";
	basename: string;
	sourcePath: string;
	destinationPath: string;
	/**
	 * move: put the Zotero file at destinationPath (conflicts follow the batch strategy).
	 * newest: the destination is the note's file with the same name; keep the newest non-empty copy.
	 * keep-destination: link Zotero to the identical note file at destinationPath.
	 * trash: the Zotero attachment duplicates the kept file at destinationPath; move it to Zotero's trash.
	 */
	resolution: "move" | "newest" | "keep-destination" | "trash";
	conflict: boolean;
	identical: boolean;
	sourceMtime: number;
	destinationMtime?: number;
}

export interface AttachmentMoveCandidate {
	baseDirectory: string;
	attachments: AttachmentMoveOperation[];
	/** Absolute paths of vault files linked only by the note; Zotero links them to the item. */
	linkNoteFiles: string[];
	/** Vault paths of duplicate or empty note files to trash if nothing else links to them. */
	trashNoteFiles: string[];
	trashNoteSnapshots?: Array<{ path: string; size: number; mtime: number; ctime: number; sha256: string }>;
	/**
	 * Files found only in Zotero or only in the note, moved into the vault and linked from both, plus
	 * note links to missing or empty files that no Zotero file replaces. All are recorded as a mismatch.
	 */
	extras: Array<{ path: string; origin: "zotero" | "note" | "missing" }>;
}

export interface PendingReview {
	key: string;
	itemkey: string;
	libraryURI: string;
	title: string;
	notePath?: string;
	reason: string;
	requested: boolean;
	libraryNotePath?: string;
	operation?: "library-uri" | "library-recheck" | "note-update" | "attachment-move";
	proposal?: BulkProposal;
	attachmentMove?: AttachmentMoveCandidate;
	attachmentStrategy?: "newest" | "zotero" | "skip";
	recheckStartedAt?: number;
	uncertain?: boolean;
	uncertainReason?: string;
	awaitingAcknowledgement?: boolean;
}

export interface ReviewBatch {
	kind: "library-uri" | "note-update" | "attachment-move";
	label: string;
	total: number;
	completed: number;
	succeeded: number;
	rechecking: number;
	recheckFailed: number;
}

const pending = new Map<string, PendingReview>();
const acknowledgedUncertain = new Map<string, { itemkey: string; libraryURI: string }>();
const activeReviews = new Map<string, number>();
let batch: ReviewBatch | undefined;
let onChange: ((reviews: PendingReview[], batch?: ReviewBatch) => void) | undefined;

export function reviewKey(item: Pick<ZoteroItemPayload, "itemkey" | "libraryURI">): string {
	return JSON.stringify([item.libraryURI, item.itemkey]);
}

function notify(): void {
	onChange?.([...pending.values()], batch && { ...batch });
}

export function setReviewListener(listener?: (reviews: PendingReview[], batch?: ReviewBatch) => void): void {
	onChange = listener;
	notify();
}

export function queueReview(item: ZoteroItemPayload, reason: string, notePath?: string, libraryNotePath?: string, proposal?: BulkProposal, attachmentMove?: AttachmentMoveCandidate): void {
	if (!item.itemkey || !item.libraryURI) throw new Error("Cannot queue a review without a Zotero item and library identity.");
	const key = reviewKey(item);
	pending.set(key, {
		key, itemkey: item.itemkey, libraryURI: item.libraryURI,
		title: item.title || item.citekey || item.itemkey,
		notePath: notePath ?? pending.get(key)?.notePath, reason, libraryNotePath: pending.get(key)?.operation === "library-recheck" ? undefined : libraryNotePath,
		proposal: pending.get(key)?.operation === "note-update" ? pending.get(key)?.proposal : proposal,
		attachmentMove: pending.get(key)?.operation === "attachment-move" ? pending.get(key)?.attachmentMove : attachmentMove,
		attachmentStrategy: pending.get(key)?.attachmentStrategy,
		requested: pending.get(key)?.requested ?? false,
		operation: pending.get(key)?.operation,
		recheckStartedAt: pending.get(key)?.recheckStartedAt,
		uncertain: pending.get(key)?.uncertain,
		uncertainReason: pending.get(key)?.uncertainReason,
		awaitingAcknowledgement: pending.get(key)?.awaitingAcknowledgement,
	});
	notify();
}

export function requestAttachmentBatch(
	selected: Array<{ key: string; candidate: AttachmentMoveCandidate }>,
	strategy: "newest" | "zotero" | "skip",
): void {
	if (batch) throw new Error("A bulk correction is already running.");
	const keys = selected.map((entry) => entry.key);
	if (!keys.length || new Set(keys).size !== keys.length) throw new Error("No matching attachments are available for bulk correction.");
	const entries = keys.map((key) => pending.get(key));
	if (entries.some((entry, index) => !entry || !entry.attachmentMove ||
		JSON.stringify(entry.attachmentMove) !== JSON.stringify(selected[index].candidate) || entry.requested ||
		entry.uncertain || acknowledgedUncertain.has(entry.key))) {
		throw new Error("The review list changed. Select the group again.");
	}
	batch = { kind: "attachment-move", label: strategy, total: entries.length, completed: 0, succeeded: 0, rechecking: 0, recheckFailed: 0 };
	for (const entry of entries) {
		if (!entry) throw new Error("The review list changed. Select the group again.");
		entry.requested = true;
		entry.operation = "attachment-move";
		entry.attachmentStrategy = strategy;
	}
	notify();
}

export function requestLibraryBatch(libraryURI: string, selected: Array<{ key: string; notePath: string }>): void {
	if (batch) throw new Error("A bulk correction is already running.");
	const keys = selected.map((entry) => entry.key);
	if (!keys.length || new Set(keys).size !== keys.length) throw new Error("No matching notes are available for bulk correction.");
	const entries = keys.map((key) => pending.get(key));
	if (entries.some((entry, index) => !entry || entry.libraryURI !== libraryURI || entry.libraryNotePath !== selected[index].notePath ||
		entry.requested || entry.uncertain || acknowledgedUncertain.has(entry.key))) {
		throw new Error("The review list changed. Select the group again.");
	}
	batch = { kind: "library-uri", label: libraryURI, total: entries.length, completed: 0, succeeded: 0, rechecking: 0, recheckFailed: 0 };
	for (const entry of entries) {
		if (!entry) throw new Error("The review list changed. Select the group again.");
		entry.requested = true;
		entry.operation = "library-uri";
	}
	notify();
}

export function requestNoteBatch(summary: string, selected: Array<{ key: string; proposal: BulkProposal }>): void {
	if (batch) throw new Error("A bulk correction is already running.");
	const keys = selected.map((entry) => entry.key);
	if (!keys.length || new Set(keys).size !== keys.length) throw new Error("No matching notes are available for bulk correction.");
	const entries = keys.map((key) => pending.get(key));
	if (entries.some((entry, index) => !entry || entry.proposal?.summary !== summary ||
		JSON.stringify(entry.proposal) !== JSON.stringify(selected[index].proposal) || entry.requested ||
		entry.uncertain || acknowledgedUncertain.has(entry.key))) {
		throw new Error("The review list changed. Select the group again.");
	}
	batch = { kind: "note-update", label: summary, total: entries.length, completed: 0, succeeded: 0, rechecking: 0, recheckFailed: 0 };
	for (const entry of entries) {
		if (!entry) throw new Error("The review list changed. Select the group again.");
		entry.requested = true;
		entry.operation = "note-update";
	}
	notify();
}

export function finishLibraryCorrection(key: string, error?: string): void {
	const entry = pending.get(key);
	if (!entry || entry.operation !== "library-uri" || !batch) return;
	if (error) {
		entry.reason = error;
		entry.requested = false;
		entry.operation = undefined;
	}
	else {
		entry.notePath = entry.libraryNotePath;
		entry.libraryNotePath = undefined;
		entry.operation = "library-recheck";
		entry.recheckStartedAt = Date.now();
		batch.rechecking++;
		batch.succeeded++;
	}
	batch.completed++;
	notify();
	if (batch.completed === batch.total && !batch.rechecking) {
		batch = undefined;
		notify();
	}
}

export function finishLibraryRecheck(key: string, resolved: boolean, error?: string): void {
	const entry = pending.get(key);
	if (!entry || entry.operation !== "library-recheck" || !batch) return;
	if (resolved && !entry.uncertain) pending.delete(key);
	else {
		entry.requested = false;
		entry.operation = undefined;
		entry.recheckStartedAt = undefined;
		if (error) entry.reason = error;
	}
	if (error) batch.recheckFailed++;
	batch.rechecking--;
	notify();
	if (batch.completed === batch.total && !batch.rechecking) {
		batch = undefined;
		notify();
	}
}

export function finishNoteCorrection(key: string, error?: string): void {
	const entry = pending.get(key);
	if (!entry || entry.operation !== "note-update" || !batch) return;
	entry.requested = false;
	entry.operation = undefined;
	if (error) {
		entry.reason = error;
		entry.proposal = undefined;
	} else {
		if (!entry.uncertain) pending.delete(key);
		batch.succeeded++;
	}
	batch.completed++;
	notify();
	if (batch.completed === batch.total) {
		batch = undefined;
		notify();
	}
}

export function finishAttachmentCorrection(key: string, error?: string): void {
	const entry = pending.get(key);
	if (!entry || entry.operation !== "attachment-move" || !batch) return;
	entry.requested = false;
	entry.operation = undefined;
	entry.attachmentStrategy = undefined;
	if (error) {
		entry.reason = error;
		entry.attachmentMove = undefined;
	}
	else {
		if (!entry.uncertain) pending.delete(key);
		batch.succeeded++;
	}
	batch.completed++;
	notify();
	if (batch.completed === batch.total) {
		batch = undefined;
		notify();
	}
}

export function requestReview(key: string): void {
	const entry = pending.get(key);
	if (!entry) throw new Error("This review is no longer pending.");
	if (entry.uncertain) throw new Error("Check both apps and acknowledge the interrupted operation first.");
	if (acknowledgedUncertain.has(key)) throw new Error("Wait for Zotero to acknowledge the checked operation.");
	entry.requested = true;
	notify();
}

export function beginReviewOperation(key: string): void {
	activeReviews.set(key, (activeReviews.get(key) ?? 0) + 1);
}

export function endReviewOperation(key: string): void {
	const count = activeReviews.get(key) ?? 0;
	if (count <= 1) activeReviews.delete(key);
	else activeReviews.set(key, count - 1);
}

export function markReviewUncertain(item: { itemkey: string; libraryURI: string; error?: string }): void {
	const key = reviewKey(item);
	if (acknowledgedUncertain.has(key)) return;
	let entry = pending.get(key);
	if (!entry) {
		queueReview({ ...item, title: item.itemkey, citekey: item.itemkey }, "Interrupted operation needs checking");
		entry = pending.get(key);
	}
	if (!entry) throw new Error("Could not record the interrupted review.");
	if (entry.uncertain && (!item.error || entry.uncertainReason === item.error)) return;
	entry.uncertain = true;
	if (item.error) entry.uncertainReason = item.error;
	notify();
}

export function acknowledgeUncertainReview(key: string): void {
	const entry = pending.get(key);
	if (!entry?.uncertain) throw new Error("This interrupted operation is no longer pending.");
	if (activeReviews.has(key)) throw new Error("Obsidian is still processing this review. Wait for it to finish before checking both apps.");
	if (entry.operation === "library-uri") finishLibraryCorrection(key, "Operation interrupted; check both apps.");
	else if (entry.operation === "library-recheck") finishLibraryRecheck(key, false, "Operation interrupted; check both apps.");
	else if (entry.operation === "attachment-move") finishAttachmentCorrection(key, "Operation interrupted; check both apps.");
	else if (entry.operation === "note-update") finishNoteCorrection(key, "Operation interrupted; check both apps.");
	entry.uncertain = false;
	entry.awaitingAcknowledgement = true;
	entry.requested = false;
	entry.operation = undefined;
	acknowledgedUncertain.set(key, { itemkey: entry.itemkey, libraryURI: entry.libraryURI });
	notify();
}

export function acknowledgedUncertainReviews(): Array<{ itemkey: string; libraryURI: string }> {
	return [...acknowledgedUncertain.values()];
}

export function isReviewBlocked(key: string): boolean {
	const entry = pending.get(key);
	return !!(entry?.uncertain || entry?.awaitingAcknowledgement);
}

export function consumeUncertainAcknowledgement(item: { itemkey: string; libraryURI: string }): void {
	const key = reviewKey(item);
	if (!acknowledgedUncertain.delete(key)) return;
	if (pending.get(key)?.awaitingAcknowledgement) pending.delete(key);
	notify();
}

export function requestedReviews(): PendingReview[] {
	return [...pending.values()].filter((entry) => entry.requested);
}

export function allReviews(): PendingReview[] {
	return [...pending.values()];
}

export function resetReviewRequest(key: string): void {
	const entry = pending.get(key);
	if (entry) {
		entry.requested = false;
		notify();
	}
}

export function failReview(item: Pick<ZoteroItemPayload, "itemkey" | "libraryURI">, reason: string): void {
	const entry = pending.get(reviewKey(item));
	if (entry) {
		if (entry.uncertain || entry.awaitingAcknowledgement) return;
		if (entry.operation === "library-uri") {
			finishLibraryCorrection(entry.key, reason);
			return;
		}
		if (entry.operation === "library-recheck") {
			finishLibraryRecheck(entry.key, false, reason);
			return;
		}
		if (entry.operation === "attachment-move") {
			finishAttachmentCorrection(entry.key, reason);
			return;
		}
		if (entry.operation === "note-update") {
			finishNoteCorrection(entry.key, reason);
			return;
		}
		entry.reason = reason;
		entry.requested = false;
		notify();
	}
}

export function removeReview(key: string): void {
	if (pending.get(key)?.operation || pending.get(key)?.uncertain || pending.get(key)?.awaitingAcknowledgement) return;
	if (pending.delete(key)) notify();
}

export function clearReviews(): void {
	pending.clear();
	acknowledgedUncertain.clear();
	batch = undefined;
	notify();
}
