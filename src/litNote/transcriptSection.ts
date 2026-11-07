/**
 * Locating and parsing the stored YouTube transcript inside a literature note.
 *
 * The transcript is written by `buildLitNoteBody` under a level-1 heading whose
 * text is the `transcriptHeading` setting, one line per caption cue (default)
 * or one line per block of cues:
 *   [m:ss](https://youtu.be/ID?t=SECONDS "START–END") caption text
 *   [mm:ss](https://youtube.com/watch?v=ID&t=SECONDS) caption text ...
 * Notes written by earlier versions may use per-cue lines of the form
 *   [mm:ss.mmm → mm:ss.mmm](https://youtube.com/watch?v=ID&t=SECONDS) caption text
 */

import type { HeadingCache } from "obsidian";
import type { TranscriptCue } from "./transcriptParagraphs";
import { unescapeCueText } from "./youtubeTranscript";

export const DEFAULT_TRANSCRIPT_HEADING = "Transcript";

export interface StoredTranscriptLine {
	/** Start time in seconds. */
	startSec: number;
	/** End time in seconds; only per-cue lines store one. */
	endSec?: number;
	/** Link target of the timestamp (may be empty when the line had none). */
	url: string;
	text: string;
}

/**
 * Normalise a user-entered heading name: strip any leading `#` markers and
 * surrounding whitespace, falling back to the default when nothing remains.
 */
export function normalizeTranscriptHeading(raw: string | null | undefined): string {
	const name = (raw ?? "").replace(/^\s*#+\s*/, "").trim();
	return name || DEFAULT_TRANSCRIPT_HEADING;
}

function sameHeading(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Return the text under the transcript heading (up to the next heading of the
 * same or higher level), or null when the note has no such heading. Notes
 * created before the heading name was changed still use the default name, so
 * that name is used as a fallback.
 */
export function findTranscriptSection(
	content: string,
	headings: HeadingCache[] | undefined,
	headingName: string
): string | null {
	const range = findTranscriptRange(content, headings, headingName);
	return range ? content.slice(range.start, range.end).trim() : null;
}

/** Character range of the transcript section body (after its heading line), or null. */
export function findTranscriptRange(
	content: string,
	headings: HeadingCache[] | undefined,
	headingName: string
): { start: number; end: number } | null {
	if (!headings || headings.length === 0) return null;
	const wanted = normalizeTranscriptHeading(headingName);
	const candidates = sameHeading(wanted, DEFAULT_TRANSCRIPT_HEADING)
		? [wanted]
		: [wanted, DEFAULT_TRANSCRIPT_HEADING];

	for (const name of candidates) {
		const idx = headings.findIndex((h) => sameHeading(h.heading, name));
		if (idx === -1) continue;
		const heading = headings[idx];
		const next = headings.slice(idx + 1).find((h) => h.level <= heading.level);
		return {
			start: heading.position.end.offset,
			end: next ? next.position.start.offset : content.length,
		};
	}
	return null;
}

const TIME = String.raw`\d{1,2}(?::\d{1,2}){1,2}(?:\.\d{1,3})?`;
const SECONDS = String.raw`\d+(?:\.\d+)?`;
const COMPACT_CUE_LINE = new RegExp(
	String.raw`^\s*\[(${TIME})\]\(([^)\s]*)\s+"(${SECONDS})\s*[–-]\s*(${SECONDS})"\)\s?(.*)$`
);
const CUE_LINE = new RegExp(
	String.raw`^\s*\[(${TIME})\s*(?:→|->|-->)\s*(${TIME})\]\(([^)\s]*)\)\s?(.*)$`
);
const TIMESTAMP_LINE = new RegExp(String.raw`^\s*\[(${TIME})\]\(([^)\s]*)\)\s*(.*)$`);

/** Parse `[h:]mm:ss[.mmm]` into seconds; returns NaN for malformed input. */
export function parseTimestamp(stamp: string): number {
	const raw = stamp.split(":");
	if (raw.some((p) => !/^\d+(?:\.\d+)?$/.test(p))) return Number.NaN;
	return raw.map(Number).reduce((total, part) => total * 60 + part, 0);
}

/**
 * Parse the stored transcript section into timestamped lines. Three line
 * formats are recognised: compact per-cue lines whose link title holds the
 * exact start and end seconds (`[m:ss](url "1.23–4.56") text`), the earlier
 * per-cue lines (`[mm:ss.mmm → mm:ss.mmm](url) text`), both with
 * backslash-escaped text, and block lines with only a start time
 * (`[mm:ss](url) text`). Text lines that do
 * not start with a timestamp link (for example wrapped or hand-edited lines)
 * are appended to the preceding timestamped line.
 */
export function parseStoredTranscript(section: string): StoredTranscriptLine[] {
	const lines: StoredTranscriptLine[] = [];
	for (const raw of section.split(/\r?\n/)) {
		if (!raw.trim()) continue;
		const compact = raw.match(COMPACT_CUE_LINE);
		if (compact) {
			const startSec = Number(compact[3]);
			const endSec = Number(compact[4]);
			lines.push({ startSec, endSec, url: compact[2], text: unescapeCueText(compact[5].trim()) });
			continue;
		}
		const cue = raw.match(CUE_LINE);
		if (cue) {
			const startSec = parseTimestamp(cue[1]);
			const endSec = parseTimestamp(cue[2]);
			if (!Number.isNaN(startSec) && !Number.isNaN(endSec)) {
				lines.push({ startSec, endSec, url: cue[3], text: unescapeCueText(cue[4].trim()) });
				continue;
			}
		}
		const match = raw.match(TIMESTAMP_LINE);
		if (match) {
			const startSec = parseTimestamp(match[1]);
			if (!Number.isNaN(startSec)) {
				lines.push({ startSec, url: match[2], text: match[3].trim() });
				continue;
			}
		}
		const previous = lines[lines.length - 1];
		if (previous) {
			previous.text = previous.text ? `${previous.text} ${raw.trim()}` : raw.trim();
		}
	}
	return lines;
}

export type StoredTranscriptCue = StoredTranscriptLine & TranscriptCue;

/**
 * Turn stored lines into cues for paragraph grouping. Per-cue lines keep their
 * stored end time. Block lines only have a start time, so each ends where the
 * next begins; the last one gets the average line length.
 */
export function storedLinesToCues(lines: StoredTranscriptLine[]): StoredTranscriptCue[] {
	const sorted = [...lines].sort((a, b) => a.startSec - b.startSec);
	const n = sorted.length;
	const averageSec = n > 1 ? (sorted[n - 1].startSec - sorted[0].startSec) / (n - 1) : 0;
	return sorted.map((line, i) => ({
		...line,
		endSec:
			line.endSec ?? (i < n - 1 ? sorted[i + 1].startSec : line.startSec + averageSec),
	}));
}
