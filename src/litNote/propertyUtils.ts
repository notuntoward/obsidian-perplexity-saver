/**
 * Utilities for normalizing and formatting Obsidian literature note properties
 * according to the canonical schema:
 * - Lowercase snake_case property names (acronyms treated as one word).
 * - Plural Obsidian properties ('tags', 'aliases', 'cssclasses').
 * - Collision detection without overwriting.
 * - Text cleaning (whitespace trim, stray trailing punctuation removal).
 * - Real YAML lists for multi-value properties (single value as one-item list).
 * - ISO 8601 dates (YYYY-MM-DD, YYYY-MM-DDTHH:mm, partial YYYY / YYYY-MM, ambiguous dates flagged).
 * - Numbers and booleans stored as true primitives.
 * - Bare DOIs (no https://doi.org/ prefix).
 * - Omission of empty values (empty strings, null, 'N/A', empty lists).
 */

import {
	parseName,
	formatName,
	type NameStyle,
	type FormatOptions,
} from "./bibtexName";

export interface ParsedDateResult {
	formatted: string;
	isAmbiguous: boolean;
	flagReason?: string;
}

const MONTH_NAMES: Record<string, string> = {
	january: "01",
	jan: "01",
	february: "02",
	feb: "02",
	march: "03",
	mar: "03",
	april: "04",
	apr: "04",
	may: "05",
	june: "06",
	jun: "06",
	july: "07",
	jul: "07",
	august: "08",
	aug: "08",
	september: "09",
	sep: "09",
	sept: "09",
	october: "10",
	oct: "10",
	november: "11",
	nov: "11",
	december: "12",
	dec: "12",
};

/**
 * Convert a property name to lowercase snake_case.
 * Treats a run of capitals (such as an acronym) as one word before a lowercase letter
 * or boundary (e.g. "ZoteroURL" -> "zotero_url", "HTMLParser" -> "html_parser").
 */
export function toSnakeCase(name: string): string {
	return name
		.trim()
		// Treat a run of capitals (acronyms) as one word before a lowercase letter:
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		// Word boundary from lowercase/digit to uppercase:
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		// Replace spaces, hyphens, and any other non-alphanumeric characters with underscores:
		.replace(/[^a-zA-Z0-9]+/g, "_")
		// Collapse consecutive underscores:
		.replace(/_+/g, "_")
		// Trim leading and trailing underscores:
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

/**
 * Map of singular Obsidian property names to their canonical plural forms.
 */
export const PLURAL_PROPERTY_MAP: Record<string, string> = {
	tag: "tags",
	alias: "aliases",
	cssclass: "cssclasses",
};

/**
 * Canonical order of frontmatter properties for literature notes.
 * Used both when converting old Dataview notes and when writing new notes from Zotero.
 * Notice: zotero_tags is placed directly above created_date.
 */
export const FRONTMATTER_ORDER: string[] = [
	"category",
	"tags",
	"read",
	"in_progress",
	"linked",
	"aliases",
	"citekey",
	"authors",
	"title",
	"publication_date",
	"zotero_item_key",
	"zotero_item_type",
	"doi",
	"url",
	"publication",
	"book_title",
	"publisher",
	"isbn",
	"zotero_collections",
	"zotero_tags",
	"created_date",
	"modified_date",
];

/**
 * Return an object with keys ordered according to canonical FRONTMATTER_ORDER.
 * Any unlisted custom or review keys are placed after standard properties
 * and before zotero_collections / zotero_tags / created_date.
 */
export function orderFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	const keysInFm = new Set(Object.keys(fm));

	// 1. Keys before zotero_collections/zotero_tags/created_date/modified_date
	const tailKeys = new Set(["zotero_collections", "zotero_tags", "created_date", "modified_date"]);

	for (const key of FRONTMATTER_ORDER) {
		if (!tailKeys.has(key) && keysInFm.has(key)) {
			ordered[key] = fm[key];
			keysInFm.delete(key);
		}
	}

	// 2. Any unrecognized custom / review keys
	for (const rem of Object.keys(fm)) {
		if (keysInFm.has(rem) && !tailKeys.has(rem)) {
			ordered[rem] = fm[rem];
			keysInFm.delete(rem);
		}
	}

	// 3. Tail keys: zotero_collections, then zotero_tags (just above created_date), then created_date, modified_date
	if (keysInFm.has("zotero_collections")) {
		ordered["zotero_collections"] = fm["zotero_collections"];
		keysInFm.delete("zotero_collections");
	}
	if (keysInFm.has("zotero_tags")) {
		ordered["zotero_tags"] = fm["zotero_tags"];
		keysInFm.delete("zotero_tags");
	}
	if (keysInFm.has("created_date")) {
		ordered["created_date"] = fm["created_date"];
		keysInFm.delete("created_date");
	}
	if (keysInFm.has("modified_date")) {
		ordered["modified_date"] = fm["modified_date"];
		keysInFm.delete("modified_date");
	}

	return ordered;
}

