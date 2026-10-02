import { isAuthorCreatorKey } from "./propertyUtils";
import { suggestBibtexForm, suggestBibtexFormTwoField } from "./bibtexName";
import type { ZoteroCreator, ZoteroItemPayload } from "./types";

export interface AuthorFormatIssue {
	citekey: string;
	creatorType: string;
	rawName: string;
	detail: string;
	/** BibTeX-canonical suggestion when the parser can auto-correct the name. */
	suggestion?: string;
	/** The index of the creator in the item's creators array, for rewriting. */
	creatorIndex: number;
}

/**
 * Validate that all creators of a Zotero item that will become the 'authors'
 * file property adhere to the '<last_name>, <first name>' format.
 *
 * Rules:
 * - Only creator types that become 'authors' are checked (e.g. author, director, programmer).
 * - Two-field creators must have both a non-empty lastName and firstName, UNLESS the
 *   lastName is a single word with no spaces (a mononym such as "Aristotle" or "Prince"),
 *   in which case no first name is required.
 * - Single-field creators (c.name) must contain a comma separating two non-empty components
 *   (e.g. "Smith, John") UNLESS the name is a single word with no spaces (mononym), which
 *   is valid as-is. A multi-word name without a comma (e.g. "John Smith") fails because
 *   it is ambiguous which part is the last name.
 * - Non-author creator types (e.g. editor, translator) are ignored.
 */
export function validateItemAuthorFormats(item: ZoteroItemPayload): AuthorFormatIssue[] {
	const issues: AuthorFormatIssue[] = [];
	const citekey = item.citekey?.trim() || item.itemkey?.trim() || "untitled";
	const creators = item.creators ?? [];

	for (let i = 0; i < creators.length; i++) {
		const c: ZoteroCreator = creators[i];
		const creatorType = c.creatorType?.trim() || "author";

		// Only check creator types that convert to the authors property
		if (!isAuthorCreatorKey(creatorType)) {
			continue;
		}

		const readableType = creatorType.charAt(0).toUpperCase() + creatorType.slice(1);

		// Case 1: Single-field mode (name)
		if (c.name !== undefined && c.name !== null && c.name.trim() !== "") {
			const rawName = c.name.trim();
			// A single-word name (no spaces) is a mononym — no comma needed.
			if (!rawName.includes(" ") && !rawName.includes(",")) {
				continue;
			}
			if (!rawName.includes(",")) {
				issues.push({
					citekey,
					creatorType: readableType,
					rawName,
					detail: `Single-field name "${rawName}" has multiple words but no comma — unable to determine which part is the last name. Use "Last, First" format.`,
					suggestion: suggestBibtexForm(rawName) ?? undefined,
					creatorIndex: i,
				});
				continue;
			}
			const parts = rawName.split(",").map((s) => s.trim());
			if (!parts[0] || !parts[1]) {
				issues.push({
					citekey,
					creatorType: readableType,
					rawName,
					detail: `Single-field name "${rawName}" does not have both a valid last name and first name around the comma.`,
					creatorIndex: i,
				});
				continue;
			}
			continue;
		}

		// Case 2: Two-field mode (firstName and lastName)
		const first = (c.firstName ?? "").trim();
		const last = (c.lastName ?? "").trim();

		if (!last && !first) {
			issues.push({
				citekey,
				creatorType: readableType,
				rawName: "(empty)",
				detail: `Creator field #${i + 1} (${readableType}) is completely blank.`,
				creatorIndex: i,
			});
		} else if (!first) {
			// A single-word lastName with no firstName is a valid mononym.
			if (last.includes(" ")) {
				issues.push({
					citekey,
					creatorType: readableType,
					rawName: `lastName: "${last}"`,
					detail: `Creator field #${i + 1} (${readableType}) has a multi-word last name "${last}" but no first name — use "Last, First" split or enter a mononym in the single-name field.`,
					suggestion: suggestBibtexForm(last) ?? undefined,
					creatorIndex: i,
				});
			}
		} else if (!last) {
			issues.push({
				citekey,
				creatorType: readableType,
				rawName: `firstName: "${first}"`,
				detail: `Creator field #${i + 1} (${readableType}) has first name "${first}" but is missing a last name.`,
				suggestion: suggestBibtexFormTwoField(first, last) ?? undefined,
				creatorIndex: i,
			});
		}
	}

	return issues;
}

/**
 * Return the zotero:// select URI for a given ZoteroItemPayload.
 */
export function getZoteroSelectUri(item: ZoteroItemPayload): string | null {
	if (item.desktopURI && item.desktopURI.startsWith("zotero://")) {
		return item.desktopURI;
	}
	if (item.itemkey) {
		return `zotero://select/library/items/${item.itemkey}`;
	}
	if (item.desktopURI) {
		const match = item.desktopURI.match(/items\/([A-Za-z0-9]+)/);
		if (match) {
			return `zotero://select/library/items/${match[1]}`;
		}
		return item.desktopURI;
	}
	return null;
}

interface ElectronWithShell {
	shell?: {
		openExternal: (url: string) => Promise<void> | void;
	};
}

/**
 * Open a Zotero item in the Zotero desktop application so the user can edit it.
 */
export function openZoteroItem(item: ZoteroItemPayload): boolean {
	const uri = getZoteroSelectUri(item);
	if (!uri) return false;

	try {
		if (typeof window !== "undefined") {
			const win = window as unknown as { electron?: ElectronWithShell };
			if (win.electron?.shell?.openExternal) {
				void win.electron.shell.openExternal(uri);
				return true;
			}
			if (typeof window.open === "function") {
				window.open(uri);
				return true;
			}
		}
	} catch (err) {
		console.warn("[LitNote] Failed to open Zotero URI:", uri, err);
	}
	return false;
}
