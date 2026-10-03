/**
 * Literature note body and frontmatter builder.
 *
 * Ports the Jinja2 template and Python helper functions from
 * refwrangle/zmknote/zotero_to_obsidian_note_receiver.py to TypeScript.
 *
 * All branches of the original template are covered:
 *   - tags / collections loops (may be empty)
 *   - relations loop with citekey guard
 *   - bibliography conditional
 *   - notes conditional (HTML → markdown)
 *   - infoCalloutLinks: Zotero URI always; DOI, URL, and each attachment type only if present
 *   - infoCalloutPrefix: abstract block (if present)
 */

import { htmlToMarkdown, App } from "obsidian";
import type { ZoteroAttachment, ZoteroItemPayload } from "./types";
import { findLitNoteForCitekey } from "../zotero/matcher";


// ---------------------------------------------------------------------------
// String helpers (ported from Python)
// ---------------------------------------------------------------------------

/**
 * Return the first n words of a title joined by spaces.
 * Mirrors the Jinja2 `truncateTitle` macro: `' '.join(title.split(' ')[:n])`.
 */
export function truncateTitle(title: string, n: number): string {
	return title.split(" ").slice(0, n).join(" ");
}

import {
	formatObsidianDate,
	parseObsidianDate,
	cleanTextValue,
	canonicalizeDoi,
	isEmptyValue,
	orderFrontmatter,
	formatTimestampWithOffset,
	extractAuthorsFromZoteroCreators,
} from "./propertyUtils";

export {
	formatObsidianDate,
	parseObsidianDate,
	cleanTextValue,
	canonicalizeDoi,
	isEmptyValue,
};

/**
 * Clean up quotes and escape characters from title/field strings.
 */
export function cleanFieldValue(val: string): string {
	let trimmed = val.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		trimmed = trimmed.slice(1, -1).trim();
	}
	return trimmed.replace(/\\"/g, '"');
}

/**
 * Build the aliases list for a literature note.
 * Guarantees that the first item is always the exact article title (when title is present).
 * If the title is longer than 5 words, the 5-word truncated title is added next.
 * Any other existing aliases are appended after, deduplicated case-insensitively.
 */
export function buildAliases(title?: string, existingAliases?: unknown): string[] {
	const aliases: string[] = [];
	const seen = new Set<string>();

	const cleanTitle = cleanFieldValue(title ?? "");
	if (cleanTitle) {
		aliases.push(cleanTitle);
		seen.add(cleanTitle.toLowerCase());

		const trunc = truncateTitle(cleanTitle, 5).trim();
		if (trunc && !seen.has(trunc.toLowerCase())) {
			aliases.push(trunc);
			seen.add(trunc.toLowerCase());
		}
	}

	if (existingAliases) {
		let rawList: unknown[] = [];
		if (Array.isArray(existingAliases)) {
			rawList = existingAliases;
		} else if (typeof existingAliases === "string") {
			rawList = [existingAliases];
		}
		for (const item of rawList) {
			const str = cleanFieldValue(String(item));
			if (str && !seen.has(str.toLowerCase())) {
				aliases.push(str);
				seen.add(str.toLowerCase());
			}
		}
	}

	return aliases;
}

/**
 * Return the last path component of a file path, normalising Windows
 * backslashes. Mirrors the Jinja2 `basename` macro.
 */
function basenameForLink(filePath: string): string {
	return filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
}

/**
 * Strip URLs, DOIs, and orphaned commas from a BBT-formatted bibliography
 * string. Ported from `cleanup_bibliography_text()` in the Python receiver.
 */
export function cleanupBibliography(bibliography: string): string {
	if (!bibliography) return "";
	let b = bibliography;
	// Remove http(s):// URLs
	b = b.replace(/https?:\/\/\S+/g, "");
	// Remove www.* URLs
	b = b.replace(/www\.\S+/g, "");
	// Remove doi.org/ paths
	b = b.replace(/doi\.org\/\S+/g, "");

	// Python implementation repeated these replacements to catch cascading commas.
	let prev: string;
	do {
		prev = b;
		// Trailing comma before period → just period
		b = b.replace(/,\s*\./g, ".");
		// Trailing comma at end → period
		b = b.replace(/,\s*$/, ".");
		// Orphaned double commas
		b = b.replace(/,\s+,/g, ",");
		// Orphaned double periods
		b = b.replace(/\.\s*\./g, ".");
	} while (b !== prev);

	// Collapse whitespace
	b = b.replace(/\s+/g, " ").trim();
	return b;
}

// ---------------------------------------------------------------------------
// Callout builders (ported from Python helper functions)
// ---------------------------------------------------------------------------

