import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import {
	hasLiteratureNoteCategory,
	isDirectChildOfFolder,
	isLiteratureNote,
	isMarkdownFile,
	getLitNoteFiles,
	findLitNoteForCitekey,
	findLitNoteFile,
} from "../../src/litNote/litNoteFinder";

describe("litNoteFinder - unified literature note discovery", () => {
	describe("hasLiteratureNoteCategory", () => {
		it("detects literaturenote as array", () => {
			expect(hasLiteratureNoteCategory({ category: ["literaturenote"] })).toBe(true);
			expect(hasLiteratureNoteCategory({ category: ["other", "LiteratureNote"] })).toBe(true);
		});

		it("detects literaturenote as string", () => {
			expect(hasLiteratureNoteCategory({ category: "literaturenote" })).toBe(true);
			expect(hasLiteratureNoteCategory({ category: "LiteratureNote" })).toBe(true);
		});

		it("rejects missing, undefined, or other categories", () => {
			expect(hasLiteratureNoteCategory(undefined)).toBe(false);
			expect(hasLiteratureNoteCategory(null)).toBe(false);
			expect(hasLiteratureNoteCategory({})).toBe(false);
			expect(hasLiteratureNoteCategory({ category: ["aisearch"] })).toBe(false);
			expect(hasLiteratureNoteCategory({ category: "general" })).toBe(false);
		});
	});

	describe("isDirectChildOfFolder", () => {
		it("accepts direct children of litNotesFolder", () => {
			const file = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/Chen24.md",
				parent: { path: "lit/lit_notes" },
			});
			expect(isDirectChildOfFolder(file, "lit/lit_notes")).toBe(true);
		});

		it("rejects subdirectories (e.g. ai-searches)", () => {
			const subFile = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/ai-searches/Molmen25trainMitochondCapill_IntensityVsResult_Graph.md",
				parent: { path: "lit/lit_notes/ai-searches" },
			});
			expect(isDirectChildOfFolder(subFile, "lit/lit_notes")).toBe(false);
		});

		it("rejects files outside litNotesFolder", () => {
			const sourceFile = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_sources/Paper.pdf",
				parent: { path: "lit/lit_sources" },
			});
			expect(isDirectChildOfFolder(sourceFile, "lit/lit_notes")).toBe(false);
		});
	});

	describe("isMarkdownFile", () => {
		it("accepts .md files", () => {
			const mdFile = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/Chen24.md",
				extension: "md",
			});
			expect(isMarkdownFile(mdFile)).toBe(true);
		});

		it("rejects .pdf files", () => {
			const pdfFile = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/Paper.pdf",
				extension: "pdf",
			});
			expect(isMarkdownFile(pdfFile)).toBe(false);
		});
	});

	describe("isLiteratureNote", () => {
		it("accepts valid literature notes with metadataCache category", () => {
			const file = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/Chen24.md",
				extension: "md",
				parent: { path: "lit/lit_notes" },
			});
			const mockApp: any = {
				metadataCache: {
					getFileCache: () => ({
						frontmatter: { category: ["literaturenote"] },
					}),
				},
			};
			expect(isLiteratureNote(mockApp, file, "lit/lit_notes")).toBe(true);
		});

		it("rejects notes without category: literaturenote", () => {
			const file = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/Graph.md",
				extension: "md",
				parent: { path: "lit/lit_notes" },
			});
			const mockApp: any = {
				metadataCache: {
					getFileCache: () => ({
						frontmatter: { tags: ["graph"] },
					}),
				},
			};
			expect(isLiteratureNote(mockApp, file, "lit/lit_notes")).toBe(false);
		});

		it("rejects notes in subdirectories even if category is present", () => {
			const subFile = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/ai-searches/Molmen25.md",
				extension: "md",
				parent: { path: "lit/lit_notes/ai-searches" },
			});
			const mockApp: any = {
				metadataCache: {
					getFileCache: () => ({
						frontmatter: { category: ["literaturenote"] },
					}),
				},
			};
			expect(isLiteratureNote(mockApp, subFile, "lit/lit_notes")).toBe(false);
		});
	});

	describe("getLitNoteFiles", () => {
		it("returns only valid lit notes directly in folder", () => {
			const valid1 = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/Chen24.md",
				extension: "md",
				parent: { path: "lit/lit_notes" },
				stat: { mtime: 2000 },
			});
			const subfolderNote = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/ai-searches/Molmen25trainMitochondCapill_IntensityVsResult_Graph.md",
				extension: "md",
				parent: { path: "lit/lit_notes/ai-searches" },
				stat: { mtime: 3000 },
			});
			const missingCategory = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/NoCategory.md",
				extension: "md",
				parent: { path: "lit/lit_notes" },
				stat: { mtime: 4000 },
			});

			const mockApp: any = {
				vault: {
					getMarkdownFiles: () => [valid1, subfolderNote, missingCategory],
				},
				metadataCache: {
					getFileCache: (f: any) => {
						if (f.path === "lit/lit_notes/Chen24.md") {
							return { frontmatter: { category: ["literaturenote"] } };
						}
						return { frontmatter: {} };
					},
				},
			};

			const result = getLitNoteFiles(mockApp, "lit/lit_notes");
			expect(result).toHaveLength(1);
			expect(result[0].path).toBe("lit/lit_notes/Chen24.md");
		});
	});

	describe("findLitNoteForCitekey and findLitNoteFile", () => {
		it("finds lit note file by citekey stem", () => {
			const valid = Object.assign(Object.create(TFile.prototype), {
				basename: "Chen24",
				path: "lit/lit_notes/Chen24.md",
				extension: "md",
				parent: { path: "lit/lit_notes" },
			});
			const mockApp: any = {
				vault: {
					getAbstractFileByPath: (p: string) => (p === "lit/lit_notes/Chen24.md" ? valid : null),
					getMarkdownFiles: () => [valid],
				},
				metadataCache: {
					getFileCache: () => ({ frontmatter: { category: ["literaturenote"] } }),
				},
			};

			expect(findLitNoteForCitekey(mockApp, "Chen24", "lit/lit_notes")).toBe("Chen24");
			expect(findLitNoteFile(mockApp, { litNotesFolder: "lit/lit_notes" }, "Chen24")).toBe(valid);
		});
	});
});
