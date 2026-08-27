import { DialogFile, DialogTurn, NoteRole, ParsedCitation } from "./types";

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
 *   1. [Title](https://example.com)
 *   [1]: https://example.com
 */
const SOURCE_LIST_LINE_RE = /^[#*>-]?\s*(?:\[(\d+)\]|(\d+)\.)\s*:?\s*(?:\[(.*?)\]\()?(https?:\/\/\S+?)\)?(?:\s+["'(].*?["')])?\s*$/;

/** Divider that appears between the response and the source list in some exports. */
const PERPLEXITY_DIVIDER_RE = /<div style="text-align: ?center">.*?<\/div>/i;

/** Save My Chatbot section headers. */
const SMC_PROMPT_HEADER = "**You**";
const SMC_RESPONSE_HEADER = "**AI answer**";
const SMC_SOURCES_HEADER = "**Sources:**";

/**
 * Checks if the content has annotated Perplexity format (HTML comments).
 * Only matches if the annotation starts at the root level of the file,
 * directly after the optional metadata header.
 */
export function isAnnotatedPerplexityContent(text: string): boolean {
	return /^(?:\[Perplexity\]\([\s\S]*?\)\s*(?:·\s*\*.*?\*)?\s*(?:\n+---\n+)?\s*)?<!-- PPLX-TURN 1 -->/i.test(text.trim());
}

export function stripAnnotations(text: string): string {
	return text
		.replace(/<!-- PPLX-TURN \d+ -->/gi, "")
		.replace(/<!-- PPLX-ROLE:\s*\S+\s*-->/gi, "")
		.trim();
}

/**
 * Parse a Perplexity dialog export into the shared DialogFile shape.
 */
export function parsePerplexityDialog(rawText: string): DialogFile {
	// Normalize line endings first. Every downstream regex in this file
	// matches a literal "\n" for section/line boundaries; real clipboard
	// content from Windows browsers is frequently CRLF, and a stray "\r"
	// before each "\n" silently breaks those matches (e.g. the `---`
	// separator between prompt/response pairs), collapsing what should be
	// multiple turns into one and scrambling citation numbering across pairs.
	const normalizedText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	if (isAnnotatedPerplexityContent(normalizedText)) {
		return parseAnnotatedPerplexityDialog(normalizedText);
	}

	const sections = splitIntoPromptResponsePairs(normalizedText);
	const turns: DialogTurn[] = [];
	let sourceUrl: string | undefined;
	let sourceMetadata: string | undefined;

	for (const section of sections) {
		const { promptText, responseText, sourceListText } = splitPromptResponseSources(section);

		if (promptText.trim()) {
			turns.push({ role: "prompt", rawText: extractLeadingQuotes(promptText.trim()), citations: [] });
		}
		if (responseText.trim()) {
			const citations = extractCitations(responseText, sourceListText);
			turns.push({ role: "ai", rawText: responseText.trim(), citations });
		}
		if (!sourceUrl) {
			sourceUrl = extractSourceUrl(section);
		}
		if (!sourceMetadata) {
			sourceMetadata = extractSourceMetadata(section);
		}
	}

	return { sourceVendor: "perplexity", sourceUrl, sourceMetadata, turns };
}

/**
 * Parses the annotated Perplexity format (with PPLX-TURN and PPLX-ROLE comments)
 * into a shared DialogFile shape.
 */
function parseAnnotatedPerplexityDialog(normalizedText: string): DialogFile {
	const sourceUrl = extractSourceUrl(normalizedText);
	const sourceMetadata = extractSourceMetadata(normalizedText);

	// Split by turn blocks using the turn regex
	const turnBlocks = normalizedText.split(/<!-- PPLX-TURN \d+ -->/g);
	const turns: DialogTurn[] = [];

	// The first split block is the metadata header (before the first turn marker), which we ignore.
	for (let i = 1; i < turnBlocks.length; i++) {
		const block = turnBlocks[i].trim();
		if (!block) continue;

		const turnNum = i;
		const roles: { role: string; content: string }[] = [];
		const roleMatchRe = /<!-- PPLX-ROLE:\s*(prompt|ai|sources|unknown[^>]*) -->/g;
		const indices: { index: number; length: number; role: string }[] = [];
		let match: RegExpExecArray | null;

		while ((match = roleMatchRe.exec(block)) !== null) {
			indices.push({ index: match.index, length: match[0].length, role: match[1].trim() });
		}

		for (let j = 0; j < indices.length; j++) {
			const start = indices[j].index + indices[j].length;
			const end = j + 1 < indices.length ? indices[j + 1].index : block.length;
			const content = block.slice(start, end).trim();
			roles.push({ role: indices[j].role, content });
		}

		let promptText = "";
		let responseText = "";
		let sourcesText = "";

		for (const r of roles) {
			if (r.role === "prompt") {
				promptText = unwrapFencedHeading(stripAnnotations(r.content));
			} else if (r.role === "ai") {
				responseText = stripAnnotations(r.content);
			} else if (r.role === "sources") {
				sourcesText = stripAnnotations(r.content);
			} else if (r.role.startsWith("unknown")) {
				const cleaned = stripAnnotations(r.content);
				// Fallback: treat the first line of the unresolved block as prompt, and the rest as response
				const firstNewline = cleaned.indexOf("\n");
				if (firstNewline !== -1) {
					promptText = cleaned.slice(0, firstNewline).trim();
					responseText = cleaned.slice(firstNewline).trim();
				} else {
					promptText = cleaned;
					responseText = "";
				}
			}
		}

		// Parse the bibliography list to map citation references for this turn
		const urlByNum = new Map<string, { url: string; title?: string }>();
		if (sourcesText && sourcesText !== "(none)") {
			const lines = sourcesText.split("\n");
			const footnoteRe = /^\s*\[\^([^\]]+)\]:\s*(?:\[(.*?)\]\()?(https?:\/\/\S+?)\)?(?:\s+.*)?$/;
			for (const line of lines) {
				const fMatch = line.match(footnoteRe);
				if (fMatch) {
					const num = fMatch[1]; // e.g., "4_1"
					const title = fMatch[2] || undefined;
					const url = fMatch[3];
					urlByNum.set(num, { url, title });
				}
			}
		}

		if (promptText.trim()) {
			turns.push({ role: "prompt", rawText: extractLeadingQuotes(promptText.trim()), citations: [] });
		}

		if (responseText.trim()) {
			// Extract citations for this turn
			const citations: ParsedCitation[] = [];
			const seen = new Set<string>();
			const citeRe = new RegExp(CITENUM_RE.source, "g");
			let cm: RegExpExecArray | null;

			while ((cm = citeRe.exec(responseText)) !== null) {
				const num = cm[1]; // e.g., "1"
				if (seen.has(num)) continue;
				seen.add(num);

				// Match turn-scoped footnote keys (e.g. "4_1") first, then global numeric keys
				const turnKey = `${turnNum}_${num}`;
				const entry = urlByNum.get(turnKey) || urlByNum.get(num);
				if (entry) {
					citations.push({ origNum: num, url: entry.url, title: entry.title });
				}
			}

			// Fallback: if no inline references were matched but there are citations for this turn in urlByNum, add them
			if (citations.length === 0 && urlByNum.size > 0) {
				for (const [key, entry] of urlByNum.entries()) {
					if (key.startsWith(`${turnNum}_`)) {
						const num = key.slice(`${turnNum}_`.length);
						citations.push({ origNum: num, url: entry.url, title: entry.title });
					}
				}
			}

			turns.push({ role: "ai", rawText: responseText.trim(), citations });
		}
	}

	return { sourceVendor: "perplexity", sourceUrl, sourceMetadata, turns };
}

/**
 * Pull the URL of the original Perplexity dialog out of the first
 * section's metadata line, if present. Used to build a clickable
 * "source" link in the note's frontmatter.
 */
function extractSourceUrl(section: string): string | undefined {
	const m = section.match(/\[Perplexity\]\((https?:\/\/(?:[a-zA-Z0-9-]+\.)*perplexity\.ai(?:\/[^)\s]*)?)\)/i);
	return m ? m[1] : undefined;
}

