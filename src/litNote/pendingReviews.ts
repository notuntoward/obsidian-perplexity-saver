import type { ZoteroAttachment, ZoteroItemPayload } from "./types";
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
	snapshotDirectory?: boolean;
	sourceMissing?: true;
	/**
	 * move: put the Zotero file at destinationPath (conflicts follow the batch strategy).
	 * newest: the destination is the note's file with the same name; keep the newest non-empty copy.
	 * keep-destination: link Zotero to the identical note file at destinationPath.
	 * trash: the Zotero attachment duplicates the kept file at destinationPath; move it to Zotero's trash.
	 */
	resolution: "move" | "newest" | "keep-destination" | "keep-note" | "trash";
	conflict: boolean;
	identical: boolean;
	sourceMtime?: number;
	destinationMtime?: number;
}

export interface AttachmentMoveCandidate {
	baseDirectory: string;
	automatic?: boolean;
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
	missingItemKey?: true;
	requested: boolean;
	libraryNotePath?: string;
	operation?: "library-uri" | "library-recheck" | "note-update" | "attachment-move" | "attachment-repair";
	repairId?: string;
	repairSnapshot?: string;
	proposal?: BulkProposal;
	attachmentMove?: AttachmentMoveCandidate;
	automaticAttachment?: boolean;
	automaticRecovery?: boolean;
	attachmentStrategy?: "newest" | "zotero" | "skip";
	recheckStartedAt?: number;
	uncertain?: boolean;
	uncertainReason?: string;
	uncertainOperation?: string;
	uncertainAttachments?: ZoteroAttachment[];
	uncertainAttachmentCheckError?: string;
	uncertainAttachmentPaths?: Array<{ itemkey: string; sourcePath: string; destinationPath: string }>;
	awaitingAcknowledgement?: boolean;
}

export interface ReviewBatch {
	kind: "library-uri" | "note-update" | "attachment-move" | "attachment-repair";
	label: string;
	total: number;
	completed: number;
	succeeded: number;
	rechecking: number;
	recheckFailed: number;
}

export interface InitialReviewScanState {
	scanId: string;
	status: "pending" | "complete" | "paused" | "error";
	error?: string;
	/** Started because the user ran "Check all literature notes against Zotero again". */
	requested?: true;
	recoveryOnly?: true;
}

export class ReviewScanCompleteError extends Error {
	constructor() {
		super("The Zotero review scan is complete. Run \"Check all literature notes against Zotero again\" to check new issues.");
	}
}

export class ReviewScanBusyError extends Error {
	constructor() {
		super("A Zotero review update is still running; retry the initial review scan when it finishes.");
	}
}

const pending = new Map<string, PendingReview>();
const acknowledgedUncertain = new Map<string, { itemkey: string; libraryURI: string }>();
const activeReviews = new Map<string, number>();
const uncertainRevisions = new Map<string, number>();
const repairBatchKeys = new Set<string>();
const initialReviewScans = new Map<string, InitialReviewScanState>();
const replacedReviewScanIds = new Set<string>();
let batch: ReviewBatch | undefined;
let currentInitialReviewScanId: string | undefined;
let rescanRequest: string | undefined;
let onChange: ((reviews: PendingReview[], batch?: ReviewBatch, scan?: InitialReviewScanState) => void) | undefined;

/**
 * Ask Zotero to check every literature note again without restarting either app. The request is
 * included in Zotero's next poll and cleared when Zotero starts the new scan.
 */
export function requestRescan(): string {
	rescanRequest ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return rescanRequest;
}

export function pendingRescan(): string | undefined {
	return rescanRequest;
}

export function reviewKey(item: Pick<ZoteroItemPayload, "itemkey" | "libraryURI">): string {
	return JSON.stringify([item.libraryURI, item.itemkey]);
}

function notify(): void {
	const scan = currentInitialReviewScanId ? initialReviewScans.get(currentInitialReviewScanId) : undefined;
	onChange?.([...pending.values()], batch && { ...batch }, scan && { ...scan });
}

export function setReviewListener(listener?: (reviews: PendingReview[], batch?: ReviewBatch, scan?: InitialReviewScanState) => void): void {
	onChange = listener;
	notify();
}

