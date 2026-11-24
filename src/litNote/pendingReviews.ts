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
		JSON.stringify(entry.attachmentMove) !== JSON.stringify(selected[index].candidate) || entry.requested)) {
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
	if (entries.some((entry, index) => !entry || entry.libraryURI !== libraryURI || entry.libraryNotePath !== selected[index].notePath || entry.requested)) {
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
		JSON.stringify(entry.proposal) !== JSON.stringify(selected[index].proposal) || entry.requested)) {
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
	if (resolved) pending.delete(key);
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
		pending.delete(key);
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
		pending.delete(key);
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
	entry.requested = true;
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
	if (pending.get(key)?.operation) return;
	if (pending.delete(key)) notify();
}

export function clearReviews(): void {
	pending.clear();
	batch = undefined;
	notify();
}
