import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteDialogTurn, getTurnsFromNote } from "../../src/commands/delete";

describe("deleteDialogTurn", () => {
	let mockApp: any;
	let mockFile: any;

	beforeEach(() => {
		mockFile = { path: "note.md" };
		mockApp = {
			vault: {
				read: vi.fn(),
				modify: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	it("fails if the turn is not found in the note", async () => {
		mockApp.vault.read.mockResolvedValue("just some text, no turns");
		const result = await deleteDialogTurn(mockApp, mockFile, 3);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Could not find turn 3");
	});

	it("successfully deletes the targeted turn block and removes scoped sources with no dialog", async () => {
		const existingText = `# Dialog

## First question ^turn-1

> [!Prompt]+
> First question text

First answer text[^1_1]

## Second question ^turn-2

> [!Prompt]+
> Second question text

Second answer text[^2_1]

## Third question ^turn-3

> [!Prompt]+
> Third question text

Third answer text[^3_1]

# Sources

[^1_1]: [A](https://a.com/)
[^2_1]: [B](https://b.com/)
[^3_1]: [C](https://c.com/)
`;

		mockApp.vault.read.mockResolvedValue(existingText);

		const result = await deleteDialogTurn(mockApp, mockFile, 2);
		expect(result.success).toBe(true);
		expect(result.removedCount).toBe(1); // source B [^2_1] is fully removed since turn 2 is deleted

		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		// Turn 2 is deleted
		expect(written).not.toContain("Second question text");
		expect(written).not.toContain("second answer[^2_1]");
		expect(written).not.toContain("[^2_1]: [B]");

		// Turn 1 and Turn 3 are preserved
		expect(written).toContain("First question text");
		expect(written).toContain("Third question text");
		expect(written).toContain("[^1_1]: [A]");
		expect(written).toContain("[^3_1]: [C]");
	});
});

describe("getTurnsFromNote", () => {
	it("correctly extracts turn numbers and shortened prompts as heading texts", () => {
		const noteText = `# Dialog

## How do I do X? ^turn-1

Prompt 1

## Why is Y like that? ^turn-5

Prompt 5
`;
		const turns = getTurnsFromNote(noteText);
		expect(turns).toHaveLength(2);
		expect(turns[0]).toEqual({
			turnNum: 1,
			headingText: "How do I do X?",
			displayText: "Turn 1: How do I do X?",
		});
		expect(turns[1]).toEqual({
			turnNum: 5,
			headingText: "Why is Y like that?",
			displayText: "Turn 5: Why is Y like that?",
		});
	});
});
