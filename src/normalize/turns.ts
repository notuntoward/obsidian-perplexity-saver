import { DialogTurn, NoteRole } from "../parsers/types";

/**
 * Render one turn as a markdown block. Each turn has ONE heading (the
 * prompt heading at level 2), not two. The prompt heading carries a
 * single block ID `^turn-N` on the same line, so it serves as the
 * turn's only anchor. Using a single ID (rather than two like
 * `^turn-N-prompt ^turn-N-ai`) avoids Obsidian wrapping the second
 * `^` anchor onto its own visual line in the editor.
 *
 *   - For a prompt turn: a level-2 summary heading (the headline derived
 *     from the prompt text) carrying the `^turn-N` block ID, followed by
 *     a closed `> [!Prompt]+` callout containing the prompt body. Any
 *     leading "# " heading markers in the prompt are stripped first so
 *     the prompt is always plain paragraph text inside the callout, never
 *     its own headline.
 *   - For an AI turn: just the AI body, no heading. The body is heading-
 *     demoted so the topmost heading sits at level 3, one level below
 *     the level-2 prompt heading, and never collides with it.
 *
 * The block ID `^turn-N` is the stable machine-readable anchor for
 * everything else (removeNoDialog, append, getSurvivingTurnIds, getNextTurnIndex).
 */
export function renderTurn(
	role: NoteRole,
	rawText: string,
	turnId: number,
	headingText: string,
	options?: { includeHeading?: boolean; calloutCollapsed?: boolean }
): string {
	const calloutSuffix = options?.calloutCollapsed !== false ? "+" : "-";
	const includeHeading = options?.includeHeading ?? true;
	if (!includeHeading) {
		// AI turn that is part of a prompt+ai pair: no heading of its own.
		// The prompt heading above serves as the turn's anchor. The
		// body is heading-demoted so the topmost heading sits at level 3,
		// one below the level-2 prompt heading.
		const body = demoteHeadingsBelow(rawText, 3);
		return `${body}\n`;
	}
	// Every other turn (all prompt turns, and standalone AI turns that
	// have no preceding prompt) gets TWO structural elements:
	//   1. A level-2 heading carrying the computed headline text and the
	//      single `^turn-N` block ID. This is the thing that shows up in
	//      the outline pane and is the machine-readable anchor for the
	//      turn.
	//   2. A closed Obsidian callout (`> [!Prompt]+`) containing the
	//      prompt body (for a normal prompt turn) or a fallback label
	//      (for a standalone AI turn). Closed by default so the
	//      prompt text collapses into a single clickable block.
	// The AI body for a paired turn follows directly below, with no
	// heading of its own.
	const heading = `## ${headingText} ^turn-${turnId}`;
	if (role === "prompt") {
		// Fold the prompt body into a closed callout as additional
		// `> ` lines so it collapses by default.
		const strippedBody = stripHeadingMarkers(rawText);
		const foldedBody = strippedBody
			.split("\n")
			.map((line) => (line.length > 0 ? `> ${line}` : ">"))
			.join("\n");
		return `${heading}\n\n> [!Prompt]${calloutSuffix}\n${foldedBody}\n`;
	}
	// Standalone AI turn: heading with the fallback label, followed by
	// a closed callout (empty body since the AI body comes after).
	// The AI body is heading-demoted so its topmost heading sits at
	// level 3.
	const body = demoteHeadingsBelow(rawText, 3);
	return `${heading}\n\n> [!Prompt]${calloutSuffix}\n\n${body}\n`;
}

/**
 * Remove markdown heading markers ("#", "##", ... at the start of a line)
 * from prompt text, leaving the rest of the line as plain paragraph text.
 * Vendors sometimes echo the user's question as a heading (Perplexity
 * prefixes the first line of a stock export with "# "); that is a display
 * artifact of the export, not a real heading, and must never survive into
 * the note as one.
 */
