import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteDialogTurn } from "../../src/commands/delete";

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

	it("successfully deletes the targeted turn block and prunes scoped sources", async () => {
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
		expect(result.prunedCount).toBe(1); // source B [^2_1] is fully pruned since turn 2 is deleted

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
