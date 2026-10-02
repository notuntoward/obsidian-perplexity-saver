import type { ZoteroClient } from "../zotero/zoteroClient";
import { buildAliases } from "./buildLitNote";
import {
	toSnakeCase,
	PLURAL_PROPERTY_MAP,
	MULTI_VALUE_PROPERTIES,
	IDENTIFIER_PROPERTIES,
	isEmptyValue,
	cleanTextValue,
	canonicalizeDoi,
	parseObsidianDate,
	formatObsidianDate,
	parseAuthorStringFallback,
	extractZoteroItemKey,
	FRONTMATTER_ORDER,
	orderFrontmatter,
	formatTimestampWithOffset,
} from "./propertyUtils";
import {
	findInfoCalloutLineRange,
	extractDataviewFields,
	parseOldFormatNote,
	KNOWN_DATAVIEW_KEYS,
	CONVERTED_DATAVIEW_KEYS,
	isConvertedDataviewKey,
	DATAVIEW_LINE_REGEX,
	normalizeDataviewKey,
	normalizeBodyDataviewLines,
	extractAuthorsFromZoteroCreators,
	type ExtractedDataviewFields,
	type UnconvertedDataviewField,
} from "./oldFormatReader";

export interface ConversionResult {
	success: boolean;
	skipped: boolean;
	reason?: string;
	filePath: string;
	originalContent: string;
	updatedContent?: string;
	updatedBody?: string;
	updatedFm?: Record<string, unknown>;
	changesMade?: string[];
	layoutType?: "LayoutA" | "LayoutB" | "NoAuthors";
	unconvertedDataviewFields?: UnconvertedDataviewField[];
	hasAuthorsProperty?: boolean;
}

/** Backward-compatible type alias */
export type ExtractedDataview = ExtractedDataviewFields;

/** Backward-compatible re-exports */
export {
	findInfoCalloutLineRange,
	extractDataviewFields,
	FRONTMATTER_ORDER,
	orderFrontmatter,
	formatTimestampWithOffset,
};

/** Backward-compatible set of remove keys */
export const REMOVE_DATAVIEW_KEYS = KNOWN_DATAVIEW_KEYS;

/**
 * Clean legacy template markers from note body text:
 * 1. Removes user comment delimiters:
 *    %% begin Obsidian Notes %%
 *    ___
 *    ... (user comments kept) ...
 *    ___
 *    %% end Obsidian Notes %%
 * 2. Removes trailing/legacy import timestamp comments:
 *    %% Import Date: 2024-05-08T14:01:11.313-07:00 %%
 */
export function cleanLegacyBodyMarkers(text: string): string {
	if (!text) return text;

	let cleaned = text;

	// 1. Remove start delimiter: %% begin Obsidian Notes %% followed by ___ / --- / ***
	cleaned = cleaned.replace(
		/^[ \t]*%%[ \t]*begin\s+obsidian\s+notes[ \t]*%%[ \t]*(?:\r?\n[ \t]*)*(?:_{3,}|-{3,}|\*{3,})[ \t]*(?:\r?\n)?/gmi,
		""
	);

	// 2. Remove end delimiter: ___ / --- / *** followed by %% end Obsidian Notes %%
	cleaned = cleaned.replace(
		/(?:\r?\n)?[ \t]*(?:_{3,}|-{3,}|\*{3,})[ \t]*(?:\r?\n[ \t]*)*%%[ \t]*end\s+obsidian\s+notes[ \t]*%%[ \t]*/gmi,
		""
	);

	// 3. Remove any standalone begin/end comment lines if they exist without the horizontal rule
	cleaned = cleaned.replace(
		/^[ \t]*%%[ \t]*(?:begin|end)\s+obsidian\s+notes[ \t]*%%[ \t]*(?:\r?\n)?/gmi,
		""
	);

	// 4. Remove %% Import Date: <timestamp> %% comments (any timestamp)
	cleaned = cleaned.replace(
		/^[ \t]*%%[ \t]*import\s+date:[^\n%]*%%[ \t]*(?:\r?\n)?/gmi,
		""
	);

	// Also catch any inline %% Import Date: ... %%
	cleaned = cleaned.replace(
		/[ \t]*%%[ \t]*import\s+date:[^\n%]*%%/gi,
		""
	);

	return cleaned;
}

