/**
 * Payload shapes sent by the Zotero companion plugin.
 * Mirrors the JSON produced by new_obsidian_note_sender.js and
 * open_obsidian_note_sender.js in refwrangle.
 */

import type { AttachmentMoveCandidate } from "./pendingReviews";

export interface ZoteroCreator {
	firstName?: string;
	lastName?: string;
	name?: string; // for single-field creators (e.g., institutions)
	creatorType?: string;
}

export interface ZoteroAttachment {
	itemkey?: string;
	title?: string;
	path?: string;
	url?: string;
	isFile?: boolean;
	mode?: "linked" | "stored" | "url";
	usesRelativePath?: boolean;
}

export interface ZoteroRelation {
	citekey?: string;
}

export interface CitationKeyCheck {
	citekey: string;
	matches: Array<{ title: string; citekey: string; libraryURI: string; itemkey: string }>;
}

export interface ZoteroItemPayload {
	title: string;
	citekey: string;
	bibliography?: string;
	tags?: string[];
	collections?: string[];
	exportDate?: string;
	desktopURI?: string;
	DOI?: string;
	url?: string;
	abstractNote?: string;
	creators?: ZoteroCreator[];
	date?: string;
	itemkey?: string;
	libraryURI?: string;
	libraryName?: string;
	libraryType?: "user" | "group";
	itemType?: string;
	publicationTitle?: string;
	volume?: string;
	issue?: string;
	publisher?: string;
	place?: string;
	pages?: string;
	ISBN?: string;
	allTags?: string[];
	notes?: string[]; // HTML strings
	attachments?: ZoteroAttachment[];
	linkedAttachmentBaseDirectory?: string;
	linkedAttachmentBaseDirectoryValidated?: boolean;
	/** The companion supports automatic, source-preserving attachment reconciliation. */
	automaticAttachments?: boolean;
	/** Filename (without extension) Zotero's renaming template produces for this item. */
	attachmentBaseName?: string;
	relations?: ZoteroRelation[];
	citationKeyCheck?: CitationKeyCheck;
	zoteroChanges?: {
		previousCitekey: string;
		attachmentMoves: Array<{ itemkey: string; from: string; to: string }>;
	};
}

export interface LitNoteCreateRequest {
	action: "create";
	/** The sender wraps items in a data array (matching existing sender JS shape). */
	data: ZoteroItemPayload[];
}

export interface LitNoteOpenRequest {
	action: "open";
	/** Full payloads, so a missing note can be created if the user chooses. */
	data?: ZoteroItemPayload[];
	/** Legacy single-citekey form; opens only, never creates. */
	citekey?: string;
}

export interface LitNoteSyncRequest {
	action: "sync" | "update" | "review-sync" | "bulk-review-sync" | "review-recheck" | "review-recover";
	data: ZoteroItemPayload[];
	automaticAttachmentPaths?: Array<{ itemkey: string; sourcePath: string; destinationPath: string; archivePath?: string; archiveDirectory?: string }>;
}

export interface LitNoteApplySyncRequest {
	action: "apply-sync" | "validate-zotero-key";
	token: string;
	data: ZoteroItemPayload[];
	zoteroAttachmentPaths?: string[];
}

export interface LitNoteCheckAttachmentBaseRequest {
	action: "check-attachment-base";
	baseDirectory: string;
}

export interface LitNoteReviewFailureRequest {
	action: "review-failed";
	itemkey: string;
	libraryURI: string;
	error: string;
}

export interface LitNoteInitialReviewScanStartRequest {
	action: "initial-review-scan-start";
	scanId: string;
}

export interface LitNoteInitialReviewScanEndRequest {
	action: "initial-review-scan-end";
	scanId: string;
	status: "complete" | "error";
	error?: string;
}

export interface LitNoteUncertainReviewRequest {
	action: "review-uncertain" | "review-uncertain-acknowledged";
	itemkey: string;
	libraryURI: string;
	error?: string;
	operation?: string;
	title?: string;
	attachments?: ZoteroAttachment[];
	attachmentCheckError?: string;
	attachmentPaths?: Array<{ itemkey: string; sourcePath: string; destinationPath: string; archivePath?: string; archiveDirectory?: string }>;
}

export interface LitNoteAttachmentMoveCompleteRequest {
	action: "attachment-move-complete" | "attachment-repair-complete";
	data: [ZoteroItemPayload];
	repairId?: string;
	automaticAttachment?: boolean;
	moved: Array<{ itemkey?: string; from: string; to: string; oldKey?: string; newKey?: string; archivePath?: string; archiveDirectory?: string; trashed?: boolean; preservedSource?: boolean; sourceMissing?: boolean; copied?: boolean; referenceCheckFailed?: boolean }>;
	linked?: Array<{ path: string; newKey: string }>;
}

export interface LitNoteAttachmentRepairPrepareRequest {
	action: "attachment-repair-prepare" | "attachment-auto-prepare";
	data: [ZoteroItemPayload];
	repairId?: string;
}

export interface LitNoteBulkLibraryRequest {
	action: "bulk-library-uri";
	data: [ZoteroItemPayload];
}

export interface LitNoteItemTrashCompleteRequest {
	action: "item-trash-complete";
	id: string;
	error?: string;
}

export type LitNoteRequest = LitNoteCreateRequest | LitNoteOpenRequest | LitNoteSyncRequest | LitNoteApplySyncRequest | LitNoteCheckAttachmentBaseRequest | LitNoteReviewFailureRequest | LitNoteInitialReviewScanStartRequest | LitNoteInitialReviewScanEndRequest | LitNoteUncertainReviewRequest | LitNoteAttachmentMoveCompleteRequest | LitNoteAttachmentRepairPrepareRequest | LitNoteBulkLibraryRequest | LitNoteItemTrashCompleteRequest;

export type LitNoteItemStatus =
	| "created"
	| "overwritten"
	| "opened"
	| "updated"
	| "set-zotero-key"
	| "prepared"
	| "pending-review"
	| "attachment-error"
	| "waiting-index"
	| "skipped"
	| "missing"
	| "error";

export interface LitNoteItemResult {
	citekey: string;
	status: LitNoteItemStatus;
	error?: string;
	noteCitekey?: string;
	expectedZoteroKey?: string;
	token?: string;
	needsAttachmentCheck?: boolean;
	deferUntilChanged?: boolean;
}

export interface LitNoteResponse {
	attachmentMove?: AttachmentMoveCandidate;
	initialReviewScan?: { scanId: string; status: "pending" | "complete" | "error"; error?: string };
	success: boolean;
	relationship?: "unset" | "inside" | "outside";
	vaultPath?: string;
	citekeys?: string[];
	identities?: Array<{ itemkey: string; notePath: string; libraryURI?: string; citekey: string; modifiedAt?: number; size?: number }>;
	requests?: Array<{
		itemkey: string;
		libraryURI: string;
		operation?: "library-uri" | "library-recheck" | "note-update" | "attachment-move" | "attachment-repair";
		repairId?: string;
		attachmentMove?: AttachmentMoveCandidate;
		strategy?: "newest" | "zotero" | "skip";
	}>;
	pending?: Array<{ itemkey: string; libraryURI: string; uncertain?: boolean }>;
	acknowledgedUncertain?: Array<{ itemkey: string; libraryURI: string }>;
	results?: LitNoteItemResult[];
	path?: string;
	error?: string;
}
