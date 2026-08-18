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
 *   - infoCalloutPrefix: abstract block and grouped-creator block only if present
 */

import { htmlToMarkdown, App } from "obsidian";
import type { ZoteroAttachment, ZoteroCreator, ZoteroItemPayload } from "./types";
import { findLitNoteForCitekey } from "../zotero/matcher";


// ---------------------------------------------------------------------------
// String helpers (ported from Python)
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion in YAML double-quoted string values.
 * Handles backslashes and double quotes (the two characters that break
 * YAML quoting inside "...").
 */
export function yamlEscape(value: string): string {
	if (typeof value !== "string") return value;
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Return the first n words of a title joined by spaces.
 * Mirrors the Jinja2 `truncateTitle` macro: `' '.join(title.split(' ')[:n])`.
 */
export function truncateTitle(title: string, n: number): string {
	return title.split(" ").slice(0, n).join(" ");
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
 * Always includes the Zotero desktop URI; adds DOI, URL, and
 * Wikilinked attachment links only when the corresponding field is present.
 * Ported from `build_info_callout_links()`.
 */
export function buildInfoCalloutLinks(item: ZoteroItemPayload): string {
	const links: string[] = [`[**Zotero**](${item.desktopURI ?? ""})`];

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
 * Return the display name for a single Zotero creator dict.
 * Matches the Python `creator_display_name()` helper.
 */
function creatorDisplayName(creator: ZoteroCreator): string {
	if (creator.name) return creator.name;
	const last = (creator.lastName ?? "").trim();
	const first = (creator.firstName ?? "").trim();
	if (last && first) return `${last}, ${first}`;
	return last || first;
}

/**
 * Build the optional block of quoted lines that precede standard metadata
 * inside the `[!info]-` callout body.
 * Emits an Abstract block (if present) then a grouped-creator block (if any creators).
 * Ported from `build_info_callout_prefix()`.
 *
 * The function returns a string that already ends with "\n" when non-empty,
 * so it can be directly concatenated with the next callout line.
 */
export function buildInfoCalloutPrefix(item: ZoteroItemPayload): string {
	const lines: string[] = [];

	const abstract = (item.abstractNote ?? "").trim();
	if (abstract) {
		const oneLine = abstract.replace(/\\n/g, " ").replace(/\n/g, " ");
		lines.push(">", "> **Abstract**", `> ${oneLine}`, ">");
	}

	const creators = item.creators ?? [];
	const grouped: Record<string, string[]> = {};
	for (const c of creators) {
		const type = (c.creatorType ?? "creator").trim();
		const name = creatorDisplayName(c);
		if (name) {
			(grouped[type] ??= []).push(name);
		}
	}

	if (Object.keys(grouped).length > 0) {
		lines.push(">");
		for (const [type, names] of Object.entries(grouped)) {
			const label = type.charAt(0).toUpperCase() + type.slice(1);
			lines.push(`> **${label}**:: ${names.join(", ")}`);
		}
		lines.push(">");
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
 *
 * Structure mirrors the Jinja2 template in zotero_to_obsidian_note_receiver.py.
 */
export function buildLitNoteBody(
	app: App,
	settings: { litNotesFolder?: string },
	item: ZoteroItemPayload
): string {
	const calloutLinks = buildInfoCalloutLinks(item);
	const calloutPrefix = buildInfoCalloutPrefix(item);

	// Info callout header line
	const lines: string[] = [
		"",
		`> [!info]- &nbsp;${calloutLinks}`,
	];

	// The prefix (abstract + creators) may be empty — if so, skip it.
	// Each line in the prefix already starts with "> " from the builder.
	if (calloutPrefix) {
		// calloutPrefix ends with "\n"; split and push each line individually
		// to keep consistent array-based assembly.
		for (const l of calloutPrefix.trimEnd().split("\n")) {
			lines.push(l);
		}
	}

	// Standard metadata fields inside the callout body
	lines.push(
		`> **Title**:: "${item.title}"`,
		`> **Date**:: ${item.date ?? ""}`,
		`> **Citekey**:: ${item.citekey}`,
		`> **ZoteroItemKey**:: ${item.itemkey ?? ""}`,
		`> **itemType**:: ${item.itemType ?? ""}`,
		`> **DOI**:: ${item.DOI ?? ""}`,
		`> **URL**:: ${item.url ?? ""}`,
		`> **Journal**:: ${item.publicationTitle ?? ""}`,
		`> **Volume**:: ${item.volume ?? ""}`,
		`> **Issue**:: ${item.issue ?? ""}`,
		`> **Book**:: ${item.publicationTitle ?? ""}`,
		`> **Publisher**:: ${item.publisher ?? ""}`,
		`> **Location**:: ${item.place ?? ""}`,
		`> **Pages**:: ${item.pages ?? ""}`,
		`> **ISBN**:: ${item.ISBN ?? ""}`,
		`> **ZoteroTags**:: ${JSON.stringify(item.allTags ?? [])}`,
		`> **ZoteroCollections**:: ${JSON.stringify(item.collections ?? [])}`,
	);

	// Relations line — only linked items that have a citekey
	const relatedLinks = (item.relations ?? [])
		.filter((r) => r.citekey)
		.map((r) => `[[@${r.citekey}]]`)
		.join(", ");
	lines.push(`> **Related**::${relatedLinks ? " " + relatedLinks : ""}`);

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
			// Indent each line with "> " and promote h1/h2 to h3 (matches Python behaviour)
			const indented = md
				.replace(/^# /gm, "### ")
				.replace(/^## /gm, "### ")
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n");
			lines.push(indented);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter builder
// ---------------------------------------------------------------------------

/**
 * Build the frontmatter object for a literature note.
 * Passed to `processFrontMatter` so Obsidian formats the YAML itself.
 * Mirrors the YAML block at the top of the Jinja2 template.
 */
export function buildLitNoteFrontmatter(
	item: ZoteroItemPayload
): Record<string, unknown> {
	const normalizeTag = (t: any) => (typeof t === "string" ? t.toLowerCase().replace(/ /g, "_") : "");

	return {
		category: ["literaturenote"],
		tags: [],
		read: false,
		"in-progress": false,
		linked: false,
		aliases: [item.title, truncateTitle(item.title, 5)],
		citekey: item.citekey,
		ZoteroTags: (item.tags ?? []).map(normalizeTag),
		ZoteroCollections: (item.collections ?? []).map(normalizeTag),
		"created date": item.exportDate ?? new Date().toISOString(),
		"modified date": "",
	};
}
