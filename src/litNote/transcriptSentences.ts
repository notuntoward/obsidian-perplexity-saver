/// <reference lib="es2022.intl" />
import { createHash } from "crypto";
import { joinCueTexts, needsSpaceBetween } from "./transcriptParagraphs";
import type { StoredTranscriptLine } from "./transcriptSection";
import { resolveTranscriptLanguage } from "./transcriptLanguage";

interface TranscriptWord {
	text: string;
	start: number;
	end: number;
	cue: number;
}

export interface PreparedTranscript {
	text: string;
	words: TranscriptWord[];
	lines: StoredTranscriptLine[];
	cueStarts: number[];
	hash: string;
	language?: string;
}

export interface BoundaryRow {
	startSec: number;
	url: string;
	text: string;
	sourceStart: number;
}

export function prepareTranscript(lines: StoredTranscriptLine[]): PreparedTranscript {
	const sorted = [...lines].sort((a, b) => a.startSec - b.startSec);
	const text = joinCueTexts(sorted.map((line) => line.text));
	const starts: number[] = [];
	let offset = 0;
	for (let i = 0; i < sorted.length; i++) {
		starts.push(offset);
		offset += sorted[i].text.length;
		if (i + 1 < sorted.length && needsSpaceBetween(sorted[i].text, sorted[i + 1].text)) offset++;
	}
	let cue = 0;
	const words = Array.from(text.matchAll(/\S+/g), (match) => {
		const start = match.index;
		while (cue + 1 < starts.length && starts[cue + 1] <= start) cue++;
		return { text: match[0], start, end: start + match[0].length, cue };
	});
	const source = sorted.map(({ startSec, endSec, url, text }) => ({ startSec, endSec, url, text }));
	return {
		text, words, lines: sorted, cueStarts: starts,
		hash: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
		language: resolveTranscriptLanguage(sorted.map((line) => line.language)),
	};
}

export function sentenceRows(transcript: PreparedTranscript): BoundaryRow[] {
	if (!transcript.words.length) return [];
	const segmenter = new Intl.Segmenter(transcript.language, { granularity: "sentence" });
	const rows: BoundaryRow[] = [];
	let cue = 0;
	for (const part of segmenter.segment(transcript.text)) {
		const text = part.segment.trim();
		if (!text) continue;
		const sourceStart = part.index + part.segment.indexOf(text);
		while (cue + 1 < transcript.cueStarts.length && transcript.cueStarts[cue + 1] <= sourceStart) cue++;
		const line = transcript.lines[cue];
		rows.push({
			startSec: line.startSec, url: line.url,
			text, sourceStart,
		});
	}
	return rows;
}
