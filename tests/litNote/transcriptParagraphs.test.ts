import { describe, expect, it } from "vitest";
import {
	buildTranscriptParagraphs,
	groupCuesIntoParagraphs,
	groupSentencesIntoParagraphs,
	joinCueTexts,
	needsSpaceBetween,
	type TranscriptCue,
} from "../../src/litNote/transcriptParagraphs";

/** Back-to-back cues of `len` seconds starting at `start`. */
function evenCues(count: number, len = 5, start = 0, text = (i: number) => `w${i}`): TranscriptCue[] {
	return Array.from({ length: count }, (_, i) => ({
		startSec: start + i * len,
		endSec: start + (i + 1) * len,
		text: text(i),
	}));
}

const sizes = (groups: TranscriptCue[][]) => groups.map((g) => g.length);

describe("needsSpaceBetween / joinCueTexts", () => {
	it("adds a space between ordinary words", () => {
		expect(needsSpaceBetween("hello", "world")).toBe(true);
		expect(joinCueTexts(["hello", "world", "again"])).toBe("hello world again");
	});

	it("does not double existing whitespace or join after a dash", () => {
		expect(needsSpaceBetween("hello ", "world")).toBe(false);
		expect(needsSpaceBetween("hello", " world")).toBe(false);
		expect(needsSpaceBetween("well-", "known")).toBe(false);
		expect(needsSpaceBetween("wait —", "what")).toBe(false);
	});

	it("does not insert spaces around CJK text", () => {
		expect(needsSpaceBetween("你好", "世界")).toBe(false);
		expect(needsSpaceBetween("hello", "世界")).toBe(false);
		expect(joinCueTexts(["こんにちは", "世界"])).toBe("こんにちは世界");
	});

	it("handles empty texts", () => {
		expect(needsSpaceBetween("", "x")).toBe(false);
		expect(joinCueTexts([])).toBe("");
	});
});

describe("groupCuesIntoParagraphs", () => {
	it("returns no paragraphs for no cues", () => {
		expect(groupCuesIntoParagraphs([])).toEqual([]);
	});

	it("keeps short continuous speech in one paragraph", () => {
		expect(sizes(groupCuesIntoParagraphs(evenCues(6)))).toEqual([6]);
	});

	it("starts a new paragraph after a pause longer than 3 seconds", () => {
		const cues = [...evenCues(2, 2), ...evenCues(2, 2, 10)];
		expect(sizes(groupCuesIntoParagraphs(cues))).toEqual([2, 2]);
	});

	it("does not split at a pause of exactly 3 seconds", () => {
		const cues = [...evenCues(2, 2), ...evenCues(2, 2, 7)];
		expect(sizes(groupCuesIntoParagraphs(cues))).toEqual([4]);
	});

	it("at a pause, splits after the last sentence end when 10s or more precede it", () => {
		const cues: TranscriptCue[] = [
			{ startSec: 0, endSec: 5, text: "Hello there." },
			{ startSec: 5, endSec: 12, text: "This is a sentence." },
			{ startSec: 12, endSec: 14, text: "and a fragment" },
			{ startSec: 20, endSec: 24, text: "after the pause" },
		];
		const groups = groupCuesIntoParagraphs(cues);
		// The fragment after the sentence end carries over into the next paragraph.
		expect(groups.map((g) => g.map((c) => c.text))).toEqual([
			["Hello there.", "This is a sentence."],
			["and a fragment", "after the pause"],
		]);
	});

	it("at a pause, keeps the whole paragraph when the sentence end is too early", () => {
		const cues: TranscriptCue[] = [
			{ startSec: 0, endSec: 3, text: "Hi." },
			{ startSec: 3, endSec: 6, text: "and then" },
			{ startSec: 12, endSec: 14, text: "later" },
		];
		expect(sizes(groupCuesIntoParagraphs(cues))).toEqual([2, 1]);
	});

	it("caps unpunctuated speech at about 60 seconds", () => {
		// 5s cues; the 13th cue ends at 65s, past the cap, and moves to the next paragraph.
		expect(sizes(groupCuesIntoParagraphs(evenCues(20)))).toEqual([12, 8]);
	});

	it("breaks at a sentence end near the cap that is already in the paragraph", () => {
		const cues = evenCues(20, 5, 0, (i) => (i === 10 ? "end." : `w${i}`));
		expect(sizes(groupCuesIntoParagraphs(cues))).toEqual([11, 9]);
	});

	it("extends to a sentence end shortly after the cap", () => {
		const cues = evenCues(20, 5, 0, (i) => (i === 13 ? "end." : `w${i}`));
		expect(sizes(groupCuesIntoParagraphs(cues))).toEqual([14, 6]);
	});

	it("prefers the nearer sentence end when there is one on both sides", () => {
		// Cue 9 ends at 50s (10s from the cap); cue 12, which crossed the cap, ends at 65s (5s).
		const cues = evenCues(20, 5, 0, (i) => (i === 9 || i === 12 ? "end." : `w${i}`));
		expect(sizes(groupCuesIntoParagraphs(cues))).toEqual([13, 7]);
	});

	it("keeps a single over-long cue as its own paragraph", () => {
		const cues: TranscriptCue[] = [
			{ startSec: 0, endSec: 90, text: "very long" },
			{ startSec: 90, endSec: 95, text: "next" },
		];
		expect(sizes(groupCuesIntoParagraphs(cues))).toEqual([1, 1]);
	});

	it("never loses or reorders cues", () => {
		const cues = evenCues(57, 4, 0, (i) => (i % 7 === 3 ? `s${i}.` : `w${i}`));
		const flat = groupCuesIntoParagraphs(cues).flat();
		expect(flat).toEqual(cues);
	});
});

