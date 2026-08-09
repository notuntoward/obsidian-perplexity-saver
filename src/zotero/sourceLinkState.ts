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
	| { kind: "zotero-item"; citekey: string; zotkey: string; title?: string }
	| { kind: "lit-note"; citekey: string; title?: string };

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
		case "lit-note": {
			const label = state.title ? `${state.title} -> ${state.citekey}` : undefined;
			return label ? `**[[${state.citekey}|${label}]]**` : `**[[${state.citekey}]]**`;
		}
		case "zotero-item": {
			const label = state.title
				? `${state.title} -> ${state.zotkey}`
				: `${state.citekey}\u2794${state.zotkey}`;
			return `**[${label}](zotero://select/library/items/${state.zotkey})**`;
		}
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
 * Matches standard markdown footnote format: [^id]: <url> or [^id]: [title](url) or [^id]: [[wikilink]] or bold variants
 */
const SOURCE_LINE_RE =
	/^\[\^(?<id>[^\]]+)\]:\s+(?:\*{0,2}\[\[(?<wikilink>[^\]]+)\]\]\*{0,2}|\*{0,2}\[(?<title>.*)\]\((?<url>https?:\/\/[^\s)]+|zotero:\/\/[^\s)]+)\)\*{0,2}|<(?<bareUrl>[^>]+)>)\s*$/;

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
	if (g.wikilink) {
		const parts = g.wikilink.split("|");
		const citekey = parts[0].trim();
		let title: string | undefined = undefined;
		if (parts[1]) {
			const label = parts[1].trim();
			const arrowIdx = label.lastIndexOf(" -> ");
			title = arrowIdx !== -1 ? label.substring(0, arrowIdx).trim() : label;
		}
		state = title ? { kind: "lit-note", citekey, title } : { kind: "lit-note", citekey };
	} else if (g.url) {
		const zoteroMatch = /^zotero:\/\/select\/library\/items\/(?<zotkey>[^/]+)$/.exec(g.url);
		if (zoteroMatch && zoteroMatch.groups) {
			const zotkey = zoteroMatch.groups.zotkey;
			let citekey = zotkey;
			let title: string | undefined = undefined;
			if (g.title) {
				const arrowIdx = g.title.lastIndexOf(" -> ");
				const unicodeArrowIdx = g.title.indexOf("\u2794");
				if (arrowIdx !== -1) {
					title = g.title.substring(0, arrowIdx).trim();
					citekey = g.title.substring(arrowIdx + 4).trim();
				} else if (unicodeArrowIdx !== -1) {
					citekey = g.title.substring(0, unicodeArrowIdx).trim();
					title = undefined;
				} else {
					title = g.title.trim();
				}
			}
			state = { kind: "zotero-item", citekey, zotkey, title };
		} else {
			state = { kind: "raw", url: g.url, title: g.title || undefined };
			rawUrl = g.url;
		}
	} else if (g.bareUrl) {
		state = { kind: "raw", url: g.bareUrl };
		rawUrl = g.bareUrl;
	} else {
		return null;
	}

	return { id, state, turnIds, rawUrl };
}