/**
 * Properties that must always be represented as lists in frontmatter.
 */
export const MULTI_VALUE_PROPERTIES = new Set([
	"authors",
	"tags",
	"aliases",
	"cssclasses",
	"category",
	"zotero_tags",
	"zotero_collections",
]);

/**
 * Properties representing identifiers or text that must never be coerced to numbers.
 */
export const IDENTIFIER_PROPERTIES = new Set([
	"doi",
	"isbn",
	"url",
	"citekey",
	"zotero_item_key",
	"zotero_item_type",
	"title",
	"publication",
	"book_title",
	"publisher",
	"publication_date",
	"created_date",
	"modified_date",
]);

/**
 * Check if a property value is considered empty.
 * Returns true for null, undefined, empty strings, whitespace-only strings,
 * placeholders like 'N/A' or 'none', and empty lists.
 */
export function isEmptyValue(val: unknown): boolean {
	if (val === null || val === undefined) return true;
	if (typeof val === "string") {
		const trimmed = val.trim();
		if (trimmed === "") return true;
		const lower = trimmed.toLowerCase();
		if (
			lower === "n/a" ||
			lower === "na" ||
			lower === "null" ||
			lower === "none" ||
			lower === "undefined"
		) {
			return true;
		}
		return false;
	}
	if (Array.isArray(val)) {
		return val.length === 0 || val.every(isEmptyValue);
	}
	return false;
}

/**
 * Clean text value: trim whitespace and remove stray trailing punctuation (, or ;).
 * Leaves wording, capitalization, and valid ending punctuation (? or !) intact.
 */
export function cleanTextValue(val: string): string {
	let trimmed = val.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		trimmed = trimmed.slice(1, -1).trim();
	}
	// Remove stray trailing commas, semicolons
	trimmed = trimmed.replace(/[,;]+$/, "").trim();
	return trimmed;
}

/**
 * Canonicalize DOI to bare identifier with no 'https://doi.org/' or 'doi:' prefix.
 */
export function canonicalizeDoi(doi: string): string {
	let trimmed = doi.trim();
	trimmed = trimmed.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
	trimmed = trimmed.replace(/^doi:\s*/i, "");
	return cleanTextValue(trimmed);
}

/**
 * Parse and format a date value according to ISO 8601 rules:
 * - YYYY-MM-DD for a date.
 * - YYYY-MM-DDTHH:mm for a date with a time.
 * - Partial dates: YYYY or YYYY-MM (never fill in missing parts).
 * - Ambiguous dates (e.g. '03/04/21'): sets isAmbiguous: true, flags it, and keeps original string.
 */
