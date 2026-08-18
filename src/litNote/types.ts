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
	title?: string;
	path?: string;
	url?: string;
}

export interface ZoteroRelation {
	citekey?: string;
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
}

export interface LitNoteCreateRequest {
	action: "create";
	/** The sender wraps items in a data array (matching existing sender JS shape). */
	data: ZoteroItemPayload[];
	force?: boolean;
}

export interface LitNoteOpenRequest {
	action: "open";
	citekey: string;
}

export type LitNoteRequest = LitNoteCreateRequest | LitNoteOpenRequest;

export interface LitNoteResponse {
	success: boolean;
	path?: string;
	error?: string;
}
