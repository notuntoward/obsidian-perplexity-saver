import { describe, it, expect, vi, beforeEach } from "vitest";
import { importDialogFromClipboard } from "../../src/commands/import";

describe("importDialogFromClipboard", () => {
	let mockApp: any;

	beforeEach(() => {
		mockApp = {
			vault: {
				create: vi.fn().mockResolvedValue({ path: "folder/test.md" }),
				createFolder: vi.fn().mockResolvedValue(undefined),
				getAbstractFileByPath: vi.fn().mockReturnValue(null),
				getMarkdownFiles: vi.fn().mockReturnValue([]),
			},
			fileManager: {
				processFrontMatter: vi.fn().mockImplementation(async (_file, callback) => {
					const fm: Record<string, unknown> = {};
					await callback(fm);
				}),
			},
		};
	});

	it("imports correctly without relinking when autoRelinkSources is false", async () => {
		const result = await importDialogFromClipboard({
			app: mockApp,
			clipboardContent: "**You**\n\nTell me about climate.\n\n**AI answer**\n\nClimate change is real[^1_1].\n\n# Sources\n\n[^1_1]: [Climate Study Title](https://example.com/climate)",
			filename: "test",
			importFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			headlineOptions: { method: "lead" },
			autoRelinkSources: false,
		});

		expect(result.success).toBe(true);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			"ai-searches/test.md",
			expect.stringContaining("Climate Study Title")
		);
		// Verify we didn't perform any relinking to Zotero
		const writtenText = mockApp.vault.create.mock.calls[0][1];
		expect(writtenText).not.toContain("zotero://");
	});

	it("relinks sources when autoRelinkSources is true", async () => {
		// Mock the Zotero library returned by ZoteroClient
		const mockZoteroClient = {
			getItems: vi.fn().mockResolvedValue([
				{
					zotkey: "ZOTKEY1",
					citekey: "smith2024climate",
					title: "Climate Study Title",
					url: "https://example.com/climate",
				},
			]),
			findItemByUrl: vi.fn().mockReturnValue({
				zotkey: "ZOTKEY1",
				citekey: "smith2024climate",
				title: "Climate Study Title",
				url: "https://example.com/climate",
			}),
		};

		const result = await importDialogFromClipboard({
			app: mockApp,
			clipboardContent: "**You**\n\nTell me about climate.\n\n**AI answer**\n\nClimate change is real[^1_1].\n\n# Sources\n\n[^1_1]: [Climate Study Title](https://example.com/climate)",
			filename: "test",
			importFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			headlineOptions: { method: "lead" },
			autoRelinkSources: true,
			zoteroClient: mockZoteroClient,
		});

		expect(result.success).toBe(true);
		const writtenText = mockApp.vault.create.mock.calls[0][1];
		expect(writtenText).toContain("[^1_1]: **[Climate Study Title -> ZOTKEY1](zotero://select/library/items/ZOTKEY1)**");
	});

	it("handles case gracefully when autoRelinkSources is true but no sources/dialog present", async () => {
		const result = await importDialogFromClipboard({
			app: mockApp,
			clipboardContent: "**You**\n\nTell me about climate.\n\n**AI answer**\n\nClimate change is real, but I have no citations.",
			filename: "test",
			importFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			headlineOptions: { method: "lead" },
			autoRelinkSources: true,
		});

		expect(result.success).toBe(true);
		const writtenText = mockApp.vault.create.mock.calls[0][1];
		expect(writtenText).toContain("Climate change is real");
		expect(writtenText).not.toContain("# Sources");
	});
});