describe("buildTranscriptParagraphs", () => {
	it("timestamps each paragraph with its first cue and joins the text", () => {
		const cues = [...evenCues(2, 2), ...evenCues(2, 2, 10, (i) => `b${i}`)];
		expect(buildTranscriptParagraphs(cues).map(({ startSec, text }) => ({ startSec, text }))).toEqual([
			{ startSec: 0, text: "w0 w1" },
			{ startSec: 10, text: "b0 b1" },
		]);
	});

	describe("readable sentence paragraphs", () => {
		const orchard = "Orchard apples ripen beside orchard trees where farmers harvest fresh apples.";
		const bonds = "Bond yields rise as central banks adjust interest rates and markets.";

		it("prefers a vocabulary transition over an arbitrary equal-length split", () => {
			const sentences = [...Array<string>(7).fill(orchard), ...Array<string>(11).fill(bonds)]
				.map((text, index) => ({ text, startSec: index * 3 }));
			const groups = groupSentencesIntoParagraphs(sentences);
			expect(groups.map((group) => group.length)).toEqual([7, 11]);
			expect(groups.flat()).toEqual(sentences);
			expect(groups[1][0]).toBe(sentences[7]);
		});

		it("balances continuous discussion into readable sizes without a short leftover tail", () => {
			const sentences = Array.from({ length: 30 }, () => ({ text: orchard }));
			const groups = groupSentencesIntoParagraphs(sentences);
			expect(groups.length).toBeGreaterThan(1);
			expect(groups.every((group) => {
				const words = group.reduce((sum, sentence) => sum + sentence.text.split(/\s+/).length, 0);
				return words >= 80 && words <= 160;
			})).toBe(true);
			expect(groups.flat()).toEqual(sentences);
		});

		it("keeps an example with its preceding explanation when a nearby break is possible", () => {
			const sentences = Array.from({ length: 18 }, (_, i) => ({ text: `${i === 9 ? "For example, " : ""}${orchard}` }));
			const groups = groupSentencesIntoParagraphs(sentences);
			expect(groups.length).toBeGreaterThan(1);
			expect(groups.every((group) => !group[0].text.startsWith("For example"))).toBe(true);
			expect(groups.flat()).toEqual(sentences);
		});

		it("never splits a long sentence or treats sentence-start spacing as silence", () => {
			const sentences = [{ text: "One. \"Two?\" Three!", startSec: 0 },
				{ text: Array<string>(200).fill("unbroken").join(" ") + ".", startSec: 1 },
				{ text: orchard, startSec: 2 }];
			const groups = groupSentencesIntoParagraphs(sentences);
			expect(groups.flat()).toEqual(sentences);
			expect(groups.some((group) => group.length === 1 && group[0] === sentences[1])).toBe(true);
			expect(groupSentencesIntoParagraphs(sentences.map((sentence, i) => ({ ...sentence, startSec: i * 1000 })))
				.map((group) => group.map((sentence) => sentence.text))).toEqual(groups.map((group) => group.map((sentence) => sentence.text)));
			expect(groupSentencesIntoParagraphs([])).toEqual([]);
		});
	});
});
