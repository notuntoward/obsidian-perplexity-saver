import { describe, it, expect } from "vitest";
import {
	getTurnBlocks,
	extractAiResponseFromTurnBlock,
	findSourcesWithNoCite,
	applyRemoveSourcesWithNoCite,
} from "../../src/commands/removeNoCite";

describe("getTurnBlocks", () => {
	it("correctly identifies and extracts turn blocks", () => {
		const note = `---
ai-source-vendor: perplexity
---

# Dialog

## How to use foo? ^turn-1

> [!Prompt]+
> prompt 1

response 1 with [^1_1]

## What about bar? ^turn-2

> [!Prompt]+
> prompt 2

response 2

# Sources

[^1_1]: [Page 1](https://foo/)
[^1_2]: [Page 2](https://bar/)
`;
		const blocks = getTurnBlocks(note);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("## How to use foo? ^turn-1");
		expect(blocks[0]).toContain("response 1");
		expect(blocks[1]).toContain("## What about bar? ^turn-2");
		expect(blocks[1]).toContain("response 2");
	});
});

describe("extractAiResponseFromTurnBlock", () => {
	it("ignores prompt callouts and extracts AI response text", () => {
		const block = `## How to use foo? ^turn-1

> [!Prompt]+
> prompt 1
> text inside prompt

AI response here
more lines of AI response`;

		const response = extractAiResponseFromTurnBlock(block);
		expect(response.trim()).toBe("AI response here\nmore lines of AI response");
	});

	it("returns whole block minus heading if no prompt callout found", () => {
		const block = `## AI response (turn 2) ^turn-2

AI response here without prompt`;
		const response = extractAiResponseFromTurnBlock(block);
		expect(response.trim()).toBe("AI response here without prompt");
	});
});

describe("findSourcesWithNoCite", () => {
	it("correctly flags sources not cited in any AI response", () => {
		const note = `---
ai-source-vendor: perplexity
---

# Dialog

## How to use foo? ^turn-1

> [!Prompt]+
> prompt 1 with [^1_2] inside prompt (which shouldn't count as cited in AI response)

response 1 with [^1_1]

## What about bar? ^turn-2

> [!Prompt]+
> prompt 2

response 2 without citations

# Sources

[^1_1]: [Page 1](https://foo/)
[^1_2]: [Page 2](https://bar/)
[^2_1]: [Page 3](https://baz/)
`;
		const uncited = findSourcesWithNoCite(note);
		expect(uncited).toHaveLength(2);
		// [^1_2] is only cited in the prompt callout, so it's considered uncited in AI response.
		// [^2_1] is not cited anywhere, so it is uncited.
		const ids = uncited.map((u) => u.id);
		expect(ids).toContain("1_2");
		expect(ids).toContain("2_1");
		expect(ids).not.toContain("1_1");
	});
});

describe("applyRemoveSourcesWithNoCite", () => {
	it("removes flagged uncited lines from note text", () => {
		const note = `---
ai-source-vendor: perplexity
---

# Dialog

## How to use foo? ^turn-1

> [!Prompt]+
> prompt 1

response 1 with [^1_1]

# Sources

[^1_1]: [Page 1](https://foo/)
[^1_2]: [Page 2](https://bar/)
`;
		const uncited = findSourcesWithNoCite(note);
		const result = applyRemoveSourcesWithNoCite(note, uncited);
		expect(result).toContain("[^1_1]: [Page 1](https://foo/)");
		expect(result).not.toContain("[^1_2]");
	});
});
