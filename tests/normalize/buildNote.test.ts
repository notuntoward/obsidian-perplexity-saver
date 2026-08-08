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
		expect(body).toMatch(/## What is the answer to this question\? \^turn-1/);
		expect(body).toMatch(/> \[!Prompt\]\+/);
		expect(body).not.toMatch(/### AI response/);
		expect(body).toContain("The answer is here.[^1_1]");
		expect(body).toContain("# Sources");
		expect(sourceLines).toHaveLength(1);
		expect(sourceLines[0]).toBe("[^1_1]: [X](https://example.com/x)");
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
		expect(body).toContain("first[^1_1] second[^1_1] third[^1_2]");
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
		const existingSources = "[^1_1]: [Y](https://example.com/y)\n";
		const d = dialog([
			{
				role: "ai",
				rawText: "answer[1]",
				citations: [{ origNum: "1", url: "https://example.com/y", title: "Y" }],
			},
		]);
		const { body, sourceLines } = buildNoteBody(d, { existingSourceText: existingSources });
		expect(body).toContain("answer[^1_1]");
		expect(sourceLines).toHaveLength(1);
		expect(sourceLines[0]).toBe("[^1_1]: [Y](https://example.com/y)");
	});

	it("mints a new id for a URL not present in existingSourceText", () => {
		const existingSources = "[^4_3]: [Y](https://example.com/y)\n";
		const d = dialog([
			{
				role: "ai",
				rawText: "answer[1]",
				citations: [{ origNum: "1", url: "https://example.com/z", title: "Z" }],
			},
		]);
		const { body, sourceLines } = buildNoteBody(d, { existingSourceText: existingSources });
		expect(body).toContain("answer[^1_1]");
		expect(sourceLines).toHaveLength(2);
		expect(sourceLines[0]).toBe("[^1_1]: [Z](https://example.com/z)");
		expect(sourceLines[1]).toBe("[^4_3]: [Y](https://example.com/y)");
	});

	it("records every turn that cites a URL, across turns within one call", () => {
		const d = dialog([
			{ role: "ai", rawText: "a[1]", citations: [{ origNum: "1", url: "https://example.com/shared" }] },
			{ role: "prompt", rawText: "What is the second question?", citations: [] },
			{ role: "ai", rawText: "b[1]", citations: [{ origNum: "1", url: "https://example.com/shared" }] },
		]);
		const { sourceLines } = buildNoteBody(d);
		expect(sourceLines).toHaveLength(2);
		expect(sourceLines[0]).toBe("[^1_1]: <https://example.com/shared>");
		expect(sourceLines[1]).toBe("[^2_1]: <https://example.com/shared>");
	});

	it("preserves numbered turn IDs across appends: new counter is max(existing) + 1", () => {
		const existingBody = `## Headline (turn 2) ^turn-2

## Headline (turn 3) ^turn-3

# Sources
[^2_1]: [Q](https://example.com/q)
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
		expect(body).toContain("### A heading");
	});

	it("bases prompt heading only on user-typed text (ignoring blockquotes) when both exist", () => {
		const d = dialog([
			{
				role: "prompt",
				rawText: "> This is a quote from the previous AI response.\n\nHere is what the user actually typed.",
				citations: [],
			},
		]);
		const { body } = buildNoteBody(d);
		expect(body).toContain("## Here is what the user actually typed. ^turn-1");
	});

	it("bases prompt heading on the quote itself if the prompt consists entirely of quote", () => {
		const d = dialog([
			{
				role: "prompt",
				rawText: "> This is a quote from the previous AI response.",
				citations: [],
			},
		]);
		const { body } = buildNoteBody(d);
		expect(body).toContain("## This is a quote from the previous AI response. ^turn-1");
	});
});

describe("collapseWhitespace", () => {
	it("preserves exactly one blank line before a heading (collapses 2+ to 1)", () => {
		expect(collapseWhitespace("body\n\n## Heading\n\nbody")).toBe("body\n\n## Heading\n\nbody");
	});

	it("collapses 2+ blank lines before a heading to exactly one blank line", () => {
		expect(collapseWhitespace("body\n\n\n## Heading\n\nbody")).toBe("body\n\n## Heading\n\nbody");
	});

	it("collapses 2+ blank lines after a heading to exactly one blank line", () => {
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
		expect(body).toContain(
			"**Source:** [perplexity](https://www.perplexity.ai/search/x)\n\n# Dialog\n\n## AI response (turn 1) ^turn-1\n\n> [!Prompt]+\n\nanswer"
		);
		expect(body).not.toMatch(/\n{3,}/);
	});

	it("preserves blank lines around headings when collapseBlankLines is false", () => {
		const { body } = buildNoteBody(d, { collapseBlankLines: false });
		expect(body).toContain("**Source:** [perplexity](https://www.perplexity.ai/search/x)\n\n# Dialog\n\n## AI response (turn 1)");
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

[^1_1]: [X](https://example.com/x)
`;
		expect(extractSourcesSection(text)).toContain("[^1_1]: [X]");
	});
});
