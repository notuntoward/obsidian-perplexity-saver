import { describe, it, expect } from "vitest";
import { getYouTubeUrlFromItem } from "../../src/litNote/youtubeItem";

describe("YouTube URLs in Zotero payloads", () => {
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
});
