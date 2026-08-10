import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPerplexityNote } from "../src/note-creator";
import { ZoteroClient } from "../src/zotero/zoteroClient";

describe("createPerplexityNote", () => {
	let mockApp: any;
	let mockActiveFile: any;

	beforeEach(() => {
		mockApp = {
			vault: {
				create: vi.fn().mockResolvedValue({ path: "folder/ai-searches/test.md" }),
				createFolder: vi.fn().mockResolvedValue(undefined),
				getAbstractFileByPath: vi.fn().mockReturnValue(null),
			},
			fileManager: {
				processFrontMatter: vi.fn().mockImplementation(async (_file, callback) => {
					const fm: Record<string, unknown> = {};
					await callback(fm);
				}),
				generateMarkdownLink: vi.fn().mockReturnValue("[[test]]"),
			},
		};

		mockActiveFile = {
			path: "folder/test-note.md",
			parent: { path: "folder" },
		};

		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
				readText: vi.fn().mockResolvedValue(""),
			},
		});
	});

	it("creates folder when it doesn't exist", async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			headlineOptions: { method: "lead" },
		});

		expect(mockApp.vault.createFolder).toHaveBeenCalled();
		expect(result.success).toBe(true);
	});

	it("does not create folder when it already exists", async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue({ path: "folder/ai-searches" });

		await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
	});

	it("returns error when file already exists", async () => {
		mockApp.vault.getAbstractFileByPath
			.mockReturnValueOnce({ path: "folder/ai-searches" })
			.mockReturnValueOnce({ path: "folder/ai-searches/test.md" });

		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("already exists");
		}
	});

	it("creates file with normalized body content", async () => {
		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "**You**\n\nmy question\n\n**AI answer**\n\nmy clipboard content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		// The clipboard is now run through the normalizer, so the written
		// body is the uniform format, not the raw clipboard text.
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("test.md"),
			expect.stringContaining("my clipboard content")
		);
		expect(result.success).toBe(true);
	});

	it("sanitizes filename", async () => {
		await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "**You**\n\nq\n\n**AI answer**\n\na",
			filename: "test:name",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("testname.md"),
			expect.any(String)
		);
	});

	it("returns error for empty sanitized filename", async () => {
		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "///",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("invalid characters");
		}
	});

	it("clears clipboard after creating note", async () => {
		await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith("");
	});

	it("adds tag to frontmatter", async () => {
		let capturedFm: Record<string, unknown> = {};
		mockApp.fileManager.processFrontMatter.mockImplementation(async (_file: any, callback: any) => {
			capturedFm = {};
			await callback(capturedFm);
		});

		await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(capturedFm.tags).toContain("ai-generated");
	});

	it("does not duplicate existing tag", async () => {
		let capturedFm: Record<string, unknown> = { tags: ["ai-generated"] };
		mockApp.fileManager.processFrontMatter.mockImplementation(async (_file: any, callback: any) => {
			capturedFm = { tags: ["ai-generated"] };
			await callback(capturedFm);
		});

		await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect((capturedFm.tags as string[]).filter((t) => t === "ai-generated")).toHaveLength(1);
	});

	it("generates markdown link", async () => {
		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(mockApp.fileManager.generateMarkdownLink).toHaveBeenCalled();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.linkText).toBe("[[test]]");
		}
	});

	it("handles file in root folder (no parent)", async () => {
		mockActiveFile.parent = null;

		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "**You**\n\nq\n\n**AI answer**\n\na",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(result.success).toBe(true);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("ai-searches/test.md"),
			expect.any(String)
		);
	});

	it("uses custom searches folder", async () => {
		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "**You**\n\nq\n\n**AI answer**\n\na",
			filename: "test",
			searchesFolder: "custom-folder",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(result.success).toBe(true);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("custom-folder/test.md"),
			expect.any(String)
		);
	});

	it("uses custom generated tag", async () => {
		let capturedFm: Record<string, unknown> = {};
		mockApp.fileManager.processFrontMatter.mockImplementation(async (_file: any, callback: any) => {
			capturedFm = {};
			await callback(capturedFm);
		});

		await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "custom-tag",
			collapseBlankLines: true,
		headlineOptions: { method: "lead" },
		});

		expect(capturedFm.tags).toContain("custom-tag");
	});

	it("uses prefetched dialog promise if provided", async () => {
		const mockPrefetchedDialog = {
			sourceVendor: "perplexity" as const,
			sourceUrl: "https://perplexity.ai/test",
			turns: [
				{
					role: "prompt" as const,
					rawText: "prefetched query",
					citations: [],
				},
				{
					role: "ai" as const,
					rawText: "prefetched answer",
					citations: [],
				},
			],
		};
		const prefetchedDialogPromise = Promise.resolve(mockPrefetchedDialog);

		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "any content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			headlineOptions: { method: "lead" },
			prefetchedDialogPromise,
		});

		expect(result.success).toBe(true);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("test.md"),
			expect.stringContaining("prefetched answer")
		);
	});
});

describe("createPerplexityNote with auto-relinking", () => {
	let mockApp: any;
	let mockActiveFile: any;

	const RELINKED_SOURCE = "zotero://select/library/items/ZOTKEY1";
	const CLIPBOARD_WITH_SOURCE =
		"# my question\n\nmy answer[1]\n\n# Citations:\n[1] [Climate Study Title](https://example.com/climate)";

	beforeEach(() => {
		mockApp = {
			vault: {
				create: vi.fn().mockResolvedValue({ path: "folder/ai-searches/test.md" }),
				createFolder: vi.fn().mockResolvedValue(undefined),
				getAbstractFileByPath: vi.fn().mockReturnValue(null),
				getMarkdownFiles: vi.fn().mockReturnValue([]),
			},
			fileManager: {
				processFrontMatter: vi.fn().mockImplementation(async (_file, callback) => {
					const fm: Record<string, unknown> = {};
					await callback(fm);
				}),
				generateMarkdownLink: vi.fn().mockReturnValue("[[test]]"),
			},
		};

		mockActiveFile = {
			path: "folder/test-note.md",
			parent: { path: "folder" },
		};

		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
				readText: vi.fn().mockResolvedValue(""),
			},
		});
	});

	function matchedClient(): ZoteroClient {
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
		return client;
	}

	it("relinks the note body when autoRelinkSources is enabled", async () => {
		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: CLIPBOARD_WITH_SOURCE,
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			headlineOptions: { method: "lead" },
			autoRelinkSources: true,
			zoteroPort: 23119,
			litNotesFolder: "",
			minTitleMatchScore: 95,
			zoteroClient: matchedClient(),
		});

		expect(result.success).toBe(true);
		const written = mockApp.vault.create.mock.calls[0][1] as string;
		expect(written).toContain(RELINKED_SOURCE);
	});

	it("writes the un-relinked body when auto-relinking fails", async () => {
		const failingClient: any = { getItems: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };

		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: CLIPBOARD_WITH_SOURCE,
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			headlineOptions: { method: "lead" },
			autoRelinkSources: true,
			zoteroPort: 23119,
			litNotesFolder: "",
			minTitleMatchScore: 95,
			zoteroClient: failingClient,
		});

		expect(result.success).toBe(true);
		const written = mockApp.vault.create.mock.calls[0][1] as string;
		expect(written).not.toContain(RELINKED_SOURCE);
		expect(written).toContain("[^1_1]: [Climate Study Title](https://example.com/climate)");
	});
});
