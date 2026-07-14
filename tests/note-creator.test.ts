import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPerplexityNote } from "../src/note-creator";

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
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("already exists");
		}
	});

	it("creates file with clipboard content", async () => {
		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "my clipboard content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
		});

		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("test.md"),
			"my clipboard content"
		);
		expect(result.success).toBe(true);
	});

	it("sanitizes filename", async () => {
		await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test:name",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
		});

		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("testname.md"),
			"content"
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
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
		});

		expect(result.success).toBe(true);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("ai-searches/test.md"),
			"content"
		);
	});

	it("uses custom searches folder", async () => {
		const result = await createPerplexityNote({
			app: mockApp,
			activeFile: mockActiveFile,
			clipboardContent: "content",
			filename: "test",
			searchesFolder: "custom-folder",
			generatedTag: "ai-generated",
		});

		expect(result.success).toBe(true);
		expect(mockApp.vault.create).toHaveBeenCalledWith(
			expect.stringContaining("custom-folder/test.md"),
			"content"
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
		});

		expect(capturedFm.tags).toContain("custom-tag");
	});
});