function extractSourceMetadata(section: string): string | undefined {
	const metaMatch = section.match(
		/\[Perplexity\]\((?:https?:\/\/(?:[a-zA-Z0-9-]+\.)*perplexity\.ai(?:\/[^)\s]*)?)\)[ \t]*(?:·[ \t]*)?(?:\*)?(.*?)(?:\*)?[ \t]*(?:\r?\n|$)/i
	);
	return metaMatch && metaMatch[1] && metaMatch[1].trim() ? metaMatch[1].trim() : undefined;
}

export function unwrapFencedHeading(text: string): string {
	let trimmed = (text || "").trim();
	if (trimmed.startsWith("```")) {
		// 1. Try greedy match when full string is wrapped in backticks (safely preserving nested code blocks)
		let match = trimmed.match(/^```(\S*)\r?\n([\s\S]*)\r?\n```$/);
		if (match) {
			const inside = match[2].trim();
			if (inside.startsWith("#")) {
				return inside;
			}
		}

		// 2. Try matching leading fenced heading block followed by trailing text (skipping inner code blocks inside unclosed <q> tags)
		const lines = trimmed.split("\n");
		let fenceEndIdx = -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim().startsWith("```")) {
				const candidateInside = lines.slice(1, i).join("\n").trim();
				if (candidateInside.startsWith("#")) {
					if (candidateInside.includes("<q>") && !candidateInside.includes("</q>")) {
						continue; // skip inner code blocks inside <q>...</q>
					}
					fenceEndIdx = i;
					break;
				}
			}
		}

		if (fenceEndIdx !== -1) {
			const inside = lines.slice(1, fenceEndIdx).join("\n").trim();
			const rest = lines.slice(fenceEndIdx + 1).join("\n").trim();
			return rest ? `${inside}\n\n${rest}` : inside;
		}

		// 3. Fallback: match without closing backticks (e.g. unclosed fence at EOF)
		match = trimmed.match(/^```(\S*)\r?\n([\s\S]*)$/);
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
 * Perplexity wraps a quoted excerpt from a prior AI response in <q>...</q>
 * when the user's follow-up prompt quotes back part of the answer (e.g.
 * highlighting text in a response and asking "explain this: <q>...</q>").
 * Pull every such excerpt out, in the order it appears, and render it as a
 * markdown blockquote placed above the remaining (non-quoted) prompt text,
 * rather than leaving raw HTML tags inline.
 */
function extractLeadingQuotes(text: string): string {
	const unwrapped = unwrapFencedHeading(text);
	const quotes: string[] = [];
	const placeholder = "\u0000";
	const withoutQuotes = unwrapped.replace(/<q>([\s\S]*?)<\/q>/g, (_match, quoted: string) => {
		quotes.push(quoted.trim());
		return placeholder;
	});
	if (quotes.length === 0) return unwrapped;

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
		/^[ \t]*\[Perplexity\]\((https?:\/\/(?:[a-zA-Z0-9-]+\.)*perplexity\.ai(?:\/[^)\s]*)?)\)[^\n]*\r?\n?/i
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
	bodyText = unwrapFencedHeading(bodyText);
	let sourceListText = "";

	// Split off the trailing # Citations: or # Sources: block, if present.
	// Accepts heading levels # to ###, bold **Citations:** or **Sources:**, and optional colons/whitespace.
	const citationsMatch = bodyText.match(
		/\n(?:\#{1,3}|\*\*)\s*(?:Citations?|Sources?)\s*:?\s*(?:\*\*|\n|$)|^>(?:\#{1,3}|\*\*)\s*(?:Citations?|Sources?)\s*:?\s*(?:\*\*|\n|$)/i
	) || bodyText.match(
		/\n\s*(?:Citations?|Sources?)\s*:\s*(?:\n|$)|^\s*(?:Citations?|Sources?)\s*:\s*(?:\n|$)/i
	);
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

	// Heuristic for stock Perplexity: split prompt from response at the
	// first blank line. The trigger is either:
	//   - the body STARTS with a level-1 (# ) heading (Perplexity echoes
	//     the user's typed question as a level-1 heading; everything
	//     after the first blank line is the AI response), OR
	//   - a level-2 (## ) or higher response heading is present in the
	//     body (the response uses its own heading hierarchy; the
	//     paragraph immediately before the first such heading is the
	//     prompt).
	// If neither is present, the whole body is treated as the response
	// (e.g. a pasted response with no prompt and no headings).
	const startsWithH1 = /^#\s+\S/m.test(bodyText) || /^```\S*\n#\s+\S/m.test(bodyText);
	const hasResponseHeading = /^##\s+\S/m.test(bodyText);
	const firstBlankMatch = bodyText.match(/\n\s*\n/);
	if ((startsWithH1 || hasResponseHeading) && firstBlankMatch && firstBlankMatch.index !== undefined) {
		let promptText = bodyText.slice(0, firstBlankMatch.index).trim();
		const responseText = bodyText.slice(firstBlankMatch.index + firstBlankMatch[0].length).trim();
		promptText = unwrapFencedHeading(promptText);
		return { promptText, responseText, sourceListText };
	}

	// Perplexity echoes the user's question as a level-1 (# ) heading. If
	// there is no blank line to split on (i.e. no AI response text
	// follows the question), treat the entire heading line as the prompt.
	if (startsWithH1) {
		return {
			promptText: unwrapFencedHeading(bodyText),
			responseText: "",
			sourceListText,
		};
	}

	return { promptText: "", responseText: bodyText, sourceListText };
}

