import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	isValidYouTubeUrl,
	extractYouTubeUrlFromText,
	getYouTubeUrlFromItem,
	extractYouTubeVideoId,
	buildTimestampUrl,
	formatTimestamp,
	parseCaptionJson3,
	getTranscriptBlocks,
	formatTranscript,
	downloadYouTubeTranscript,
	type TranscriptLine,
} from "../../src/litNote/youtubeTranscript";
import { requestUrlMock } from "../__mocks__/obsidian";
import { parseStoredTranscript } from "../../src/litNote/transcriptSection";
import { prepareTranscript } from "../../src/litNote/transcriptSentences";
import { readInlineTimings } from "../../src/litNote/transcriptTimingStorage";
import { alignedSentenceRows } from "../../src/litNote/transcriptAlignment";

describe("youtubeTranscript", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("URL validation and extraction", () => {
		it("identifies valid YouTube URLs", () => {
			expect(isValidYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
			expect(isValidYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
			expect(isValidYouTubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
			expect(isValidYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
			expect(isValidYouTubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(true);
			expect(isValidYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
			expect(isValidYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(true);
			expect(isValidYouTubeUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(true);
		});

		it("rejects non-YouTube or invalid URLs", () => {
			expect(isValidYouTubeUrl("https://vimeo.com/12345678")).toBe(false);
			expect(isValidYouTubeUrl("https://google.com")).toBe(false);
			expect(isValidYouTubeUrl("https://youtube.com/about")).toBe(false);
			expect(isValidYouTubeUrl("not-a-url")).toBe(false);
			expect(isValidYouTubeUrl(null)).toBe(false);
			expect(isValidYouTubeUrl(undefined)).toBe(false);
		});

		it("extracts YouTube URL from free text", () => {
			const text = "Check out this video: https://www.youtube.com/watch?v=dQw4w9WgXcQ for details.";
			expect(extractYouTubeUrlFromText(text)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
			expect(extractYouTubeUrlFromText("No link here")).toBeNull();
		});

		it("extracts YouTube URL from ZoteroItemPayload", () => {
			const itemWithUrl = {
				title: "Never Gonna Give You Up",
				citekey: "astley1987",
				url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			};
			expect(getYouTubeUrlFromItem(itemWithUrl)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

			const itemWithAttachment = {
				title: "Video with attachment",
				citekey: "video2024",
				attachments: [
					{ title: "Snapshot", path: "/path/to/snap.html" },
					{ title: "Link", url: "https://youtu.be/dQw4w9WgXcQ" },
				],
			};
			expect(getYouTubeUrlFromItem(itemWithAttachment)).toBe("https://youtu.be/dQw4w9WgXcQ");

			const nonYouTubeItem = {
				title: "Paper title",
				citekey: "paper2024",
				url: "https://doi.org/10.1234/5678",
			};
			expect(getYouTubeUrlFromItem(nonYouTubeItem)).toBeNull();
		});

		it("extracts YouTube video IDs", () => {
			expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
			expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe("dQw4w9WgXcQ");
			expect(extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
			expect(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
			expect(extractYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
			expect(extractYouTubeVideoId("https://example.com")).toBeNull();
		});
	});

	describe("Timestamp formatting and URLs", () => {
		it("formats timestamps into mm:ss or hh:mm:ss", () => {
			expect(formatTimestamp(0)).toBe("00:00");
			expect(formatTimestamp(5000)).toBe("00:05");
			expect(formatTimestamp(65000)).toBe("01:05");
			expect(formatTimestamp(3665000)).toBe("01:01:05");
			expect(formatTimestamp(-100)).toBe("00:00");
		});

		it("builds timestamp URLs correctly", () => {
			expect(buildTimestampUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 15000))
				.toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=15");
			expect(buildTimestampUrl("https://youtu.be/dQw4w9WgXcQ", 75000))
				.toBe("https://youtu.be/dQw4w9WgXcQ?t=75");
			expect(buildTimestampUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", 30000))
				.toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30");
		});
	});

	describe("native JSON3 captions", () => {
		it("preserves native starts, bounds and text without inventing multiword offsets", () => {
			const lines = parseCaptionJson3({ events: [
				{ tStartMs: 0, wpWinPosId: 1 },
				{ tStartMs: 70200, dDurationMs: 4000, segs: [
					{ utf8: "We left. " }, { utf8: "We stayed &amp; waited.", tOffsetMs: 2300 },
				] },
				{ tStartMs: 72500, dDurationMs: 2000, segs: [{ utf8: "Next." }] },
			] });
			expect(lines).toEqual([
				{ offset: 70200, duration: 2300, text: "We left. We stayed &amp; waited.", wordStarts: [70200, null, 72500, null, null, null] },
				{ offset: 72500, duration: 2000, text: "Next.", wordStarts: [72500] },
			]);
		});

		it.each([
			{ events: [{ tStartMs: -1, dDurationMs: 10, segs: [{ utf8: "No." }] }] },
			{ events: [{ tStartMs: 0, dDurationMs: 10, segs: [{ utf8: "No. " }, { utf8: "Overrun.", tOffsetMs: 11 }] }] },
			{ events: [{ tStartMs: 0, dDurationMs: 10, segs: [{ utf8: "A " }, { utf8: "B ", tOffsetMs: 8 }, { utf8: "C", tOffsetMs: 4 }] }] },
			{ events: [{ tStartMs: 0, dDurationMs: 10, segs: [{ utf8: 123 }] }] },
		])("rejects malformed, reversed or out-of-bound native data", (data) => {
			expect(() => parseCaptionJson3(data)).toThrow(/JSON3/);
		});
	});

	describe("Transcript block grouping and formatting", () => {
		const sampleLines: TranscriptLine[] = [
			{ text: "Line 1", offset: 0, duration: 2000 },
			{ text: "Line 2", offset: 2000, duration: 2000 },
			{ text: "Line 3", offset: 4000, duration: 2000 },
			{ text: "Line 4", offset: 6000, duration: 2000 },
			{ text: "Line 5", offset: 8000, duration: 2000 },
			{ text: "Line 6", offset: 10000, duration: 2000 },
		];

		it("groups transcript lines into blocks with timestampMod", () => {
			const blocks = getTranscriptBlocks(sampleLines, 3);
			expect(blocks).toHaveLength(2);
			expect(blocks[0].quote).toBe("Line 1 Line 2 Line 3");
			expect(blocks[0].quoteTimeOffset).toBe(0);
			expect(blocks[1].quote).toBe("Line 4 Line 5 Line 6");
			expect(blocks[1].quoteTimeOffset).toBe(6000);
		});

		it("formats transcript into clickable markdown timestamps", () => {
			const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
			const md = formatTranscript(sampleLines, url, 3);
			const lines = md.split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("[00:00](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0) Line 1 Line 2 Line 3");
			expect(lines[1]).toBe("[00:06](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=6) Line 4 Line 5 Line 6");
		});
	});

	describe("downloadYouTubeTranscript", () => {
		it("saves native sentence starts and leaves missing offsets explicitly approximate", async () => {
			requestUrlMock.mockResolvedValueOnce({ status: 200, json: { captions: { playerCaptionsTracklistRenderer: {
				captionTracks: [{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=test&fmt=srv3" }],
			} } }, text: "" }).mockResolvedValueOnce({ status: 200, text: JSON.stringify({ events: [
				{ tStartMs: 12000, dDurationMs: 10000, segs: [
					{ utf8: "We left. " }, { utf8: "We stayed. ", tOffsetMs: 4000 }, { utf8: "Then we returned." },
				] },
			] }) });
			const result = await downloadYouTubeTranscript("https://youtu.be/dQw4w9WgXcQ");
			const prepared = prepareTranscript(parseStoredTranscript(result!));
			const timing = readInlineTimings(prepared)!;
			const rows = alignedSentenceRows(prepared, timing);
			expect(rows.map((row) => row.text)).toEqual(["We left.", "We stayed.", "Then we returned."]);
			expect(rows.map((row) => row.startSec)).toEqual([12, 16, 16]);
			expect(rows.map((row) => row.timingUncertain)).toEqual([false, false, true]);
			expect(requestUrlMock).toHaveBeenCalledTimes(2);
		});

		it("successfully fetches and formats YouTube transcript", async () => {
			requestUrlMock.mockImplementation((opts: any) => {
				if (opts.url.includes("youtubei/v1/player")) {
					return Promise.resolve({
						status: 200,
						json: {
							playabilityStatus: { status: "OK" },
							captions: {
								playerCaptionsTracklistRenderer: {
									captionTracks: [
										{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=test" },
									],
								},
							},
						},
						text: "",
					});
				}
				if (opts.url.includes("api/timedtext")) {
					return Promise.resolve({
						status: 200,
						text: JSON.stringify({ events: [
							{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Hello" }] },
							{ tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: "World" }] },
						] }),
					});
				}
				return Promise.reject(new Error("Unknown URL"));
			});

			const result = await downloadYouTubeTranscript("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
			const prepared = prepareTranscript(parseStoredTranscript(result!));
			expect(prepared.lines.map(({ text, startSec, endSec }) => ({ text, startSec, endSec }))).toEqual([
				{ text: "Hello", startSec: 0, endSec: 2 }, { text: "World", startSec: 2, endSec: 4 },
			]);
			expect(prepared.language).toBe("en");
			expect(readInlineTimings(prepared)?.words).toEqual([[0, null, null], [2, null, null]]);
			expect(requestUrlMock.mock.calls.filter(([opts]) => typeof opts !== "string" && opts.url.includes("timedtext"))
				.every(([opts]) => typeof opts !== "string" && new URL(opts.url).searchParams.get("fmt") === "json3")).toBe(true);

			const obsoleteOptions = {
				format: "blocks",
				timestampMod: 5,
				lang: "en",
			} as const;
			const formerlyLossy = await downloadYouTubeTranscript("https://www.youtube.com/watch?v=dQw4w9WgXcQ", obsoleteOptions);
			const retained = prepareTranscript(parseStoredTranscript(formerlyLossy!));
			expect(retained.lines.map(({ startSec, endSec }) => ({ startSec, endSec })))
				.toEqual([{ startSec: 0, endSec: 2 }, { startSec: 2, endSec: 4 }]);
			expect(readInlineTimings(retained)?.words).toEqual([[0, null, null], [2, null, null]]);
		});

		it.each([
			["fr", "", "fr"],
			["fr", "&tlang=en-US", "en-US"],
			[undefined, "", undefined],
		])("stores the selected track/output language, not the requested English preference (%s, %s)", async (languageCode, translation, expected) => {
			requestUrlMock.mockResolvedValueOnce({
				status: 200, text: "", json: { captions: { playerCaptionsTracklistRenderer: {
					captionTracks: [{ languageCode, baseUrl: "https://www.youtube.com/api/timedtext?v=test" + translation }],
				} } },
			}).mockResolvedValueOnce({ status: 200, text: JSON.stringify({ events: [
				{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Bonjour." }] },
			] }) });
			const result = await downloadYouTubeTranscript("https://youtu.be/dQw4w9WgXcQ");
			if (expected) expect(result).toContain(`<!-- saver-transcript-language: ${expected} -->`);
			else expect(result).not.toContain("saver-transcript-language");
		});

		it("returns null when video has no captions", async () => {
			requestUrlMock.mockResolvedValueOnce({
				status: 200,
				json: {
					playabilityStatus: { status: "OK" },
					captions: undefined,
				},
				text: "",
			});

			const result = await downloadYouTubeTranscript("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
			expect(result).toBeNull();
		});

		it("returns null when video is unplayable", async () => {
			requestUrlMock.mockResolvedValueOnce({
				status: 200,
				json: {
					playabilityStatus: { status: "UNPLAYABLE", reason: "Private video" },
				},
				text: "",
			});

			const result = await downloadYouTubeTranscript("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
			expect(result).toBeNull();
		});

		it("returns null for invalid YouTube URLs", async () => {
			const result = await downloadYouTubeTranscript("https://vimeo.com/12345");
			expect(result).toBeNull();
		});
	});
});