export function parseObsidianDate(val: unknown): ParsedDateResult {
	if (!val) return { formatted: "", isAmbiguous: false };

	if (val instanceof Date) {
		if (isNaN(val.getTime())) return { formatted: "", isAmbiguous: false };
		const y = val.getFullYear();
		const m = String(val.getMonth() + 1).padStart(2, "0");
		const d = String(val.getDate()).padStart(2, "0");
		const hh = val.getHours();
		const mm = val.getMinutes();
		if (hh === 0 && mm === 0 && val.getSeconds() === 0) {
			return { formatted: `${y}-${m}-${d}`, isAmbiguous: false };
		}
		return {
			formatted: `${y}-${m}-${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
			isAmbiguous: false,
		};
	}

	let str = String(val).trim();
	if (!str) return { formatted: "", isAmbiguous: false };

	// Strip surrounding quotes
	if (
		(str.startsWith('"') && str.endsWith('"')) ||
		(str.startsWith("'") && str.endsWith("'"))
	) {
		str = str.slice(1, -1).trim();
	}

	// 1. Partial: YYYY
	if (/^\d{4}$/.test(str)) {
		return { formatted: str, isAmbiguous: false };
	}

	// 2. Partial: YYYY-MM or YYYY/MM
	const yyyyMm = str.match(/^(\d{4})[-/](\d{1,2})$/);
	if (yyyyMm) {
		const m = yyyyMm[2].padStart(2, "0");
		return { formatted: `${yyyyMm[1]}-${m}`, isAmbiguous: false };
	}

	// 3. Partial with month name: "May 2024", "2024 May", "May, 2024"
	const monthYear =
		str.match(/^([A-Za-z]+)[,\s]+(\d{4})$/) ||
		str.match(/^(\d{4})[,\s]+([A-Za-z]+)$/);
	if (monthYear) {
		const isFirstYear = monthYear[1].length === 4 && /^\d{4}$/.test(monthYear[1]);
		const monthStr = isFirstYear ? monthYear[2] : monthYear[1];
		const yearStr = isFirstYear ? monthYear[1] : monthYear[2];
		const mNum = MONTH_NAMES[monthStr.toLowerCase()];
		if (mNum) {
			return { formatted: `${yearStr}-${mNum}`, isAmbiguous: false };
		}
	}

	// 4. ISO Date with time: YYYY-MM-DDTHH:mm...
	const isoDateTime = str.match(
		/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/
	);
	if (isoDateTime) {
		const [, y, m, d, hh, mm, ss] = isoDateTime;
		// If time is 00:00:00 (or midnight UTC), treat as pure date
		if (hh === "00" && mm === "00" && (!ss || ss === "00")) {
			return { formatted: `${y}-${m}-${d}`, isAmbiguous: false };
		}
		return { formatted: `${y}-${m}-${d}T${hh}:${mm}`, isAmbiguous: false };
	}

	// 5. YYYY-MM-DD or YYYY/MM/DD
	const ymd = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
	if (ymd) {
		const m = ymd[2].padStart(2, "0");
		const d = ymd[3].padStart(2, "0");
		return { formatted: `${ymd[1]}-${m}-${d}`, isAmbiguous: false };
	}

	// 6. Word month dates: "15 March 2026", "March 15, 2026", "15-Mar-2026"
	const wordMonth1 = str.match(/^(\d{1,2})[,\s-]+([A-Za-z]+)[,\s-]+(\d{4})$/);
	if (wordMonth1) {
		const mNum = MONTH_NAMES[wordMonth1[2].toLowerCase()];
		if (mNum) {
			const d = wordMonth1[1].padStart(2, "0");
			return { formatted: `${wordMonth1[3]}-${mNum}-${d}`, isAmbiguous: false };
		}
	}
	const wordMonth2 = str.match(/^([A-Za-z]+)[,\s-]+(\d{1,2})[,\s-]+(\d{4})$/);
	if (wordMonth2) {
		const mNum = MONTH_NAMES[wordMonth2[1].toLowerCase()];
		if (mNum) {
			const d = wordMonth2[2].padStart(2, "0");
			return { formatted: `${wordMonth2[3]}-${mNum}-${d}`, isAmbiguous: false };
		}
	}

	// 7. Slash/dash numeric dates: A/B/C or A-B-C
	const slashMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
	if (slashMatch) {
		const n1 = parseInt(slashMatch[1], 10);
		const n2 = parseInt(slashMatch[2], 10);
		let yStr = slashMatch[3];
		if (yStr.length === 2) {
			const yr = parseInt(yStr, 10);
			yStr = yr > 50 ? `19${yStr}` : `20${yStr}`;
		}
		// If both n1 <= 12 and n2 <= 12 and n1 !== n2, it's ambiguous!
		if (n1 <= 12 && n2 <= 12 && n1 !== n2) {
			return {
				formatted: str,
				isAmbiguous: true,
				flagReason: `Ambiguous date '${str}': cannot distinguish month from day without guessing`,
			};
		}
		// If n1 > 12: n1 is day, n2 is month (DD/MM/YYYY)
		if (n1 > 12 && n2 <= 12) {
			const d = String(n1).padStart(2, "0");
			const m = String(n2).padStart(2, "0");
			return { formatted: `${yStr}-${m}-${d}`, isAmbiguous: false };
		}
		// If n2 > 12: n2 is day, n1 is month (MM/DD/YYYY)
		if (n2 > 12 && n1 <= 12) {
			const m = String(n1).padStart(2, "0");
			const d = String(n2).padStart(2, "0");
			return { formatted: `${yStr}-${m}-${d}`, isAmbiguous: false };
		}
		// If n1 === n2
		if (n1 === n2 && n1 <= 12) {
			const m = String(n1).padStart(2, "0");
			return { formatted: `${yStr}-${m}-${m}`, isAmbiguous: false };
		}
	}

	// Fallback to standard Date parsing if valid
	const parsed = new Date(str);
	if (!isNaN(parsed.getTime())) {
		const y = parsed.getUTCFullYear();
		const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
		const d = String(parsed.getUTCDate()).padStart(2, "0");
		return { formatted: `${y}-${m}-${d}`, isAmbiguous: false };
	}

	return { formatted: str, isAmbiguous: false };
}

/**
 * Standard date formatter returning the ISO 8601 string.
 */
export function formatObsidianDate(val: unknown): string {
	return parseObsidianDate(val).formatted;
}

/**
 * Format a Date object's local timezone offset as ±HH:mm (e.g. "-07:00" or "+02:00").
 */
export function formatTimezoneOffset(d: Date): string {
	const offsetMinutes = -d.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absMin = Math.abs(offsetMinutes);
	const hours = String(Math.floor(absMin / 60)).padStart(2, "0");
	const minutes = String(absMin % 60).padStart(2, "0");
	return `${sign}${hours}:${minutes}`;
}

/**
 * Format created_date and modified_date file properties in ISO 8601 offset format
 * (e.g. "2026-10-01T09:27:42-07:00").
 *
 * Rules:
 * - If the timestamp has no offset, assumes it was in local time in the timezone
 *   of this computer and calculates the correct offset needed for that date.
 * - If the timestamp already has an explicit offset (±HH:mm), preserves the timestamp
 *   and offset, standardizing seconds to :SS and offset to ±HH:mm.
 * - If the timestamp has UTC 'Z', converts it to local time with the local offset.
 * - If val is a Date instance (e.g. new Date()), formats with local time and offset.
 */
export function formatTimestampWithOffset(val: unknown): string | null {
	if (!val) return null;

	if (val instanceof Date) {
		if (isNaN(val.getTime())) return null;
		const y = val.getFullYear();
		const m = String(val.getMonth() + 1).padStart(2, "0");
		const d = String(val.getDate()).padStart(2, "0");
		const hh = String(val.getHours()).padStart(2, "0");
		const mm = String(val.getMinutes()).padStart(2, "0");
		const ss = String(val.getSeconds()).padStart(2, "0");
		const offset = formatTimezoneOffset(val);
		return `${y}-${m}-${d}T${hh}:${mm}:${ss}${offset}`;
	}

	let str = String(val).trim();
	if (!str) return null;

	// Strip surrounding quotes
	if (
		(str.startsWith('"') && str.endsWith('"')) ||
		(str.startsWith("'") && str.endsWith("'"))
	) {
		str = str.slice(1, -1).trim();
	}
	if (!str) return null;

	// 1. Check if string already has an explicit numeric timezone offset: ±HH:mm or ±HHmm
	const offsetMatch = str.match(
		/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?([+-]\d{2}):?(\d{2})$/
	);
	if (offsetMatch) {
		const [, y, m, d, hh, mm, rawSs, offH, offM] = offsetMatch;
		const ss = rawSs ? rawSs.padStart(2, "0") : "00";
		return `${y}-${m}-${d}T${hh}:${mm}:${ss}${offH}:${offM}`;
	}

	// 2. Check if string has UTC 'Z' suffix: e.g. "2026-08-31T17:43:25.813Z"
	const utcMatch = str.match(
		/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z$/i
	);
	if (utcMatch) {
		const parsed = new Date(str);
		if (!isNaN(parsed.getTime())) {
			return formatTimestampWithOffset(parsed);
		}
	}

	// 3. String without offset: e.g. "2024-05-09 15:30:00", "2024-05-09T15:30", "2024-05-09"
	// Assume local time in the timezone of this computer and calculate the offset for that date.
	const localMatch = str.match(
		/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
	);
	if (localMatch) {
		const y = parseInt(localMatch[1], 10);
		const m = parseInt(localMatch[2], 10);
		const d = parseInt(localMatch[3], 10);
		const hh = localMatch[4] !== undefined ? parseInt(localMatch[4], 10) : 0;
		const mm = localMatch[5] !== undefined ? parseInt(localMatch[5], 10) : 0;
		const ss = localMatch[6] !== undefined ? parseInt(localMatch[6], 10) : 0;

		const localDate = new Date(y, m - 1, d, hh, mm, ss);
		if (!isNaN(localDate.getTime())) {
			const yStr = String(y).padStart(4, "0");
			const mStr = String(m).padStart(2, "0");
			const dStr = String(d).padStart(2, "0");
			const hhStr = String(hh).padStart(2, "0");
			const mmStr = String(mm).padStart(2, "0");
			const ssStr = String(ss).padStart(2, "0");
			const offset = formatTimezoneOffset(localDate);
			return `${yStr}-${mStr}-${dStr}T${hhStr}:${mmStr}:${ssStr}${offset}`;
		}
	}

	// Fallback to Date parsing if possible
	const fallbackDate = new Date(str);
	if (!isNaN(fallbackDate.getTime())) {
		return formatTimestampWithOffset(fallbackDate);
	}

	return str;
}

/**
 * Safely parse an author string from an older literature note when structured
 * creators cannot be retrieved from Zotero.
 * Handles:
 * - Semicolon-separated authors: "Smith, John; Doe, Jane" -> ["Smith, John", "Doe, Jane"]
 * - "and" / "&" separated authors: "Smith, John and Doe, Jane" -> ["Smith, John", "Doe, Jane"]
 * - Even comma-separated pairs: "Mølmen, Knut Sindre, Almquist, Nicki Winfield, Skattebo, Øyvind" -> ["Mølmen, Knut Sindre", "Almquist, Nicki Winfield", "Skattebo, Øyvind"]
 * - Single authors with 1 or 0 commas: "Morris, G. Elliott" -> ["Morris, G. Elliott"]
 */
export function parseAuthorStringFallback(raw: string): string[] {
	if (!raw) return [];
	const trimmed = cleanTextValue(raw);
	if (!trimmed) return [];

	// 1. Semicolon delimiter (standard in bibliographies for separating multiple Last, First names)
	if (trimmed.includes(";")) {
		const parts = trimmed
			.split(";")
			.map(cleanTextValue)
			.filter((s) => !isEmptyValue(s));
		if (parts.length > 0) return parts;
	}

	// 2. Conjunction delimiters: " and " or " & "
	if (/\s+(?:and|&)\s+/i.test(trimmed)) {
		const parts = trimmed
			.split(/\s+(?:and|&)\s+/i)
			.map(cleanTextValue)
			.filter((s) => !isEmptyValue(s));
		if (parts.length > 0) return parts;
	}

	// 3. Comma-separated parts
	const commaParts = trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	// Case 3a: No commas (e.g. "Aristotle") or single comma (e.g. "Morris, G. Elliott") -> 1 author
	if (commaParts.length <= 2) {
		return [trimmed];
	}

	// Case 3b: Even number of parts >= 4, e.g. "Last1, First1, Last2, First2" -> pair every two items
	if (commaParts.length >= 4 && commaParts.length % 2 === 0) {
		const paired: string[] = [];
		for (let i = 0; i < commaParts.length; i += 2) {
			paired.push(cleanTextValue(`${commaParts[i]}, ${commaParts[i + 1]}`));
		}
		return paired;
	}

	// Case 3c: Odd number of parts (e.g. "Smith, John, Jr.") or ambiguous -> preserve as single string
	return [trimmed];
}

/**
 * Extract a Zotero item key from body text or callout links.
 * Supports:
 * - zotero://select/library/items/KEY
 * - zotero://select/items/KEY or zotero://select/items/0_KEY
 * - zotero://select/groups/<id>/items/KEY
 * - http(s)://zotero.org/users/<id>/items/KEY
 * - http(s)://zotero.org/groups/<id>/items/KEY
 */
export function extractZoteroItemKey(text: string): string | null {
	if (!text) return null;
	// Protocol links
	const proto = text.match(
		/zotero:\/\/(?:select\/(?:library|groups\/\d+|items)?\/items\/(?:0_)?([A-Za-z0-9]+)|select\/items\/(?:0_)?([A-Za-z0-9]+))/i
	);
	if (proto) {
		return proto[1] || proto[2] || null;
	}
	// Web URLs
	const web = text.match(
		/https?:\/\/(?:www\.)?zotero\.org\/(?:users|groups)\/\d+\/items\/([A-Za-z0-9]+)/i
	);
	if (web) {
		return web[1] || null;
	}
	return null;
}

/**
 * Normalize Dataview field key or creatorType to lowercase alphanumeric only (stripping spaces, underscores, hyphens, brackets).
 */
export function normalizeDataviewKey(rawKey: string): string {
	return rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Creator keys that should be converted into frontmatter `authors`.
 * Covers all creator types from user rules (author, creator, director, podcaster, etc.).
 */
export const AUTHOR_CREATOR_KEY_SET = new Set([
	"author",
	"authors",
	"firstauthor",
	"creator",
	"creators",
	"firstcreator",
	"bookauthor",
	"firstbookauthor",
	"inventor",
	"firstinventor",
	"artist",
	"firstartist",
	"director",
	"firstdirector",
	"podcaster",
	"firstpodcaster",
	"cartographer",
	"firstcartographer",
	"programmer",
	"firstprogrammer",
	"composer",
	"firstcomposer",
	"producer",
	"firstproducer",
	"producers",
	"scriptwriter",
	"firstscriptwriter",
	"interviewee",
	"presenter",
	"sponsor",
	"contributor",
]);

/**
 * Creator keys that should NOT be put in `authors` (left in callout and logged).
 */
export const NON_AUTHOR_CREATOR_KEY_SET = new Set([
	"editor",
	"serieseditor",
	"translator",
	"reviewedauthor",
	"interviewer",
	"recipient",
	"commenter",
	"counsel",
	"attorneyagent",
]);

/**
 * Check if a normalized or raw key corresponds to an author/creator role.
 * Matches all standard author roles (author, director, programmer, creator, etc.)
 * as well as any 'First*' prefix variants (e.g. FirstAuthor, FirstDirector, FirstProgrammer).
 */
export function isAuthorCreatorKey(rawKey: string): boolean {
	const norm = normalizeDataviewKey(rawKey);
	if (AUTHOR_CREATOR_KEY_SET.has(norm)) return true;
	if (norm.startsWith("first") && norm.length > 5) {
		const base = norm.slice(5);
		if (AUTHOR_CREATOR_KEY_SET.has(base)) return true;
	}
	return false;
}

/**
 * Convert Zotero creator objects into author strings according to canonical creator rules.
 * Shared function used both in new note creation from Zotero and old note conversion.
 * - Only includes creator types configured as authors (author, creator, director, podcaster, etc.).
 * - Excludes non-author creator types (editor, translator, seriesEditor, etc.).
 * - If creatorType is unspecified, defaults to author.
 * - Formats as "Last, First" or single "Name".
 */
export function extractAuthorsFromZoteroCreators(
	creators?: Array<{ firstName?: string; lastName?: string; name?: string; creatorType?: string }>,
	style: NameStyle = "last-first",
	options?: FormatOptions
): string[] {
	if (!creators || !Array.isArray(creators)) return [];
	return creators
		.filter((c) => {
			if (!c.creatorType) return true;
			return isAuthorCreatorKey(c.creatorType);
		})
		.map((c) => {
			if (c.name) return c.name.trim();
			const last = (c.lastName ?? "").trim();
			const first = (c.firstName ?? "").trim();
			if (last && first) {
				const n = parseName(`${last}, ${first}`);
				return formatName(n, style, options);
			}
			return last || first;
		})
		.filter(Boolean)
		.map(cleanTextValue);
}
