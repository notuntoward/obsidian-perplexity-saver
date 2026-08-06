/**
 * sourceLinkState.ts
 *
 * Pure functions and types for representing and rendering the state of a
 * citation source line in the "# Sources" section of a normalized AI dialog
 * note. This module is the single source of truth for the on-disk format of
 * a source line; no other code should hand-build a "[^sN]: ..." string.
 *
 * The module is deliberately dependency-free: no `import` from "obsidian",
 * no `app` or `vault` references, no side effects. This keeps the types and
 * render/parse functions trivially unit-testable and safe to use from any
 * code path (parser, renderer, relinker, removeNoDialog).
 *
 * Today, only the "raw" state is ever produced by the plugin (a citation
 * whose original URL has not been promoted into Zotero yet). The
 * "zotero-item" and "lit-note" states are defined now so that a future
 * Zotero-relinking feature can use this same module without requiring any
 * changes to notes already on disk.
 *
 * Ownership model: a source's `(turn N)` / `(turns N, M)` tag records every
 * turn that has ever cited it, not just the turn that introduced it. This
 * lets removal distinguish "this source's only citing turn was deleted,
 * remove it" from "one of several citing turns was deleted, just drop that
 * turn from the ownership list and keep the source" (see removeNoDialog.ts).
 */

/** The three possible states a citation source can be in. */
export type SourceLinkState =
	| { kind: "raw"; url: string; title?: string }
	| { kind: "zotero-item"; citekey: string; zotkey: string }
	| { kind: "lit-note"; citekey: string };

/** A fully parsed representation of one "# Sources" line. */
export interface ParsedSourceLine {
	id: string; // e.g. "s1" (without the caret/brackets)
	state: SourceLinkState;
	turnIds: number[]; // every turn that cites this source, ascending, deduped
	rawUrl: string; // the ORIGINAL url, preserved regardless of current state
}

/**
 * Render a single "# Sources" line from its state.
 *
 * This is the ONLY function in the whole plugin allowed to construct this
 * line's text. Do not string-concatenate a source line anywhere else.
 *
 * @param id       footnote id, e.g. "s1"
 * @param state    the link's current state
 * @param turnIds  every turn that cites this source (one or more)
 * @param rawUrl   the ORIGINAL url; preserved as a hidden HTML comment so a
 *                 later relink still has the matching key
 */
export function renderSourceLine(
	id: string,
	state: SourceLinkState,
	turnIds: number[],
	rawUrl: string
): string {
	const linkText = renderLinkText(state);
	return `[^${id}]: ${linkText}`;
}

function renderLinkText(state: SourceLinkState): string {
	switch (state.kind) {
		case "lit-note":
			return `[[${state.citekey}]]`;
		case "zotero-item":
			return `[Zotero: ${state.citekey}](zotero://select/library/items/${state.zotkey})`;
		case "raw":
			return state.title ? `[${state.title}](${state.url})` : `<${state.url}>`;
	}
}

/**
 * Convert internal footnote id "s1" to Obsidian block-id "src-1".
 */
export function toBlockId(id: string): string {
	return id;
}

/**
 * Regex for parsing a rendered source line back into its parts.
 * Matches standard markdown footnote format: [^id]: <url> or [^id]: [title](url) or [^id]: [[citekey]]
 */
const SOURCE_LINE_RE =
	/^\[\^(?<id>[^\]]+)\]:\s+(?:\[\[(?<citekey>[^\]]+)\]\]|\[(?<title>[^\]]*)\]\((?<url>[^)]+)\)|<(?<bareUrl>[^>]+)>)\s*$/;

/**
 * Parse a "# Sources" line back into a structured object.
 */
export function parseSourceLine(line: string): ParsedSourceLine | null {
	const m = SOURCE_LINE_RE.exec(line.trim());
	if (!m || !m.groups) return null;

	const g = m.groups;
	const id = g.id;

	// Turn ID is parsed from the prefix before the underscore (e.g. "1" from "1_1")
	const turnNum = parseInt(id.split("_")[0], 10);
	const turnIds = isNaN(turnNum) ? [1] : [turnNum];

	let state: SourceLinkState;
	let rawUrl = "";
	if (g.citekey) {
		state = { kind: "lit-note", citekey: g.citekey };
	} else if (g.url) {
		state = { kind: "raw", url: g.url, title: g.title || undefined };
		rawUrl = g.url;
	} else if (g.bareUrl) {
		state = { kind: "raw", url: g.bareUrl };
		rawUrl = g.bareUrl;
	} else {
		return null;
	}

	return { id, state, turnIds, rawUrl };
}