export function startInitialReviewScan(scanId: string, preserveExisting = false): InitialReviewScanState {
	if (!scanId.trim()) throw new Error("scanId must not be empty.");
	if (replacedReviewScanIds.has(scanId)) throw new Error("This initial review scan was replaced by a newer Zotero session.");
	const existing = initialReviewScans.get(scanId);
	if (existing) {
		if (existing.status === "error") {
			if (currentInitialReviewScanId !== scanId) {
				throw new Error("This initial review scan is no longer current; retry with the current scanId.");
			}
			initialReviewScans.set(scanId, { scanId, status: "pending", ...(existing.requested ? { requested: true as const } : {}), ...(existing.recoveryOnly ? { recoveryOnly: true as const } : {}) });
			notify();
		}
		return { ...(initialReviewScans.get(scanId) ?? existing) };
	}
	const current = currentInitialReviewScanId ? initialReviewScans.get(currentInitialReviewScanId) : undefined;
	if (current) {
		// A new scan ID means Zotero restarted; its scan replaces the old one. Ordinary reviews are
		// dropped because the new scan reports the ones that still apply. Interrupted or unacknowledged
		// work is kept, and nothing is replaced while an update is still running.
		if (batch || activeReviews.size || [...pending.values()].some((entry) => entry.operation)) {
			throw new ReviewScanBusyError();
		}
		if (!preserveExisting) {
			for (const [key, entry] of pending) {
				if (!entry.uncertain && !entry.awaitingAcknowledgement) pending.delete(key);
			}
		}
		for (const id of initialReviewScans.keys()) replacedReviewScanIds.add(id);
		initialReviewScans.clear();
	}
	const scan: InitialReviewScanState = { scanId, status: "pending", ...(preserveExisting ? { recoveryOnly: true as const } : {}), ...(!preserveExisting && rescanRequest ? { requested: true as const } : {}) };
	initialReviewScans.set(scanId, scan);
	currentInitialReviewScanId = scanId;
	if (!preserveExisting) rescanRequest = undefined;
	notify();
	return { ...scan };
}

export function endInitialReviewScan(scanId: string, status: "complete" | "paused" | "error", error?: string): InitialReviewScanState {
	const scan = initialReviewScans.get(scanId);
	if (!scan) {
		throw new Error("No matching initial review scan is pending.");
	}
	if (scan.status === "complete" || scan.status === "paused" || (scan.status === "error" && status === "error")) return { ...scan };
	if (currentInitialReviewScanId !== scanId || scan.status !== "pending") {
		if (scan.status === "error" && status === "complete") {
			throw new Error("Retry the initial review scan before completing it.");
		}
		throw new Error("This initial review scan is no longer pending.");
	}
	const updated: InitialReviewScanState = status === "error"
		? { scanId, status, ...(error ? { error } : {}), ...(scan.requested ? { requested: true as const } : {}), ...(scan.recoveryOnly ? { recoveryOnly: true as const } : {}) }
		: { scanId, status, ...(scan.requested ? { requested: true as const } : {}), ...(scan.recoveryOnly ? { recoveryOnly: true as const } : {}) };
	initialReviewScans.set(scanId, updated);
	notify();
	return { ...updated };
}

export function currentInitialReviewScan(): InitialReviewScanState | undefined {
	const scan = currentInitialReviewScanId ? initialReviewScans.get(currentInitialReviewScanId) : undefined;
	return scan && { ...scan };
}

export function replaceMissingItemKeyReviews(paths: string[]): void {
	for (const [key, entry] of pending) {
		if (entry.missingItemKey) pending.delete(key);
	}
	for (const notePath of paths) {
		const key = `missing-item-key:${notePath}`;
		pending.set(key, {
			key, itemkey: "", libraryURI: "", notePath,
			title: notePath.split("/").pop() ?? notePath,
			reason: "Missing Zotero item key", missingItemKey: true, requested: false,
		});
	}
	notify();
}

export function queueReview(item: ZoteroItemPayload, reason: string, notePath?: string, libraryNotePath?: string, proposal?: BulkProposal, attachmentMove?: AttachmentMoveCandidate): void {
	if (!item.itemkey || !item.libraryURI) throw new Error("Cannot queue a review without a Zotero item and library identity.");
	const key = reviewKey(item);
	if (currentInitialReviewScan()?.status === "complete" && !pending.has(key)) {
		throw new ReviewScanCompleteError();
	}
	pending.set(key, {
		key, itemkey: item.itemkey, libraryURI: item.libraryURI,
		title: item.title || item.citekey || item.itemkey,
		notePath: notePath ?? pending.get(key)?.notePath, reason, libraryNotePath: pending.get(key)?.operation === "library-recheck" ? undefined : libraryNotePath,
		proposal: pending.get(key)?.operation === "note-update" ? pending.get(key)?.proposal : proposal,
		attachmentMove: pending.get(key)?.operation === "attachment-move" ? pending.get(key)?.attachmentMove : attachmentMove,
		automaticAttachment: pending.get(key)?.automaticAttachment,
		attachmentStrategy: pending.get(key)?.attachmentStrategy,
		requested: pending.get(key)?.requested ?? false,
		operation: pending.get(key)?.operation,
		repairId: pending.get(key)?.repairId,
		repairSnapshot: pending.get(key)?.repairSnapshot,
		recheckStartedAt: pending.get(key)?.recheckStartedAt,
		uncertain: pending.get(key)?.uncertain,
		uncertainReason: pending.get(key)?.uncertainReason,
		uncertainOperation: pending.get(key)?.uncertainOperation,
		uncertainAttachments: pending.get(key)?.uncertainAttachments,
		uncertainAttachmentCheckError: pending.get(key)?.uncertainAttachmentCheckError,
		uncertainAttachmentPaths: pending.get(key)?.uncertainAttachmentPaths,
		awaitingAcknowledgement: pending.get(key)?.awaitingAcknowledgement,
	});
	notify();
}

