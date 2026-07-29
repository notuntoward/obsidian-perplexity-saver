import { describe, it, expect } from "vitest";
import { findPrunableSources, applyPrune } from "../../src/commands/prune";

describe("findPrunableSources", () => {
	it("returns an empty list when no sources", () => {
		expect(findPrunableSources("no sources here")).toEqual([]);
	});

	it("flags sources whose only citing turn is not present in the body (full removal case)", () => {
		const note = `### AI response (turn 1) ^turn-1-ai

body

### AI response (turn 3) ^turn-3-ai

body

# Sources

[^s1]: [A](https://a/) (turn 1) <!-- src-url: https://a/ -->
[^s2]: [B](https://b/) (turn 2) <!-- src-url: https://b/ -->
[^s3]: [C](https://c/) (turn 3) <!-- src-url: https://c/ -->
`;
		const prunable = findPrunableSources(note);
		expect(prunable).toHaveLength(1);
		expect(prunable[0].id).toBe("s2");
		expect(prunable[0].turnIds).toEqual([2]);
		expect(prunable[0].deadTurnIds).toEqual([2]);
		expect(prunable[0].survivingTurnIds).toEqual([]);
	});

	it("leaves sources alone when their turn ids are all present", () => {
		const note = `### AI response (turn 1) ^turn-1-ai

body

# Sources

[^s1]: [A](https://a/) (turn 1) <!-- src-url: https://a/ -->
`;
		expect(findPrunableSources(note)).toEqual([]);
	});

	it("flags a multi-turn source as partially prunable when only some owning turns survive", () => {
		const note = `### AI response (turn 1) ^turn-1-ai

body

# Sources

[^s1]: [A](https://a/) (turns 1, 2) <!-- src-url: https://a/ -->
`;
		const prunable = findPrunableSources(note);
		expect(prunable).toHaveLength(1);
		expect(prunable[0].deadTurnIds).toEqual([2]);
		expect(prunable[0].survivingTurnIds).toEqual([1]);
	});

	it("leaves a multi-turn source alone when all owning turns survive", () => {
		const note = `### AI response (turn 1) ^turn-1-ai

body

### AI response (turn 2) ^turn-2-ai

body

# Sources

[^s1]: [A](https://a/) (turns 1, 2) <!-- src-url: https://a/ -->
`;
		expect(findPrunableSources(note)).toEqual([]);
	});
});

describe("applyPrune", () => {
	it("removes flagged source lines and leaves the rest intact", () => {
		const note = `# Dialog

### AI response (turn 1) ^turn-1-ai

body

# Sources

[^s1]: [A](https://a/) (turn 1) <!-- src-url: https://a/ -->
[^s2]: [B](https://b/) (turn 2) <!-- src-url: https://b/ -->
`;
		const prunable = findPrunableSources(note);
		const updated = applyPrune(note, prunable);
		expect(updated).toContain("[^s1]: [A](https://a/)");
		expect(updated).not.toContain("[^s2]");
		expect(updated).toContain("### AI response (turn 1) ^turn-1-ai");
	});

	it("rewrites a partially-owned source to drop only the dead turn, keeping the line", () => {
		const note = `# Dialog

### AI response (turn 1) ^turn-1-ai

body

# Sources

[^s1]: [A](https://a/) (turns 1, 2) <!-- src-url: https://a/ -->
`;
		const prunable = findPrunableSources(note);
		const updated = applyPrune(note, prunable);
		expect(updated).toContain("[^s1]: [A](https://a/) (turn 1) <!-- src-url: https://a/ -->");
		expect(updated).not.toContain("turns 1, 2");
	});

	it("is a no-op when there is nothing to remove", () => {
		const note = "anything";
		expect(applyPrune(note, [])).toBe("anything");
	});
});
