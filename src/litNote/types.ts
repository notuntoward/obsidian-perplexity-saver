/**
 * Payload shapes sent by the Zotero companion plugin.
 * Mirrors the JSON produced by new_obsidian_note_sender.js and
 * open_obsidian_note_sender.js in refwrangle.
 */

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
	action: "sync" | "update";
	data: ZoteroItemPayload[];
}

export interface LitNoteApplySyncRequest {
	action: "apply-sync" | "validate-zotero-key";
	token: string;
	data: ZoteroItemPayload[];
	zoteroAttachmentPaths?: string[];
}

export type LitNoteRequest = LitNoteCreateRequest | LitNoteOpenRequest | LitNoteSyncRequest | LitNoteApplySyncRequest;

export type LitNoteItemStatus =
	| "created"
	| "overwritten"
	| "opened"
	| "updated"
	| "set-zotero-key"
	| "prepared"
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
	citekeys?: string[];
	identities?: Array<{ itemkey: string; notePath: string; libraryURI?: string; citekey: string; modifiedAt?: number; size?: number }>;
	results?: LitNoteItemResult[];
	path?: string;
	error?: string;
}
