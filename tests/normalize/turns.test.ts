import { describe, it, expect } from "vitest";
import {
	renderTurn,
	getNextTurnIndex,
	getSurvivingTurnIds,
	demoteHeadingsBelow,
	stripHeadingMarkers,
	assignTurnIds,
} from "../../src/normalize/turns";
import { DialogTurn } from "../../src/parsers/types";

describe("renderTurn", () => {
	it("renders a prompt turn with a level-2 headline heading and block ID", () => {
		const out = renderTurn("prompt", "Hello there", 1, "A greeting");
		expect(out).toContain("## A greeting ^turn-1-prompt");
		expect(out).toContain("Hello there");
	});

	it("renders an AI turn with a level-3 AI response heading and block ID", () => {
		const out = renderTurn("ai", "Greetings", 1, "ignored");
		expect(out).toContain("### AI response (turn 1) ^turn-1-ai");
		expect(out).toContain("Greetings");
	});

	it("demotes headings in AI turn bodies so the topmost lands at level 4", () => {
		const out = renderTurn("ai", "## A heading\n\ntext", 1, "ignored");
		// The AI response heading is at level 3, so response headings should start at level 4.
		expect(out).toContain("#### A heading");
		expect(out).not.toMatch(/^## A heading/m);
	});

	it("demotes an h3 to h3 (no shift needed if already deep enough)", () => {
		const out = renderTurn("ai", "### Already deep\n\ntext", 1, "ignored");
		// Level 3 -> target 4: 1 level demoted => 4
		expect(out).toContain("#### Already deep");
	});

	it("caps heading shift at level 6", () => {
		const out = renderTurn("ai", "## x\n\n###### y\n\ntext", 1, "ignored");
		// Going from 2 -> 4 (2 levels), and 6 stays 6 (capped at max 6).
		expect(out).toContain("#### x");
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

	it("returns max+1 across both roles", () => {
		const text = `### AI response (turn 1) ^turn-1-ai\n\n## Headline one (turn 2) ^turn-2-prompt\n\n### AI response (turn 5) ^turn-5-ai`;
		expect(getNextTurnIndex(text)).toBe(6);
	});
});

describe("getSurvivingTurnIds", () => {
	it("returns the set of all present turn ids", () => {
		const text = `### AI response (turn 2) ^turn-2-ai\n\n### AI response (turn 4) ^turn-4-ai\n\n## Headline five (turn 5) ^turn-5-prompt`;
		const ids = getSurvivingTurnIds(text);
		expect([...ids].sort()).toEqual([2, 4, 5]);
	});

	it("returns empty set when no turns present", () => {
		expect(getSurvivingTurnIds("just text").size).toBe(0);
	});
});
