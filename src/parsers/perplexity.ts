import { DialogFile, DialogTurn, ParsedCitation } from "./types";

/**
 * Inline citation marker in a Perplexity response, e.g. "...forum[1]...".
 * Captures the numeric part.
 */
const CITENUM_RE = /\[(\d+)\]/g;

/**
 * One line in Perplexity's source list, e.g.
 *   [1] [Title](https://example.com)
 *   [1] https://example.com
 *   [1] [Title](https://example.com "anchor")
 */
const SOURCE_LIST_LINE_RE = /^\[(\d+)\]\s+(?:\[(.*?)\]\()?(https?:\/\/\S+?)\)?(?:\s+["'(].*?["')])?\s*$/;

/** Divider that appears between the response and the source list in some exports. */
const PERPLEXITY_DIVIDER_RE = /<div style="text-align: ?center">.*?<\/div>/i;

/** Save My Chatbot section headers. */
const SMC_PROMPT_HEADER = "**You**";
const SMC_RESPONSE_HEADER = "**AI answer**";
const SMC_SOURCES_HEADER = "**Sources:**";

/**
 * Parse a Perplexity dialog export into the shared DialogFile shape.
 *
 * Two formats are accepted:
 *   - Stock Perplexity pastes: multiple prompt/response pairs separated by
 *     `---` lines. Each pair has a user prompt (first paragraph), an AI
 *     response (intro paragraph plus ## headings), and a trailing
 *     `# Citations:` block. All source lists across pairs are merged into
 *     one global deduped set by the renderer.
 *   - "Save My Chatbot" browser-extension exports: have explicit **You**
 *     and **AI answer** bold markers, plus a **Sources:** block.
 */
export function parsePerplexityDialog(rawText: string): DialogFile {
	// Normalize line endings first. Every downstream regex in this file
	// matches a literal "\n" for section/line boundaries; real clipboard
	// content from Windows browsers is frequently CRLF, and a stray "\r"
	// before each "\n" silently breaks those matches (e.g. the `---`
	// separator between prompt/response pairs), collapsing what should be
	// multiple turns into one and scrambling citation numbering across pairs.
	const normalizedText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const sections = splitIntoPromptResponsePairs(normalizedText);
	const turns: DialogTurn[] = [];
	let sourceUrl: string | undefined;

	for (const section of sections) {
		const { promptText, responseText, sourceListText } = splitPromptResponseSources(section);

		if (promptText.trim()) {
			turns.push({ role: "prompt", rawText: extractLeadingQuotes(promptText.trim()), citations: [] });
		}
		if (responseText.trim()) {
			const citations = extractCitations(responseText, sourceListText);
			turns.push({ role: "ai", rawText: responseText.trim(), citations });
		}
		if (!sourceUrl) sourceUrl = extractSourceUrl(section);
	}

	return { sourceVendor: "perplexity", sourceUrl, turns };
}

/**
 * Pull the URL of the original Perplexity dialog out of the first
 * section's metadata line, if present. Used to build a clickable
 * "source" link in the note's frontmatter.
 */
function extractSourceUrl(section: string): string | undefined {
	const m = section.match(/^\[Perplexity\]\((https?:\/\/(?:www\.)?perplexity\.ai\/[^)]+)\)/m);
	return m ? m[1] : undefined;
}

/**
 * Perplexity wraps a quoted excerpt from a prior AI response in <q>...</q>
 * when the user's follow-up prompt quotes back part of the answer (e.g.
 * highlighting text in a response and asking "explain this: <q>...</q>").
 * Pull every such excerpt out, in the order it appears, and render it as a
 * markdown blockquote placed above the remaining (non-quoted) prompt text,
 * rather than leaving raw HTML tags inline.
 */
function extractLeadingQuotes(text: string): string {
	const quotes: string[] = [];
	const placeholder = "\u0000";
	const withoutQuotes = text.replace(/<q>([\s\S]*?)<\/q>/g, (_match, quoted: string) => {
		quotes.push(quoted.trim());
		return placeholder;
	});
	if (quotes.length === 0) return text;

	// Collapse any whitespace left dangling around the removed tag so the
	// remaining prose doesn't end up with doubled spaces or a stray blank line.
	const rest = withoutQuotes
		.replace(new RegExp(`[ \\t]*${placeholder}[ \\t]*`, "g"), " ")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.trim();

	const quoteBlocks = quotes.map((quoted) =>
		quoted
			.split("\n")
			.map((line) => `> ${line}`.trimEnd())
			.join("\n")
	);

	return rest ? `${quoteBlocks.join("\n\n")}\n\n${rest}` : quoteBlocks.join("\n\n");
}

function splitIntoPromptResponsePairs(rawText: string): string[] {
	if (rawText.includes(SMC_PROMPT_HEADER)) {
		// Save My Chatbot: **You** marks each new prompt. Split on lines that
		// begin a new "**You**" so each section is one prompt+response pair.
		const parts = rawText.split(/\n(?=\*\*You\*\*)/);
		const first = parts.shift() ?? "";
		const trimmed = parts.length > 0 ? [first, ...parts] : [rawText];
		return trimmed.map((s) => s.trim()).filter((s) => s.length > 0);
	}

	// Stock Perplexity: prompt/response pairs are separated by horizontal rules.
	// Split on `---` lines with optional surrounding whitespace.
	const parts = rawText
		.split(/\n[ \t]*---[ \t]*\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return parts.length > 0 ? parts : [rawText];
}

function stripMetadataLine(section: string): { body: string; sourceUrl?: string } {
	const metaMatch = section.match(
		/^\[Perplexity\]\((https?:\/\/(?:www\.)?perplexity\.ai\/[^)]+)\)[^\n]*\n?/
	);
	if (!metaMatch) return { body: section.trim() };
	return { body: section.slice(metaMatch[0].length).trim(), sourceUrl: metaMatch[1] };
}

function splitPromptResponseSources(section: string): {
	promptText: string;
	responseText: string;
	sourceListText: string;
} {
	if (section.includes(SMC_PROMPT_HEADER)) {
		return splitSmcSection(section);
	}
	return splitStockSection(section);
}

function splitSmcSection(section: string): {
	promptText: string;
	responseText: string;
	sourceListText: string;
} {
	const parts = section.split(/\*\*(You|AI answer|Sources:)\*\*/);
	let promptText = "";
	let responseText = "";
	let sourceListText = "";
	for (let i = 1; i < parts.length; i += 2) {
		const label = parts[i];
		const body = parts[i + 1] ?? "";
		if (label === "You") {
			promptText = body;
		} else if (label === "AI answer") {
			responseText = body;
		} else if (label === "Sources:") {
			sourceListText = body;
		}
	}
	return { promptText, responseText, sourceListText };
}

function splitStockSection(section: string): {
	promptText: string;
	responseText: string;
	sourceListText: string;
} {
	let { body: bodyText } = stripMetadataLine(section);
	let sourceListText = "";

	// Split off the trailing # Citations: block, if present.
	const citationsMatch = bodyText.match(/\n#\s*Citations:\s*\n|^#\s*Citations:\s*\n/);
	if (citationsMatch) {
		sourceListText = bodyText.slice(citationsMatch.index! + citationsMatch[0].length).trim();
		bodyText = bodyText.slice(0, citationsMatch.index!).trim();
	}

	// Stock exports may also use a centered HTML divider before the source list.
	const dividerMatch = bodyText.match(PERPLEXITY_DIVIDER_RE);
	if (dividerMatch) {
		sourceListText = bodyText
			.slice(bodyText.indexOf(dividerMatch[0]) + dividerMatch[0].length)
			.trim();
		bodyText = bodyText.slice(0, bodyText.indexOf(dividerMatch[0])).trim();
	}

	// Heuristic for stock Perplexity: if the body contains a level-2 response
	// heading, the first paragraph is the user prompt and everything after the
	// first blank line is the AI response. Otherwise the whole body is the
	// response (e.g. a pasted response with no prompt).
	const hasResponseHeading = /^##\s+\S/m.test(bodyText);
	const firstBlankMatch = bodyText.match(/\n\s*\n/);
	if (hasResponseHeading && firstBlankMatch && firstBlankMatch.index !== undefined) {
		const promptText = bodyText.slice(0, firstBlankMatch.index).trim();
		const responseText = bodyText.slice(firstBlankMatch.index + firstBlankMatch[0].length).trim();
		return { promptText, responseText, sourceListText };
	}

	return { promptText: "", responseText: bodyText, sourceListText };
}

function extractCitations(responseText: string, sourceListText: string): ParsedCitation[] {
	const urlByNum = new Map<string, { url: string; title?: string }>();

	if (sourceListText) {
		const lineRe = new RegExp(SOURCE_LIST_LINE_RE.source, "gm");
		let m: RegExpExecArray | null;
		while ((m = lineRe.exec(sourceListText)) !== null) {
			urlByNum.set(m[1], { url: m[3], title: m[2] || undefined });
		}
	}

	const citations: ParsedCitation[] = [];
	const seen = new Set<string>();
	const citeRe = new RegExp(CITENUM_RE.source, "g");
	let cm: RegExpExecArray | null;
	while ((cm = citeRe.exec(responseText)) !== null) {
		const num = cm[1];
		if (seen.has(num)) continue;
		seen.add(num);
		const entry = urlByNum.get(num);
		if (entry) {
			citations.push({ origNum: num, url: entry.url, title: entry.title });
		}
	}
	return citations;
}

// Used by detect.ts.
export function isPerplexityContent(text: string): boolean {
	return (
		/\[Perplexity\]\(https?:\/\/(?:www\.)?perplexity\.ai\//m.test(text) ||
		/^#\s*Citations?:\s*$/m.test(text) ||
		/<div style="text-align: ?center">/i.test(text) ||
		/\*\*You\*\*/.test(text)
	);
}
