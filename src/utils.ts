import { App, Editor, TFile } from "obsidian";

export function sanitizeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|#^\[\]]/g, "");
}

/**
 * Finds the wikilink or embed under the editor cursor in `sourceFile` and
 * resolves it to the TFile it points to, using Obsidian's metadata
 * cache. Returns null if there is no link at the cursor, or if the
 * link cannot be resolved to an existing file.
 */
export function resolveLinkAtCursor(app: App, sourceFile: TFile, editor: Editor): TFile | null {
	const cursor = editor.getCursor();
	const cache = app.metadataCache.getFileCache(sourceFile);
	const candidates = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];

	const hit = candidates.find(({ position }) => {
		const { start, end } = position;
		const afterStart =
			cursor.line > start.line || (cursor.line === start.line && cursor.ch >= start.col);
		const beforeEnd =
			cursor.line < end.line || (cursor.line === end.line && cursor.ch <= end.col);
		return afterStart && beforeEnd;
	});

	if (!hit) return null;

	const dest = app.metadataCache.getFirstLinkpathDest(hit.link, sourceFile.path);
	return dest ?? null;
}

/**
 * Suggest a filename derived from a selected text region.
 * Collapses newlines/whitespace, strips invalid filename characters,
 * trims, and limits length to max 60 chars.
 */
export function suggestFilenameFromSelection(selectionText: string): string {
	if (!selectionText) return "";
	const collapsed = selectionText.replace(/\s+/g, " ").trim();
	const sanitized = sanitizeFilename(collapsed).trim();
	if (sanitized.length > 60) {
		return sanitized.slice(0, 60).trim();
	}
	return sanitized;
}

/**
 * Formats alias text for a wikilink.
 * Replaces newlines/consecutive whitespace with a single space,
 * escapes closing brackets ']]' as '\]\]',
 * and truncates to 1000 chars ending with '**...**' if exceeded.
 */
export function formatWikilinkAlias(text: string): string {
	if (!text) return "";
	const collapsed = text.replace(/\s+/g, " ").trim();
	const escaped = collapsed.replace(/\]\]/g, "\\]\\]");
	if (escaped.length > 1000) {
		return escaped.slice(0, 1000) + "**...**";
	}
	return escaped;
}

/**
 * Determines the wikilink alias string to pass to Obsidian's generateMarkdownLink.
 * Returns undefined if no alias is needed.
 */
export function determineWikilinkAlias(
	sanitizedTargetFilename: string,
	originalSelectedText?: string,
	defaultFilename?: string,
	rawInputText?: string
): string | undefined {
	const sanitized = sanitizedTargetFilename.trim();

	const userEdited =
		rawInputText !== undefined &&
		defaultFilename !== undefined &&
		rawInputText.trim() !== defaultFilename.trim();

	if (userEdited && rawInputText) {
		const userAlias = formatWikilinkAlias(rawInputText);
		if (userAlias && userAlias !== sanitized) {
			return userAlias;
		}
		return undefined;
	}

	if (originalSelectedText && originalSelectedText.trim()) {
		const alias = formatWikilinkAlias(originalSelectedText);
		if (alias && alias !== sanitized) {
			return alias;
		}
	}

	return undefined;
}

/**
 * Builds the wikilink syntax [[Target|Alias]] or [[Target]].
 * Prioritizes user-typed text if the user edited the default filename.
 */
export function buildWikilink(
	targetFilename: string,
	originalSelectedText?: string,
	defaultFilename?: string,
	rawInputText?: string
): string {
	const sanitizedTarget = sanitizeFilename(targetFilename).trim();
	const alias = determineWikilinkAlias(
		sanitizedTarget,
		originalSelectedText,
		defaultFilename,
		rawInputText
	);

	if (alias) {
		return `[[${sanitizedTarget}|${alias}]]`;
	}

	return `[[${sanitizedTarget}]]`;
}

/**
 * Unwraps fenced code blocks surrounding prompts, especially when they start with a heading.
 * Handles variants such as language-tagged fences, trailing newlines, or text following
 * the code block.
 */
export function unwrapFencedHeading(text: string): string {
	let trimmed = text.trim();
	if (trimmed.startsWith("```")) {
		// 1. Try matching with closing backticks at the very end of the string (to safely support nested code blocks)
		let match = trimmed.match(/^```(\S*)\n([\s\S]*?)\n```$/);
		if (match) {
			const inside = match[2].trim();
			if (inside.startsWith("#")) {
				const rest = trimmed.slice(match[0].length).trim();
				return rest ? `${inside}\n\n${rest}` : inside;
			}
		}

		// 2. Fallback: match without closing backticks (the whole remaining text is the inside)
		match = trimmed.match(/^```(\S*)\n([\s\S]*)$/);
		if (match) {
			const inside = match[2].trim();
			if (inside.startsWith("#")) {
				return inside;
			}
		}
	}
	return trimmed;
}

/**
 * Checks if the given note text represents an AI dialog note saved by Perplexity Saver
 * by verifying the presence of turn block anchors (e.g. ^turn-N).
 */
export function isAiDialogNote(noteText: string): boolean {
	if (!noteText) return false;
	return /\^turn-\d+/.test(noteText);
}

export function normalizeUrl(url: string): string {
	if (!url) return "";
	try {
		let cleaned = url.toLowerCase().trim();
		// Normalize protocol: http:// -> https://
		if (cleaned.startsWith("http://")) {
			cleaned = "https://" + cleaned.substring(7);
		}
		const parsed = new URL(cleaned);
		let path = parsed.pathname;
		while (path.length > 1 && path.endsWith("/")) {
			path = path.slice(0, -1);
		}

		// ArXiv URL canonicalization: /pdf/1805.09785.pdf, /html/1805.09785v1 -> /abs/1805.09785
		const arxivMatch =
			/^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]+)?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i.exec(
				path
			);
		if (parsed.hostname.includes("arxiv.org") && arxivMatch) {
			path = "/abs/" + arxivMatch[1];
		}

		return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
	} catch {
		// Fallback for non-standard URLs
		let cleaned = url.toLowerCase().trim();
		if (cleaned.startsWith("http://")) {
			cleaned = "https://" + cleaned.substring(7);
		}
		return cleaned;
	}
}
