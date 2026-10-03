import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	isValidYouTubeUrl,
	extractYouTubeUrlFromText,
	getYouTubeUrlFromItem,
	extractYouTubeVideoId,
	buildTimestampUrl,
	formatTimestamp,
	decodeHtmlEntities,
	parseCaptionXml,
	getTranscriptBlocks,
	formatTranscript,
	downloadYouTubeTranscript,
	type TranscriptLine,
} from "../../src/litNote/youtubeTranscript";
import { requestUrlMock } from "../__mocks__/obsidian";

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

	describe("XML parsing and HTML entity decoding", () => {
		it("decodes HTML entities properly", () => {
			expect(decodeHtmlEntities("&amp; &quot; &#39; &lt; &gt;")).toBe('& " \' < >');
			expect(decodeHtmlEntities("&#65; &#66; &#x43;")).toBe("A B C");
			expect(decodeHtmlEntities("We&amp;#39;re")).toBe("We're");
		});

		it("parses timedtext XML with <text> tags", () => {
			const xml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="1.36" dur="1.68">[Music]</text>
  <text start="18.64" dur="3.24">We&amp;#39;re no strangers to love</text>
  <text start="22.64" dur="4.32">You know the rules and so do I</text>
</transcript>`;
			const lines = parseCaptionXml(xml);
			expect(lines).toHaveLength(3);
			expect(lines[0]).toEqual({ text: "[Music]", offset: 1360, duration: 1680 });
			expect(lines[1]).toEqual({ text: "We're no strangers to love", offset: 18640, duration: 3240 });
			expect(lines[2]).toEqual({ text: "You know the rules and so do I", offset: 22640, duration: 4320 });
		});

		it("parses timedtext XML with <p> tags", () => {
			const xml = `<p t="1000" d="2000">First line</p><p t="3000" d="2500">Second line</p>`;
			const lines = parseCaptionXml(xml);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toEqual({ text: "First line", offset: 1000, duration: 2000 });
			expect(lines[1]).toEqual({ text: "Second line", offset: 3000, duration: 2500 });
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
						text: `<transcript><text start="0" dur="2">Hello</text><text start="2" dur="2">World</text></transcript>`,
					});
				}
				return Promise.reject(new Error("Unknown URL"));
			});

			const result = await downloadYouTubeTranscript("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
				timestampMod: 1,
			});
			expect(result).not.toBeNull();
			expect(result).toContain("[00:00](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0) Hello");
			expect(result).toContain("[00:02](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2) World");
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
