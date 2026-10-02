import { parseYaml } from "obsidian";
import { cleanFieldValue } from "./buildLitNote";
import {
	cleanTextValue,
	normalizeDataviewKey,
	AUTHOR_CREATOR_KEY_SET,
	NON_AUTHOR_CREATOR_KEY_SET,
	extractAuthorsFromZoteroCreators,
	isAuthorCreatorKey,
} from "./propertyUtils";

export {
	normalizeDataviewKey,
	AUTHOR_CREATOR_KEY_SET,
	NON_AUTHOR_CREATOR_KEY_SET,
	extractAuthorsFromZoteroCreators,
	isAuthorCreatorKey,
};

export interface UnconvertedDataviewField {
	key: string;
	rawKey: string;
	value: string;
}

export interface ExtractedDataviewFields {
	firstAuthor?: string;
	authors: string[];
	title?: string;
	date?: string;
	citekey?: string;
	zoteroItemKey?: string;
	itemType?: string;
	doi?: string;
	url?: string;
	journal?: string;
	book?: string;
	publisher?: string;
	isbn?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	location?: string;
	zoteroTags?: string[];
	zoteroCollections?: string[];
	singleAuthorRaw?: string;
	createdDate?: string;
	modifiedDate?: string;
	unconvertedFields?: UnconvertedDataviewField[];
}

export interface OldFormatNote {
	frontmatter: Record<string, unknown>;
	body: string;
	fields: ExtractedDataviewFields;
	title: string;
	date: string;
	citekey: string;
	authors: string[];
	layoutType: "LayoutA" | "LayoutB" | "NoAuthors";
}

/**
 * Normalized keys of all Dataview fields converted to frontmatter properties.
 */
export const CONVERTED_DATAVIEW_KEYS = new Set([
	...AUTHOR_CREATOR_KEY_SET,
	"title",
	"date",
	"citekey",
	"citationkey",
	"zoteroitemkey",
	"itemtype",
	"doi",
	"url",
	"journal",
	"volume",
	"issue",
	"book",
	"publisher",
	"location",
	"pages",
	"isbn",
	"zoterotags",
	"zoterocollections",
	"createddate",
	"modifieddate",
	"related",
]);

/**
 * Check if a normalized Dataview key is converted into frontmatter properties.
 * Matches standard converted keys as well as any author/creator role (including First* variants).
 */
export function isConvertedDataviewKey(normKey: string): boolean {
	return CONVERTED_DATAVIEW_KEYS.has(normKey) || isAuthorCreatorKey(normKey);
}

/**
 * Backward-compatible set of known Dataview field names inside callouts.
 */
export const KNOWN_DATAVIEW_KEYS = CONVERTED_DATAVIEW_KEYS;

/**
 * Regular expression to match line-level Dataview inline fields:
 * Supports optional blockquote '>', multiple '>', leading spaces before '>',
 * optional bullets ('-' or '*'), optional bold '**',
 * keys with spaces/hyphens/underscores/parentheses, optional spaces before '::', and value.
 */
export const DATAVIEW_LINE_REGEX =
	/^(?:\s*(?:>\s*)+)?(?:[-*]\s*)?(?:\*\*)?([A-Za-z0-9_\-\s()]+?)(?:\*\*)?\s*::\s*(.*)$/;

/**
 * Normalize and expand malformed Dataview lines in body text:
 * 1. Splits lines where a second Dataview field is concatenated after '>' without a newline
 *    (e.g. `> **Author**:: Smith> **Title**:: Title`).
 * 2. Normalizes leading whitespace and multiple blockquote markers
 *    (e.g. `> > **Author**:: ...` or ` > **Author**:: ...` -> `> **Author**:: ...`).
 */
export function normalizeBodyDataviewLines(bodyText: string): string[] {
	const rawLines = bodyText.split(/\r?\n/);
	const expanded: string[] = [];

	for (const rawLine of rawLines) {
		// Split concatenated dataview fields on the same line, e.g.
		// " > **Author**:: Morris, G. Elliott> **Title**:: \"The hidden axis...\""
		const subLines = rawLine.split(/(?<=\S)\s*(?=>\s*(?:\*\*)?[A-Za-z0-9_\-\s()]+?(?:\*\*)?\s*::)/);
		for (const sub of subLines) {
			// Normalize multiple leading '>' or leading space before '>' on Dataview field lines
			if (DATAVIEW_LINE_REGEX.test(sub) && /^\s*(?:>\s*)+/.test(sub)) {
				expanded.push(sub.replace(/^\s*(?:>\s*)+/, "> "));
			} else {
				expanded.push(sub);
			}
		}
	}

	return expanded;
}

/**
 * Identify line range [start, end] of the primary > [!info] callout block in body text.
 * Tolerates blank lines within the callout block so that fields following empty lines
 * are not prematurely cut off.
 */