const ATTACHMENT_LABELS: Record<string, string> = {
	".pdf": "PDF",
	".html": "HTM",
	".docx": "DOC",
	".pptx": "PPT",
	".epub": "EPUB",
	".txt": "TXT",
};

/**
 * Build the `[!info]-` callout title link bar.
 * Always includes the Zotero desktop select URI (zotero://select/library/items/<itemkey>);
 * adds DOI, URL, and Wikilinked attachment links only when the corresponding field is present.
 * Ported from `build_info_callout_links()`.
 */
export function buildInfoCalloutLinks(item: ZoteroItemPayload): string {
	let zoteroUri = "";

	if (item.itemkey) {
		zoteroUri = `zotero://select/library/items/${item.itemkey}`;
	} else if (item.desktopURI) {
		const match = item.desktopURI.match(/items\/([A-Za-z0-9]+)/);
		if (match) {
			zoteroUri = `zotero://select/library/items/${match[1]}`;
		} else {
			zoteroUri = item.desktopURI;
		}
	}

	const links: string[] = [`[**Zotero**](${encodeURI(zoteroUri)})`];

	if (item.DOI) {
		links.push(`[**DOI**](https://doi.org/${item.DOI})`);
	}
	if (item.url) {
		links.push(`[**URL**](${item.url})`);
	}

	for (const att of item.attachments ?? []) {
		const rawPath = (att as ZoteroAttachment).path;
		const path = typeof rawPath === "string" ? rawPath : "";
		const lowerPath = path.toLowerCase();
		for (const [suffix, label] of Object.entries(ATTACHMENT_LABELS)) {
			if (lowerPath.endsWith(suffix)) {
				const base = basenameForLink(path);
				links.push(`**[[${base}|${label}]]**`);
				break;
			}
		}
	}

	return links.join(" | ");
}

/**
 * Build the optional block of quoted lines inside the `[!info]-` callout body.
 * Emits an Abstract block (if present).
 *
 * The function returns a string that already ends with "\n" when non-empty,
 * so it can be directly concatenated with the next callout line.
 */
export function buildInfoCalloutPrefix(item: ZoteroItemPayload): string {
	const lines: string[] = [];

	const abstract = (item.abstractNote ?? "").trim();
	if (abstract) {
		const oneLine = abstract.replace(/\\n/g, " ").replace(/\n/g, " ");
		lines.push(">", "> **Abstract**", `> ${oneLine}`);
	}

	return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

// ---------------------------------------------------------------------------
// HTML → Markdown for Zotero note HTML
// ---------------------------------------------------------------------------

/**
 * Convert Zotero note HTML to Obsidian markdown.
 * Uses Obsidian's built-in `htmlToMarkdown()` as the primary converter,
 * then applies a post-processing step for Zotero-specific citation spans
 * which htmlToMarkdown() does not handle (they carry a data-citation JSON
 * attribute that encodes the zotero:// select URI).
 */
export function zoteroHtmlToMd(
	app: App,
	settings: { litNotesFolder?: string },
	html: string
): string {
	if (!html) return "";

	let citationMap: Record<string, string> = {};
	let counter = 0;

	// Pre-process: extract citation spans before htmlToMarkdown strips attributes.
	// Our custom Zotero plugin payload parser injects `data-citekey` and `data-zotero-uri`.
	const preprocessed = html.replace(
		/<span[^>]*class="citation"[^>]*>(.*?)<\/span>/gs,
		(match, innerText) => {
			const citekeyMatch = match.match(/data-citekey="([^"]*)"/);
			const uriMatch = match.match(/data-zotero-uri="([^"]*)"/);
			
			if (citekeyMatch && uriMatch) {
				const citekey = citekeyMatch[1];
				const zoteroUri = uriMatch[1];
				const litNoteStem = findLitNoteForCitekey(app, citekey, settings.litNotesFolder);
				const linkText = citekey || innerText;
				
				let replacement = "";
				if (litNoteStem) {
					replacement = (litNoteStem === linkText) ? `[[${litNoteStem}]]` : `[[${litNoteStem}|${linkText}]]`;
				} else {
					replacement = `[${linkText}](${zoteroUri})`;
				}
				
				const id = `__ZOTERO_CITATION_${counter++}__`;
				citationMap[id] = replacement;
				return id;
			}
			return innerText; // fallback if no data attributes
		}
	);

	// Highlights: <span style="background-color: ...">text</span> → ==text==
	const highlighted = preprocessed.replace(
		/<span[^>]+style="[^"]*background-color[^"]*"[^>]*>(.*?)<\/span>/gs,
		"==$1=="
	);

	let md = htmlToMarkdown(highlighted);

	// Restore citations from placeholders to avoid Turndown escaping brackets
	for (const [id, rep] of Object.entries(citationMap)) {
		md = md.replace(id, rep);
	}

	return md;
}

