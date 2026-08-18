import { describe, expect, it } from "vitest";
import {
	buildInfoCalloutLinks,
	buildInfoCalloutPrefix,
	buildLitNoteBody,
	buildLitNoteFrontmatter,
	cleanupBibliography,
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
		it("builds links with all attachment types", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				desktopURI: "zotero://select/items/1",
				DOI: "10.1234/test",
				url: "https://example.com",
				attachments: [
					{ path: "/path/to/doc.pdf" },
					{ path: "C:\\Users\\Bob\\file.epub" },
				],
			};
			const links = buildInfoCalloutLinks(item);
			expect(links).toBe("[**Zotero**](zotero://select/items/1) | [**DOI**](https://doi.org/10.1234/test) | [**URL**](https://example.com) | **[[doc.pdf|PDF]]** | **[[file.epub|EPUB]]**");
		});

		it("builds prefix with abstract and creators", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "test",
				abstractNote: "This is \n an abstract.",
				creators: [
					{ creatorType: "author", firstName: "Jane", lastName: "Doe" },
					{ creatorType: "editor", name: "Institution" },
				],
			};
			const prefix = buildInfoCalloutPrefix(item);
			expect(prefix).toContain("> **Abstract**\n> This is   an abstract.\n>");
			expect(prefix).toContain("> **Author**:: Doe, Jane\n> **Editor**:: Institution");
		});

		it("handles empty prefix components", () => {
			const item: ZoteroItemPayload = { title: "Test", citekey: "test" };
			expect(buildInfoCalloutPrefix(item)).toBe("");
		});
	});

	describe("Frontmatter", () => {
		it("builds correct frontmatter fields", () => {
			const item: ZoteroItemPayload = {
				title: "A Very Long Title About Testing That Gets Truncated",
				citekey: "Test2024",
				tags: ["Machine Learning", "AI"],
				collections: ["My Collection"],
			};
			const fm = buildLitNoteFrontmatter(item);
			expect(fm.citekey).toBe("Test2024");
			expect(fm.aliases).toEqual(["A Very Long Title About Testing That Gets Truncated", "A Very Long Title About"]);
			expect(fm.ZoteroTags).toEqual(["machine_learning", "ai"]);
			expect(fm.ZoteroCollections).toEqual(["my_collection"]);
		});
	});

	describe("Full note body Regressions", () => {
		it("assembles the complete note with all branches", () => {
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
			expect(body).toContain("> **Title**:: \"Test Note\"");
			expect(body).toContain("> **Related**:: [[@Related1]], [[@Related2]]");
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
