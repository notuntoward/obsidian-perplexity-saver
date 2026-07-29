import { DialogFile, DialogTurn, NoteRole, ParsedCitation } from "./types";

/** Matches the plain "You said" line that marks a user prompt in Gemini's native copy format. */
const NATIVE_PROMPT_MARKER_RE = /^You said\s*$/m;

/** Matches a level-2 heading ending in "said" (e.g. "## Gemini said") marking an AI response. */
const NATIVE_AI_MARKER_RE = /^##\s+.+\s+said\s*$/m;

/** Matches the bold `**Gemini**` header used in the mixed format to mark an AI response. */
const LEGACY_AI_BOLD_MARKER_RE = /^\*\*Gemini\*\*\s*$/m;

/**
 * Either of the three possible markers: a native "You said" prompt, a
 * native "## ... said" response heading, or a bold `**Gemini**`
 * response header (the mixed format). Captured so the caller can tell
 * which one matched.
 */
const MIXED_MARKER_RE = /^(You said|##\s+.+\s+said|\*\*Gemini\*\*)\s*$/gm;

/** A heading introducing a bulleted or numbered reference/source list at the end of a response. */
const SOURCES_HEADING_RE =
	/^(#{1,6})\s*(?:References?(?:\s*(?:&|and)\s*Sources?)?|Sources?(?:\s*(?:&|and)\s*References?)?)\s*:?\s*$/im;

/**
 * Parse a Gemini dialog export into the shared DialogFile shape.
 *
 * Three formats are accepted:
 *   - Native format (Gemini's own "Copy" button, the most common
 *     real-world export): a title/metadata preamble, then alternating
 *     plain "You said" lines and "## <name> said" headings, with no
 *     separators between turns. A trailing usage-limit notice and the
 *     standard "Gemini is AI and can make mistakes." disclaimer are UI
 *     chrome and are stripped, not treated as content. A response may
 *     end with a "References & Sources" (or similar) heading followed by
 *     a bulleted or numbered link list; that section is extracted into
 *     the turn's citations and removed from the rendered body, so it
 *     ends up exactly once, in the note's single `# Sources` section.
 *   - Mixed format (also real-world, slightly older Gemini UI): the
 *     same native "You said" prompt markers, but the AI response is
 *     marked with a bold `**Gemini**` header instead of a "## Gemini
 *     said" heading. No separators between turns. Handled the same
 *     way otherwise (chrome stripped, sources section extracted).
 *   - Legacy bold-marker format (from now-obsolete browser extensions):
 *     `**You**` / `**Gemini**` bold headers, sections separated by
 *     `---`. Kept only for backward compatibility with old clipboard
 *     content; no longer the primary path.
 */
export function parseGeminiDialog(rawText: string): DialogFile {
	const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const sourceUrl = extractGeminiSourceUrl(normalized);

	if (NATIVE_PROMPT_MARKER_RE.test(normalized) && NATIVE_AI_MARKER_RE.test(normalized)) {
		return { sourceVendor: "gemini", sourceUrl, turns: parseNativeFormat(normalized) };
	}

	if (NATIVE_PROMPT_MARKER_RE.test(normalized) && LEGACY_AI_BOLD_MARKER_RE.test(normalized)) {
		return { sourceVendor: "gemini", sourceUrl, turns: parseMixedFormat(normalized) };
	}

	return { sourceVendor: "gemini", sourceUrl, turns: parseLegacyBoldMarkerFormat(normalized) };
}

/**
 * Pull the URL of the original Gemini dialog out of the metadata line
 * (e.g. `[Gemini](https://gemini.google.com/app) 2026-07-27 ...`). Used
 * to build a clickable "source" link in the note's frontmatter.
 */
function extractGeminiSourceUrl(text: string): string | undefined {
	const m = text.match(/^\[Gemini\]\((https?:\/\/gemini\.google\.com\/[^)]+)\)/m);
	return m ? m[1] : undefined;
}

/**
 * Remove trailing UI chrome that Gemini's own "Copy" button appends: the
 * standard AI disclaimer, and (if present) a usage-limit notice consisting
 * of a heading whose text mentions "limit" plus its explanatory paragraph.
 * Both always trail the very last real content, so this is applied once
 * to the whole raw text before splitting into turns.
 */
function stripTrailingChrome(text: string): string {
	let out = text.replace(/\n?Gemini is AI and can make mistakes\.\s*$/i, "");
	out = out.replace(/\n#{1,6}[^\n]*\blimit\b[^\n]*[\s\S]*$/i, "");
	return out.trimEnd();
}

function parseNativeFormat(normalized: string): DialogTurn[] {
	return parseMarkerBasedFormat(normalized);
}

/**
 * Parse the mixed format: native "You said" prompt markers, but bold
 * `**Gemini**` response headers instead of "## Gemini said" headings.
 * Identical to the fully-native format otherwise (chrome stripped,
 * sources section extracted and removed from the body).
 */
function parseMixedFormat(normalized: string): DialogTurn[] {
	return parseMarkerBasedFormat(normalized);
}

/**
 * Shared implementation for both the fully-native format and the mixed
 * format. Splits the text on alternating prompt/response markers and
 * builds turns, stripping trailing chrome and extracting the sources
 * section from each AI response.
 */
function parseMarkerBasedFormat(normalized: string): DialogTurn[] {
	const text = stripTrailingChrome(normalized);
	const turns: DialogTurn[] = [];

	const markers: Array<{ index: number; length: number; role: NoteRole }> = [];
	let m: RegExpExecArray | null;
	const markerRe = new RegExp(MIXED_MARKER_RE.source, MIXED_MARKER_RE.flags);
	while ((m = markerRe.exec(text)) !== null) {
		const captured = m[1];
		const role: NoteRole = captured === "You said" ? "prompt" : "ai";
		markers.push({ index: m.index, length: m[0].length, role });
	}

	for (let i = 0; i < markers.length; i++) {
		const start = markers[i].index + markers[i].length;
		const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
		const chunk = text.slice(start, end).trim();
		if (!chunk) continue;

		if (markers[i].role === "prompt") {
			turns.push({ role: "prompt", rawText: chunk, citations: [] });
		} else {
			const { body, citations } = extractSourcesSectionFromResponse(chunk);
			turns.push({ role: "ai", rawText: body, citations });
		}
	}

	return turns;
}

/**
 * Pull a trailing "References & Sources" (or similarly-titled) section out
 * of an AI response: parse its bulleted links into citations, and remove
 * the heading and list from the rendered body so the same information
 * doesn't also linger inline once it's been promoted to `# Sources`.
 * Only strips the section if at least one link was actually found there,
 * so an unrelated heading that merely happens to say "Sources" with no
 * real link list is left alone rather than guessed at.
 */
function extractSourcesSectionFromResponse(responseText: string): { body: string; citations: ParsedCitation[] } {
	const headingMatch = responseText.match(SOURCES_HEADING_RE);
	if (!headingMatch || headingMatch.index === undefined) {
		return { body: responseText, citations: [] };
	}

	const headingLevel = headingMatch[1].length;
	const sectionStart = headingMatch.index;
	const afterHeading = headingMatch.index + headingMatch[0].length;
	const rest = responseText.slice(afterHeading);
	const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s+\\S`, "m");
	const nextHeadingMatch = rest.match(nextHeadingRe);
	const sectionEnd =
		nextHeadingMatch && nextHeadingMatch.index !== undefined ? afterHeading + nextHeadingMatch.index : responseText.length;

	const sectionText = responseText.slice(afterHeading, sectionEnd);
	const citations = parseReferenceListItems(sectionText);
	if (citations.length === 0) {
		return { body: responseText, citations: [] };
	}

	const body = (responseText.slice(0, sectionStart) + responseText.slice(sectionEnd)).trim();
	return { body, citations };
}

/**
 * Parse a reference list where each item may be:
 *   - bulleted (- **Source name:** *Article title*
 *   	  [https://url](https://url))
 *   - numbered (1. **Source name:** *Article title*
 *   	  [https://url](https://url))
 * Items may be separated by blank lines, and a single item may contain
 * multiple links (e.g. "Title:\n\t[link1](url1)\n\tand\n\t[link2](url2)").
 * Each link becomes its own citation; the human-readable title is built
 * from whatever bold/italic text precedes the links on the same item.
 */
function parseReferenceListItems(sectionText: string): ParsedCitation[] {
	const items = sectionText
		.split(/\n\s*\n|(?=\n[ \t]*(?:-|\d+\.)\s+)/)
		.map((s) => s.replace(/^\n+/, "").trim())
		.filter((s) => s.length > 0);

	const citations: ParsedCitation[] = [];
	let counter = 1;
	for (const item of items) {
		const urlMatches = Array.from(item.matchAll(/\((https?:\/\/[^\s)]+)\)/g));
		if (urlMatches.length === 0) continue;

		let bold: string | undefined;
		const withoutBold = item.replace(/\*\*([^*]+)\*\*/, (_match, inner: string) => {
			if (bold === undefined) {
				bold = inner.replace(/:\s*$/, "").trim();
			}
			return "";
		});
		const italicMatch = withoutBold.match(/\*([^*]+)\*/);
		const italic = italicMatch ? italicMatch[1].trim() : undefined;
		const title = [bold, italic].filter(Boolean).join(": ") || undefined;

		for (const urlMatch of urlMatches) {
			citations.push({ origNum: `gref${counter++}`, url: urlMatch[1], title });
		}
	}
	return citations;
}

function parseLegacyBoldMarkerFormat(normalized: string): DialogTurn[] {
	const sections = normalized.split(/\n[ \t]*---[ \t]*\n/);
	const turns: DialogTurn[] = [];

	for (const rawSection of sections) {
		const section = rawSection.trim();
		if (!section) continue;

		const userMatch = section.match(/^\*\*You\*\*\s*\n([\s\S]*)/m);
		const geminiMatch = section.match(/^\*\*Gemini\*\*\s*\n([\s\S]*)/m);

		if (userMatch) {
			turns.push({ role: "prompt", rawText: userMatch[1].trim(), citations: [] });
		} else if (geminiMatch) {
			const rawBody = geminiMatch[1].trim();
			// Extract the sources section (removing it from the body) and use
			// its citations as the turn's citations, not inline links from
			// whatever body is left. This way the same information ends up
			// in exactly one place: the note's single # Sources block.
			const { body, citations } = extractSourcesSectionFromResponse(rawBody);
			const finalCitations = citations.length > 0 ? citations : extractInlineLinks(body);
			turns.push({ role: "ai", rawText: body, citations: finalCitations });
		} else if (/^#\s+New chat/m.test(section) || /^\[Gemini\]\(https?:\/\//m.test(section)) {
			continue;
		}
	}

	return turns;
}

/**
 * Extract every inline markdown link from an AI response (legacy format
 * only). Each link is treated as a citation candidate with a synthetic
 * origNum assigned in order of appearance.
 */
function extractInlineLinks(text: string): ParsedCitation[] {
	const citations: ParsedCitation[] = [];
	const linkRe = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
	let m: RegExpExecArray | null;
	let counter = 1;
	while ((m = linkRe.exec(text)) !== null) {
		citations.push({ origNum: String(counter++), url: m[2], title: m[1] || undefined });
	}
	return citations;
}

// Used by detect.ts.
export function isGeminiContent(text: string): boolean {
	return (
		/^\[Gemini\]\(https?:\/\/gemini\.google\.com\//m.test(text) ||
		/\*\*Gemini\*\*\s*$/m.test(text) ||
		/^\*\*You\*\*\s*\n/m.test(text) ||
		(NATIVE_PROMPT_MARKER_RE.test(text) && NATIVE_AI_MARKER_RE.test(text))
	);
}
