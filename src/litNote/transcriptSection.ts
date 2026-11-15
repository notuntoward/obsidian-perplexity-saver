/**
 * Locating and parsing the stored YouTube transcript inside a literature note.
 *
 * The transcript is written by `buildLitNoteBody` under a level-1 heading whose
 * text is the `transcriptHeading` setting, one line per caption cue:
 *   [m:ss](https://youtu.be/ID?t=SECONDS "START–END") caption text
 * Optional word timings append `; w=...` to that title, with one version/hash
 * comment for the section. A start-only title keeps legacy block text escaping.
 * Legacy block notes contain only whole-second starts:
 *   [mm:ss](https://youtube.com/watch?v=ID&t=SECONDS) caption text ...
 * Notes written by earlier versions may use per-cue lines of the form
 *   [mm:ss.mmm → mm:ss.mmm](https://youtube.com/watch?v=ID&t=SECONDS) caption text
 */

import type { HeadingCache } from "obsidian";
import type { TranscriptCue } from "./transcriptParagraphs";
import { unescapeCueText } from "./youtubeTranscript";
import { resolveTranscriptLanguage, TRANSCRIPT_LANGUAGE_PREFIX } from "./transcriptLanguage";

export const DEFAULT_TRANSCRIPT_HEADING = "Transcript";

export interface StoredTranscriptLine {
	/** Start time in seconds. */
	startSec: number;
	/** End time in seconds; only per-cue lines store one. */
	endSec?: number;
	/** Link target of the timestamp (may be empty when the line had none). */
	url: string;
	text: string;
	wordTimings?: string;
	timingMarker?: string;
	language?: string;
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

export { sameHeading as sameTranscriptHeading };

/** Heading geometry shared by Obsidian's metadata cache and the editor's syntax tree. */
export interface HeadingSpan {
	level: number;
	/** Offset of the heading's first character. */
	start: number;
	/** Offset just past the heading line. */
	end: number;
}

export interface DetectedTranscript {
	/** Index into the heading list it was detected from. */
	index: number;
	/** The section body, ending like a named transcript section: at the next heading of the same or higher level. */
	range: { start: number; end: number };
	cueLines: number;
}

function headingSpans(headings: HeadingCache[]): HeadingSpan[] {
	return headings.map((h) => ({ level: h.level, start: h.position.start.offset, end: h.position.end.offset }));
}

function sectionRange(spans: HeadingSpan[], index: number, contentLength: number): { start: number; end: number } {
	const heading = spans[index];
	const next = spans.slice(index + 1).find((h) => h.level <= heading.level);
	return { start: heading.end, end: next ? next.start : contentLength };
}

/**
 * Return the text under the transcript heading (up to the next heading of the
 * same or higher level), or null when the note has no such heading. Notes
 * created before the heading name was changed still use the default name, so
 * that name is used as a fallback. Failing that, a single section that is
 * recognizably a stored transcript is used, whatever its heading says.
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
	// More than one candidate is ambiguous, so none is chosen silently.
	const detected = detectTranscriptSections(content, headingSpans(headings));
	return detected.length === 1 ? detected[0].range : null;
}

/** Headings whose section looks like a stored transcript, for notes whose heading name is no longer configured. */
export function findTranscriptCandidates(
	content: string,
	headings: HeadingCache[] | undefined
): { heading: HeadingCache; cueLines: number }[] {
	if (!headings?.length) return [];
	return detectTranscriptSections(content, headingSpans(headings))
		.map((found) => ({ heading: headings[found.index], cueLines: found.cueLines }));
}

const TIME = String.raw`\d{1,2}(?::\d{1,2}){1,2}(?:\.\d{1,3})?`;
const SECONDS = String.raw`\d+(?:\.\d+)?`;
const COMPACT_CUE_LINE = new RegExp(
	String.raw`^\s*\[(${TIME})\]\(([^)\s]*)\s+"(${SECONDS})(?:\s*[–-]\s*(${SECONDS}))?(?:;\s*w=([^"]*))?"\)\s?(.*)$`
);
const CUE_LINE = new RegExp(
	String.raw`^\s*\[(${TIME})\s*(?:→|->|-->)\s*(${TIME})\]\(([^)\s]*)\)\s?(.*)$`
);
const TIMESTAMP_LINE = new RegExp(String.raw`^\s*\[(${TIME})\]\(([^)\s]*)\)\s*(.*)$`);

/** A stored cue line that links into YouTube, so a hand-made timestamp list is not mistaken for a transcript. */
function youtubeCueLine(raw: string): boolean {
	const url = raw.match(COMPACT_CUE_LINE)?.[2] ?? raw.match(CUE_LINE)?.[3] ?? raw.match(TIMESTAMP_LINE)?.[2];
	return !!url && /youtu\.?be/i.test(url);
}

const MIN_UNMARKED_CUES = 5;
const MIN_CUE_SHARE = 0.5;

/**
 * Find sections that are recognizably a stored transcript by their content: Saver's own timing or language
 * comments with at least one YouTube cue line, or mostly YouTube cue lines (at least five). Only a section's own
 * lines count, up to the next heading of any level, so a parent heading does not duplicate its child.
 */
export function detectTranscriptSections(content: string, spans: HeadingSpan[]): DetectedTranscript[] {
	const found: DetectedTranscript[] = [];
	// Cheap exit for the vast majority of notes, which this runs on for every edit.
	if (!/youtu\.?be/i.test(content)) return found;
	spans.forEach((span, index) => {
		const body = content.slice(span.end, spans[index + 1]?.start ?? content.length);
		let cues = 0;
		let lines = 0;
		let marked = false;
		for (const raw of body.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) continue;
			if (line.startsWith(TRANSCRIPT_LANGUAGE_PREFIX) || line.startsWith("<!-- saver-word-timing:")) {
				marked = true;
				continue;
			}
			lines++;
			if (youtubeCueLine(raw)) cues++;
		}
		const qualifies = marked ? cues >= 1 : cues >= MIN_UNMARKED_CUES && cues / lines >= MIN_CUE_SHARE;
		if (qualifies) found.push({ index, range: sectionRange(spans, index, content.length), cueLines: cues });
	});
	return found;
}

