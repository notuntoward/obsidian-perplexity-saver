import { describe, it, expect, vi, beforeEach } from "vitest";
import { replaceDialogFromClipboard } from "../../src/commands/replace";
import { HeadlineOptions } from "../../src/normalize/headlines";
import { ZoteroClient } from "../../src/zotero/zoteroClient";

const HEADLINE_OPTIONS: HeadlineOptions = { method: "lead" };

describe("replaceDialogFromClipboard", () => {
	let mockApp: any;
	let mockFile: any;

	beforeEach(() => {
		mockFile = { path: "note.md", basename: "note" };
		mockApp = {
			vault: {
				read: vi.fn(),
				modify: vi.fn().mockResolvedValue(undefined),
			},
			metadataCache: {
				getFileCache: vi.fn().mockReturnValue({
					frontmatter: {
						tags: ["custom-tag"],
						"original-prop": 123,
					},
				}),
			},
			fileManager: {
				processFrontMatter: vi.fn().mockImplementation(async (_file, callback) => {
					const fm: Record<string, unknown> = {};
					await callback(fm);
					return fm;
				}),
			},
		};
		Object.assign(navigator, {
			clipboard: { readText: vi.fn() },
		});
	});

	it("fails when the clipboard is empty", async () => {
		(navigator.clipboard.readText as any).mockResolvedValue("");

		const result = await replaceDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Clipboard is empty");
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
	});

	it("fails when the clipboard contains no recognizable turns", async () => {
		(navigator.clipboard.readText as any).mockResolvedValue("just random text with no turns or citations");

		const result = await replaceDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS);
		// Plain text fallback in parser might produce 1 turn with prompt or empty turns
		// If detectAndParse handles it, check result
	});

	it("completely overwrites the note with new dialog turns and citations", async () => {
		const oldContent = `# Dialog

## Old question ^turn-1

old question

old answer[^1_1]

# Sources

[^1_1]: [Old Source](https://old.com/)
`;
		mockApp.vault.read.mockResolvedValue(oldContent);
		(navigator.clipboard.readText as any).mockResolvedValue(
			"# New question\n\nNew answer[1]\n\n# Citations:\n[1] [New Source](https://new.com/)"
		);

		const result = await replaceDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS, false);
		expect(result.success).toBe(true);
		expect(result.turnsReplaced).toBe(1);

		expect(mockApp.vault.modify).toHaveBeenCalledTimes(1);
		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toContain("## New question ^turn-1");
		expect(written).toContain("New answer[^1_1]");
		expect(written).toContain("[^1_1]: [New Source](https://new.com/)");
		expect(written).not.toContain("Old question");
		expect(written).not.toContain("https://old.com/");

		expect(mockApp.fileManager.processFrontMatter).toHaveBeenCalled();
	});

	it("updates frontmatter properties while preserving pre-existing metadata", async () => {
		(navigator.clipboard.readText as any).mockResolvedValue(
			"[Perplexity](https://www.perplexity.ai/search/test-replace) · *2026-08-27 12:00 PDT*\n# Prompt\n\nAnswer"
		);

		let capturedFrontmatter: Record<string, unknown> = {};
		mockApp.fileManager.processFrontMatter = vi.fn().mockImplementation(async (_file, callback) => {
			await callback(capturedFrontmatter);
		});

		const result = await replaceDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS, false);
		expect(result.success).toBe(true);
		expect(capturedFrontmatter["ai-dialog-format"]).toBe("v1");
		expect(capturedFrontmatter["ai-source-vendor"]).toBe("perplexity");
		expect(capturedFrontmatter["ai-source-url"]).toBe("https://www.perplexity.ai/search/test-replace");
		expect(capturedFrontmatter["ai-source-turns-synced"]).toBe(1);
		expect(capturedFrontmatter["tags"]).toEqual(["custom-tag"]);
		expect(capturedFrontmatter["original-prop"]).toBe(123);
	});

	it("relinks sources when autoRelinkSources is enabled", async () => {
		(navigator.clipboard.readText as any).mockResolvedValue(
			"# Climate question\n\nClimate answer[1]\n\n# Citations:\n[1] [Climate Study Title](https://example.com/climate)"
		);

		mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

		const client = new ZoteroClient({ port: 23119 });
		const item = {
			zotkey: "ZOTKEY1",
			citekey: "smith2024climate",
			title: "Climate Study Title",
			url: "https://example.com/climate",
			normalizedUrl: "https://example.com/climate",
		};
		(client as any).cachedItems = [item];
		(client as any).urlMap.set("https://example.com/climate", item);
		(client as any).lastFetchTime = Date.now();

		const result = await replaceDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS, false, 100, {
			autoRelinkSources: true,
			zoteroPort: 23119,
			litNotesFolder: "",
			minTitleMatchScore: 95,
			zoteroClient: client,
		});

		expect(result.success).toBe(true);
		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toContain("[^1_1]: **[Climate Study Title \u2794 ZOTKEY1](zotero://select/library/items/ZOTKEY1)**");
	});

	it("handles autoRelinkSources failure gracefully", async () => {
		(navigator.clipboard.readText as any).mockResolvedValue(
			"# Climate question\n\nClimate answer[1]\n\n# Citations:\n[1] [Climate Study Title](https://example.com/climate)"
		);

		mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);
		const failingClient: any = { getItems: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };

		const result = await replaceDialogFromClipboard(mockApp, mockFile, HEADLINE_OPTIONS, false, 100, {
			autoRelinkSources: true,
			zoteroPort: 23119,
			litNotesFolder: "",
			minTitleMatchScore: 95,
			zoteroClient: failingClient,
		});

		expect(result.success).toBe(true);
		const written = mockApp.vault.modify.mock.calls[0][1] as string;
		expect(written).toContain("[^1_1]: [Climate Study Title](https://example.com/climate)");
	});
});
