import { DialogFile, DialogTurn } from "../parsers/types";
import { renderSourceLine, parseSourceLine, SourceLinkState, toBlockId } from "../zotero/sourceLinkState";
import { renderTurn, assignTurnIds } from "./turns";
import { HeadlineOptions, headlineForPrompt } from "./headlines";

interface SourceEntry {
	id: string;
	turnIds: Set<number>;
	state: SourceLinkState;
	rawUrl: string;
}

/**
 * Build the body of a normalized AI dialog note from a parsed DialogFile.
 * This is the single function that consumes a DialogFile and produces the
 * uniform markdown the rest of the plugin (append, prune, relinker) reads.
 *
 * Behavior:
 *   - A prompt and the AI response immediately following it are one
 *     logical turn and share one turn ID (see assignTurnIds). A prompt
 *     turn is rendered with a level-2 summary heading (the headline
 *     derived from the prompt text, via the method selected in
 *     `headlineOptions`) followed by the prompt body. The AI turn is
 *     rendered with a level-3 "AI response (turn N)" heading followed
 *     by the AI body, with the body heading-demoted so the topmost
 *     heading lands at level 4.
 *   - Citations on AI turns are rewritten from the vendor's original
 *     numbering (e.g. [1]) to Obsidian block-linked citations
 *     (e.g. [[#^src-1|1]]), with every occurrence of a given number
 *     rewritten, not just the first.
 *   - Source lines are rendered via renderSourceLine (Part B) so the
 *     on-disk format is exactly what the future relinker expects.
 *   - A source cited by more than one turn (in this call, or reused from
 *     `existingSourceText` on append) records every citing turn's ID, e.g.
 *     `(turns 2, 5)`, not just the first. This is what lets pruning keep a
 *     source alive as long as any one of its citing turns still exists
 *     (see prune.ts), instead of deleting it the moment the turn that
 *     happened to introduce it first is removed.
 *   - If `existingSourceText` is provided (e.g. when appending to a note
 *     that already has a # Sources block), the returned `sourceLines` is
 *     the complete, regenerated # Sources block: every existing entry
 *     (verbatim, except its turnIds set may grow) plus every newly minted
 *     one. Callers must replace the whole existing # Sources block with
 *     this result, not just append to it.
 *   - If `collapseBlankLines` is true (the default), the final body is
 *     post-processed to remove blank lines immediately before and after
 *     every heading and to collapse any run of 2+ blank lines to one,
 *     producing a denser, more uniform file.
 */
export function buildNoteBody(
	dialog: DialogFile,
	options: {
		startTurnId?: number;
		existingSourceText?: string;
		collapseBlankLines?: boolean;
		collapsePromptCallouts?: boolean;
		headlineOptions?: HeadlineOptions;
	} = {}
): { body: string; sourceLines: string[] } {
	const startTurnId = options.startTurnId ?? 1;
	const existingSourceText = options.existingSourceText ?? "";
	const collapseBlankLines = options.collapseBlankLines ?? true;
	const collapsePromptCallouts = options.collapsePromptCallouts ?? true;
	const headlineOptions: HeadlineOptions = options.headlineOptions ?? { method: "lead" };

	// url -> full source entry, seeded with whatever the existing # Sources
	// block already has so we never mint a duplicate sN for the same URL,
	// and so a newly citing turn can be added to an existing entry's
	// turnIds set rather than creating a second entry for the same source.
	const sourcesByUrl = new Map<string, SourceEntry>();
	let maxExistingSourceNum = 0;
	for (const line of existingSourceText.split("\n")) {
		const parsed = parseSourceLine(line);
		if (!parsed) continue;
		sourcesByUrl.set(parsed.rawUrl, {
			id: parsed.id,
			turnIds: new Set(parsed.turnIds),
			state: parsed.state,
			rawUrl: parsed.rawUrl,
		});
		const m = parsed.id.match(/^s(\d+)$/);
		if (m) maxExistingSourceNum = Math.max(maxExistingSourceNum, parseInt(m[1], 10));
	}
	let sourceCounter = maxExistingSourceNum + 1;

	const turnIds = assignTurnIds(dialog.turns, startTurnId);
	const turnBlocks: string[] = [];

	dialog.turns.forEach((turn, i) => {
		const turnId = turnIds[i];
		const mintNextSourceId = () => {
			const id = "s" + sourceCounter;
			sourceCounter++;
			return id;
		};
		const bodyText = rewriteCitationsForTurn(turn, turnId, sourcesByUrl, mintNextSourceId);
		// The prompt heading is the turn's only heading and carries both
		// anchor IDs. A paired AI turn (one that immediately follows a
		// prompt with the same turnId) has no heading of its own — the
		// prompt heading above serves the turn. A standalone AI turn (no
		// preceding prompt) still needs a heading, so it gets a stable
		// fallback label (not derived from the AI's response text, which
		// would leak citation markers and internal headings into the
		// outline pane).
		const isPairedAI =
			turn.role === "ai" && i > 0 && dialog.turns[i - 1].role === "prompt" && turnIds[i - 1] === turnId;
		if (isPairedAI) {
			turnBlocks.push(renderTurn(turn.role, bodyText, turnId, "", { includeHeading: false }));
		} else {
			const headingText =
				turn.role === "prompt"
					? promptHeadingText(turn.rawText, turnId, headlineOptions)
					: `AI response (turn ${turnId})`;
			turnBlocks.push(renderTurn(turn.role, bodyText, turnId, headingText, { calloutCollapsed: collapsePromptCallouts }));
		}
	});

	// Sources section below — kept as before.

	const sourceLines = [...sourcesByUrl.values()]
		.sort((a, b) => numericSourceId(a.id) - numericSourceId(b.id))
		.map((entry) =>
			renderSourceLine(entry.id, entry.state, [...entry.turnIds].sort((a, b) => a - b), entry.rawUrl)
		);

	const sections: string[] = ["# Dialog", ""];
	if (dialog.sourceUrl) {
		sections.push(renderSourceLink(dialog.sourceVendor, dialog.sourceUrl), "");
	}
	sections.push(...turnBlocks);
	if (sourceLines.length > 0) {
		sections.push("", "# Sources", "", ...sourceLines);
	}
	let body = sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
	if (collapseBlankLines) {
		body = collapseWhitespace(body);
	}

	return { body, sourceLines };
}

