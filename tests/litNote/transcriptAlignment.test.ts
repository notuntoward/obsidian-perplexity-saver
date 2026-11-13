import { describe, expect, it } from "vitest";
import { prepareTranscript, sentenceRows } from "../../src/litNote/transcriptSentences";
import { alignedSentenceRows, readAlignmentCache, type AlignmentCache } from "../../src/litNote/transcriptAlignment";

const transcript = prepareTranscript([{
	startSec: 21, endSec: 30, url: "https://youtu.be/abcdefghijk?t=21", text: "We left. We stayed.",
}]);

export function cacheForTest(): AlignmentCache {
	return {
		version: 2, sourceHash: transcript.hash, videoId: "abcdefghijk",
		engine: "whisperx-3.8.6", model: "WAV2VEC2_ASR_BASE_960H", paddingSeconds: 0,
		createdAt: "2026-11-13T00:00:00Z", audioSha256: "a".repeat(64), audioDuration: 100,
		captionSha256: "b".repeat(64), captions: [{ first: 0, last: 4, start: 21, end: 30 }],
		wordSources: ["caption", "acoustic", "acoustic", "acoustic"],
		words: [[21, null, null], [21.4, 22, 0.9], [25, 25.3, 0.8], [25.4, 26, 0.8]],
	};
}

describe("acoustically aligned punctuation sentences", () => {
	it("changes timing, not sentence text or source position, including timestamp links", () => {
		const baseline = sentenceRows(transcript);
		const rows = alignedSentenceRows(transcript, cacheForTest());
		expect(rows.map((r) => r.text)).toEqual(baseline.map((r) => r.text));
		expect(rows.map((r) => r.sourceStart)).toEqual(baseline.map((r) => r.sourceStart));
		expect(rows.map((r) => [r.startSec, r.endSec])).toEqual([[21, 22], [25, 26]]);
		expect(new URL(rows[1].url).searchParams.get("t")).toBe("25");
		expect(rows.every((row) => !row.timingUncertain)).toBe(true);
	});

	it("reuses matching results and rejects edited text, another video, corrupt or non-monotonic timings", () => {
		const cache = cacheForTest();
		expect(readAlignmentCache(JSON.parse(JSON.stringify(cache)), transcript)).toEqual(cache);
		expect(readAlignmentCache(cache, prepareTranscript([{ ...transcript.lines[0], text: "Edited." }]))).toBeNull();
		expect(() => readAlignmentCache({ ...cache, videoId: "otherxxxxxx" }, transcript)).toThrow("video");
		expect(() => readAlignmentCache({ ...cache, words: [[1, 2, 0.9]] }, transcript)).toThrow("word");
		expect(() => readAlignmentCache({ ...cache, words: [[21, null, null], [5, 6, 0.9], [25, 25.3, 0.8], [25.4, 26, 0.8]] }, transcript)).toThrow(/word/i);
		expect(readAlignmentCache({ ...cache, version: 1, paddingSeconds: 40 }, transcript)).toBeNull();
	});

	it("explicitly marks unsupported words and estimates without breaking playback row order", () => {
		const cache = cacheForTest();
		cache.words[2] = null;
		cache.wordSources[2] = "unmatched";
		const rows = alignedSentenceRows(transcript, cache);
		expect(rows[1].timingUncertain).toBe(true);
		expect(rows[1].startSec).toBe(25.4);
		cache.words[3] = null;
		cache.wordSources[3] = "unmatched";
		const unaligned = alignedSentenceRows(transcript, cache);
		expect(unaligned[1].timingUncertain).toBe(true);
		expect(unaligned[1].startSec).toBeGreaterThanOrEqual(unaligned[0].endSec!);
	});

	it("accepts native starts without pretending they have acoustic ends or confidence scores", () => {
		const native: AlignmentCache = {
			...cacheForTest(), engine: "youtube-json3", model: null, audioSha256: null,
			wordSources: ["caption", "youtube", "youtube", "youtube"],
			words: [[21, null, null], [21.4, null, null], [25, null, null], [25.4, null, null]],
		};
		const rows = alignedSentenceRows(transcript, native);
		expect(rows.map((row) => row.startSec)).toEqual([21, 25]);
		expect(rows.every((row) => row.endSec === undefined && !row.timingUncertain)).toBe(true);
		expect(() => readAlignmentCache({ ...native, words: [[22, null, null], ...native.words.slice(1)] }, transcript)).toThrow("anchor");
		expect(() => readAlignmentCache({ ...native, words: [...native.words.slice(0, 3), [31, null, null]] }, transcript)).toThrow("anchor");
	});

	it("does not mark precise sentence starts approximate when only internal word timings are missing", () => {
		const native: AlignmentCache = {
			...cacheForTest(), engine: "youtube-json3", model: null, audioSha256: null,
			wordSources: ["caption", "unmatched", "youtube", "unmatched"],
			words: [[21, null, null], null, [25, null, null], null],
		};
		const cache = readAlignmentCache(native, transcript)!;
		const rows = alignedSentenceRows(transcript, cache);
		expect(rows.map((row) => row.startSec)).toEqual([21, 25]);
		expect(rows.map((row) => row.timingUncertain)).toEqual([false, false]);
		expect(rows.map((row) => row.text)).toEqual(["We left.", "We stayed."]);
	});

	it("allows native starts tied at the next caption boundary but not acoustic spans across it", () => {
		const prepared = prepareTranscript([...transcript.lines, {
			startSec: 30, endSec: 31, url: "https://youtu.be/abcdefghijk?t=30", text: "Next.",
		}]);
		const native: AlignmentCache = {
			...cacheForTest(), sourceHash: prepared.hash, engine: "youtube-json3", model: null, audioSha256: null,
			captions: [{ first: 0, last: 4, start: 21, end: 30 }, { first: 4, last: 5, start: 30, end: 31 }],
			wordSources: ["caption", "youtube", "youtube", "youtube", "caption"],
			words: [[21, null, null], [21.4, null, null], [25, null, null], [30, null, null], [30, null, null]],
		};
		expect(readAlignmentCache(native, prepared)?.words).toEqual(native.words);
		const acoustic: AlignmentCache = {
			...native, engine: "whisperx-3.8.6", model: "WAV2VEC2_ASR_BASE_960H", audioSha256: "a".repeat(64),
			wordSources: ["caption", "youtube", "youtube", "acoustic", "caption"],
			words: [...native.words.slice(0, 3), [30, 30.1, 0.9], native.words[4]],
		};
		expect(() => readAlignmentCache(acoustic, prepared)).toThrow("anchor");
	});
});
