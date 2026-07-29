import { describe, it, expect } from "vitest";
import { DialogFile } from "../../src/parsers/types";
import { buildNoteBody, extractSourcesSection, collapseWhitespace } from "../../src/normalize/buildNote";

function dialog(turns: DialogFile["turns"]): DialogFile {
	return { sourceVendor: "perplexity", turns };
}

describe("buildNoteBody", () => {
	it("builds a note with # Dialog and # Sources, no turns TOC, prompt+ai sharing one turn number", () => {
		const d = dialog([
			{ role: "prompt", rawText: "What is the answer to this question?", citations: [] },
			{
				role: "ai",
				rawText: "The answer is here.[1]",
				citations: [{ origNum: "1", url: "https://example.com/x", title: "X" }],
			},
		]);
		const { body, sourceLines } = buildNoteBody(d);
		expect(body).toContain("# Dialog");
		expect(body).not.toContain("## Turns");
		// Prompt marker is a level-2 heading carrying the single `^turn-N`
		// block ID, followed by a closed `> [!Prompt]+` callout containing
		// the prompt body. The AI body follows directly below, with no AI
		// heading of its own. AI body headings are demoted to start at level 3.
		expect(body).toMatch(/## What is the answer to this question\? \^turn-1/);
		expect(body).toMatch(/> \[!Prompt\]\+/);
		expect(body).not.toMatch(/### AI response/);
		expect(body).toContain("The answer is here.[^s1]");
		expect(body).toContain("# Sources");
		expect(sourceLines).toHaveLength(1);
		expect(sourceLines[0]).toContain("[^s1]: [X](https://example.com/x) (turn 1) <!-- src-url: https://example.com/x -->");
	});

	it("converts every occurrence of a repeated citation number, not just the first", () => {
		const d = dialog([
			{
				role: "ai",
				rawText: "first[1] second[1] third[2]",
				citations: [
					{ origNum: "1", url: "https://example.com/a" },
					{ origNum: "2", url: "https://example.com/b" },
				],
			},
		]);
		const { body } = buildNoteBody(d);
		expect(body).toContain("first[^s1] second[^s1] third[^s2]");
		expect(body).not.toMatch(/\[1\]|\[2\]/);
	});

	it("renumbers turn IDs when startTurnId is given, prompt+ai sharing the same number", () => {
		const d = dialog([
			{ role: "prompt", rawText: "What is the question to ask?", citations: [] },
			{ role: "ai", rawText: "a", citations: [] },
		]);
		const { body } = buildNoteBody(d, { startTurnId: 10 });
		expect(body).toMatch(/## What is the question to ask\? \^turn-10/);
	});

	it("reuses existing source IDs when the same URL appears in existingSourceText", () => {
		const existingSources = "[^s4]: [Y](https://example.com/y) (turn 3) <!-- src-url: https://example.com/y -->\n";
		const d = dialog([
			{
				role: "ai",
				rawText: "answer[1]",
				citations: [{ origNum: "1", url: "https://example.com/y", title: "Y" }],
			},
		]);
		const { body, sourceLines } = buildNoteBody(d, { existingSourceText: existingSources });
		// Citation [1] in body should be rewritten to s4, not minted a new id.
		expect(body).toContain("answer[^s4]");
		// The full sources list is regenerated: the existing entry is still
		// present, now with this turn added to its ownership list.
		expect(sourceLines).toHaveLength(1);
		expect(sourceLines[0]).toContain("[^s4]: [Y](https://example.com/y) (turns 1, 3) <!-- src-url: https://example.com/y -->");
	});

	it("mints a new id for a URL not present in existingSourceText", () => {
		const existingSources = "[^s4]: [Y](https://example.com/y) (turn 3) <!-- src-url: https://example.com/y -->\n";
		const d = dialog([
			{
				role: "ai",
				rawText: "answer[1]",
				citations: [{ origNum: "1", url: "https://example.com/z", title: "Z" }],
			},
		]);
		const { body, sourceLines } = buildNoteBody(d, { existingSourceText: existingSources });
		expect(body).toContain("answer[^s5]");
		// Full regenerated list: existing s4 entry unchanged, plus new s5.
		expect(sourceLines).toHaveLength(2);
		expect(sourceLines[0]).toContain("[^s4]: [Y](https://example.com/y) (turn 3)");
		expect(sourceLines[1]).toContain("[^s5]");
	});

	it("records every turn that cites a URL, across turns within one call", () => {
		const d = dialog([
			{ role: "ai", rawText: "a[1]", citations: [{ origNum: "1", url: "https://example.com/shared" }] },
			{ role: "prompt", rawText: "What is the second question?", citations: [] },
			{ role: "ai", rawText: "b[1]", citations: [{ origNum: "1", url: "https://example.com/shared" }] },
		]);
		const { sourceLines } = buildNoteBody(d);
		expect(sourceLines).toHaveLength(1);
		// First ai turn is a standalone turn 1 (no preceding prompt); the
		// prompt+ai pair after it is turn 2.
		expect(sourceLines[0]).toContain("(turns 1, 2)");
	});

	it("preserves numbered turn IDs across appends: new counter is max(existing) + 1", () => {
		const existingBody = `## Headline (turn 2) ^turn-2

## Headline (turn 3) ^turn-3

# Sources
[^s7]: [Q](https://example.com/q) (turn 2) <!-- src-url: https://example.com/q -->
`;
		const d = dialog([{ role: "prompt", rawText: "What is the next question?", citations: [] }]);
		const { body } = buildNoteBody(d, {
			startTurnId: 10,
			existingSourceText: extractSourcesSection(existingBody),
		});
		expect(body).toContain("^turn-10");
	});

	it("omits # Sources when there are no citations", () => {
		const d = dialog([
			{ role: "prompt", rawText: "What is the question?", citations: [] },
			{ role: "ai", rawText: "a", citations: [] },
		]);
		const { body } = buildNoteBody(d);
		expect(body).not.toContain("# Sources");
	});

	it("demotes embedded headings in AI response bodies to exactly one level below the prompt heading", () => {
		// The prompt heading is at level 2, so response headings should start at level 3.
		const d = dialog([
			{ role: "ai", rawText: "## A heading\n\n### Subheading", citations: [] },
		]);
		const { body } = buildNoteBody(d);
		expect(body).toContain("### A heading");
		expect(body).toContain("#### Subheading");
		expect(body).not.toMatch(/^## A heading/m);
	});

	it("strips heading markers from prompt text but not from AI text", () => {
		const d = dialog([
			{ role: "prompt", rawText: "# What is the question?", citations: [] },
			{ role: "ai", rawText: "## A heading\n\nbody", citations: [] },
		]);
		const { body } = buildNoteBody(d);
		expect(body).toContain("What is the question?");
		expect(body).not.toMatch(/^# What is the question\?/m);
		// AI body headings are demoted to start at level 3 (one below the level-2 prompt heading).
		expect(body).toContain("### A heading");
	});
});

describe("collapseWhitespace", () => {
	it("removes a blank line immediately before a heading", () => {
		// Blank line before a heading is removed so the heading starts
		// right after the previous content (no gap above).
		expect(collapseWhitespace("body\n\n## Heading\n\nbody")).toBe("body\n## Heading\n\nbody");
	});

	it("collapses 2+ blank lines after a heading to exactly one blank line", () => {
		// The heading is followed by exactly one blank line, not zero (the
		// heading is still visually separated from its body) and not more
		// (no accidental double-spacing).
		expect(collapseWhitespace("## Heading\n\n\nbody")).toBe("## Heading\n\nbody");
	});

	it("collapses 3+ consecutive blank lines to a single blank line", () => {
		expect(collapseWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
	});

	it("does not affect body lines that are not adjacent to a heading", () => {
		expect(collapseWhitespace("a\n\nb\n\nc")).toBe("a\n\nb\n\nc");
	});

	it("handles a heading as the very first content", () => {
		expect(collapseWhitespace("\n\n## Heading\n\nbody")).toBe("## Heading\n\nbody");
	});
});

describe("buildNoteBody — collapseBlankLines option", () => {
	const d: DialogFile = {
		sourceVendor: "perplexity",
		sourceUrl: "https://www.perplexity.ai/search/x",
		turns: [
			{ role: "ai", rawText: "answer", citations: [] },
		],
	};

	it("collapses by default (collapseBlankLines omitted)", () => {
		const { body } = buildNoteBody(d);
		// A standalone AI turn (no preceding prompt) gets a stable
		// "AI response (turn N)" label, not a headline derived from the
		// AI's response text (which would leak citation markers and
		// internal headings into the outline pane). The heading is
		// separate from the callout.
		expect(body).toContain(
			"# Dialog\n\n**Source:** [perplexity](https://www.perplexity.ai/search/x)\n## AI response (turn 1) ^turn-1\n\n> [!Prompt]+\n\nanswer"
		);
		// No double blank lines anywhere.
		expect(body).not.toMatch(/\n{3,}/);
	});

	it("preserves blank lines around headings when collapseBlankLines is false", () => {
		const { body } = buildNoteBody(d, { collapseBlankLines: false });
		// Blank line is between # Dialog and **Source:** (non-heading content
		// after a heading). The # Dialog heading itself is attached to its
		// following content with a single blank line.
		expect(body).toContain("# Dialog\n\n**Source:**");
		// The prompt heading has a blank line after it (between heading and callout).
		expect(body).toMatch(/\n\n> \[!Prompt\]/);
	});
});

describe("buildNoteBody — collapsePromptCallouts option", () => {
	const d: DialogFile = {
		sourceVendor: "perplexity",
		sourceUrl: "https://www.perplexity.ai/search/x",
		turns: [
			{ role: "prompt", rawText: "What is the answer?", citations: [] },
			{ role: "ai", rawText: "The answer is here.", citations: [] },
		],
	};

	it("collapses callouts by default (collapsePromptCallouts defaults to true)", () => {
		const { body } = buildNoteBody(d);
		expect(body).toContain("> [!Prompt]+");
		expect(body).not.toContain("> [!Prompt]-");
	});

	it("expands callouts when collapsePromptCallouts is false", () => {
		const { body } = buildNoteBody(d, { collapsePromptCallouts: false });
		expect(body).toContain("> [!Prompt]-");
		expect(body).not.toContain("> [!Prompt]+");
	});
});

describe("extractSourcesSection", () => {
	it("returns empty string when no # Sources section", () => {
		expect(extractSourcesSection("# Dialog\n\n> [!Prompt]+ Headline ^turn-1\n\ntext")).toBe("");
	});

	it("returns the section text after # Sources", () => {
		const text = `# Dialog

> [!Prompt]+ Headline ^turn-1

# Sources

[^s1]: [X](https://example.com/x) (turn 1) <!-- src-url: https://example.com/x -->
`;
		expect(extractSourcesSection(text)).toContain("[^s1]: [X]");
	});
});
