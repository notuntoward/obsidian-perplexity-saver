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
	action: "sync" | "update" | "review-sync" | "bulk-review-sync" | "review-recheck";
	data: ZoteroItemPayload[];
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

export interface LitNoteUncertainReviewRequest {
	action: "review-uncertain" | "review-uncertain-acknowledged";
	itemkey: string;
	libraryURI: string;
	error?: string;
}

export interface LitNoteAttachmentMoveCompleteRequest {
	action: "attachment-move-complete";
	data: [ZoteroItemPayload];
	moved: Array<{ itemkey?: string; from: string; to: string; oldKey?: string; newKey?: string; trashed?: boolean; preservedSource?: boolean; copied?: boolean }>;
	linked?: Array<{ path: string; newKey: string }>;
}

export interface LitNoteBulkLibraryRequest {
	action: "bulk-library-uri";
	data: [ZoteroItemPayload];
}

export type LitNoteRequest = LitNoteCreateRequest | LitNoteOpenRequest | LitNoteSyncRequest | LitNoteApplySyncRequest | LitNoteCheckAttachmentBaseRequest | LitNoteReviewFailureRequest | LitNoteUncertainReviewRequest | LitNoteAttachmentMoveCompleteRequest | LitNoteBulkLibraryRequest;

export type LitNoteItemStatus =
	| "created"
	| "overwritten"
	| "opened"
	| "updated"
	| "set-zotero-key"
	| "prepared"
	| "pending-review"
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
	success: boolean;
	relationship?: "unset" | "inside" | "outside";
	vaultPath?: string;
	citekeys?: string[];
	identities?: Array<{ itemkey: string; notePath: string; libraryURI?: string; citekey: string; modifiedAt?: number; size?: number }>;
	requests?: Array<{
		itemkey: string;
		libraryURI: string;
		operation?: "library-uri" | "library-recheck" | "note-update" | "attachment-move";
		attachmentMove?: AttachmentMoveCandidate;
		strategy?: "newest" | "zotero" | "skip";
	}>;
	pending?: Array<{ itemkey: string; libraryURI: string; uncertain?: boolean }>;
	acknowledgedUncertain?: Array<{ itemkey: string; libraryURI: string }>;
	results?: LitNoteItemResult[];
	path?: string;
	error?: string;
}
