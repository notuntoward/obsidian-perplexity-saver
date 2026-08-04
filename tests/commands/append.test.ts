import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendDialogFromClipboard } from "../../src/commands/append";
import { HeadlineOptions } from "../../src/normalize/headlines";

const HEADLINE_OPTIONS: HeadlineOptions = { method: "lead" };

describe("appendDialogFromClipboard", () => {
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
		Object.assign(navigator, {
			clipboard: { readText: vi.fn() },
		});
	});

	it("fails when the note has no existing turn anchors", async () => {
		mockApp.vault.read.mockResolvedValue("just some note text, no turns");
		(navigator.clipboard.readText as any).mockResolvedValue(
			"second question\n\n## Answer\n\nsecond answer[1]\n\n# Citations:\n[1] [A](https://a.com/)"
		);

		const result = await appendDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Import AI dialog from clipboard");
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
	});

	it("fails when the clipboard is empty", async () => {
		mockApp.vault.read.mockResolvedValue("### AI response (turn 1) ^turn-1\n\nbody");
		(navigator.clipboard.readText as any).mockResolvedValue("");

		const result = await appendDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Clipboard is empty");
	});

	it("appends a new turn pair after the highest existing turn id", async () => {
		const existing = `# Dialog

## First question ^turn-1

first question

first answer[^1_1]

# Sources

[^1_1]: [A](https://a.com/)
`;
		mockApp.vault.read.mockResolvedValue(existing);
		(navigator.clipboard.readText as any).mockResolvedValue(
			"second question\n\n## Answer\n\nsecond answer[1]\n\n# Citations:\n[1] [B](https://b.com/)"
		);

		const result = await appendDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(true);
		expect(result.turnsAppended).toBe(2);

		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toMatch(/## second question \^turn-2$/m);
		expect(written).toMatch(/> \[!Prompt\]\+\n> second question/);
		expect(written).not.toMatch(/### AI response/);
		expect(written).toContain("second question");
		expect(written).toContain("second answer[^2_1]");
		expect(written).toContain("first question");
		expect(written).toContain("first answer[^1_1]");
	});

	it("grows an existing source's ownership list when the appended turn re-cites the same URL", async () => {
		const existing = `# Dialog

## First question ^turn-1

first question

first answer[^1_1]

# Sources

[^1_1]: [A](https://a.com/)
`;
		mockApp.vault.read.mockResolvedValue(existing);
		(navigator.clipboard.readText as any).mockResolvedValue(
			"second question\n\n## Answer\n\nsame source again[1]\n\n# Citations:\n[1] [A](https://a.com/)"
		);

		const result = await appendDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(true);

		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toContain("[^1_1]: [A](https://a.com/)");
		expect(written).toContain("[^2_1]: [A](https://a.com/)");
		expect(written).toContain("same source again[^2_1]");
		expect(result.newSources).toBe(1);
	});

	it("mints a genuinely new source and reports it in newSources", async () => {
		const existing = `# Dialog

## First question ^turn-1

first question

first answer[^1_1]

# Sources

[^1_1]: [A](https://a.com/)
`;
		mockApp.vault.read.mockResolvedValue(existing);
		(navigator.clipboard.readText as any).mockResolvedValue(
			"second question\n\n## Answer\n\nnew source[1]\n\n# Citations:\n[1] [B](https://b.com/)"
		);

		const result = await appendDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(true);
		expect(result.newSources).toBe(1);

		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toContain("[^1_1]: [A](https://a.com/)");
		expect(written).toContain("[^2_1]: [B](https://b.com/)");
	});
});