export function requestAutomaticAttachment(key: string, snapshot: string, recovery = false): void {
	const entry = pending.get(key);
	if (!entry?.attachmentMove?.automatic || entry.requested || entry.uncertain || entry.awaitingAcknowledgement) {
		throw new Error("The automatic attachment plan is no longer available.");
	}
	entry.requested = true;
	entry.operation = "attachment-move";
	entry.automaticAttachment = true;
	if (recovery) entry.automaticRecovery = true;
	entry.repairSnapshot = snapshot;
	entry.attachmentStrategy = "newest";
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
	if (!entry || entry.operation !== "attachment-move") return;
	if (entry.automaticAttachment) {
		pending.delete(key);
		notify();
		return;
	}
	if (!batch) return;
	entry.requested = false;
	entry.operation = undefined;
	entry.attachmentStrategy = undefined;
	if (error) {
		entry.reason = error;
		entry.attachmentMove = undefined;
		entry.repairSnapshot = undefined;
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
	if (entry.missingItemKey) throw new Error("Open the note and add its Zotero item key before requesting a review.");
	if (entry.uncertain) throw new Error("Check both apps and acknowledge the interrupted operation first.");
	if (acknowledgedUncertain.has(key)) throw new Error("Wait for Zotero to acknowledge the checked operation.");
	entry.requested = true;
	notify();
}

export function requestUncertainAttachmentRepair(key: string, repairId: string): void {
	const entry = pending.get(key);
	if (!entry?.uncertain || entry.uncertainOperation !== "attachment-move" || entry.requested || activeReviews.has(key)) {
		throw new Error("This interrupted attachment review is no longer available for repair.");
	}
	entry.requested = true;
	entry.operation = "attachment-repair";
	entry.repairId = repairId;
	entry.attachmentMove = undefined;
	entry.repairSnapshot = undefined;
	notify();
}

export function requestUncertainAttachmentRepairBatch(selected: Array<{ key: string; repairId: string }>): void {
	if (batch) throw new Error("A bulk correction is already running.");
	const keys = selected.map((entry) => entry.key);
	if (!keys.length || new Set(keys).size !== keys.length) throw new Error("No interrupted attachment repairs are available.");
	const entries = keys.map((key) => pending.get(key));
	if (entries.some((entry, index) => !entry?.uncertain || entry.uncertainOperation !== "attachment-move" ||
		entry.requested || activeReviews.has(entry.key) || !selected[index].repairId)) {
		throw new Error("The review list changed. Select the group again.");
	}
	batch = { kind: "attachment-repair", label: "", total: entries.length, completed: 0, succeeded: 0, rechecking: 0, recheckFailed: 0 };
	for (const key of keys) repairBatchKeys.add(key);
	for (const [index, entry] of entries.entries()) {
		if (!entry) throw new Error("The review list changed. Select the group again.");
		entry.requested = true;
		entry.operation = "attachment-repair";
		entry.repairId = selected[index].repairId;
		entry.attachmentMove = undefined;
		entry.repairSnapshot = undefined;
	}
	notify();
}

export function finishUncertainAttachmentRepair(key: string, error?: string): void {
	const entry = pending.get(key);
	if (!entry || entry.operation !== "attachment-repair") return;
	const repairBatch = batch?.kind === "attachment-repair" && repairBatchKeys.has(key) ? batch : undefined;
	entry.requested = false;
	entry.operation = undefined;
	entry.repairId = undefined;
	entry.attachmentMove = undefined;
	if (error) {
		entry.uncertainReason = error;
		repairBatchKeys.delete(key);
	}
	else {
		entry.uncertain = false;
		entry.awaitingAcknowledgement = true;
		acknowledgedUncertain.set(key, { itemkey: entry.itemkey, libraryURI: entry.libraryURI });
		if (repairBatch) {
			repairBatch.succeeded++;
			repairBatch.rechecking++;
		}
	}
	if (repairBatch) repairBatch.completed++;
	notify();
	if (repairBatch && repairBatch.completed === repairBatch.total && !repairBatch.rechecking) {
		batch = undefined;
		notify();
	}
}

export function beginReviewOperation(key: string): void {
	activeReviews.set(key, (activeReviews.get(key) ?? 0) + 1);
}

export function endReviewOperation(key: string): void {
	const count = activeReviews.get(key) ?? 0;
	if (count <= 1) activeReviews.delete(key);
	else activeReviews.set(key, count - 1);
}

export function markReviewUncertain(item: { itemkey: string; libraryURI: string; error?: string; title?: string; notePath?: string; operation?: string; attachments?: ZoteroAttachment[]; attachmentCheckError?: string; attachmentPaths?: Array<{ itemkey: string; sourcePath: string; destinationPath: string }> }): void {
	const key = reviewKey(item);
	if (acknowledgedUncertain.has(key)) return;
	let entry = pending.get(key);
	if (!entry) {
		queueReview({ ...item, title: item.title || item.itemkey, citekey: item.itemkey }, "Interrupted operation needs checking", item.notePath);
		entry = pending.get(key);
	}
	if (!entry) throw new Error("Could not record the interrupted review.");
	const title = item.title && entry.title === entry.itemkey ? item.title : entry.title;
	const notePath = entry.notePath || item.notePath;
	const operation = item.operation || entry.uncertainOperation || entry.operation;
	const attachments = item.operation === "attachment-move" ? item.attachments : entry.uncertainAttachments;
	const attachmentPaths = item.attachmentPaths ?? entry.uncertainAttachmentPaths;
	uncertainRevisions.set(key, (uncertainRevisions.get(key) ?? 0) + 1);
	if (entry.uncertain && (!item.error || entry.uncertainReason === item.error) &&
		entry.title === title && entry.notePath === notePath && entry.uncertainOperation === operation &&
		JSON.stringify(entry.uncertainAttachments) === JSON.stringify(attachments) &&
		entry.uncertainAttachmentCheckError === item.attachmentCheckError &&
		JSON.stringify(entry.uncertainAttachmentPaths) === JSON.stringify(attachmentPaths)) return;
	entry.title = title;
	entry.notePath = notePath;
	entry.uncertainOperation = operation;
	entry.uncertainAttachments = attachments;
	entry.uncertainAttachmentCheckError = item.attachmentCheckError;
	entry.uncertainAttachmentPaths = attachmentPaths;
	entry.uncertain = true;
	if (item.error) entry.uncertainReason = item.error;
	notify();
}

export function beginInterruptedRecovery(key: string): number {
	const entry = pending.get(key);
	if (activeReviews.has(key) || entry?.requested || entry?.operation || acknowledgedUncertain.has(key) || entry?.awaitingAcknowledgement) {
		throw new Error("The interrupted review is still being processed.");
	}
	return uncertainRevisions.get(key) ?? 0;
}

export function finishInterruptedRecovery(key: string, revision: number, resolved: boolean): void {
	if ((activeReviews.get(key) ?? 0) !== 1 || (uncertainRevisions.get(key) ?? 0) !== revision ||
		acknowledgedUncertain.has(key)) {
		throw new Error("The interrupted review changed while it was being checked.");
	}
	const entry = pending.get(key);
	if (!entry) return;
	if (entry.requested || entry.awaitingAcknowledgement || entry.operation) {
		throw new Error("The interrupted review is still being processed.");
	}
	if (resolved) pending.delete(key);
	else {
		entry.uncertain = false;
		entry.uncertainReason = undefined;
		entry.uncertainOperation = undefined;
		entry.uncertainAttachments = undefined;
		entry.uncertainAttachmentCheckError = undefined;
		entry.uncertainAttachmentPaths = undefined;
	}
	notify();
}

export function acknowledgeUncertainReview(key: string): void {
	const entry = pending.get(key);
	if (!entry?.uncertain) throw new Error("This interrupted operation is no longer pending.");
	if (entry.operation === "attachment-repair" && entry.requested) throw new Error("Wait for the attachment repair to finish before confirming.");
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
	if (pending.get(key)?.awaitingAcknowledgement) {
		pending.delete(key);
		if (batch?.kind === "attachment-repair" && repairBatchKeys.delete(key)) batch.rechecking--;
	}
	notify();
	if (batch?.kind === "attachment-repair" && batch.completed === batch.total && !batch.rechecking) {
		batch = undefined;
		notify();
	}
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
		if (entry.uncertain && entry.operation === "attachment-repair") {
			finishUncertainAttachmentRepair(entry.key, reason);
			return;
		}
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
	for (const key of activeReviews.keys()) uncertainRevisions.set(key, (uncertainRevisions.get(key) ?? 0) + 1);
	for (const key of uncertainRevisions.keys()) if (!activeReviews.has(key)) uncertainRevisions.delete(key);
	repairBatchKeys.clear();
	batch = undefined;
	initialReviewScans.clear();
	replacedReviewScanIds.clear();
	currentInitialReviewScanId = undefined;
	rescanRequest = undefined;
	notify();
}