/**
 * Headings of a note as Obsidian's metadata cache would list them, for text that is not in the cache (an editor
 * buffer). Only ATX headings are recognized, and fenced code and front matter are skipped.
 */
export function headingsFromText(content: string): HeadingCache[] {
	const headings: HeadingCache[] = [];
	const lines = content.split("\n");
	let offset = 0;
	let fence: string | null = null;
	let frontmatter = lines[0]?.trim() === "---";
	lines.forEach((line, lineNo) => {
		const trimmed = line.replace(/\r$/, "");
		const start = offset;
		offset += line.length + 1;
		if (frontmatter) {
			if (lineNo > 0 && /^(---|\.\.\.)\s*$/.test(trimmed)) frontmatter = false;
			return;
		}
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(trimmed)?.[1];
		if (marker) {
			if (fence === null) fence = marker[0];
			else if (marker[0] === fence) fence = null;
			return;
		}
		if (fence !== null) return;
		const match = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(trimmed);
		if (!match) return;
		headings.push({
			heading: match[2].trim(),
			level: match[1].length,
			position: {
				start: { line: lineNo, col: 0, offset: start },
				end: { line: lineNo, col: trimmed.length, offset: start + trimmed.length },
			},
		});
	});
	return headings;
}

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
	const markers: string[] = [];
	const languages: unknown[] = [];
	for (const raw of section.split(/\r?\n/)) {
		if (!raw.trim()) continue;
		if (raw.trim().startsWith(TRANSCRIPT_LANGUAGE_PREFIX)) {
			languages.push(raw.trim().match(/^<!-- saver-transcript-language:\s*(.*?)\s*-->$/)?.[1]);
			continue;
		}
		if (raw.trim().startsWith("<!-- saver-word-timing:")) {
			markers.push(raw.trim());
			continue;
		}
		const compact = raw.match(COMPACT_CUE_LINE);
		if (compact) {
			const startSec = Number(compact[3]);
			lines.push({
				startSec, url: compact[2],
				...(compact[4] === undefined ? {} : { endSec: Number(compact[4]) }),
				...(compact[5] === undefined ? {} : { wordTimings: compact[5] }),
				text: compact[4] === undefined ? compact[6].trim() : unescapeCueText(compact[6].trim()),
			});
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
	const language = resolveTranscriptLanguage(languages);
	return markers.length || language ? lines.map((line) => ({
		...line,
		...(markers.length ? { timingMarker: markers.join("\n") } : {}),
		...(language ? { language } : {}),
	})) : lines;
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
