/**
 * bibtexName.ts
 *
 * Dependency-free BibTeX name parser.
 *
 * Exports:
 *   parseAuthors(s)   → Name[]   (splits on " and " at brace-depth 0)
 *   parseName(s)      → Name     (parses one name string)
 *   formatName(n, style) → string
 *   suggestBibtexForm(raw) → string | null
 *     Returns a "von Last, First" suggestion when the raw string is parseable
 *     into a non-trivial structure, or null if it cannot be reliably converted.
 *
 * Name = { first: string; von: string; last: string; jr: string }
 *
 * All fields are stored without stripping braces so round-trip fidelity is
 * preserved.  Use stripBraces() for display.
 */

export interface Name {
	first: string;
	von: string;
	last: string;
	jr: string;
}

// ---------------------------------------------------------------------------
// Utility: brace-depth tracking
// ---------------------------------------------------------------------------

/** Walk a string and return the depth after processing each character. */
function braceDepths(s: string): number[] {
	const depths: number[] = new Array(s.length);
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "{") depth++;
		else if (s[i] === "}") depth = Math.max(0, depth - 1);
		depths[i] = depth;
	}
	return depths;
}

/** Strip outer braces for display, recursively (two passes handles nesting). */
export function stripBraces(s: string): string {
	return s.replace(/\{([^{}]*)\}/g, "$1").replace(/\{([^{}]*)\}/g, "$1");
}

// ---------------------------------------------------------------------------
// Step 1: Split authors on " and " at brace-depth 0
// ---------------------------------------------------------------------------

export function splitAuthors(s: string): string[] {
	const depths = braceDepths(s);
	const parts: string[] = [];
	let start = 0;

	for (let i = 0; i < s.length - 4; i++) {
		if (depths[i] === 0 && /\s/.test(s[i])) {
			const m = s.slice(i).match(/^(\s+)[Aa][Nn][Dd](\s+)/);
			if (m) {
				parts.push(s.slice(start, i));
				start = i + m[0].length;
				i = start - 1;
			}
		}
	}
	parts.push(s.slice(start));

	return parts
		.map((p) => p.trim())
		.filter(
			(p) =>
				p !== "" &&
				!/^[Aa][Nn][Dd]\s+[Oo][Tt][Hh][Ee][Rr][Ss]$/.test(p) &&
				!/^[Oo][Tt][Hh][Ee][Rr][Ss]$/.test(p)
		);
}

// ---------------------------------------------------------------------------
// Step 2: Tokenize — split on whitespace and commas at brace-depth 0
// ---------------------------------------------------------------------------

interface Token {
	text: string;
	isComma: boolean;
}

function tokenize(s: string): Token[] {
	const depths = braceDepths(s);
	const tokens: Token[] = [];
	let current = "";

	const flush = (): void => {
		const t = current.trim();
		if (t !== "") tokens.push({ text: t, isComma: false });
		current = "";
	};

	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		const d = depths[i];

		if (d === 0 && ch === ",") {
			flush();
			tokens.push({ text: ",", isComma: true });
		} else if (d === 0 && /\s/.test(ch)) {
			flush();
		} else {
			current += ch;
		}
	}
	flush();
	return tokens;
}

// ---------------------------------------------------------------------------
// Step 4: Decide if a token is lowercase-starting
// ---------------------------------------------------------------------------

/**
 * A token is "von-like" when its first letter at brace-depth 0 is lowercase.
 * A leading backslash command or brace-protected group is skipped.
 * Tokens with no letters are treated as uppercase (not von).
 */
