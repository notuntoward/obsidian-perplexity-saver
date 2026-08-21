import { describe, it, expect } from "vitest";
import { parseJumpItems } from "../../src/commands/jump";

describe("parseJumpItems", () => {
	it("should parse headings and find AI response starts", () => {
		const doc = [
			"## First Heading ^turn-1", // 0
			"",                         // 1
			"> [!Prompt]+",             // 2
			"> user prompt",            // 3
			"",                         // 4
			"AI response 1",            // 5
			"More AI response",         // 6
			"",                         // 7
			"## Second Heading ^turn-2",// 8
			"",                         // 9
			"> [!Prompt]-",             // 10
			"> second prompt",          // 11
			"> more prompt",            // 12
			"",                         // 13
			"AI response 2"             // 14
		];

		const getLine = (i: number) => doc[i];
		
		const { items, currentTurnIndex } = parseJumpItems(doc.length, getLine, 0);

		expect(items.length).toBe(2);
		
		expect(items[0].headingText).toBe("First Heading");
		expect(items[0].headingLine).toBe(0);
		expect(items[0].aiResponseLine).toBe(5);
		expect(items[0].isCurrent).toBe(true); // cursor at 0

		expect(items[1].headingText).toBe("Second Heading");
		expect(items[1].headingLine).toBe(8);
		expect(items[1].aiResponseLine).toBe(14);
		expect(items[1].isCurrent).toBe(false);

		expect(currentTurnIndex).toBe(0);
	});

	it("should identify the correct current turn based on cursor", () => {
		const doc = [
			"## T1 ^turn-1", // 0
			"ai 1",          // 1
			"## T2 ^turn-2", // 2
			"ai 2",          // 3
			"## T3 ^turn-3", // 4
			"ai 3",          // 5
		];

		const getLine = (i: number) => doc[i];

		// Cursor before first heading
		let res = parseJumpItems(doc.length, getLine, -1);
		expect(res.currentTurnIndex).toBe(-1);

		// Cursor on first heading
		res = parseJumpItems(doc.length, getLine, 0);
		expect(res.currentTurnIndex).toBe(0);

		// Cursor inside first turn
		res = parseJumpItems(doc.length, getLine, 1);
		expect(res.currentTurnIndex).toBe(0);

		// Cursor on second heading
		res = parseJumpItems(doc.length, getLine, 2);
		expect(res.currentTurnIndex).toBe(1);

		// Cursor inside third turn
		res = parseJumpItems(doc.length, getLine, 5);
		expect(res.currentTurnIndex).toBe(2);
	});
});
