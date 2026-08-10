import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncDialogFromClipboard } from "../../src/commands/sync";
import { HeadlineOptions } from "../../src/normalize/headlines";
import { ZoteroClient } from "../../src/zotero/zoteroClient";

const HEADLINE_OPTIONS: HeadlineOptions = { method: "lead" };

describe("syncDialogFromClipboard", () => {
	let mockApp: any;
	let mockFile: any;

	beforeEach(() => {
		mockFile = { path: "note.md" };
		mockApp = {
			vault: {
				read: vi.fn(),
				modify: vi.fn().mockResolvedValue(undefined),
			},
			metadataCache: {
				getFileCache: vi.fn().mockReturnValue({}),
			},
			fileManager: {
				processFrontMatter: vi.fn().mockImplementation(async (_file, callback) => {
					const fm = {};
					await callback(fm);
				}),
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

		const result = await syncDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Import AI dialog from clipboard");
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
	});

	it("fails when the clipboard is empty", async () => {
		mockApp.vault.read.mockResolvedValue("### AI response (turn 1) ^turn-1\n\nbody");
		(navigator.clipboard.readText as any).mockResolvedValue("");

		const result = await syncDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Clipboard is empty");
	});

	it("appends a new turn pair after the highest existing turn id (legacy fallback behavior)", async () => {
		const existing = `# Dialog

## First question ^turn-1

first question

first answer[^1_1]

# Sources

[^1_1]: [A](https://a.com/)
`;
		mockApp.vault.read.mockResolvedValue(existing);
		(navigator.clipboard.readText as any).mockResolvedValue(
			"# first question\n\nfirst answer[1]\n\n---\n\n# second question\n\nsecond answer[2]\n\n# Citations:\n[1] [A](https://a.com/)\n[2] [B](https://b.com/)"
		);

		const result = await syncDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(true);
		expect(result.turnsSynced).toBe(1);

		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toMatch(/## second question \^turn-2$/m);
		expect(written).toMatch(/> \[!Prompt\]\+\n> second question/);
		expect(written).toContain("second question");
		expect(written).toContain("second answer[^2_1]");
		expect(written).toContain("first question");
		expect(written).toContain("first answer[^1_1]");
	});

	it("uses frontmatter watermark to slice incoming turns when available", async () => {
		const existing = `# Dialog

## First question ^turn-1

first question

first answer[^1_1]

## Second question ^turn-2

second question

second answer[^2_1]

# Sources

[^1_1]: [A](https://a.com/)
[^2_1]: [B](https://b.com/)
`;
		mockApp.vault.read.mockResolvedValue(existing);
		// Simulate frontmatter with turns synced count = 3 (even though turn 3 was manually deleted and max surviving index is 2)
		mockApp.metadataCache.getFileCache.mockReturnValue({
			frontmatter: {
				"ai-source-turns-synced": 3,
			},
		});

		// Clipboard contains a total of 4 logical turns
		const clipboardContent = `[Perplexity](https://www.perplexity.ai/search/x) · *2026-07-27 10:18 PDT*
# Q1

A1

---

# Q2

A2

---

# Q3

A3

---

# Q4

A4`;
		(navigator.clipboard.readText as any).mockResolvedValue(clipboardContent);

		const result = await syncDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(true);
		expect(result.turnsSynced).toBe(1); // Only turn 4 is synced (clipboard index 3)

		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toMatch(/## Q4 \^turn-3$/m); // Next monotonic local index is 3 (max surviving 2 + 1)
		expect(written).not.toContain("Q3"); // Turn 3 should not be re-appended since synced watermark was 3
	});

	it("relinks the synced note when autoRelinkSources is enabled", async () => {
		const existing = `# Dialog

## First question ^turn-1

first question

first answer[^1_1]

# Sources

[^1_1]: [A](https://a.com/)
`;
		mockApp.vault.read.mockResolvedValue(existing);
		(navigator.clipboard.readText as any).mockResolvedValue(
			"# first question\n\nfirst answer[1]\n\n---\n\n# second question\n\nsecond answer[2]\n\n# Citations:\n[1] [A](https://a.com/)\n[2] [B](https://b.com/)"
		);
		mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

		const client = new ZoteroClient({ port: 23119 });
		const item = {
			zotkey: "ZOTB1",
			citekey: "author2026b",
			title: "B",
			url: "https://b.com/",
			normalizedUrl: "https://b.com",
		};
		(client as any).cachedItems = [item];
		(client as any).urlMap.set("https://b.com", item);
		(client as any).lastFetchTime = Date.now();

		const result = await syncDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS, true, 100, {
			autoRelinkSources: true,
			zoteroPort: 23119,
			litNotesFolder: "",
			minTitleMatchScore: 95,
			zoteroClient: client,
		});
		expect(result.success).toBe(true);
		expect(result.turnsSynced).toBe(1);

		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toContain("## second question ^turn-2");
		expect(written).toContain("[^2_1]: **[B \u2794 ZOTB1](zotero://select/library/items/ZOTB1)**");
	});

	it("still syncs when auto-relinking fails because Zotero is unreachable", async () => {
		const existing = `# Dialog

## First question ^turn-1

first question

first answer[^1_1]

# Sources

[^1_1]: [A](https://a.com/)
`;
		mockApp.vault.read.mockResolvedValue(existing);
		(navigator.clipboard.readText as any).mockResolvedValue(
			"# first question\n\nfirst answer[1]\n\n---\n\n# second question\n\nsecond answer[2]\n\n# Citations:\n[1] [A](https://a.com/)\n[2] [B](https://b.com/)"
		);
		mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

		const failingClient: any = { getItems: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };

		const result = await syncDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS, true, 100, {
			autoRelinkSources: true,
			zoteroPort: 23119,
			litNotesFolder: "",
			minTitleMatchScore: 95,
			zoteroClient: failingClient,
		});
		expect(result.success).toBe(true);
		expect(result.turnsSynced).toBe(1);

		// The sync succeeds and the new source is written un-relinked.
		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toContain("## second question ^turn-2");
		expect(written).toContain("[^2_1]: [B](https://b.com/)");
	});
});
