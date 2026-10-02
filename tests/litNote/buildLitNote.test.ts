import { describe, expect, it } from "vitest";
import {
	buildAliases,
	buildInfoCalloutLinks,
	buildInfoCalloutPrefix,
	buildLitNoteBody,
	buildLitNoteFrontmatter,
	cleanupBibliography,
	formatObsidianDate,
	zoteroHtmlToMd,
} from "../../src/litNote/buildLitNote";
import type { ZoteroItemPayload } from "../../src/litNote/types";

describe("Lit Note Builder", () => {
	it("cleans up bibliography text", () => {
		const raw = "Smith, J. (2020). _Test_. http://example.com, doi.org/10.1234/567, .";
		expect(cleanupBibliography(raw)).toBe("Smith, J. (2020). _Test_.");
	});

	it("converts zotero HTML to markdown", () => {
		const html = `<p><span class="citation" data-citation="{}">(Smith, 2020)</span> said hello.</p><ul><li><span style="background-color: #ffcc00">Highlight</span></li></ul>`;
		const mockApp = { vault: { getAbstractFileByPath: () => null } } as any;
		const mockSettings = { litNotesFolder: "" } as any;
		const md = zoteroHtmlToMd(mockApp, mockSettings, html);
		expect(md).toContain("(Smith, 2020) said hello.");
		expect(md).toContain("==Highlight==");
	});

	describe("Callout components", () => {
		it("builds links with all attachment types using itemkey", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				itemkey: "VVUZBQM2",
				DOI: "10.1234/test",
				url: "https://example.com",
				attachments: [
					{ path: "/path/to/doc.pdf" },
					{ path: "C:\\Users\\Bob\\file.epub" },
				],
			};
			const links = buildInfoCalloutLinks(item);
			expect(links).toBe("[**Zotero**](zotero://select/library/items/VVUZBQM2) | [**DOI**](https://doi.org/10.1234/test) | [**URL**](https://example.com) | **[[doc.pdf|PDF]]** | **[[file.epub|EPUB]]**");
		});

		it("always builds clean item select links using itemkey regardless of collections", () => {
			const itemWithCollections: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				itemkey: "6EX2GZ5P",
				collections: ["Scratch Space"],
			};
			expect(buildInfoCalloutLinks(itemWithCollections)).toBe("[**Zotero**](zotero://select/library/items/6EX2GZ5P)");

			const itemWithEmptyCollections: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				itemkey: "VVUZBQM2",
				collections: [],
			};
			expect(buildInfoCalloutLinks(itemWithEmptyCollections)).toBe("[**Zotero**](zotero://select/library/items/VVUZBQM2)");
		});

		it("falls back to desktopURI or extracts item key if itemkey is not directly provided", () => {
			const itemWithHttpDesktopUri: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				desktopURI: "http://zotero.org/users/local/123/items/SWDUCE7N",
			};
			expect(buildInfoCalloutLinks(itemWithHttpDesktopUri)).toBe("[**Zotero**](zotero://select/library/items/SWDUCE7N)");

			const itemWithCustomDesktopUri: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				desktopURI: "zotero://select/library/items/ABC123",
			};
			expect(buildInfoCalloutLinks(itemWithCustomDesktopUri)).toBe("[**Zotero**](zotero://select/library/items/ABC123)");
		});

		it("builds prefix with abstract", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				abstractNote: "This is \n an abstract.",
			};
			const prefix = buildInfoCalloutPrefix(item);
			expect(prefix).toContain("> **Abstract**\n> This is   an abstract.");
		});

		it("handles empty prefix components", () => {
			const item: ZoteroItemPayload = { title: "Test", citekey: "test" };
			expect(buildInfoCalloutPrefix(item)).toBe("");
		});
	});

	describe("Frontmatter", () => {
		it("builds correct frontmatter fields including authors and file properties", () => {
			const item: ZoteroItemPayload = {
				title: "A Very Long Title About Testing That Gets Truncated",
				citekey: "Test2024",
				date: "2024-05-10",
				itemkey: "KEY123",
				itemType: "journalArticle",
				DOI: "10.1234/test",
				url: "https://example.com/paper",
				publicationTitle: "Journal of Testing",
				tags: ["Machine Learning", "AI"],
				collections: ["My Collection"],
				creators: [{ firstName: "Jane", lastName: "Doe", creatorType: "author" }],
			};
			const fm = buildLitNoteFrontmatter(item);
			expect(fm.citekey).toBe("Test2024");
			expect(fm.title).toBe("A Very Long Title About Testing That Gets Truncated");
			expect(fm.authors).toEqual(["Doe, Jane"]);
			expect(fm.publication_date).toBe("2024-05-10");
			expect(fm.zotero_item_key).toBe("KEY123");
			expect(fm.zotero_item_type).toBe("journalArticle");
			expect(fm.doi).toBe("10.1234/test");
			expect(fm.url).toBe("https://example.com/paper");
			expect(fm.publication).toBe("Journal of Testing");
			expect(fm.aliases).toEqual(["A Very Long Title About Testing That Gets Truncated", "A Very Long Title About"]);
			expect(fm.zotero_tags).toEqual(["machine_learning", "ai"]);
			expect(fm.zotero_collections).toEqual(["my_collection"]);
			expect(fm.in_progress).toBe(false);

			// created_date is set with obsidian-compliant timestamp of the time the note was created in offset format
			expect(fm.created_date).toBeDefined();
			expect(typeof fm.created_date).toBe("string");
			expect(fm.created_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
			// modified_date is NOT created on note creation
			expect(fm.modified_date).toBeUndefined();

			// Frontmatter keys must be in canonical FRONTMATTER_ORDER with zotero_tags directly above created_date
			const keys = Object.keys(fm);
			const zoteroTagsIdx = keys.indexOf("zotero_tags");
			const createdDateIdx = keys.indexOf("created_date");
			expect(zoteroTagsIdx).toBeGreaterThan(-1);
			expect(createdDateIdx).toBe(zoteroTagsIdx + 1);
		});

		it("uses exportDate for created_date when provided in Zotero payload", () => {
			const item: ZoteroItemPayload = {
				title: "Exported Item",
				citekey: "Export24",
				exportDate: "2024-05-08T14:01:11.313-07:00",
			};
			const fm = buildLitNoteFrontmatter(item);
			expect(fm.created_date).toBe("2024-05-08T14:01:11-07:00");
			expect(fm.modified_date).toBeUndefined();
		});

		it("ensures first alias item is the title when title is 5 words or fewer", () => {
			const item: ZoteroItemPayload = {
				title: "Short Title Here",
				citekey: "Short24",
			};
			const fm = buildLitNoteFrontmatter(item);
			expect(fm.title).toBe("Short Title Here");
			expect(fm.aliases).toEqual(["Short Title Here"]);
		});

		it("formats publication_date according to ISO 8601 rules", () => {
			expect(formatObsidianDate("2024-05-10")).toBe("2024-05-10");
			expect(formatObsidianDate("2026-07-13T11:33:04-07:00")).toBe("2026-07-13T11:33");
			expect(formatObsidianDate("2026-08-31T17:43:25.813Z")).toBe("2026-08-31T17:43");
			expect(formatObsidianDate("2024")).toBe("2024");
			expect(formatObsidianDate("2024-05")).toBe("2024-05");
			expect(formatObsidianDate("")).toBe("");
		});

		it("builds aliases with title first, 5-word truncated next, and existing aliases preserved", () => {
			const aliases = buildAliases("A Very Long Article Title That Exceeds Five Words", [
				"Custom Short Alias",
				"a very long article title that exceeds five words",
			]);
			expect(aliases).toEqual([
				"A Very Long Article Title That Exceeds Five Words",
				"A Very Long Article Title",
				"Custom Short Alias",
			]);
		});

		it("converts Creator and Director to authors and excludes non-author creator types (editor, translator)", () => {
			const item: ZoteroItemPayload = {
				title: "Multimedia Project",
				citekey: "Media2024",
				creators: [
					{ firstName: "Jon", lastName: "Favreau", creatorType: "creator" },
					{ firstName: "Christopher", lastName: "Nolan", creatorType: "director" },
					{ firstName: "Donald", lastName: "Knuth", creatorType: "editor" },
					{ firstName: "Robert", lastName: "Fagles", creatorType: "translator" },
				],
			};
			const fm = buildLitNoteFrontmatter(item);
			expect(fm.authors).toEqual(["Favreau, Jon", "Nolan, Christopher"]);
		});

		it("converts firstDirector and firstProgrammer creator types to authors in Zotero payload", () => {
			const item: ZoteroItemPayload = {
				title: "Doom Documentary",
				citekey: "Doom2024",
				creators: [
					{ firstName: "John", lastName: "Carmack", creatorType: "firstProgrammer" },
					{ firstName: "Christopher", lastName: "Nolan", creatorType: "firstDirector" },
					{ firstName: "Donald", lastName: "Knuth", creatorType: "firstEditor" },
				],
			};
			const fm = buildLitNoteFrontmatter(item);
			expect(fm.authors).toEqual(["Carmack, John", "Nolan, Christopher"]);
		});
	});

	describe("Full note body Regressions", () => {
		it("assembles the complete note with clean callouts and all branches", () => {
			const item: ZoteroItemPayload = {
				title: "Test Note",
				citekey: "Test24",
				date: "2024-01-01",
				bibliography: "Smith (2024).",
				notes: ["<p>Note 1</p>", "<h1>Note 2</h1>"],
				relations: [{ citekey: "Related1" }, { citekey: "Related2" }],
			};
			const mockApp = { vault: { getAbstractFileByPath: () => null } } as any;
			const mockSettings = { litNotesFolder: "" } as any;
			const body = buildLitNoteBody(mockApp, mockSettings, item);
			expect(body).toContain("> [!info]- &nbsp;[**Zotero**]()");
			expect(body).toContain("> Smith (2024)."); // bibliography
			expect(body).toContain("> [!note]- &nbsp;Zotero Note (2)");
			expect(body).toContain("> Note 1");
			expect(body).toContain("> ### Note 2"); // h1 promoted to h3 and indented
		});

		it("ensures there is a blank line before the first info callout to prevent Live Preview auto-expansion", () => {
			const item: ZoteroItemPayload = {
				title: "Test Note",
				citekey: "Test24",
			};
			const mockApp = { vault: { getAbstractFileByPath: () => null } } as any;
			const mockSettings = { litNotesFolder: "" } as any;
			const body = buildLitNoteBody(mockApp, mockSettings, item);
			
			// The regression: Obsidian auto-expands callouts if they are on the very first visible line.
			// The generated body string MUST start with a newline to prevent this.
			expect(body.startsWith("\n> [!info]-")).toBe(true);
		});
	});
});
