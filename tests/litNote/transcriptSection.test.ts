import { describe, expect, it } from "vitest";
import type { HeadingCache } from "obsidian";
import {
	DEFAULT_TRANSCRIPT_HEADING,
	findTranscriptRange,
	findTranscriptSection,
	normalizeTranscriptHeading,
	parseStoredTranscript,
	parseTimestamp,
	storedLinesToCues,
} from "../../src/litNote/transcriptSection";
import {
	escapeCueText,
	formatPreciseTimestamp,
	formatTranscript,
	formatTranscriptCues,
	type TranscriptLine,
} from "../../src/litNote/youtubeTranscript";
import { transcriptRows } from "../../src/litNote/transcriptView";

/** Build the HeadingCache Obsidian's metadata cache would produce. */
function headingsOf(content: string): HeadingCache[] {
	const headings: HeadingCache[] = [];
	let offset = 0;
	content.split("\n").forEach((line, lineNo) => {
		const m = line.match(/^(#{1,6})\s+(.*)$/);
		if (m) {
			headings.push({
				heading: m[2].trim(),
				level: m[1].length,
				position: {
					start: { line: lineNo, col: 0, offset },
					end: { line: lineNo, col: line.length, offset: offset + line.length },
				},
			});
		}
		offset += line.length + 1;
	});
	return headings;
}

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("normalizeTranscriptHeading", () => {
	it("strips heading markers and whitespace", () => {
		expect(normalizeTranscriptHeading("  ## Video transcript  ")).toBe("Video transcript");
	});

	it("falls back to the default for empty input", () => {
		expect(normalizeTranscriptHeading("")).toBe(DEFAULT_TRANSCRIPT_HEADING);
		expect(normalizeTranscriptHeading(" # ")).toBe(DEFAULT_TRANSCRIPT_HEADING);
		expect(normalizeTranscriptHeading(undefined)).toBe(DEFAULT_TRANSCRIPT_HEADING);
	});
});

describe("findTranscriptSection", () => {
	const note = [
		"> [!info]- links",
		"",
		"# Captions",
		"",
		"[00:00](u) one",
		"## Sub heading",
		"[00:05](u) two",
		"",
		"# Notes",
		"mine",
	].join("\n");

	it("returns the text under the configured heading up to the next same-level heading", () => {
		expect(findTranscriptSection(note, headingsOf(note), "Captions")).toBe(
			"[00:00](u) one\n## Sub heading\n[00:05](u) two"
		);
	});

	it("matches the heading name case-insensitively", () => {
		expect(findTranscriptSection(note, headingsOf(note), "captions")).not.toBeNull();
	});

	it("runs to the end of the note when no later heading closes it", () => {
		const content = "# Transcript\n\n[00:00](u) one\n[00:05](u) two\n";
		expect(findTranscriptSection(content, headingsOf(content), "Transcript")).toBe(
			"[00:00](u) one\n[00:05](u) two"
		);
	});

	it("falls back to the default heading for notes created before a rename", () => {
		const content = "# Transcript\n[00:00](u) one";
		expect(findTranscriptSection(content, headingsOf(content), "Captions")).toBe("[00:00](u) one");
	});

	it("returns null when there is no matching heading", () => {
		expect(findTranscriptSection(note, headingsOf(note), "Missing")).toBeNull();
		expect(findTranscriptSection("text", undefined, "Transcript")).toBeNull();
	});
});

describe("parseStoredTranscript", () => {
	it("round-trips the format written at note creation", () => {
		const section = formatTranscript(
			[
				{ text: "first", offset: 0, duration: 1000 },
				{ text: "second", offset: 65_400, duration: 1000 },
				{ text: "third", offset: 3_725_000, duration: 1000 },
			],
			URL,
			1
		);
		const lines = parseStoredTranscript(section);
		expect(lines.map((l) => [l.startSec, l.text])).toEqual([
			[0, "first"],
			[65, "second"],
			[3725, "third"],
		]);
		expect(lines[1].url).toBe(`${URL}&t=65`);
	});

	it("appends untimestamped lines to the previous line and skips leading junk", () => {
		const lines = parseStoredTranscript("intro text\n[00:10](u) start of\nwrapped text\n\n[00:20](u) next");
		expect(lines).toEqual([
			{ startSec: 10, url: "u", text: "start of wrapped text" },
			{ startSec: 20, url: "u", text: "next" },
		]);
	});

	it("parses timestamps", () => {
		expect(parseTimestamp("01:05")).toBe(65);
		expect(parseTimestamp("1:02:03")).toBe(3723);
		expect(parseTimestamp("aa:bb")).toBeNaN();
	});
});

describe("storedLinesToCues", () => {
	it("ends each cue at the next start and gives the last the average length", () => {
		const cues = storedLinesToCues([
			{ startSec: 0, url: "u", text: "a" },
			{ startSec: 10, url: "u", text: "b" },
			{ startSec: 20, url: "u", text: "c" },
		]);
		expect(cues.map((c) => [c.startSec, c.endSec])).toEqual([
			[0, 10],
			[10, 20],
			[20, 30],
		]);
	});
});

describe("transcriptRows", () => {
	const lines = Array.from({ length: 10 }, (_, i) => ({
		startSec: i * 12,
		url: `${URL}&t=${i * 12}`,
		text: i === 4 ? `sentence ${i}.` : `words ${i}`,
	}));

	it("shows stored lines unchanged in lines mode", () => {
		expect(transcriptRows(lines, "lines")).toEqual(lines);
	});

	it("groups lines into timestamped paragraphs in paragraphs mode", () => {
		const rows = transcriptRows(lines, "paragraphs");
		// Line 4 ends at 60s, exactly at the cap, so the first paragraph ends there.
		expect(rows.map((r) => r.startSec)).toEqual([0, 60]);
		expect(rows[0].text).toBe("words 0 words 1 words 2 words 3 sentence 4.");
		expect(rows[1].url).toBe(`${URL}&t=60`);
	});
});

describe("per-cue transcript format", () => {
	const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
	const raw: TranscriptLine[] = [
		{ offset: 0, duration: 2345, text: "[Music]" },
		{ offset: 2001, duration: 4999, text: "50% of *bold* claims cost $5 #tag" },
		{ offset: 7500, duration: 1, text: "a\\b c_d `code` <b>x</b> a|b ~~s~~ ==h== ^id" },
		{ offset: 3_725_042, duration: 1_958, text: "over an hour in." },
	];

	it("formats millisecond start and end times", () => {
		expect(formatPreciseTimestamp(0)).toBe("00:00.000");
		expect(formatPreciseTimestamp(83_450)).toBe("01:23.450");
		expect(formatPreciseTimestamp(3_725_042)).toBe("01:02:05.042");
	});

	it("writes one short, escaped, timestamped line per cue with exact times in the link title", () => {
		const lines = formatTranscriptCues(raw, url).split("\n");
		expect(lines).toHaveLength(raw.length);
		expect(lines[0]).toBe('[0:00](https://youtu.be/dQw4w9WgXcQ?t=0 "0–2.345") \\[Music\\]');
		expect(lines[1]).toBe('[0:02](https://youtu.be/dQw4w9WgXcQ?t=2 "2.001–7") 50\\% of \\*bold\\* claims cost \\$5 \\#tag');
		expect(lines[3]).toBe('[1:02:05](https://youtu.be/dQw4w9WgXcQ?t=3725 "3725.042–3727") over an hour in.');
		expect(escapeCueText("plain words, no markup.")).toBe("plain words, no markup.");
	});

	it("round-trips every cue without loss", () => {
		const parsed = parseStoredTranscript(formatTranscriptCues(raw, url));
		expect(
			parsed.map((l) => ({
				offset: Math.round(l.startSec * 1000),
				duration: Math.round((l.endSec ?? Number.NaN) * 1000) - Math.round(l.startSec * 1000),
				text: l.text,
			}))
		).toEqual(raw);
		expect(parsed[0].url).toBe("https://youtu.be/dQw4w9WgXcQ?t=0");
	});

	it("still reads the earlier arrow cue format", () => {
		const old = [
			"[00:00.000 → 00:02.345](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0) \\[Music\\]",
			"[01:02:05.042 → 01:02:07.000](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3725) over an hour in.",
		].join("\n");
		const parsed = parseStoredTranscript(old);
		expect(parsed.map((l) => [l.startSec, l.endSec, l.text])).toEqual([
			[0, 2.345, "[Music]"],
			[3725.042, 3727, "over an hour in."],
		]);
	});

	it("keeps stored end times (including overlaps) when building cues", () => {
		const cues = storedLinesToCues(parseStoredTranscript(formatTranscriptCues(raw, url)));
		expect(cues[0].endSec).toBeCloseTo(2.345, 6);
		expect(cues[1].startSec).toBeCloseTo(2.001, 6);
		expect(cues[2].endSec).toBeCloseTo(7.501, 6);
	});

	it("parses fractional timestamps and rejects malformed ones", () => {
		expect(parseTimestamp("01:23.450")).toBeCloseTo(83.45, 6);
		expect(parseTimestamp("1:02:05.042")).toBeCloseTo(3725.042, 6);
		expect(parseTimestamp("1::05")).toBeNaN();
	});

	it("still reads the older block format", () => {
		const block = formatTranscript(raw.slice(0, 2), url, 5);
		const parsed = parseStoredTranscript(block);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].endSec).toBeUndefined();
		expect(parsed[0].text).toBe("[Music] 50% of *bold* claims cost $5 #tag");
	});
});

describe("findTranscriptRange", () => {
	it("spans the transcript body up to the next heading of the same or higher level", () => {
		const content = "# Note\nmine\n## Transcript\nline one\n### Sub\nline two\n## After\nmore\n";
		const range = findTranscriptRange(content, headingsOf(content), "Transcript");
		expect(range).not.toBeNull();
		expect(content.slice(range!.start, range!.end)).toBe("\nline one\n### Sub\nline two\n");
	});

	it("returns null without a transcript heading", () => {
		const content = "# Note\nmine\n";
		expect(findTranscriptRange(content, headingsOf(content), "Transcript")).toBeNull();
	});
});