/**
 * Clean callout body by removing converted Dataview lines strictly within the > [!info] block,
 * trimming trailing empty quote lines from the callout, and ensuring a clean blank line
 * above and below the callout.
 */
export function cleanCalloutBody(bodyText: string): string {
	const cleanedBody = cleanLegacyBodyMarkers(bodyText);
	const lines = normalizeBodyDataviewLines(cleanedBody);
	const range = findInfoCalloutLineRange(lines);

	if (!range) {
		const calloutFiltered: string[] = [];
		for (const line of lines) {
			const match = line.match(DATAVIEW_LINE_REGEX);
			if (match) {
				const norm = normalizeDataviewKey(match[1]);
				if (isConvertedDataviewKey(norm)) {
					continue;
				}
			}
			if (line.trim() === "~") {
				continue;
			}
			calloutFiltered.push(line);
		}
		const trimmed = calloutFiltered.join("\n").trim();
		return trimmed ? `\n\n${trimmed}\n` : "\n\n";
	}

	const [start, end] = range;

	// 1. Process lines inside the callout block
	const calloutRaw = lines.slice(start, end + 1);
	const calloutFiltered: string[] = [];

	for (const line of calloutRaw) {
		const match = line.match(DATAVIEW_LINE_REGEX);
		if (match) {
			const normKey = normalizeDataviewKey(match[1]);
			if (isConvertedDataviewKey(normKey)) {
				continue;
			}
		}
		if (line.trim() === "~") {
			continue;
		}
		calloutFiltered.push(line);
	}

	// Trim trailing empty quote lines (e.g. '>' or '> ') from the bottom of the callout
	while (calloutFiltered.length > 1 && /^>\s*$/.test(calloutFiltered[calloutFiltered.length - 1])) {
		calloutFiltered.pop();
	}

	// Collapse consecutive empty quote lines inside the callout to a single '>'
	const calloutCollapsed: string[] = [];
	for (const line of calloutFiltered) {
		if (/^>\s*$/.test(line)) {
			if (calloutCollapsed.length > 0 && /^>\s*$/.test(calloutCollapsed[calloutCollapsed.length - 1])) {
				continue;
			}
			calloutCollapsed.push(">");
		} else {
			calloutCollapsed.push(line);
		}
	}

	const calloutText = calloutCollapsed.join("\n");

	// 2. Lines before the callout (if any)
	const beforeLines = lines.slice(0, start);
	while (beforeLines.length > 0 && beforeLines[beforeLines.length - 1].trim() === "") {
		beforeLines.pop();
	}

	// 3. Lines after the callout (if any)
	const afterLines = lines.slice(end + 1);
	let firstNonEmptyAfter = 0;
	while (firstNonEmptyAfter < afterLines.length && afterLines[firstNonEmptyAfter].trim() === "") {
		firstNonEmptyAfter++;
	}
	const remainingAfter = afterLines.slice(firstNonEmptyAfter);
	while (remainingAfter.length > 0 && remainingAfter[remainingAfter.length - 1].trim() === "") {
		remainingAfter.pop();
	}

	// Build the assembled body:
	// If beforeLines has content, put it first with a blank line before callout
	let result = "";
	if (beforeLines.length > 0) {
		result = "\n" + beforeLines.join("\n").trim() + "\n\n" + calloutText;
	} else {
		result = "\n" + calloutText;
	}

	// Blank line below the callout
	if (remainingAfter.length > 0) {
		result += "\n\n" + remainingAfter.join("\n") + "\n";
	} else {
		result += "\n\n";
	}

	return result;
}

export function removeDataviewLinesFromCallout(bodyText: string): string {
	return cleanCalloutBody(bodyText);
}

/**
 * Format string for YAML safely, supporting nested arrays and objects.
 * Emits ISO datetimes unquoted so Obsidian Bases treats them as native dates.
 */
