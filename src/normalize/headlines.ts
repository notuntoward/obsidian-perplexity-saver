import { removeStopwords, eng } from "stopword";

/**
 * Two selectable algorithms for deriving the human-readable summary
 * heading that appears above each user prompt turn in a uniform-format
 * note. The renderer asks for a headline via `headlineForPrompt(text, opts)`
 * and the result is used as the heading text for that turn.
 *
 *   - Method 1 ("lead"): Intl.Segmenter splits into sentences; the first
 *     sentence that fits under maxChars wins, with a clean word-boundary
 *     fallback if even the first sentence is too long. Simple, fast, no
 *     dependencies beyond the runtime.
 *   - Method 2 ("tf-idf"): Tokenize, drop stopwords, score every sentence
 *     by TF-IDF (with a configurable lead-position prior), pick the
 *     highest-scoring sentence, and truncate cleanly at a word
 *     boundary. The "stop-word package" is used for scoring only; the
 *     returned headline is an original sentence, not a keyword bag.
 *
 * Both methods are extractive: the result is always an original
 * sentence (or a safe truncation of one), never generated or rephrased
 * language. This keeps the heading grammatically intact and faithful
 * to the prompt, which matters for a research-note vault.
 */

export type HeadlineMethod = "lead" | "tf-idf";

export interface HeadlineOptions {
	method: HeadlineMethod;
	/** Maximum headline length, including a possible ellipsis. */
	maxChars?: number;
	/** BCP 47 language tag used by Intl.Segmenter. */
	locale?: string;
	/**
	 * Terms to ignore in addition to standard English stop words. Add
	 * recurring note/template vocabulary here. Only used by Method 2.
	 */
	extraStopwords?: string[];
	/**
	 * Amount to favor sentences near the beginning: 0 disables it.
	 * Reasonable range: 0.05 to 0.35. Only used by Method 2.
	 * Default 0.30 when Method 2 is selected.
	 */
	leadBias?: number;
}

/**
 * Produce a headline for the given prompt text, dispatching to the
 * algorithm selected in the options. The returned string is ready to
 * be used as the heading text above the prompt body in the uniform
 * note format.
 */
export function headlineForPrompt(promptText: string, options: HeadlineOptions): string {
	const { method } = options;
	if (method === "tf-idf") {
		return headlineFromText(promptText, {
			maxChars: options.maxChars ?? 100,
			locale: options.locale,
			extraStopwords: options.extraStopwords,
			leadBias: options.leadBias ?? 0.30,
		});
	}
	return headlineFromLead(promptText, {
		maxChars: options.maxChars ?? 100,
		locale: options.locale,
	});
}

// ---------------------------------------------------------------------------
// Method 1: lead-sentence extraction with a clean word-boundary truncation
// fallback. No external dependencies; safe in any environment that has
// Intl.Segmenter (V8 since Node 16).
// ---------------------------------------------------------------------------

interface LeadOptions {
	maxChars: number;
	locale?: string;
}

export function headlineFromLead(markdown: string, opts: LeadOptions): string {
	const { maxChars } = opts;
	const text = cleanInput(markdown);
	if (!text) return "";
	const sentences = splitSentencesForLead(text);

	let result = "";
	for (const sentence of sentences) {
		const candidate = result ? `${result} ${sentence}` : sentence;
		if (candidate.length > maxChars) break;
		result = candidate;
	}

	return result || truncateAtWord(sentences[0], maxChars);
}

/**
 * Sentence splitter for Method 1 (lead extraction). Splits on `.`, `!`,
 * `?`, and newlines, then trims. Unlike `splitSentences()` (used by
 * Method 2 with a 3-word minimum), this does not filter by word count:
 * a single-word sentence is still a valid candidate for lead extraction.
 * We only drop segments that are pure whitespace.
 *
 * `Intl.Segmenter({ granularity: "sentence" })` was considered but proved
 * too conservative — it treats short fragments like "x. y. z." as a
 * single segment. A simple regex split gives Method 1 the more aggressive
 * sentence boundary detection the user-facing reference implementation
 * intended.
 */
function splitSentencesForLead(text: string): string[] {
	const out: string[] = [];
	const re = /[.!?]+(\s+|$)/g;
	let lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const end = m.index + m[0].length;
		const segment = text.slice(lastIndex, end).trim();
		if (segment.length > 0) out.push(segment);
		lastIndex = end;
	}
	const tail = text.slice(lastIndex).trim();
	if (tail.length > 0) out.push(tail);
	return out;
}

// ---------------------------------------------------------------------------
// Method 2: TF-IDF sentence ranking with a configurable lead-position
// prior. Uses the `stopword` package for stop-word filtering only; the
// returned headline is the highest-scoring original sentence, truncated
// to a word boundary.
// ---------------------------------------------------------------------------