/**
 * Render a clickable link back to the original AI dialog page, placed
 * inline as the first line of the note body so it is visible from both
 * the editor and reading view (the YAML property is no longer the only
 * way to reach the source). Not wrapped in a blockquote: blockquoting it
 * added visual noise without semantic benefit, and the source link is
 * structural metadata about the note, not a quoted passage.
 */
function renderSourceLink(vendor: DialogFile["sourceVendor"], url: string): string {
	return `**Source:** [${vendor}](${url})`;
}

/**
 * Collapse blank lines around headings and any run of multiple blank
 * lines down to a single blank line, for users who prefer a denser,
 * more uniform file. The single-pass regex:
 *   - collapses 2+ blank lines immediately before a heading down to
 *     exactly one blank line, so every heading is separated from the
 *     preceding paragraph by a single blank line (required for Obsidian
 *     to render the heading correctly);
 *   - collapses 2+ blank lines after a heading into exactly one blank
 *     line, so the heading is visually attached to its own body without
 *     floating in extra whitespace;
 *   - collapses any run of 2+ consecutive blank lines everywhere else
 *     to one, eliminating accidental double-spacing from paste or merge
 *     operations.
 * Used only when the user has the "collapse blank lines" setting on.
 */
export function collapseWhitespace(body: string): string {
	return body
		.replace(/^[ \t]*\n+/, "") // strip leading blank lines
		.replace(/[ \t]*\n[ \t]*\n+(?=#{1,6}\s)/g, "\n\n") // blank lines before a heading -> exactly 1
		.replace(/(#{1,6}[^\n]*)\n[ \t]*\n+/g, "$1\n\n") // blank lines after a heading -> exactly 1
		.replace(/\n{3,}/g, "\n\n");
}

/**
 * Rewrite an AI turn's citation markers (e.g. [1]) to Obsidian block-linked
 * citations (e.g. [[#^src-1|1]]), minting a new source entry the first time
 * a URL is seen and adding this turn's ID to an existing entry's ownership
 * set on every subsequent citation of the same URL (whether from an earlier
 * turn in this same call or from a prior append). Every occurrence of a given
 * citation number in the text is rewritten, not just the first.
 */
function rewriteCitationsForTurn(
	turn: DialogTurn,
	turnId: number,
	sourcesByUrl: Map<string, SourceEntry>,
	mintId: () => string
): string {
	if (turn.role !== "ai" || turn.citations.length === 0) {
		return turn.rawText;
	}

	const numToId = new Map<string, string>();
	for (const c of turn.citations) {
		let entry = sourcesByUrl.get(c.url);
		if (!entry) {
			entry = {
				id: mintId(),
				turnIds: new Set([turnId]),
				state: { kind: "raw", url: c.url, title: c.title },
				rawUrl: c.url,
			};
			sourcesByUrl.set(c.url, entry);
		} else {
			entry.turnIds.add(turnId);
		}
		numToId.set(c.origNum, entry.id);
	}

	return turn.rawText.replace(/\[(\d+)\]/g, (match, num) => {
		const id = numToId.get(num);
		if (!id) return match;
		const sourceNum = id.replace(/^s/, "");
		return `[[#^${toBlockId(id)}|${sourceNum}]]`;
	});
}

function numericSourceId(id: string): number {
	const m = id.match(/^s(\d+)$/);
	return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Pull the existing # Sources section text out of a note, for re-use during append. */
export function extractSourcesSection(noteText: string): string {
	const match = noteText.match(/# Sources\n+([\s\S]*)$/);
	return match ? match[1] : "";
}

/**
 * Compute the heading text for a prompt turn. If the headline algorithm
 * returns an empty string (e.g. the prompt is too short to yield a
 * meaningful sentence), fall back to a short default that includes the
 * turn number so the heading is never blank.
 */
function promptHeadingText(
	promptText: string,
	turnId: number,
	headlineOptions: HeadlineOptions
): string {
	const headline = headlineForPrompt(promptText, headlineOptions);
	if (headline.trim()) return headline;
	return `Prompt (turn ${turnId})`;
}
