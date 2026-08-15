import { describe, it, expect } from "vitest";
import {
	renderTurn,
	getNextTurnIndex,
	getSurvivingTurnIds,
	demoteHeadingsBelow,
	stripHeadingMarkers,
	assignTurnIds,
	deduplicateSameTurnCitations,
	deduplicateDialogCitations,
} from "../../src/normalize/turns";
import { DialogTurn } from "../../src/parsers/types";

describe("renderTurn", () => {
	it("renders a prompt turn as a level-2 heading plus a closed callout containing the prompt body", () => {
		const out = renderTurn("prompt", "Hello there", 1, "A greeting");
		// The level-2 heading carries the single `^turn-N` block ID and
		// the computed headline. A single ID (not two) avoids Obsidian
		// wrapping the second `^` anchor onto its own visual line.
		expect(out).toContain("## A greeting ^turn-1");
		// The prompt body is folded inside a closed `> [!Prompt]-` callout
		// so it collapses by default.
		expect(out).toMatch(/> \[!Prompt\]-\n> Hello there/);
	});

	it("renders an AI turn with no heading of its own when includeHeading is false (the prompt heading above is the turn's only heading)", () => {
		const out = renderTurn("ai", "Greetings", 1, "ignored", { includeHeading: false });
		expect(out).not.toMatch(/^#{1,6}\s/m); // no heading line at all
		expect(out).toContain("Greetings");
		// The AI heading is gone; the prompt heading above is the turn's
		// only visible heading and carries both anchor IDs.
		expect(out).not.toContain("AI response");
	});

	it("demotes headings in AI turn bodies so the topmost lands at level 3", () => {
		const out = renderTurn("ai", "## A heading\n\ntext", 1, "ignored", { includeHeading: false });
		// The prompt heading is at level 2, so response headings should start at level 3.
		expect(out).toContain("### A heading");
		expect(out).not.toMatch(/^## A heading/m);
	});

	it("demotes an h2 to h3 (one level shift to reach the target)", () => {
		const out = renderTurn("ai", "## Already there\n\ntext", 1, "ignored", { includeHeading: false });
		expect(out).toContain("### Already there");
	});

	it("leaves a deep h5 alone (no shift needed, already below the target)", () => {
		const out = renderTurn("ai", "##### Already deep\n\ntext", 1, "ignored", { includeHeading: false });
		// minLevel=5 >= targetMinLevel=3, so offset=0 and headings are unchanged.
		expect(out).toContain("##### Already deep");
	});

	it("caps heading shift at level 6", () => {
		const out = renderTurn("ai", "## x\n\n###### y\n\ntext", 1, "ignored", { includeHeading: false });
		// Going from 2 -> 3 (1 level), and 6 stays 6 (capped at max 6).
		expect(out).toContain("### x");
		expect(out).toContain("###### y");
	});

	it("strips heading markers from prompt turns instead of demoting them", () => {
		const out = renderTurn("prompt", "# My structured question\n\nbody", 1, "My question");
		expect(out).toContain("My structured question");
		expect(out).not.toMatch(/^#{1,6}[ \t]+My structured question/m);
	});
});

describe("stripHeadingMarkers", () => {
	it("removes a leading '# ' from the first line", () => {
		expect(stripHeadingMarkers("# How do I foo?\n\nmore text")).toBe("How do I foo?\n\nmore text");
	});

	it("removes heading markers from every matching line, any level", () => {
		expect(stripHeadingMarkers("## a\ntext\n### b")).toBe("a\ntext\nb");
	});

	it("leaves text with no headings unchanged", () => {
		expect(stripHeadingMarkers("just plain text")).toBe("just plain text");
	});
});

describe("demoteHeadingsBelow", () => {
	it("returns text unchanged when no headings present", () => {
		expect(demoteHeadingsBelow("just text", 3)).toBe("just text");
	});

	it("shifts by the minimum amount to reach targetMinLevel", () => {
		expect(demoteHeadingsBelow("## a\n### b", 3)).toBe("### a\n#### b");
	});

	it("caps at level 6", () => {
		expect(demoteHeadingsBelow("###### a", 3)).toBe("###### a");
	});
});

describe("assignTurnIds", () => {
	function turn(role: "prompt" | "ai"): DialogTurn {
		return { role, rawText: "x", citations: [] };
	}

	it("pairs a prompt with the ai response immediately following it", () => {
		const turns = [turn("prompt"), turn("ai")];
		expect(assignTurnIds(turns, 1)).toEqual([1, 1]);
	});

	it("increments once per prompt+ai pair across multiple exchanges", () => {
		const turns = [turn("prompt"), turn("ai"), turn("prompt"), turn("ai")];
		expect(assignTurnIds(turns, 1)).toEqual([1, 1, 2, 2]);
	});

	it("respects a non-default startTurnId (append scenario)", () => {
		const turns = [turn("prompt"), turn("ai"), turn("prompt"), turn("ai")];
		expect(assignTurnIds(turns, 5)).toEqual([5, 5, 6, 6]);
	});

	it("gives a standalone ai turn (no preceding prompt) its own id", () => {
		const turns = [turn("ai")];
		expect(assignTurnIds(turns, 1)).toEqual([1]);
	});

	it("gives a standalone prompt (no following ai) its own id", () => {
		const turns = [turn("prompt")];
		expect(assignTurnIds(turns, 1)).toEqual([1]);
	});

	it("handles a standalone ai turn followed by a normal pair", () => {
		const turns = [turn("ai"), turn("prompt"), turn("ai")];
		expect(assignTurnIds(turns, 1)).toEqual([1, 2, 2]);
	});
});

describe("getNextTurnIndex", () => {
	it("returns 1 when no turns present", () => {
		expect(getNextTurnIndex("no turns here")).toBe(1);
	});

	it("returns max+1 across all turns, whether the anchor uses the new ^turn-N or old ^turn-N-prompt format", () => {
		const text = `## Headline one (turn 1) ^turn-1\n\n> [!Prompt]- Headline two (turn 2) ^turn-2\n\n## Headline five (turn 5) ^turn-5-prompt ^turn-5-ai`;
		expect(getNextTurnIndex(text)).toBe(6);
	});
});

describe("getSurvivingTurnIds", () => {
	it("returns the set of all present turn ids", () => {
		const text = `## Headline (turn 2) ^turn-2\n\n## Headline (turn 4) ^turn-4-prompt ^turn-4-ai\n\n## Headline (turn 5) ^turn-5`;
		const ids = getSurvivingTurnIds(text);
		expect([...ids].sort()).toEqual([2, 4, 5]);
	});

	it("returns empty set when no turns present", () => {
		expect(getSurvivingTurnIds("just text").size).toBe(0);
	});
});

describe("deduplicateSameTurnCitations", () => {
	it("does nothing for non-ai turns", () => {
		const turn: DialogTurn = {
			role: "prompt",
			rawText: "Search Google [1] or [2]",
			citations: [
				{ origNum: "1", url: "https://google.com" },
				{ origNum: "2", url: "https://google.com" },
			],
		};
		deduplicateSameTurnCitations(turn);
		expect(turn.citations).toHaveLength(2);
		expect(turn.rawText).toBe("Search Google [1] or [2]");
	});

	it("deduplicates same-turn citations and renumbers footnotes in rawText", () => {
		const turn: DialogTurn = {
			role: "ai",
			rawText: "This is a statement [2] and another statement [5]. Here is a footnote [^9]. We also refer to [2] again.",
			citations: [
				{ origNum: "2", url: "https://google.com", title: "Google" },
				{ origNum: "5", url: "https://google.com", title: "Google Corp" },
				{ origNum: "9", url: "https://yahoo.com" },
			],
		};
		deduplicateSameTurnCitations(turn);

		expect(turn.citations).toEqual([
			{ origNum: "1", url: "https://google.com", title: "Google" },
			{ origNum: "2", url: "https://yahoo.com", title: undefined },
		]);
		expect(turn.rawText).toBe(
			"This is a statement [1] and another statement [1]. Here is a footnote [^2]. We also refer to [1] again."
		);
	});

	it("merges titles when the duplicate has a title but the first seen citation does not", () => {
		const turn: DialogTurn = {
			role: "ai",
			rawText: "Check [1] and [2].",
			citations: [
				{ origNum: "1", url: "https://google.com" },
				{ origNum: "2", url: "https://google.com", title: "Google Title" },
			],
		};
		deduplicateSameTurnCitations(turn);
		expect(turn.citations).toEqual([
			{ origNum: "1", url: "https://google.com", title: "Google Title" },
		]);
		expect(turn.rawText).toBe("Check [1] and [1].");
	});

	it("safely handles multi-digit and out-of-order renumberings without collisions", () => {
		const turn: DialogTurn = {
			role: "ai",
			rawText: "Ref 12 is [12] and ref 1 is [1].",
			citations: [
				{ origNum: "12", url: "https://yahoo.com" },
				{ origNum: "1", url: "https://google.com" },
			],
		};
		deduplicateSameTurnCitations(turn);
		expect(turn.citations).toEqual([
			{ origNum: "1", url: "https://yahoo.com", title: undefined },
			{ origNum: "2", url: "https://google.com", title: undefined },
		]);
		expect(turn.rawText).toBe("Ref 12 is [1] and ref 1 is [2].");
	});
});