export function stripHeadingMarkers(text: string): string {
	return text.replace(/^#{1,6}[ \t]+/gm, "");
}

/**
 * Shift every heading in `text` down by the minimum number of levels
 * needed to make the topmost heading sit at exactly `targetMinLevel`
 * (capped at level 6). If `text` has no headings, it is returned
 * unchanged.
 *
 * Used for AI turns with targetMinLevel=3, so the topmost heading in
 * the response lands one level below the `## prompt` structural heading
 * (which sits at level 2) and never collides with it.
 */
export function demoteHeadingsBelow(text: string, targetMinLevel: number): string {
	const headingRe = /^(#{1,6})(\s+)/gm;
	let minLevel = Infinity;
	let m: RegExpExecArray | null;
	while ((m = headingRe.exec(text)) !== null) {
		const level = m[1].length;
		if (level < minLevel) minLevel = level;
	}
	if (!isFinite(minLevel)) return text;
	const offset = Math.max(0, targetMinLevel - minLevel);
	return text.replace(/^(#{1,6})(\s+)/gm, (_, hashes: string, space: string) => {
		const newLevel = Math.min(hashes.length + offset, 6);
		return "#".repeat(newLevel) + space;
	});
}

/**
 * Assign a turn ID to every entry in a flat DialogTurn list, pairing a
 * "prompt" with the "ai" response that immediately follows it into one
 * logical turn (they share the same ID). A turn is a prompt-and-response
 * pair; a standalone prompt or standalone AI response with no matching
 * partner (e.g. a pasted response with no visible prompt) gets its own
 * unique ID instead of sharing with a neighbor it isn't actually paired
 * with.
 *
 * Example: [prompt, ai, prompt, ai] with startTurnId=1 yields [1, 1, 2, 2].
 */
export function assignTurnIds(turns: DialogTurn[], startTurnId: number): number[] {
	const ids: number[] = [];
	let nextId = startTurnId;
	let i = 0;
	while (i < turns.length) {
		if (turns[i].role === "prompt" && i + 1 < turns.length && turns[i + 1].role === "ai") {
			ids.push(nextId, nextId);
			nextId++;
			i += 2;
		} else {
			ids.push(nextId);
			nextId++;
			i += 1;
		}
	}
	return ids;
}

/**
 * Group flat DialogTurn list into logical turns (pairing prompts and responses).
 */
export interface LogicalTurn {
	id: number;
	turns: DialogTurn[];
}

export function groupLogicalTurns(turns: DialogTurn[]): LogicalTurn[] {
	const ids = assignTurnIds(turns, 1);
	const groups: LogicalTurn[] = [];
	let currentGroup: LogicalTurn | null = null;
	for (let i = 0; i < turns.length; i++) {
		const id = ids[i];
		if (!currentGroup || currentGroup.id !== id) {
			currentGroup = { id, turns: [] };
			groups.push(currentGroup);
		}
		currentGroup.turns.push(turns[i]);
	}
	return groups;
}

/**
 * Find the next available turn ID by scanning the file for the highest
 * existing `^turn-N` anchor. Self-correcting against manual edits
 * (e.g. a user deleting a middle turn does not desync the counter).
 * For backward compatibility, also matches the old `^turn-N-prompt` and
 * `^turn-N-ai` formats — both yield the same turn number.
 */
export function getNextTurnIndex(noteText: string): number {
	const re = /\^turn-(\d+)/g;
	let max = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(noteText)) !== null) {
		const n = parseInt(m[1], 10);
		if (n > max) max = n;
	}
	return max + 1;
}

/**
 * Scan the body and return the set of turn IDs that still have at least
 * one `^turn-N` anchor present. Used by the removeNoDialog command to decide
 * which source lines are orphaned.
 */
export function getSurvivingTurnIds(noteText: string): Set<number> {
	const ids = new Set<number>();
	const re = /\^turn-(\d+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(noteText)) !== null) {
		ids.add(parseInt(m[1], 10));
	}
	return ids;
}
