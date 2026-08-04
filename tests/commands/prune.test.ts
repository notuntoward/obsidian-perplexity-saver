import { describe, it, expect } from "vitest";
import { findPrunableSources, applyPrune } from "../../src/commands/prune";

describe("findPrunableSources", () => {
	it("returns an empty list when no sources", () => {
		expect(findPrunableSources("no sources here")).toEqual([]);
	});

	it("flags sources whose only citing turn is not present in the body (full removal case)", () => {
		const note = `## AI response (turn 1) ^turn-1

body

## AI response (turn 3) ^turn-3

body

# Sources

[^1_1]: [A](https://a/)
[^2_1]: [B](https://b/)
[^3_1]: [C](https://c/)
`;
		const prunable = findPrunableSources(note);
		expect(prunable).toHaveLength(1);
		expect(prunable[0].id).toBe("2_1");
		expect(prunable[0].turnIds).toEqual([2]);
		expect(prunable[0].deadTurnIds).toEqual([2]);
		expect(prunable[0].survivingTurnIds).toEqual([]);
	});

	it("leaves sources alone when their turn ids are all present", () => {
		const note = `## AI response (turn 1) ^turn-1

body

# Sources

[^1_1]: [A](https://a/)
`;
		expect(findPrunableSources(note)).toEqual([]);
	});
});

describe("applyPrune", () => {
	it("removes flagged source lines and leaves the rest intact", () => {
		const note = `# Dialog

## AI response (turn 1) ^turn-1

body

# Sources

[^1_1]: [A](https://a/)
[^2_1]: [B](https://b/)
`;
		const prunable = findPrunableSources(note);
		const updated = applyPrune(note, prunable);
		expect(updated).toContain("[^1_1]: [A](https://a/)");
		expect(updated).not.toContain("[^2_1]");
		expect(updated).toContain("## AI response (turn 1) ^turn-1");
	});

	it("is a no-op when there is nothing to remove", () => {
		const note = "anything";
		expect(applyPrune(note, [])).toBe("anything");
	});
});