export function findInfoCalloutLineRange(lines: string[]): [number, number] | null {
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].match(/^\s*>\s*\[!info\]/i)) {
			start = i;
			break;
		}
	}
	if (start === -1) return null;

	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		const rawLine = lines[i];
		const trimmed = rawLine.trim();

		// Stop if hitting a different callout block (e.g. > [!note], > [!quote])
		if (trimmed.match(/^>\s*\[!(?!info)[a-z0-9_\-]+\]/i)) {
			break;
		}
		// Stop if hitting unquoted section dividers or headers
		if (
			trimmed.startsWith("___") ||
			trimmed.startsWith("---") ||
			trimmed.startsWith("#") ||
			trimmed.startsWith("%%")
		) {
			break;
		}
		// If line does not start with '>' and is not the legacy '~' divider
		if (!rawLine.trimStart().startsWith(">") && trimmed !== "~") {
			// Lookahead: if subsequent non-empty line starts with '>', callout continues
			let continuesAfterBlank = false;
			for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
				const nextTrim = lines[j].trim();
				if (nextTrim === "") continue;
				if (nextTrim.startsWith(">")) {
					continuesAfterBlank = true;
				}
				break;
			}
			if (!continuesAfterBlank) {
				break;
			}
		}

		end = i;
	}
	return [start, end];
}

/**
 * Robustly extract Dataview fields from note body text.
 * Handles case-insensitivity, optional blockquote prefixes, and multiline values.
 */
export function extractDataviewFields(bodyText: string): ExtractedDataviewFields {
	const result: ExtractedDataviewFields = { authors: [], unconvertedFields: [] };
	const lines = normalizeBodyDataviewLines(bodyText);
	const range = findInfoCalloutLineRange(lines);

	const scanStart = range ? range[0] : 0;
	const scanEnd = range ? range[1] : lines.length - 1;

	const processLine = (rawLine: string, lineIndex: number, maxLineIndex: number): number => {
		const match = rawLine.match(DATAVIEW_LINE_REGEX);
		if (!match) return lineIndex;

		const rawKey = match[1].trim();
		const normKey = normalizeDataviewKey(rawKey);
		let val = match[2].trim();

		// Handle multiline continuation if quotes are unclosed
		if (
			(val.startsWith('"') && !val.endsWith('"')) ||
			(val.startsWith("'") && !val.endsWith("'"))
		) {
			for (let j = lineIndex + 1; j <= maxLineIndex; j++) {
				const nextRaw = lines[j];
				const nextTrim = nextRaw.replace(/^[>\s]+/, "").trim();
				if (nextTrim.match(DATAVIEW_LINE_REGEX)) {
					break;
				}
				val += " " + nextTrim;
				lineIndex = j;
				if (val.endsWith('"') || val.endsWith("'")) {
					break;
				}
			}
		}

		const cleaned = cleanFieldValue(val);
		if (!cleaned) return lineIndex;

		if (isAuthorCreatorKey(normKey)) {
			if (normKey === "firstauthor" || normKey.startsWith("first")) {
				if (!result.firstAuthor) {
					result.firstAuthor = cleaned;
				}
			}
			result.authors.push(cleaned);
			if (!result.singleAuthorRaw) {
				result.singleAuthorRaw = cleaned;
			}
		} else {
			switch (normKey) {
				case "title":
					result.title = cleaned;
					break;
				case "date":
					result.date = cleaned;
					break;
				case "citekey":
				case "citationkey":
					result.citekey = cleaned;
					break;
				case "zoteroitemkey":
					result.zoteroItemKey = cleaned;
					break;
				case "itemtype":
					result.itemType = cleaned;
					break;
				case "doi":
					result.doi = cleaned;
					break;
				case "url":
					result.url = cleaned;
					break;
				case "journal":
					result.journal = cleaned;
					break;
				case "book":
					result.book = cleaned;
					break;
				case "publisher":
					result.publisher = cleaned;
					break;
				case "isbn":
					result.isbn = cleaned;
					break;
				case "volume":
					result.volume = cleaned;
					break;
				case "issue":
					result.issue = cleaned;
					break;
				case "pages":
					result.pages = cleaned;
					break;
				case "location":
					result.location = cleaned;
					break;
				case "zoterotags":
					if (!result.zoteroTags) result.zoteroTags = [];
					result.zoteroTags.push(cleaned);
					break;
				case "zoterocollections":
					if (!result.zoteroCollections) result.zoteroCollections = [];
					result.zoteroCollections.push(cleaned);
					break;
				case "createddate":
					result.createdDate = cleaned;
					break;
				case "modifieddate":
					result.modifiedDate = cleaned;
					break;
				case "related":
					break;
				default:
					result.unconvertedFields!.push({
						key: normKey,
						rawKey,
						value: cleaned,
					});
					break;
			}
		}

		return lineIndex;
	};

	// 1. Primary scan inside the callout range (or full body if no callout header)
	for (let i = scanStart; i <= scanEnd; i++) {
		i = processLine(lines[i], i, scanEnd);
	}

	// 2. Full-body scan fallback for lines outside the callout range
	if (range) {
		const scanned = new Set<number>();
		for (let i = scanStart; i <= scanEnd; i++) {
			scanned.add(i);
		}
		for (let i = 0; i < lines.length; i++) {
			if (scanned.has(i)) continue;
			// Stop scanning if reaching user notes comment block
			if (/%%[ \t]*begin\s+obsidian\s+notes[ \t]*%%/i.test(lines[i])) {
				break;
			}
			i = processLine(lines[i], i, lines.length - 1);
		}
	}

	// 3. Regex fallback for Title, Date, Citekey if not captured
	if (!result.title) {
		const m = bodyText.match(/^(?:>\s*)?(?:\*\*)?title(?:\*\*)?\s*::\s*(.*)$/im);
		if (m) result.title = cleanFieldValue(m[1]);
	}
	if (!result.date) {
		const m = bodyText.match(/^(?:>\s*)?(?:\*\*)?date(?:\*\*)?\s*::\s*(.*)$/im);
		if (m) result.date = cleanFieldValue(m[1]);
	}
	if (!result.citekey) {
		const m = bodyText.match(/^(?:>\s*)?(?:\*\*)?citekey(?:\*\*)?\s*::\s*(.*)$/im);
		if (m) result.citekey = cleanFieldValue(m[1]);
	}

	return result;
}