// ---------------------------------------------------------------------------
// Full note body builder
// ---------------------------------------------------------------------------

/**
 * Assemble the markdown body of the literature note (everything after the
 * frontmatter fence). This string is passed to `app.vault.create()` and
 * frontmatter is then added separately via `processFrontMatter`.
 */
export function buildLitNoteBody(
	app: App,
	settings: { litNotesFolder?: string },
	item: ZoteroItemPayload,
	transcript?: string
): string {
	const calloutLinks = buildInfoCalloutLinks(item);
	const calloutPrefix = buildInfoCalloutPrefix(item);

	// Info callout header line
	const lines: string[] = [
		"",
		`> [!info]- &nbsp;${calloutLinks}`,
	];

	if (calloutPrefix) {
		for (const l of calloutPrefix.trimEnd().split("\n")) {
			lines.push(l);
		}
	}

	// Bibliography block (conditional)
	const bib = cleanupBibliography(item.bibliography ?? "");
	if (bib) {
		lines.push("", `> ${bib}`);
	}

	// Notes section (conditional)
	const notes = item.notes ?? [];
	if (notes.length > 0) {
		lines.push("", "___");
		lines.push(`> [!note]- &nbsp;Zotero Note (${notes.length})`);
		for (let i = 0; i < notes.length; i++) {
			if (i > 0) {
				lines.push(">", "> ---", ">"); // Visual separator between distinct Zotero notes
			}
			const md = zoteroHtmlToMd(app, settings, notes[i]);
			// Indent each line with "> " and promote h1/h2 to h3
			const indented = md
				.replace(/^# /gm, "### ")
				.replace(/^## /gm, "### ")
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n");
			lines.push(indented);
		}
	}

	if (transcript && transcript.trim()) {
		lines.push("", "");
		lines.push("# Transcript", "");
		lines.push(transcript.trim());
	}

	return lines.join("\n") + "\n\n";
}

// ---------------------------------------------------------------------------
// Frontmatter builder
// ---------------------------------------------------------------------------

import type { NameStyle } from "./bibtexName";

/**
 * Build the frontmatter object for a literature note in the new Obsidian file property format.
 */
export function buildLitNoteFrontmatter(
	item: ZoteroItemPayload,
	settings?: { authorFormatStyle?: NameStyle; authorDropVon?: boolean }
): Record<string, unknown> {
	const normalizeTag = (t: any) => (typeof t === "string" ? t.toLowerCase().replace(/ /g, "_") : "");

	const creators = extractAuthorsFromZoteroCreators(
		item.creators,
		settings?.authorFormatStyle ?? "last-first",
		{ dropVon: settings?.authorDropVon }
	);

	const fm: Record<string, unknown> = {
		category: ["literaturenote"],
		tags: [],
		read: false,
		in_progress: false,
		linked: false,
	};

	const aliases = buildAliases(item.title);
	if (aliases.length > 0) {
		fm.aliases = aliases;
	}

	if (item.citekey) {
		fm.citekey = item.citekey.trim();
	}

	if (item.tags && item.tags.length > 0) {
		const normTags = item.tags.map(normalizeTag).filter(Boolean);
		if (normTags.length > 0) {
			fm.zotero_tags = normTags;
		}
	}

	if (item.collections && item.collections.length > 0) {
		const normColls = item.collections.map(normalizeTag).filter(Boolean);
		if (normColls.length > 0) {
			fm.zotero_collections = normColls;
		}
	}

	if (creators.length > 0) {
		fm.authors = creators;
	}
	if (item.title) {
		fm.title = cleanTextValue(item.title);
	}
	if (item.date) {
		const formattedDate = formatObsidianDate(item.date);
		if (formattedDate) {
			fm.publication_date = formattedDate;
		}
	}
	if (item.itemkey) {
		fm.zotero_item_key = item.itemkey.trim();
	}
	if (item.itemType) {
		fm.zotero_item_type = item.itemType.trim();
	}
	if (item.DOI) {
		const bareDoi = canonicalizeDoi(item.DOI);
		if (bareDoi) {
			fm.doi = bareDoi;
		}
	}
	if (item.url) {
		fm.url = item.url.trim();
	}
	if (item.publicationTitle) {
		fm.publication = cleanTextValue(item.publicationTitle);
	}
	if (item.publisher) {
		fm.publisher = cleanTextValue(item.publisher);
	}
	if (item.ISBN) {
		fm.isbn = item.ISBN.trim();
	}

	fm.created_date = formatTimestampWithOffset(item.exportDate ?? new Date());

	return orderFrontmatter(fm);
}
