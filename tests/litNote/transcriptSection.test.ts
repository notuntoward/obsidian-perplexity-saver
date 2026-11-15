import { describe, expect, it } from "vitest";
import type { HeadingCache } from "obsidian";
import {
	DEFAULT_TRANSCRIPT_HEADING,
	findTranscriptCandidates,
	findTranscriptRange,
	findTranscriptSection,
	headingsFromText,
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
import { prepareTranscript } from "../../src/litNote/transcriptSentences";

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
	it("keeps compact word offsets out of the caption text and ignores its fingerprint comment", () => {
		const lines = parseStoredTranscript(
			'[0:12](https://youtu.be/abcdefghijk?t=12 "12-14; w=0,200,900,1100") We left. We stayed.\n' +
			"<!-- saver-word-timing:1 " + "a".repeat(64) + " -->"
		);
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("We left. We stayed.");
		expect(lines[0].startSec).toBe(12);
		expect(lines[0].endSec).toBe(14);
	});

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
	it("reads language annotations without including them in caption text or timing fingerprints", () => {
		const plain = '[0:00](https://youtu.be/abcdefghijk?t=0 "0-5") Bonjour. Au revoir.\n';
		const known = parseStoredTranscript("<!-- saver-transcript-language: fr-FR -->\n" + plain);
		expect(known[0].language).toBe("fr-FR");
		expect(known[0].text).toBe("Bonjour. Au revoir.");
		expect(prepareTranscript(known).hash).toBe(prepareTranscript(parseStoredTranscript(plain)).hash);
		const conflict = parseStoredTranscript(plain + "<!-- saver-transcript-language: en -->\n<!-- saver-transcript-language: fr -->");
		expect(conflict[0].language).toBeUndefined();
		expect(conflict[0].text).toBe(known[0].text);
		const invalid = parseStoredTranscript(plain + "<!-- saver-transcript-language: not a locale -->");
		expect(invalid[0].language).toBeUndefined();
		expect(invalid[0].text).toBe(known[0].text);
	});

	it("groups intact caption cues when punctuation supplies no sentence boundaries", () => {
		const cues = Array.from({ length: 30 }, (_, i) => ({
			startSec: i * 2, url: `https://youtu.be/abcdefghijk?t=${i * 2}`, text: "bonjour tout le monde sans ponctuation",
			language: "fr",
		}));
		const rows = transcriptRows(cues, "readable-paragraphs");
		expect(rows).toHaveLength(cues.length);
		expect(rows.filter((row) => row.paragraphStart).length).toBeGreaterThan(1);
		expect(rows.map(({ text, startSec, url }) => ({ text, startSec, url }))).toEqual(cues.map(({ language: _language, ...cue }) => cue));
	});

	const lines = Array.from({ length: 10 }, (_, i) => ({
		startSec: i * 12,
		url: `${URL}&t=${i * 12}`,
		text: i === 4 ? `sentence ${i}.` : `words ${i}`,
	}));

	it("preserves stored lines and includes source offsets in lines mode", () => {
		const starts = [0, 8, 16, 24, 32, 44, 52, 60, 68, 76];
		expect(transcriptRows(lines, "lines")).toEqual(lines.map((line, i) => ({ ...line, sourceStart: starts[i] })));
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

describe("a transcript under a heading that is no longer configured", () => {
	const cue = (i: number): string => `[0:0${i}](https://youtu.be/dQw4w9WgXcQ?t=${i} "${i}–${i + 1}") caption ${i}`;
	const cues = (n: number): string => Array.from({ length: n }, (_, i) => cue(i)).join("\n");
	const section = (content: string, name = "Subtitles"): string | null => findTranscriptSection(content, headingsOf(content), name);

	it("is found by its content when it is the only candidate", () => {
		expect(section(`Intro\n\n# Old captions\n\n${cues(5)}\n\n# Notes\nmine\n`)).toBe(cues(5));
	});

	it("is found with just one cue line when it carries Saver's own comments", () => {
		const body = `<!-- saver-transcript-language: en -->\n${cue(1)}`;
		expect(section(`# Whatever\n${body}\n`)).toBe(body);
	});

	it("is not guessed when several sections look like transcripts", () => {
		expect(section(`# One\n${cues(6)}\n# Two\n${cues(6)}\n`)).toBeNull();
		expect(findTranscriptCandidates(`# One\n${cues(6)}\n# Two\n${cues(6)}\n`, headingsOf(`# One\n${cues(6)}\n# Two\n${cues(6)}\n`)).map((c) => c.heading.heading)).toEqual(["One", "Two"]);
	});

	it("is not mistaken for hand-made timestamp notes", () => {
		const list = Array.from({ length: 8 }, (_, i) => `- [0:0${i}](https://youtu.be/dQw4w9WgXcQ?t=${i}): point ${i}`).join("\n");
		expect(section(`# Notes\n${list}\n`)).toBeNull();
		expect(section(`# Notes\n${cues(4)}\n`)).toBeNull();
		expect(section(`# Notes\n${cues(6).replace(/youtu\.be/g, "example.com")}\n`)).toBeNull();
		expect(section(`# Notes\n${cues(5)}\n${Array.from({ length: 6 }, () => "prose").join("\n")}\n`)).toBeNull();
	});

	it("is attributed to the child heading, not to a parent that contains it", () => {
		const content = `# Video\nabout it\n## Old captions\n${cues(5)}\n`;
		expect(findTranscriptCandidates(content, headingsOf(content)).map((c) => c.heading.heading)).toEqual(["Old captions"]);
		expect(section(content)).toBe(cues(5));
	});

	it("never overrides a heading that matches by name", () => {
		expect(section(`# Subtitles\n${cue(1)}\n# Old\n${cues(6)}\n`)).toBe(cue(1));
	});
});

describe("headingsFromText", () => {
	it("lists ATX headings with editor positions and skips front matter and fenced code", () => {
		const content = "---\ntitle: x\n# not a heading\n---\n# Real\n```\n# in code\n```\ntext\n## Child ##\n";
		const headings = headingsFromText(content);
		expect(headings.map((h) => [h.heading, h.level, h.position.start.line])).toEqual([["Real", 1, 4], ["Child", 2, 9]]);
		expect(content.slice(headings[0].position.start.offset, headings[0].position.end.offset)).toBe("# Real");
	});
});