function isVonToken(text: string): boolean {
	let i = 0;
	// Skip leading \command{...}
	if (text[i] === "\\") {
		i++;
		while (i < text.length && /[a-zA-Z]/.test(text[i])) i++;
		if (i < text.length && text[i] === "{") {
			let depth = 0;
			while (i < text.length) {
				if (text[i] === "{") depth++;
				else if (text[i] === "}") {
					depth--;
					if (depth === 0) {
						i++;
						break;
					}
				}
				i++;
			}
		}
	} else if (text[i] === "{") {
		// Brace-protected group → treat as uppercase (Last-name part)
		return false;
	}
	// Find first letter
	while (i < text.length) {
		const ch = text[i];
		if (/[a-zA-Z]/.test(ch)) return ch === ch.toLowerCase();
		i++;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Step 3: Parse by comma count
// ---------------------------------------------------------------------------

function splitByCommas(tokens: Token[]): Token[][] {
	const parts: Token[][] = [];
	let current: Token[] = [];
	for (const tok of tokens) {
		if (tok.isComma) {
			parts.push(current);
			current = [];
		} else {
			current.push(tok);
		}
	}
	parts.push(current);
	return parts;
}

function wordsToString(words: Token[]): string {
	return words.map((t) => t.text).join(" ");
}

/** Parse a single name string into a Name object. */
export function parseName(raw: string): Name {
	const s = raw.trim();

	// Brace-protected corporate author: treat the whole thing as Last
	if (s.startsWith("{") && s.endsWith("}")) {
		return { first: "", von: "", last: s, jr: "" };
	}

	const allTokens = tokenize(s);
	const parts = splitByCommas(allTokens);
	const nCommas = parts.length - 1;

	if (nCommas === 0) {
		// Form: First von Last (or First Last Jr)
		const words = parts[0];
		if (words.length === 0) return { first: "", von: "", last: "", jr: "" };
		if (words.length === 1) return { first: "", von: "", last: words[0].text, jr: "" };

		// Check for trailing Jr/Sr/numeric suffix (e.g. "John Smith Jr", "Winifred Sackville Stoner Jr.")
		let wordsForName = words;
		let jr = "";
		if (
			words.length >= 3 &&
			/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(stripBraces(words[words.length - 1].text))
		) {
			jr = words[words.length - 1].text;
			wordsForName = words.slice(0, words.length - 1);
		}

		// Find the first von token (scanning left to right, before the last token)
		let vonStart = wordsForName.length; // default: no von span
		for (let i = 0; i < wordsForName.length - 1; i++) {
			if (isVonToken(wordsForName[i].text)) {
				vonStart = i;
				break;
			}
		}

		if (vonStart === wordsForName.length) {
			// No von particle → everything before last is first
			const firstWords = wordsForName.slice(0, wordsForName.length - 1);
			const lastWords = wordsForName.slice(wordsForName.length - 1);
			return {
				first: wordsToString(firstWords),
				von: "",
				last: wordsToString(lastWords),
				jr,
			};
		}

		// Von span: starts at vonStart, ends at the last lowercase token
		// before the final word (last is always the final word).
		let vonEnd = vonStart + 1;
		for (let i = vonStart + 1; i < wordsForName.length - 1; i++) {
			if (isVonToken(wordsForName[i].text)) vonEnd = i + 1;
		}

		const firstWords = wordsForName.slice(0, vonStart);
		const vonWords = wordsForName.slice(vonStart, vonEnd);
		const lastWords = wordsForName.slice(vonEnd);

		return {
			first: wordsToString(firstWords),
			von: wordsToString(vonWords),
			last: wordsToString(lastWords.length > 0 ? lastWords : wordsForName.slice(-1)),
			jr,
		};
	}

	if (nCommas === 1) {
		// Form: von Last, First
		const beforeComma = parts[0];
		const afterComma = parts[1];

		let vonEnd2 = 0;
		while (
			vonEnd2 < beforeComma.length - 1 &&
			isVonToken(beforeComma[vonEnd2].text)
		) {
			vonEnd2++;
		}

		return {
			first: wordsToString(afterComma),
			von: wordsToString(beforeComma.slice(0, vonEnd2)),
			last: wordsToString(beforeComma.slice(vonEnd2)),
			jr: "",
		};
	}

	// nCommas >= 2: Form: von Last, Jr, First
	const beforeComma = parts[0];
	const jrPart = parts[1];
	const firstParts = parts.slice(2);

	let vonEnd3 = 0;
	while (
		vonEnd3 < beforeComma.length - 1 &&
		isVonToken(beforeComma[vonEnd3].text)
	) {
		vonEnd3++;
	}

	return {
		first: firstParts.map((p) => wordsToString(p)).join(", "),
		von: wordsToString(beforeComma.slice(0, vonEnd3)),
		last: wordsToString(beforeComma.slice(vonEnd3)),
		jr: wordsToString(jrPart),
	};
}

/** Split on " and " at brace-depth 0 and parse each name. */
export function parseAuthors(s: string): Name[] {
	return splitAuthors(s).map(parseName);
}

// ---------------------------------------------------------------------------
// Step 5: Format
// ---------------------------------------------------------------------------

export type NameStyle =
	| "last-first" // Smith, John  (or van Beethoven, Ludwig)
	| "last-first-jr" // Smith Jr, John
	| "first-last" // John Smith
	| "bibtex" // von Last, Jr, First  (full BibTeX round-trip)
	| "von-last" // van Beethoven  (citekeys / in-text)
	| "initials"; // J. Smith  (J.-P. for hyphenated)

export interface FormatOptions {
	/** If true, omit the 'von' particle (e.g. "Beethoven, Ludwig" instead of "van Beethoven, Ludwig"). */
	dropVon?: boolean;
	/** If true, strip enclosing curly braces for display. */
	stripBraces?: boolean;
}

function computeInitials(first: string): string {
	return first
		.split(/\s+/)
		.map((word) =>
			word
				.split("-")
				.map((part) => {
					const ch = stripBraces(part).match(/[a-zA-Z]/);
					return ch ? ch[0].toUpperCase() + "." : part;
				})
				.join("-")
		)
		.join(" ");
}

export function formatName(
	n: Name,
	style: NameStyle = "last-first",
	options?: FormatOptions
): string {
	const { first, von, last, jr } = n;
	const effectiveVon = options?.dropVon ? "" : von;
	const effectiveVonLast = [effectiveVon, last].filter(Boolean).join(" ");
	const effectiveVonLastJr = jr ? `${effectiveVonLast}, ${jr}` : effectiveVonLast;

	let result: string;
	switch (style) {
		case "last-first": {
			if (!first) {
				result = effectiveVonLast;
			} else {
				result = `${effectiveVonLast}, ${first}${jr ? ` ${jr}` : ""}`;
			}
			break;
		}
		case "last-first-jr": {
			if (!first) {
				result = effectiveVonLastJr;
			} else {
				result = `${effectiveVonLastJr}, ${first}`;
			}
			break;
		}
		case "first-last": {
			result = [first, effectiveVon, last, jr].filter(Boolean).join(" ");
			break;
		}
		case "bibtex": {
			if (!first && !jr) {
				result = effectiveVonLast;
			} else if (jr) {
				result = `${effectiveVonLast}, ${jr}, ${first}`;
			} else {
				result = `${effectiveVonLast}, ${first}`;
			}
			break;
		}
		case "von-last": {
			result = effectiveVonLast;
			break;
		}
		case "initials": {
			const inits = first ? computeInitials(first) : "";
			result = [inits, effectiveVonLast, jr].filter(Boolean).join(" ");
			break;
		}
		default: {
			result = effectiveVonLast;
			break;
		}
	}

	if (options?.stripBraces) {
		result = stripBraces(result);
	}

	return result;
}

/**
 * Read author strings from frontmatter or BibTeX and format them according to style and options.
 * Pure function with no Obsidian dependencies.
 */
export function formatAuthors(
	input: string | string[],
	style: NameStyle = "last-first",
	options?: FormatOptions
): string[] {
	if (!input) return [];
	const rawList = Array.isArray(input) ? input : [input];
	const results: string[] = [];

	for (const raw of rawList) {
		if (typeof raw !== "string" || !raw.trim()) continue;
		const authors = parseAuthors(raw);
		for (const author of authors) {
			const formatted = formatName(author, style, options);
			if (formatted) {
				results.push(formatted);
			}
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Auto-suggestion helpers (used by the author format validator)
// ---------------------------------------------------------------------------

/**
 * Try to parse a raw single-field name string and produce a suggestion in
 * BibTeX "von Last, Jr, First" form.
 *
 * Returns null when:
 *   - The name already has a comma with non-empty content on both sides.
 *   - The name is a mononym (no space, no comma) — nothing to reorder.
 *   - Parsing could not identify a first-name component — we can't reliably
 *     determine which part is the last name.
 */
export function suggestBibtexForm(raw: string): string | null {
	const s = raw.trim();

	// Already comma-separated with both sides filled → looks fine
	if (s.includes(",")) {
		const [left, right] = s.split(",", 2).map((p) => p.trim());
		if (left && right) return null;
	}

	// Mononym — no correction possible
	if (!s.includes(" ")) return null;

	const n = parseName(s);
	if (!n.last) return null;
	// If no first was identified, we can't tell which word is Last
	if (!n.first && !n.von) return null;

	return formatName(n, "bibtex");
}

/**
 * Given a Zotero two-field creator's firstName + lastName, produce the
 * canonical BibTeX form.  Returns null when already in a sensible form or
 * insufficient data exists.
 */
export function suggestBibtexFormTwoField(
	firstName: string,
	lastName: string
): string | null {
	const first = firstName.trim();
	const last = lastName.trim();
	if (!first || !last) return null;
	// Parse as "von Last, First" to extract any von particle from lastName
	const n = parseName(`${last}, ${first}`);
	if (!n.last) return null;
	return formatName(n, "bibtex");
}
