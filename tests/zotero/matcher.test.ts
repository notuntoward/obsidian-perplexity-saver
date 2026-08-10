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

	it("still splits a genuine sentence-style subtitle after a period", () => {
		expect(extractMainTitle("Deep Learning. A Comprehensive Survey")).toBe("Deep Learning");
	});

	it("does not truncate titles at a 'U.S.' abbreviation (regression)", () => {
		// Regression test: the period-based subtitle delimiter used to also
		// match the period inside "U.S." (and similar two-letter
		// abbreviations), since it's followed by a space and a capital
		// letter just like a real subtitle boundary. That reduced any
		// title starting with "U.S." down to just "U.S", causing unrelated
		// "U.S. ..." titled sources to spuriously match each other.
		expect(extractMainTitle("U.S. Census Bureau QuickFacts: Washington")).toBe(
			"U.S. Census Bureau QuickFacts"
		);
		expect(extractMainTitle("The U.S. Senators who perform best vs the competition")).toBe(
			"The U.S. Senators who perform best vs the competition"
		);
	});

	it("does not truncate titles at other two-letter abbreviations like 'D.C.' or 'U.K.'", () => {
		expect(extractMainTitle("Washington D.C. Metro Area Population Report")).toBe(
			"Washington D.C. Metro Area Population Report"
		);
		expect(extractMainTitle("U.K. Election Results Analysis")).toBe("U.K. Election Results Analysis");
	});

	it("does not truncate titles at longer dotted abbreviations like 'U.S.A.', 'U.S.D.A.', or 'N.A.T.O.'", () => {
		// The lookbehind only needs to check the single letter.letter pair
		// immediately before the candidate split period, so this holds for
		// any length of dotted initialism, not just two-letter ones.
		expect(extractMainTitle("U.S.D.A. Releases New Nutrition Guidelines for 2025")).toBe(
			"U.S.D.A. Releases New Nutrition Guidelines for 2025"
		);
		// A colon still correctly splits off a real subtitle even when the
		// main title itself contains a longer dotted abbreviation.
		expect(extractMainTitle("U.S.A. Today: The Numbers Behind the News")).toBe("U.S.A. Today");
		// A genuine sentence-style subtitle split still works after a
		// longer dotted abbreviation, as long as the period that actually
		// splits is not itself part of the abbreviation.
		expect(extractMainTitle("N.A.T.O. Expansion. A Historical Overview")).toBe("N.A.T.O. Expansion");
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

	it("does not spuriously match unrelated 'U.S. ...' titled sources (regression)", () => {
		// Regression test for the exact false-positive relinking bug: every
		// source whose title happened to start with "U.S." was previously
		// truncated to the single token "us" and matched every other such
		// source at a perfect 100, regardless of topic (e.g. Census
		// QuickFacts pages for different states all matched an unrelated
		// political-analysis article, because both titles start with
		// "U.S.").
		const score = matchTitles(
			"U.S. Census Bureau QuickFacts: Washington",
			"The U.S. Senators who perform best vs the competition; + a FAQ about WAR/WARP"
		);
		expect(score).toBeLessThan(50);
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
