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

import path from "path";
import { htmlToMarkdown, App, FileSystemAdapter, Notice, TFile } from "obsidian";
import type { ZoteroItemPayload } from "./types";
import { getNoteZoteroSelectUri } from "./zoteroUri";
import { findLitNoteForCitekey } from "../zotero/matcher";
import { normalizeTranscriptHeading } from "commons/youtube";


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
 * Adds DOI, URL, and resolved attachment links when present.
 * Ported from `build_info_callout_links()`.
 */
export function buildInfoCalloutLinks(item: ZoteroItemPayload, attachmentLinks: string[] = [], managed = false): string {
	const links: string[] = [`[**Zotero**](${encodeURI(getNoteZoteroSelectUri(item))})`];

	if (item.DOI) {
		links.push(`[**DOI**](https://doi.org/${item.DOI})`);
	}
	if (item.url) {
		links.push(`[**URL**](${item.url})`);
	}

	if (managed) {
		const attachments = attachmentLinks.length ? ` | ${attachmentLinks.join(" | ")}` : "";
		return `${links.join(" | ")}<!-- zotero-attachments:start -->${attachments}<!-- zotero-attachments:end -->`;
	}
	links.push(...attachmentLinks);

	return links.join(" | ");
}

export interface AttachmentProblem {
	path?: string;
	itemkey?: string;
	mode?: "linked" | "stored" | "url";
	label?: string;
	title: string;
	problem: string;
	dialogProblem?: string;
	action: string;
}

export async function buildAttachmentLinks(app: App, item: ZoteroItemPayload, sourcePath: string, onUnavailable?: (details: AttachmentProblem[]) => void): Promise<string[]> {
	const links: string[] = [];
	const unavailable: AttachmentProblem[] = [];
	for (const attachment of item.attachments ?? []) {
		const attachmentPath = attachment.path;
		const pathAdvice = attachment.mode === "stored"
			? "Check the stored attachment in Zotero; the Linked Attachment Base Directory does not apply to stored files."
			: attachment.mode === "linked" && attachment.usesRelativePath
				? item.linkedAttachmentBaseDirectory === ""
					? "Zotero's Linked Attachment Base Directory is unset. Set it to the folder containing the linked file and check the attachment. Changing the directory does not move files."
					: `Check the linked attachment in Zotero and its Linked Attachment Base Directory${item.linkedAttachmentBaseDirectory ? ` (${item.linkedAttachmentBaseDirectory})` : ""}. Changing the directory does not move files.`
				: attachment.mode === "linked"
					? "Check the linked attachment's file location in Zotero."
					: "Check the attachment's file location in Zotero.";
		if (!attachmentPath) {
			if (attachment.isFile || !attachment.url) {
				links.push("**Attachment unavailable in vault**");
				unavailable.push({
					label: attachment.title || "Attachment",
					itemkey: attachment.itemkey,
					mode: attachment.mode,
					title: "Zotero attachment path could not be resolved",
					problem: "Zotero could not resolve a file path.",
					action: pathAdvice,
				});
			}
			continue;
		}
		const label = ATTACHMENT_LABELS[path.extname(attachmentPath).toLowerCase()];
		if (!label && !attachment.isFile && attachment.mode !== "linked" && attachment.mode !== "stored") continue;

		const adapter = app.vault.adapter;
		const vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
		const relative = vaultRoot && path.isAbsolute(attachmentPath)
			? path.relative(vaultRoot, attachmentPath)
			: "";
		const insideVault = relative && relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		const relativePath = insideVault ? relative.split(path.sep).join("/") : "";
		const file = relativePath ? app.vault.getAbstractFileByPath(relativePath) : null;
		let problem = "";
		let dialogProblem: string | undefined;
		let action = "";
		let title = "";
		if (!vaultRoot) {
			title = "Obsidian vault path is unavailable";
			problem = "This vault does not expose a local filesystem path, so Saver cannot verify the attachment.";
			action = "Use a local filesystem vault to link this attachment.";
		} else if (!path.isAbsolute(attachmentPath)) {
			title = "Zotero attachment path is not absolute";
			problem = "Zotero did not provide an absolute file path.";
			action = pathAdvice;
		} else if (!insideVault) {
			title = attachment.mode === "stored"
				? "Stored Zotero attachment has not been moved into the vault"
				: "Zotero attachment is outside the Obsidian vault";
			problem = `This attachment is outside the Obsidian vault (${vaultRoot}). Note attachment links can only target files inside the vault.`;
			dialogProblem = `Vault: ${vaultRoot}. Attachment links can only target files inside it.`;
			action = attachment.mode === "stored"
				? "Move the attachment into the vault and link it in Zotero, then update the note. The Linked Attachment Base Directory does not move stored files."
				: `Link the attachment to a file inside the vault in Zotero, then retry.${attachment.mode === "linked" && attachment.usesRelativePath ? " Changing the Linked Attachment Base Directory does not move files." : ""}`;
		} else {
			try {
				const info = await adapter.stat(relativePath);
				if (!info) {
					title = "Zotero attachment file is missing";
					problem = "The file is missing from this location.";
					action = pathAdvice;
				} else if (info.type !== "file") {
					title = "Zotero attachment path is not a file";
					problem = "This path is not a file.";
					action = "Check the attachment location in Zotero.";
				} else if (!(file instanceof TFile)) {
					title = "Zotero attachment is not indexed by Obsidian";
					problem = "The file exists inside the vault but is not indexed by Obsidian.";
					action = "Check that Obsidian can see the file and let it finish indexing.";
				}
			} catch (error: unknown) {
				title = "Zotero attachment could not be checked";
				problem = `Obsidian could not check this file: ${error instanceof Error ? error.message : String(error)}.`;
				action = "Check the file and its permissions.";
			}
		}
		if (!problem && file instanceof TFile) {
			if (label) links.push(`**${app.fileManager.generateMarkdownLink(file, sourcePath, "", label)}**`);
		} else {
			if (label) links.push(`**${label} unavailable in vault**`);
			unavailable.push({ path: attachmentPath, itemkey: attachment.itemkey, mode: attachment.mode, title, problem, ...(dialogProblem ? { dialogProblem } : {}), action });
		}
	}
	if (unavailable.length) {
		if (onUnavailable) onUnavailable(unavailable);
		else new Notice(
			`Zotero attachments unavailable for "${item.title}":\n${unavailable.map((entry) => `${entry.path ?? entry.label}: ${entry.problem} ${entry.action}`).join("\n\n")}`,
			15000
		);
	}
	return links;
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
		(match: string, innerText: string): string => {
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
export async function buildLitNoteBody(
	app: App,
	settings: { litNotesFolder?: string; transcriptHeading?: string },
	item: ZoteroItemPayload,
	transcript?: string,
	notePath?: string
): Promise<string> {
	const sourcePath = notePath ?? `${settings.litNotesFolder ?? ""}/${item.citekey || item.itemkey || "untitled"}.md`;
	const calloutLinks = buildInfoCalloutLinks(item, await buildAttachmentLinks(app, item, sourcePath), true);
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
		lines.push(`# ${normalizeTranscriptHeading(settings.transcriptHeading)}`, "");
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
	const normalizeTag = (t: unknown) => (typeof t === "string" ? t.toLowerCase().replace(/ /g, "_") : "");

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
	if (item.libraryURI) {
		fm.zotero_library_uri = item.libraryURI.trim();
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