function extractCitations(responseText: string, sourceListText: string): ParsedCitation[] {
	const urlByNum = new Map<string, { url: string; title?: string }>();

	if (sourceListText) {
		const lineRe = new RegExp(SOURCE_LIST_LINE_RE.source, "gm");
		let m: RegExpExecArray | null;
		while ((m = lineRe.exec(sourceListText)) !== null) {
			const num = m[1] || m[2];
			const title = m[3] || undefined;
			const url = m[4];
			if (num && url) {
				urlByNum.set(num, { url, title });
			}
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

	// Fallback: if the response body had no inline bracket references [1], [2], etc.,
	// but a # Citations: block was present with sources, preserve all of those sources.
	if (citations.length === 0 && urlByNum.size > 0) {
		for (const [num, entry] of urlByNum.entries()) {
			citations.push({ origNum: num, url: entry.url, title: entry.title });
		}
	}

	return citations;
}

// Used by detect.ts.
export function isPerplexityContent(text: string): boolean {
	return (
		/\[Perplexity\]\(https?:\/\/(?:[a-zA-Z0-9-]+\.)*perplexity\.ai/im.test(text) ||
		/^(?:\#{1,3}|\*\*|\s*)\s*(?:Citations?|Sources?)\s*:?\s*(?:\*\*|\s*)$/im.test(text) ||
		/<div style="text-align: ?center">/i.test(text) ||
		/\*\*You\*\*/.test(text) ||
		/<!-- PPLX-TURN \d+ -->/i.test(text)
	);
}
