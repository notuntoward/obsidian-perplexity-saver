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
 * code path (parser, renderer, relinker, prune).
 *
 * Today, only the "raw" state is ever produced by the plugin (a citation
 * whose original URL has not been promoted into Zotero yet). The
 * "zotero-item" and "lit-note" states are defined now so that a future
 * Zotero-relinking feature can use this same module without requiring any
 * changes to notes already on disk.
 *
 * Ownership model: a source's `(turn N)` / `(turns N, M)` tag records every
 * turn that has ever cited it, not just the turn that introduced it. This
 * lets pruning distinguish "this source's only citing turn was deleted,
 * remove it" from "one of several citing turns was deleted, just drop that
 * turn from the ownership list and keep the source" (see prune.ts).
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
	const sorted = [...new Set(turnIds)].sort((a, b) => a - b);
	const turnLabel = sorted.length <= 1 ? `turn ${sorted[0]}` : `turns ${sorted.join(", ")}`;
	return `^${toBlockId(id)} ${linkText} (${turnLabel}) <!-- src-url: ${rawUrl} -->`;
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
	const m = id.match(/^s(\d+)$/);
	return m ? `src-${m[1]}` : id;
}

/**
 * Convert Obsidian block-id "src-1" back to internal footnote id "s1".
 */
function fromBlockId(blockId: string): string {
	const m = blockId.match(/^src-(\d+)$/);
	return m ? `s${m[1]}` : blockId;
}

/**
 * Regex for parsing a rendered source line back into its parts.
 * Matches, in order: block id, link (one of three forms), turn number(s)
 * (either "turn N" or "turns N, M, ..."), and the trailing hidden src-url
 * comment.
 */
const SOURCE_LINE_RE =
	/^\^(?<id>src-\d+)\s+(?:\[\[(?<citekey>[^\]]+)\]\]|\[Zotero:\s*(?<zkey>[^\]]+)\]\(zotero:\/\/select\/library\/items\/(?<zotkey>[^)]+)\)|\[(?<title>[^\]]*)\]\((?<url>[^)]+)\)|<(?<bareUrl>[^>]+)>)\s*\(turns?\s+(?<turns>[\d,\s]+)\)\s*<!--\s*src-url:\s*(?<rawUrl>\S+)\s*-->\s*$/;

/**
 * Parse a "# Sources" line back into a structured object. Returns null if
 * the line doesn't match the expected format (e.g. malformed, hand-edited
 * without the trailing src-url comment, or some other plugin's output).
 * Callers must handle null and should generally leave unparseable lines
 * untouched rather than deleting them, since we can't be sure what they are.
 */
export function parseSourceLine(line: string): ParsedSourceLine | null {
	const m = SOURCE_LINE_RE.exec(line.trim());
	if (!m || !m.groups) return null;

	const g = m.groups;
	const turnIds = g.turns
		.split(",")
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => !isNaN(n));
	if (turnIds.length === 0) return null;
	const rawUrl = g.rawUrl;

	let state: SourceLinkState;
	if (g.citekey) {
		state = { kind: "lit-note", citekey: g.citekey };
	} else if (g.zkey && g.zotkey) {
		state = { kind: "zotero-item", citekey: g.zkey, zotkey: g.zotkey };
	} else if (g.url) {
		state = { kind: "raw", url: g.url, title: g.title || undefined };
	} else if (g.bareUrl) {
		state = { kind: "raw", url: g.bareUrl };
	} else {
		return null;
	}

	return { id: fromBlockId(g.id), state, turnIds, rawUrl };
}
