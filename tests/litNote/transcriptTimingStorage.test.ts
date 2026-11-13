import { describe, expect, it } from "vitest";
import { parseStoredTranscript } from "../../src/litNote/transcriptSection";
import { prepareTranscript } from "../../src/litNote/transcriptSentences";
import { alignedSentenceRows, type WordTimings } from "../../src/litNote/transcriptAlignment";
import { readInlineTimings, writeInlineTimings } from "../../src/litNote/transcriptTimingStorage";

const section = '\n[0:21](https://youtu.be/abcdefghijk?t=21 "21-30") We left. We stayed.\n\n';

function cacheForTest(): WordTimings {
	return {
		sourceHash: prepareTranscript(parseStoredTranscript(section)).hash, videoId: "abcdefghijk",
		wordSources: ["caption", "acoustic", "acoustic", "acoustic"],
		words: [[21, null, null], [21.4, 22, 0.9], [25, 25.3, 0.8], [25.4, 26, 0.8]],
	};
}

describe("compact word timings in existing transcript links", () => {
	it("round-trips starts, acoustic ends/scores and uncertainty without changing source identity or sentence rows", () => {
		const transcript = prepareTranscript(parseStoredTranscript(section));
		const cache = cacheForTest();
		cache.words[3] = null;
		cache.wordSources[3] = "unmatched";
		const compact = writeInlineTimings(section, cache);
		expect(compact).toContain('; w=0,a400:1000:0.9,a4000:4300:0.8,?") We left. We stayed.');
		expect(compact.split("\n")).toHaveLength(section.split("\n").length + 1);
		const reopened = prepareTranscript(parseStoredTranscript(compact));
		expect(reopened.hash).toBe(transcript.hash);
		expect(reopened.text).toBe(transcript.text);
		const saved = readInlineTimings(reopened)!;
		expect(saved.words).toEqual(cache.words);
		expect(alignedSentenceRows(reopened, saved)).toEqual(alignedSentenceRows(transcript, cache));
		expect(writeInlineTimings(compact, saved)).toBe(compact);
	});

	it("stores native times as only relative millisecond numbers, with no synthetic end or score", () => {
		const cache = cacheForTest();
		cache.words = cache.words.map((word) => word && [word[0], null, null]);
		cache.wordSources = ["caption", "youtube", "youtube", "youtube"];
		const compact = writeInlineTimings(section, cache);
		expect(compact).toContain('; w=0,400,4000,4400")');
		const saved = readInlineTimings(prepareTranscript(parseStoredTranscript(compact)))!;
		expect(saved.words).toEqual(cache.words);
		expect(saved.wordSources).toEqual(["youtube", "youtube", "youtube", "youtube"]);
	});

	it("preserves old grouped captions, wrapped text, blank lines, source order and Markdown escapes", () => {
		const old = "\n[00:30](https://youtu.be/abcdefghijk?t=30) Next.\n\n[00:21](https://youtu.be/abcdefghijk?t=21) We left.\nWe stayed.\n";
		const transcript = prepareTranscript(parseStoredTranscript(old));
		const cache = { ...cacheForTest(), sourceHash: transcript.hash,
			words: [...cacheForTest().words, [30, null, null] as [number, null, null]],
			wordSources: [...cacheForTest().wordSources, "youtube" as const] };
		const compact = writeInlineTimings(old, cache);
		expect(compact).toContain('") We left.\nWe stayed.\n');
		expect(compact.indexOf("Next.")).toBeLessThan(compact.indexOf("We left."));
		expect(prepareTranscript(parseStoredTranscript(compact)).hash).toBe(transcript.hash);
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(compact)))?.words).toEqual(cache.words);
		const escaped = '\n[0:21](https://youtu.be/abcdefghijk?t=21 "21-30") We \\[left\\]. We stayed.\n';
		const prepared = prepareTranscript(parseStoredTranscript(escaped));
		const encoded = writeInlineTimings(escaped, { ...cacheForTest(), sourceHash: prepared.hash });
		expect(encoded).toContain("We \\[left\\].");
		expect(prepareTranscript(parseStoredTranscript(encoded)).hash).toBe(prepared.hash);
	});

	it("rejects stale, incomplete, unversioned, non-monotonic and out-of-cue data", () => {
		const compact = writeInlineTimings(section, cacheForTest());
		const read = (text: string) => readInlineTimings(prepareTranscript(parseStoredTranscript(text)));
		expect(read(compact.replace("We stayed.", "We edited."))).toBeNull();
		expect(() => read(compact.replace("a400:1000:0.9,", ""))).toThrow(/word count/i);
		expect(() => read(compact.replace(/<!--.*-->\n/, ""))).toThrow(/fingerprint/i);
		expect(() => read(compact.replace("a4000:4300:0.8", "a100:300:0.8"))).toThrow(/timing/i);
		expect(() => read(compact.replace("a4000:4300:0.8", "a10000:10300:0.8"))).toThrow(/timing/i);
		expect(() => read(compact.replace("saver-word-timing:1", "saver-word-timing:99"))).toThrow(/version/i);
		expect(() => read(compact.replace("0,a400", "NaN,a400"))).toThrow(/timing/i);
		expect(read(section)).toBeNull();
	});

	it("does not mistake rounded legacy block timestamps for exact upper bounds", () => {
		const old = "\n[00:21](https://youtu.be/abcdefghijk?t=21) We left. We stayed.\n" +
			"[00:25](https://youtu.be/abcdefghijk?t=25) Next.\n";
		const transcript = prepareTranscript(parseStoredTranscript(old));
		const cache: WordTimings = {
			sourceHash: transcript.hash, videoId: "abcdefghijk",
			wordSources: transcript.words.map(() => "youtube"),
			words: [21.2, 21.4, 25, 25.4, 25.9].map((start) => [start, null, null]),
		};
		const compact = writeInlineTimings(old, cache);
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(compact)))?.words).toEqual(cache.words);
	});

	it("preserves an earlier accepted start relative to an approximate stored timestamp", () => {
		const cache = cacheForTest();
		cache.words[0] = [20.8, null, null];
		const compact = writeInlineTimings(section, cache);
		expect(compact).toContain("; w=-200,");
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(compact)))?.words).toEqual(cache.words);
	});

	it("does not round a valid acoustic end beyond a fractional caption bound", () => {
		const source = '\n[0:00](https://youtu.be/abcdefghijk?t=0 "0.1-0.3") We left.\n';
		const cache: WordTimings = {
			sourceHash: prepareTranscript(parseStoredTranscript(source)).hash, videoId: "abcdefghijk",
			wordSources: ["caption", "acoustic"], words: [[0.1, null, null], [0.15, 0.3, 0.9]],
		};
		const compact = writeInlineTimings(source, cache);
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(compact)))?.words).toEqual(cache.words);
	});

	it("round-trips native starts exactly at a cue end, but rejects acoustic spans crossing it", () => {
		const native = cacheForTest();
		native.words = native.words.map((word) => word && [word[0], null, null]);
		native.words[3] = [30, null, null];
		native.wordSources = ["caption", "youtube", "youtube", "youtube"];
		const compact = writeInlineTimings(section, native);
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(compact)))?.words).toEqual(native.words);
		expect(() => readInlineTimings(prepareTranscript(parseStoredTranscript(
			compact.replace("4000,9000", "4000,a9000:9100:0.9")
		)))).toThrow(/timing/i);
	});

	it("adds one metadata line and less than eight bytes per word for a lecture-sized native transcript", () => {
		const lines = Array.from({ length: 1902 }, (_, cue) => ({
			startSec: cue * 2 + 0.123, endSec: cue * 2 + 2.123,
			url: `https://youtu.be/abcdefghijk?t=${cue * 2}`,
			text: Array.from({ length: cue < 84 ? 5 : 6 }, () => "Word.").join(" "),
		}));
		const original = lines.map((line) => `[0:00](${line.url} "${line.startSec}-${line.endSec}") ${line.text}`).join("\n");
		const transcript = prepareTranscript(lines);
		const cache: WordTimings = {
			sourceHash: transcript.hash, videoId: "abcdefghijk",
			wordSources: transcript.words.map(() => "youtube"),
			words: lines.flatMap((line) => line.text.split(" ").map((_, i): [number, null, null] =>
				[line.startSec + i * 0.3, null, null])),
		};
		expect(cache.words).toHaveLength(11328);
		const compact = writeInlineTimings(original, cache);
		expect(compact.split("\n")).toHaveLength(1903);
		expect(compact.length - original.length).toBeLessThan(8 * cache.words.length);
		const reopened = readInlineTimings(prepareTranscript(parseStoredTranscript(compact)))!;
		expect(reopened.words).toHaveLength(cache.words.length);
		cache.words.forEach((word, i) => expect(reopened.words[i]?.[0]).toBeCloseTo(word![0], 6));
	});
});
