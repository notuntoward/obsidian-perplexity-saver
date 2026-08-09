import { describe, it, expect } from "vitest";
import { extractMainTitle, normalizeString, matchTitles, findLitNoteForCitekey } from "../../src/zotero/matcher";

describe("matcher - extractMainTitle", () => {
	it("removes subtitle after pipe", () => {
		expect(extractMainTitle("Main Title | Subtitle or Organization")).toBe("Main Title");
	});

	it("removes subtitle after colon", () => {
		expect(extractMainTitle("Super Article: A Study of Things")).toBe("Super Article");
	});

	it("removes subtitle after double dash", () => {
		expect(extractMainTitle("Economic Report -- 2025 Edition")).toBe("Economic Report");
	});

	it("handles titles without delimiters", () => {
		expect(extractMainTitle("Plain Simple Title")).toBe("Plain Simple Title");
	});
});

describe("matcher - normalizeString", () => {
	it("lowercases and removes stop words and punctuation", () => {
		expect(normalizeString("The Quick Brown Fox in the Forest!")).toBe("quick brown fox forest");
	});
});

describe("matcher - matchTitles", () => {
	it("returns 100 for exact match", () => {
		expect(matchTitles("Climate Impact Analysis", "Climate Impact Analysis")).toBe(100);
	});

	it("scores high for titles with identical main titles but different subtitles", () => {
		const score = matchTitles(
			"Climate Impact Analysis: Global Trends",
			"Climate Impact Analysis | Research Report"
		);
		expect(score).toBe(100);
	});

	it("scores low for completely different titles", () => {
		const score = matchTitles("Quantum Computing Breakthrough", "Baking Homemade Bread");
		expect(score).toBeLessThan(30);
	});
});

describe("matcher - findLitNoteForCitekey", () => {
	it("returns true when file stem matches citekey", () => {
		const mockApp: any = {
			vault: {
				getMarkdownFiles: () => [
					{ basename: "smith2024", parent: { path: "lit/lit_notes" } },
					{ basename: "jones2025", parent: { path: "notes" } },
				],
			},
		};

		expect(findLitNoteForCitekey(mockApp, "smith2024")).toBe("smith2024");
		expect(findLitNoteForCitekey(mockApp, "smith2024", "lit/lit_notes")).toBe("smith2024");
		expect(findLitNoteForCitekey(mockApp, "nonexistent")).toBeNull();
	});
});