/**
 * Parse an old-format literature note into structured components.
 * Normalizes YAML frontmatter, Dataview callout properties, and body content.
 */
export function parseOldFormatNote(
	rawContent: string,
	fallbackStem = ""
): OldFormatNote {
	const content = rawContent.replace(/\r\n/g, "\n");
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

	let rawFm = "";
	let body = content;
	let frontmatter: Record<string, unknown> = {};

	if (fmMatch) {
		rawFm = fmMatch[1];
		body = fmMatch[2];
		try {
			const parsed = parseYaml(rawFm);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				frontmatter = parsed as Record<string, unknown>;
			}
		} catch {
			// Parsing error handled gracefully
		}
	}

	// Normalize quote-suffixed frontmatter keys (e.g. "created date:")
	for (const key of Object.keys(frontmatter)) {
		if (key.includes(":") || key.includes('"') || key.includes("'")) {
			const cleanKey = key.replace(/["':]/g, "").trim();
			if (cleanKey && cleanKey !== key) {
				if (frontmatter[cleanKey] === undefined) {
					frontmatter[cleanKey] = frontmatter[key];
				}
				delete frontmatter[key];
			}
		}
	}

	const fields = extractDataviewFields(body);

	// Resolve title
	const title =
		fields.title ||
		(frontmatter.title ? cleanFieldValue(String(frontmatter.title)) : "") ||
		(frontmatter.Title ? cleanFieldValue(String(frontmatter.Title)) : "") ||
		fallbackStem;

	// Resolve date
	const date =
		fields.date ||
		(frontmatter.publication_date ? String(frontmatter.publication_date).trim() : "") ||
		(frontmatter.date ? String(frontmatter.date).trim() : "");

	// Resolve citekey
	const citekey =
		fields.citekey ||
		(frontmatter.citekey ? String(frontmatter.citekey).trim() : "") ||
		(frontmatter["citation key"] ? String(frontmatter["citation key"]).trim() : "") ||
		(frontmatter["citation_key"] ? String(frontmatter["citation_key"]).trim() : "") ||
		fallbackStem;

	// Resolve author layout
	let authors: string[] = [];
	let layoutType: "LayoutA" | "LayoutB" | "NoAuthors" = "NoAuthors";

	if (Array.isArray(frontmatter.authors) && frontmatter.authors.length > 0) {
		authors = frontmatter.authors.map((a) => String(a).trim());
	} else if (typeof frontmatter.authors === "string" && frontmatter.authors.trim()) {
		authors = [frontmatter.authors.trim()];
	} else if (fields.firstAuthor || fields.authors.length > 1) {
		layoutType = "LayoutA";
		authors = [
			...new Set([
				...(fields.firstAuthor ? [fields.firstAuthor] : []),
				...fields.authors,
			]),
		];
	} else if (fields.authors.length === 1) {
		layoutType = "LayoutB";
		authors = [fields.authors[0]];
	}

	return {
		frontmatter,
		body,
		fields,
		title,
		date,
		citekey,
		authors,
		layoutType,
	};
}