const ISO_DATE_REGEX =
	/^\d{4}(?:-\d{2}(?:-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

function formatYamlValue(val: unknown, indent = 0): string {
	const prefix = " ".repeat(indent);

	if (isEmptyValue(val)) {
		return "";
	}

	if (typeof val === "boolean" || typeof val === "number") {
		return String(val);
	}

	if (typeof val === "string") {
		const trimmed = val.trim();
		if (ISO_DATE_REGEX.test(trimmed)) {
			return trimmed;
		}

		// Don't quote wikilinks
		if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
			return trimmed;
		}

		// Quote if string contains characters that require escaping or colons
		if (
			trimmed.includes(":") ||
			trimmed.includes("#") ||
			trimmed.includes("[") ||
			trimmed.includes("]") ||
			trimmed.includes("{") ||
			trimmed.includes("}") ||
			trimmed.includes("&") ||
			trimmed.includes("*") ||
			trimmed.includes("?") ||
			trimmed.includes("|") ||
			trimmed.includes("<") ||
			trimmed.includes(">") ||
			trimmed.includes("=") ||
			trimmed.includes("!") ||
			trimmed.includes("%") ||
			trimmed.includes("@") ||
			trimmed.includes("`") ||
			trimmed.startsWith('"') ||
			trimmed.startsWith("'")
		) {
			const unquoted =
				(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
				(trimmed.startsWith("'") && trimmed.endsWith("'"))
					? trimmed.slice(1, -1)
					: trimmed;
			const unescaped = unquoted.replace(/\\"/g, '"');
			return `"${unescaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return trimmed;
	}

	if (Array.isArray(val)) {
		const filtered = val.filter((item) => !isEmptyValue(item));
		if (filtered.length === 0) return "";
		const lines: string[] = [];
		for (const item of filtered) {
			if (typeof item === "object" && item !== null && !Array.isArray(item)) {
				lines.push(`\n${prefix}  -`);
				for (const [k, v] of Object.entries(item)) {
					const formattedV = formatYamlValue(v, indent + 4);
					lines.push(`\n${prefix}    ${k}: ${formattedV}`);
				}
			} else {
				const formattedItem = formatYamlValue(item, indent + 2);
				lines.push(`\n${prefix}  - ${formattedItem}`);
			}
		}
		return lines.join("");
	}

	if (typeof val === "object" && val !== null) {
		const lines: string[] = [];
		for (const [k, v] of Object.entries(val)) {
			if (isEmptyValue(v)) continue;
			const formattedV = formatYamlValue(v, indent + 2);
			if (Array.isArray(v) && v.length > 0) {
				lines.push(`\n${prefix}  ${k}:${formattedV}`);
			} else {
				lines.push(`\n${prefix}  ${k}: ${formattedV}`.trimEnd());
			}
		}
		return lines.join("");
	}

	return String(val);
}

/**
 * Stringify frontmatter object guaranteeing the key order specified by movement rules.
 */
export function stringifyOrderedFrontmatter(fm: Record<string, unknown>): string {
	const normalizedFm: Record<string, unknown> = {};

	for (const [rawKey, val] of Object.entries(fm)) {
		if (isEmptyValue(val)) continue;

		const cleanKey = rawKey.replace(/["':]/g, "").trim();
		const lower = cleanKey.toLowerCase();
		let targetKey: string;

		if (PLURAL_PROPERTY_MAP[lower]) {
			targetKey = PLURAL_PROPERTY_MAP[lower];
		} else if (cleanKey === "created date" || lower === "created date" || cleanKey === "created_date") {
			targetKey = "created_date";
		} else if (cleanKey === "modified date" || lower === "modified date" || cleanKey === "modified_date") {
			targetKey = "modified_date";
		} else if (cleanKey === "in-progress") {
			targetKey = "in_progress";
		} else if (cleanKey === "ZoteroTags" || lower === "zoterotags") {
			targetKey = "zotero_tags";
		} else if (cleanKey === "ZoteroCollections" || lower === "zoterocollections") {
			targetKey = "zotero_collections";
		} else if (cleanKey === "citation key" || cleanKey === "citation_key") {
			targetKey = "citekey";
		} else {
			targetKey = toSnakeCase(cleanKey);
		}

		let normalizedVal = val;
		if (targetKey === "created_date" || targetKey === "modified_date") {
			const formattedTs = formatTimestampWithOffset(val);
			if (formattedTs) {
				normalizedVal = formattedTs;
			}
		}

		normalizedFm[targetKey] = normalizedVal;
	}

	const orderedFm = orderFrontmatter(normalizedFm);

	const lines: string[] = ["---"];
	for (const [key, val] of Object.entries(orderedFm)) {
		if (isEmptyValue(val)) continue;
		const formatted = formatYamlValue(val);
		if (Array.isArray(val) && val.length > 0) {
			lines.push(`${key}:${formatted}`);
		} else {
			lines.push(`${key}: ${formatted}`.trimEnd());
		}
	}
	lines.push("---");
	return lines.join("\n");
}

/**
 * Main conversion function: transfers dataview properties in callout to file properties (frontmatter).
 * Uses parseOldFormatNote to ingest notes in the old format.
 */
export async function convertDataviewPropsToFrontmatter(
	rawNoteContent: string,
	filePath: string,
	zoteroClient?: ZoteroClient
): Promise<ConversionResult> {
	const changesMade: string[] = [];
	const fallbackStem = filePath.split("/").pop()?.replace(/\.md$/, "") || "";
	const oldNote = parseOldFormatNote(rawNoteContent, fallbackStem);

	const rawFm = oldNote.frontmatter;
	const bodyText = oldNote.body;
	const dv = oldNote.fields;

	// Ingest existing frontmatter properties with snake_case normalization, plural merging, and collision protection
	const existingFm: Record<string, unknown> = {};

	for (const [rawKey, val] of Object.entries(rawFm)) {
		if (isEmptyValue(val)) {
			changesMade.push(`Omitted empty property '${rawKey}'`);
			continue;
		}

		const cleanKey = rawKey.replace(/["':]/g, "").trim();
		const lower = cleanKey.toLowerCase();
		let targetKey: string;

		if (PLURAL_PROPERTY_MAP[lower]) {
			targetKey = PLURAL_PROPERTY_MAP[lower];
		} else if (cleanKey === "created date" || lower === "created date" || cleanKey === "created_date") {
			targetKey = "created_date";
		} else if (cleanKey === "modified date" || lower === "modified date" || cleanKey === "modified_date") {
			targetKey = "modified_date";
		} else if (cleanKey === "in-progress") {
			targetKey = "in_progress";
		} else if (cleanKey === "ZoteroTags") {
			targetKey = "zotero_tags";
		} else if (cleanKey === "ZoteroCollections") {
			targetKey = "zotero_collections";
		} else if (cleanKey === "citation key" || cleanKey === "citation_key") {
			if (existingFm.citekey !== undefined) {
				changesMade.push("Removed redundant 'citation key' property (citekey already present)");
				continue;
			}
			targetKey = "citekey";
		} else if (cleanKey === "citekey") {
			targetKey = "citekey";
			if (existingFm.citekey !== undefined) {
				// Overwrite any earlier citation key with the explicit citekey
				existingFm.citekey = val;
				changesMade.push("Replaced 'citation key' with explicit 'citekey'");
				continue;
			}
		} else {
			targetKey = toSnakeCase(cleanKey);
		}

		if (existingFm[targetKey] !== undefined) {
			// If plural property, merge them
			if (targetKey === "tags" || targetKey === "aliases" || targetKey === "cssclasses") {
				const currentList = Array.isArray(existingFm[targetKey])
					? (existingFm[targetKey] as unknown[])
					: [existingFm[targetKey]];
				const newList = Array.isArray(val) ? val : [val];
				const merged = [
					...new Set(
						[...currentList, ...newList]
							.map(String)
							.map(cleanTextValue)
							.filter((s) => !isEmptyValue(s))
					),
				];
				existingFm[targetKey] = merged;
				changesMade.push(`Merged '${cleanKey}' into plural property '${targetKey}'`);
			} else {
				// Collision detection without overwriting
				const existingVal = existingFm[targetKey];
				if (JSON.stringify(existingVal) === JSON.stringify(val)) {
					// Duplicate identical property, keep one
				} else {
					// Preserve both values for review
					const reviewKey = `${targetKey}_review`;
					existingFm[reviewKey] = val;
					changesMade.push(
						`Collision detected: '${cleanKey}' conflicts with existing '${targetKey}'. Preserved both values for review.`
					);
				}
			}
		} else {
			existingFm[targetKey] = val;
			if (cleanKey !== targetKey) {
				changesMade.push(`Normalized property name '${cleanKey}' -> '${targetKey}'`);
			}
		}
	}

	// Resolve authors list
	let authorsList: string[] = [];
	let layoutType: "LayoutA" | "LayoutB" | "NoAuthors" = oldNote.layoutType;

	if (Array.isArray(existingFm.authors) && existingFm.authors.length > 0) {
		authorsList = (existingFm.authors as string[]).map(cleanTextValue).filter((s) => !isEmptyValue(s));
	} else if (typeof existingFm.authors === "string" && !isEmptyValue(existingFm.authors)) {
		authorsList = [cleanTextValue(existingFm.authors)];
	} else if (oldNote.layoutType === "LayoutA") {
		authorsList = oldNote.authors.map(cleanTextValue).filter((s) => !isEmptyValue(s));
		changesMade.push(`Converted Layout A authors (${authorsList.length} authors)`);
	} else if (oldNote.layoutType === "LayoutB") {
		const singleStr = oldNote.fields.singleAuthorRaw || oldNote.authors[0];
		let zoteroCreators: string[] | null = null;
		const lookupKey =
			dv.zoteroItemKey ||
			(existingFm.zotero_item_key as string) ||
			dv.citekey ||
			(existingFm.citekey as string) ||
			oldNote.citekey;

		const itemKeyFromUri = extractZoteroItemKey(bodyText) || "";
		const itemKeyToFetch = dv.zoteroItemKey || itemKeyFromUri;

		if (zoteroClient && (itemKeyToFetch || lookupKey)) {
			try {
				let item: any = null;
				if (itemKeyToFetch) {
					item = await zoteroClient.getItemByKey(itemKeyToFetch);
				}
				if (!item && lookupKey) {
					item = await zoteroClient.getItemByCitekey(lookupKey);
				}

				if (item && item.creators && Array.isArray(item.creators) && item.creators.length > 0) {
					zoteroCreators = extractAuthorsFromZoteroCreators(item.creators);
				}
			} catch (err) {
				console.debug("Zotero creator lookup error:", err);
			}
		}

		if (zoteroCreators && zoteroCreators.length > 0) {
			authorsList = zoteroCreators;
			changesMade.push(
				`Converted Layout B single author string '${singleStr}' using Zotero structured creators (${authorsList.length} authors)`
			);
		} else {
			const fallbackAuthors = parseAuthorStringFallback(singleStr);
			if (fallbackAuthors.length > 0) {
				authorsList = fallbackAuthors;
				changesMade.push(
					`Converted Layout B author string '${singleStr}' using note fallback (${authorsList.length} author(s))`
				);
			} else if (singleStr) {
				authorsList = [cleanTextValue(singleStr)];
				changesMade.push(`Preserved author string '${singleStr}' in frontmatter`);
			}
		}
	}

	// Update frontmatter fields
	const updatedFm: Record<string, unknown> = { ...existingFm };

	if (updatedFm.category === undefined) {
		updatedFm.category = ["literaturenote"];
	}

	// Mandatory boolean file properties
	if (updatedFm.read === undefined) {
		updatedFm.read = false;
		changesMade.push("Initialized missing 'read' property to false");
	} else if (typeof updatedFm.read === "string") {
		updatedFm.read = updatedFm.read === "true";
	}

	if (updatedFm.in_progress === undefined) {
		updatedFm.in_progress = false;
		changesMade.push("Initialized missing 'in_progress' property to false");
	} else if (typeof updatedFm.in_progress === "string") {
		updatedFm.in_progress = updatedFm.in_progress === "true";
	}

	if (updatedFm.linked === undefined) {
		updatedFm.linked = false;
		changesMade.push("Initialized missing 'linked' property to false");
	} else if (typeof updatedFm.linked === "string") {
		updatedFm.linked = updatedFm.linked === "true";
	}

	if (authorsList.length > 0) {
		updatedFm.authors = authorsList;
	} else {
		changesMade.push("Warning: Unable to convert any dataview field into an authors file property");
	}

	if (dv.unconvertedFields && dv.unconvertedFields.length > 0) {
		for (const u of dv.unconvertedFields) {
			changesMade.push(`Left dataview field in callout: '${u.rawKey}' (value: "${u.value}")`);
		}
	}

	// Title: robustly resolved from old-format reader, wording and capitalization preserved
	const noteTitle = cleanTextValue(oldNote.title);
	if (noteTitle) {
		updatedFm.title = noteTitle;
		changesMade.push(`Set frontmatter 'title': "${noteTitle}"`);
	}

	// Publication date: formatted as official ISO 8601 string, ambiguous dates flagged
	const rawDate = oldNote.date || (updatedFm.publication_date as string);
	if (rawDate) {
		const parsedDate = parseObsidianDate(rawDate);
		if (parsedDate.isAmbiguous) {
			changesMade.push(
				parsedDate.flagReason ||
					`Flagged ambiguous date '${rawDate}': cannot distinguish month from day without guessing`
			);
			updatedFm.publication_date = rawDate.trim();
		} else if (parsedDate.formatted) {
			updatedFm.publication_date = parsedDate.formatted;
			changesMade.push(`Set frontmatter 'publication_date': ${parsedDate.formatted}`);
		}
	}

	// Citekey
	if (oldNote.citekey) {
		updatedFm.citekey = oldNote.citekey.trim();
	}

	const itemKey = dv.zoteroItemKey || extractZoteroItemKey(bodyText);
	if (itemKey && !updatedFm.zotero_item_key) {
		updatedFm.zotero_item_key = itemKey.trim();
		changesMade.push(`Set frontmatter 'zotero_item_key': ${itemKey}`);
	}
	if (dv.itemType) {
		updatedFm.zotero_item_type = dv.itemType.trim();
		changesMade.push(`Set frontmatter 'zotero_item_type': ${dv.itemType}`);
	}
	if (dv.doi) {
		const bareDoi = canonicalizeDoi(dv.doi);
		if (bareDoi) {
			updatedFm.doi = bareDoi;
			changesMade.push(`Set frontmatter 'doi': ${bareDoi}`);
		}
	} else if (updatedFm.doi) {
		updatedFm.doi = canonicalizeDoi(String(updatedFm.doi));
	}

	if (dv.url) {
		updatedFm.url = dv.url.trim();
		changesMade.push(`Set frontmatter 'url': ${dv.url}`);
	}
	if (dv.journal) {
		const pub = cleanTextValue(dv.journal);
		updatedFm.publication = pub;
		changesMade.push(`Set frontmatter 'publication': ${pub}`);
	}
	if (dv.book && dv.book !== dv.journal) {
		const book = cleanTextValue(dv.book);
		updatedFm.book_title = book;
		changesMade.push(`Set frontmatter 'book_title': ${book}`);
	}
	if (dv.publisher) {
		const pub = cleanTextValue(dv.publisher);
		updatedFm.publisher = pub;
		changesMade.push(`Set frontmatter 'publisher': ${pub}`);
	}
	if (dv.isbn) {
		updatedFm.isbn = dv.isbn.trim();
		changesMade.push(`Set frontmatter 'isbn': ${dv.isbn}`);
	}

	if (dv.zoteroTags && dv.zoteroTags.length > 0) {
		updatedFm.zotero_tags = dv.zoteroTags.map(cleanTextValue).filter((s) => !isEmptyValue(s));
	}
	if (dv.zoteroCollections && dv.zoteroCollections.length > 0) {
		updatedFm.zotero_collections = dv.zoteroCollections.map(cleanTextValue).filter((s) => !isEmptyValue(s));
	}

	if (dv.createdDate && !updatedFm.created_date) {
		const formatted = formatTimestampWithOffset(dv.createdDate);
		updatedFm.created_date = formatted || dv.createdDate;
		changesMade.push(`Set frontmatter 'created_date' from Dataview field: ${updatedFm.created_date}`);
	}
	if (dv.modifiedDate && !updatedFm.modified_date) {
		const formatted = formatTimestampWithOffset(dv.modifiedDate);
		updatedFm.modified_date = formatted || dv.modifiedDate;
		changesMade.push(`Set frontmatter 'modified_date' from Dataview field: ${updatedFm.modified_date}`);
	}

	if (updatedFm.created_date) {
		const formatted = formatTimestampWithOffset(updatedFm.created_date);
		if (formatted) {
			updatedFm.created_date = formatted;
		}
	}
	if (updatedFm.modified_date) {
		const formatted = formatTimestampWithOffset(updatedFm.modified_date);
		if (formatted) {
			updatedFm.modified_date = formatted;
		}
	}
	if (updatedFm.created_date_review) {
		const formatted = formatTimestampWithOffset(updatedFm.created_date_review);
		if (formatted) {
			updatedFm.created_date_review = formatted;
		}
	}
	if (updatedFm.modified_date_review) {
		const formatted = formatTimestampWithOffset(updatedFm.modified_date_review);
		if (formatted) {
			updatedFm.modified_date_review = formatted;
		}
	}

	// Aliases: GUARANTEED title at index 0
	if (noteTitle || updatedFm.aliases) {
		const newAliases = buildAliases(noteTitle, updatedFm.aliases);
		if (newAliases.length > 0) {
			updatedFm.aliases = newAliases;
			changesMade.push(`Updated aliases (title as first alias): ${JSON.stringify(newAliases)}`);
		}
	}

	// Clean and normalize all properties:
	// - Omit empty values
	// - Ensure multi-value properties are YAML lists
	// - Coerce booleans and numbers
	for (const [key, val] of Object.entries(updatedFm)) {
		if (isEmptyValue(val)) {
			delete updatedFm[key];
			continue;
		}

		if (MULTI_VALUE_PROPERTIES.has(key)) {
			let arr: string[] = [];
			if (Array.isArray(val)) {
				arr = val.map(String).map(cleanTextValue).filter((s) => !isEmptyValue(s));
			} else {
				const cleaned = cleanTextValue(String(val));
				if (!isEmptyValue(cleaned)) {
					arr = [cleaned];
				}
			}
			if (arr.length === 0) {
				delete updatedFm[key];
			} else {
				updatedFm[key] = arr;
			}
		} else if (typeof val === "string") {
			const trimmed = val.trim();
			if (trimmed === "true") {
				updatedFm[key] = true;
			} else if (trimmed === "false") {
				updatedFm[key] = false;
			} else if (!IDENTIFIER_PROPERTIES.has(key) && /^-?\d+$/.test(trimmed)) {
				updatedFm[key] = Number(trimmed);
			} else {
				updatedFm[key] = cleanTextValue(val);
			}
		}
	}

	// Clean callout body with blank lines above and below, removing legacy comment markers
	if (/%%[ \t]*(?:begin|end)\s+obsidian\s+notes[ \t]*%%/i.test(bodyText)) {
		changesMade.push("Removed legacy 'begin/end Obsidian Notes' comment markers");
	}
	if (/%%[ \t]*import\s+date:/i.test(bodyText)) {
		changesMade.push("Removed legacy 'Import Date' comment");
	}

	const updatedBody = cleanCalloutBody(bodyText);

	// Format final note text
	const newFmText = stringifyOrderedFrontmatter(updatedFm);
	const updatedContent = `${newFmText}\n${updatedBody}`;

	return {
		success: true,
		skipped: false,
		filePath,
		originalContent: rawNoteContent,
		updatedContent,
		updatedBody,
		updatedFm,
		changesMade,
		layoutType,
		unconvertedDataviewFields: dv.unconvertedFields,
		hasAuthorsProperty: authorsList.length > 0,
	};
}