export function headlineFromText(
	input: string,
	options: {
		maxChars?: number;
		locale?: string;
		extraStopwords?: string[];
		leadBias?: number;
	} = {}
): string {
	const {
		maxChars = 100,
		locale = "en",
		extraStopwords = [],
		leadBias = 0.30,
	} = options;

	const text = cleanInput(input);
	const sentences = splitSentences(text, locale);

	if (sentences.length === 0) return "";
	if (sentences.length === 1) return truncateAtWord(sentences[0], maxChars);

	const ignored = new Set<string>([...eng, ...extraStopwords.map((word) => word.toLowerCase())]);

	const termLists = sentences.map((s) => tokenize(s, ignored));
	const documentFrequency = makeDocumentFrequency(termLists);
	const totalSentences = sentences.length;

	const ranked = sentences.map((sentence, index) => ({
		sentence,
		index,
		score: sentenceScore(termLists[index], index, totalSentences, documentFrequency, leadBias),
	}));

	ranked.sort((a, b) => b.score - a.score || a.index - b.index);

	return truncateAtWord(ranked[0].sentence, maxChars);
}

// ---------------------------------------------------------------------------
// Shared helpers used by both methods. Conservative: do not try to fully
// parse Markdown; the goal is to recover readable prose, not a tokenized
// representation of every construct.
// ---------------------------------------------------------------------------

function cleanInput(input: string): string {
	return input
		.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/m, "") // YAML frontmatter
		.replace(/```[\s\S]*?```/g, " ") // fenced code
		.replace(/`[^`]*`/g, " ") // inline code
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ") // image
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1") // markdown link -> label
		.replace(/\[\[([^|\]]+)\|([^\]]+)]]/g, "$2") // obsidian alias link
		.replace(/\[\[([^\]]+)]]/g, "$1") // obsidian link
		.replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading marker
		.replace(/^\s*[-*+]\s+/gm, "") // list marker
		.replace(/[*_>#]/g, "") // remaining emphasis and heading markers
		.replace(/\s+/g, " ")
		.trim();
}

function splitSentences(text: string, locale: string): string[] {
	// Intl.Segmenter is available in Node 16+ and modern browsers, but the
	// ES2020 lib types do not include it. Cast through `unknown` to keep the
	// call site readable without bumping the whole project's lib target.
	const IntlWithSegmenter = Intl as unknown as {
		Segmenter: new (
			locale: string | string[],
			options: { granularity: "sentence" | "word" }
		) => { segment: (text: string) => Iterable<{ segment: string }> };
	};
	const segmenter = new IntlWithSegmenter.Segmenter(locale, { granularity: "sentence" });
	return [...segmenter.segment(text)]
		.map(({ segment }) => segment.trim())
		.filter((sentence) => {
			const wordCount = sentence.match(/\p{L}+/gu)?.length ?? 0;
			return wordCount >= 3;
		});
}

function tokenize(sentence: string, _ignored: ReadonlySet<string>): string[] {
	const words = sentence
		.toLocaleLowerCase()
		.match(/\p{L}+(?:['’-]\p{L}+)*/gu) ?? [];
	// removeStopwords is used for stop-word filtering only; the Set-based
	// ignored set is then applied to drop any user-supplied extra stop words.
	return removeStopwords(words, eng).filter((word) => word.length >= 3 && !_ignored.has(word));
}

function makeDocumentFrequency(termLists: readonly string[][]): Map<string, number> {
	const df = new Map<string, number>();
	for (const terms of termLists) {
		for (const term of new Set(terms)) {
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	}
	return df;
}

function sentenceScore(
	terms: readonly string[],
	index: number,
	totalSentences: number,
	df: ReadonlyMap<string, number>,
	leadBias: number
): number {
	if (terms.length === 0) return Number.NEGATIVE_INFINITY;

	const tf = new Map<string, number>();
	for (const term of terms) {
		tf.set(term, (tf.get(term) ?? 0) + 1);
	}

	let score = 0;
	for (const [term, count] of tf) {
		const idf = Math.log((totalSentences + 1) / ((df.get(term) ?? 0) + 1)) + 1;
		const weightedTf = 1 + Math.log(count);
		score += weightedTf * idf;
	}
	// Normalize to keep a long, unfocused sentence from winning by word count alone.
	score /= Math.sqrt(terms.length);
	// Gentle positional prior: first sentence gets the full bonus, last gets zero.
	score += leadBias * (1 - index / Math.max(totalSentences - 1, 1));
	// Very short sentences are often connective fragments or headings.
	if (terms.length < 4) score *= 0.7;
	return score;
}

export function truncateAtWord(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	if (maxChars <= 1) return "…".slice(0, maxChars);

	const available = maxChars - 1; // reserve room for ellipsis
	const prefix = normalized.slice(0, available);
	const lastSpace = prefix.lastIndexOf(" ");
	// If the first token itself is longer than the budget, a hard cut is
	// preferable to returning an empty headline.
	const safePrefix = lastSpace > Math.floor(available * 0.5) ? prefix.slice(0, lastSpace) : prefix;

	return `${safePrefix.trimEnd()}…`;
}
