import { DialogTurn, NoteRole } from "../parsers/types";

/**
 * Display label for the AI-response heading on a turn. The prompt
 * heading is the computed headline (varies per turn); the AI heading
 * is a stable label so the outline pane reads "AI response (turn N)"
 * regardless of content.
 */
const AI_HEADING_LABEL = (turnId: number) => `AI response (turn ${turnId})`;

/**
 * Render one turn as a markdown block. The new turn structure has TWO
 * headings per turn:
 *
 *   - For a prompt turn: a level-2 summary heading (the headline derived
 *     from the prompt text) carrying the permanent `^turn-N-prompt` block
 *     ID, followed by the prompt body. Any leading "# " heading markers
 *     in the prompt are stripped first so the prompt is always plain
 *     paragraph text under its heading, never its own headline.
 *   - For an AI turn: a level-3 "AI response (turn N)" heading carrying
 *     the permanent `^turn-N-ai` block ID, followed by the AI body. The
 *     body is heading-demoted so the topmost heading sits at level 4,
 *     one below the AI response heading, never colliding with it.
 *
 * The block IDs `^turn-N-prompt` and `^turn-N-ai` are the stable
 * machine-readable anchor for everything else (prune, append, getSurvivingTurnIds,
 * getNextTurnIndex) and must not change; the only thing changing is the
 * heading text and the level hierarchy.
 */
export function renderTurn(
	role: NoteRole,
	rawText: string,
	turnId: number,
	headingText: string
): string {
	const anchor = `^turn-${turnId}-${role}`;
	if (role === "prompt") {
		const body = stripHeadingMarkers(rawText);
		return `## ${headingText} ${anchor}\n\n${body}\n`;
	}
	const body = demoteHeadingsBelow(rawText, 4);
	return `### ${AI_HEADING_LABEL(turnId)} ${anchor}\n\n${body}\n`;
}

/**
 * The display label used for an AI-response heading at the given turn
 * number. Exposed so the caller (buildNoteBody) can pre-compute the
 * heading text for an AI turn without re-deriving it.
 */
export function aiHeadingLabel(turnId: number): string {
	return AI_HEADING_LABEL(turnId);
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
 * Used for AI turns with targetMinLevel=4, so the topmost heading in
 * the response lands one level below the `### AI response` structural
 * heading (which sits at level 3) and never collides with it.
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
 * Find the next available turn ID by scanning the file for the highest
 * existing `^turn-N-role` anchor. Self-correcting against manual edits
 * (e.g. a user deleting a middle turn does not desync the counter).
 */
export function getNextTurnIndex(noteText: string): number {
	const re = /\^turn-(\d+)-(?:prompt|ai)/g;
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
 * one `^turn-N-*` anchor present. Used by the prune command to decide
 * which source lines are orphaned.
 */
export function getSurvivingTurnIds(noteText: string): Set<number> {
	const ids = new Set<number>();
	const re = /\^turn-(\d+)-(?:prompt|ai)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(noteText)) !== null) {
		ids.add(parseInt(m[1], 10));
	}
	return ids;
}
