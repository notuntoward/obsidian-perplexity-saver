import { describe, expect, it } from "vitest";
import {
	toSnakeCase,
	cleanTextValue,
	canonicalizeDoi,
	parseObsidianDate,
	formatObsidianDate,
	isEmptyValue,
	parseAuthorStringFallback,
	extractZoteroItemKey,
	FRONTMATTER_ORDER,
	orderFrontmatter,
	formatTimestampWithOffset,
} from "../../src/litNote/propertyUtils";
import {
	convertDataviewPropsToFrontmatter,
	stringifyOrderedFrontmatter,
} from "../../src/litNote/dataviewConverter";

describe("Property Normalization Rules", () => {
	describe("1. Property names", () => {
		it("converts camelCase, PascalCase, Title Case, spaces, hyphens, and mixed styles to lowercase snake_case", () => {
			expect(toSnakeCase("firstAuthor")).toBe("first_author");
			expect(toSnakeCase("ZoteroItemKey")).toBe("zotero_item_key");
			expect(toSnakeCase("created date")).toBe("created_date");
			expect(toSnakeCase("modified date")).toBe("modified_date");
			expect(toSnakeCase("in-progress")).toBe("in_progress");
			expect(toSnakeCase("Book Title")).toBe("book_title");
			expect(toSnakeCase("Publication-Title")).toBe("publication_title");
		});

		it("treats a run of capitals such as an acronym as one word", () => {
			expect(toSnakeCase("ZoteroURL")).toBe("zotero_url");
			expect(toSnakeCase("HTMLParser")).toBe("html_parser");
			expect(toSnakeCase("DOI")).toBe("doi");
			expect(toSnakeCase("ISBN")).toBe("isbn");
			expect(toSnakeCase("ItemTypeID")).toBe("item_type_id");
		});

		it("renames singular tag, alias, cssclass to plural and merges into existing plural key", async () => {
			const noteWithSingulars = `---
tag: machine-learning
tags:
  - artificial-intelligence
alias: Short Title
aliases:
  - Existing Alias
cssclass: custom-style
cssclasses:
  - wide-page
citekey: Doe24
title: Test Title
---

> [!info]-
> **FirstAuthor**:: Doe, Jane
> **Author**:: Smith, Bob
`;

			const res = await convertDataviewPropsToFrontmatter(noteWithSingulars, "lit/test.md");
			expect(res.success).toBe(true);

			const fm = res.updatedFm!;
			expect(fm.tags).toEqual(["machine-learning", "artificial-intelligence"]);
			expect(fm.tag).toBeUndefined();

			expect(fm.aliases).toEqual(["Test Title", "Short Title", "Existing Alias"]);
			expect(fm.alias).toBeUndefined();

			expect(fm.cssclasses).toEqual(["custom-style", "wide-page"]);
			expect(fm.cssclass).toBeUndefined();
		});

		it("does not overwrite values when two old names map to the same new name and logs for review", async () => {
			const noteWithCollision = `---
created date: 2024-01-01
created_date: 2024-02-02
citekey: Doe24
---

> [!info]-
> **FirstAuthor**:: Doe, Jane
> **Author**:: Smith, Bob
`;

			const res = await convertDataviewPropsToFrontmatter(noteWithCollision, "lit/test.md");
			expect(res.success).toBe(true);

			const fm = res.updatedFm!;
			// Both values preserved in offset format
			expect(fm.created_date).toMatch(/^2024-01-01T00:00:00[+-]\d{2}:\d{2}$/);
			expect(fm.created_date_review).toMatch(/^2024-02-02T00:00:00[+-]\d{2}:\d{2}$/);

			// Logged for review
			expect(res.changesMade?.some((c) => c.includes("Collision detected"))).toBe(true);
		});
	});

	describe("2. Property values", () => {
		describe("Text & Stray Trailing Punctuation", () => {
			it("trims whitespace and removes stray trailing commas and semicolons while preserving valid punctuation", () => {
				expect(cleanTextValue("  Smith, John,  ")).toBe("Smith, John");
				expect(cleanTextValue("Journal of Testing; ")).toBe("Journal of Testing");
				expect(cleanTextValue('"What is Life?"')).toBe("What is Life?");
				expect(cleanTextValue("Notice!")).toBe("Notice!");
			});

			it("quotes strings containing colons or # in YAML serialization", () => {
				const yaml = stringifyOrderedFrontmatter({
					title: "Sub: Title",
					tag_line: "#headline",
					citekey: "Key123",
				});
				expect(yaml).toContain('title: "Sub: Title"');
				expect(yaml).toContain('tag_line: "#headline"');
				expect(yaml).toContain("citekey: Key123");
			});
		});

		describe("Lists", () => {
			it("writes single values as a one-item YAML list and preserves order", () => {
				const yaml = stringifyOrderedFrontmatter({
					authors: ["Single Author, Jane"],
					aliases: ["One Alias"],
					tags: ["single-tag"],
				});
				expect(yaml).toContain("authors:\n  - Single Author, Jane");
				expect(yaml).toContain("aliases:\n  - One Alias");
				expect(yaml).toContain("tags:\n  - single-tag");
			});
		});

		describe("Dates", () => {
			it("writes YYYY-MM-DD for a date", () => {
				expect(formatObsidianDate("2026-03-15")).toBe("2026-03-15");
				expect(formatObsidianDate("2026/03/15")).toBe("2026-03-15");
				expect(formatObsidianDate("March 15, 2026")).toBe("2026-03-15");
				expect(formatObsidianDate("2026-03-15T00:00:00.000Z")).toBe("2026-03-15");
			});

			it("writes YYYY-MM-DDTHH:mm for a date with a time", () => {
				expect(formatObsidianDate("2026-07-13T11:33:04-07:00")).toBe("2026-07-13T11:33");
				expect(formatObsidianDate("2026-08-31T17:43:25.813Z")).toBe("2026-08-31T17:43");
			});

			it("keeps partial dates as YYYY or YYYY-MM without filling in missing parts", () => {
				expect(formatObsidianDate("2021")).toBe("2021");
				expect(formatObsidianDate("2024-05")).toBe("2024-05");
				expect(formatObsidianDate("May 2024")).toBe("2024-05");
			});

			it("flags ambiguous dates like 03/04/21 without guessing", () => {
				const res = parseObsidianDate("03/04/21");
				expect(res.isAmbiguous).toBe(true);
				expect(res.formatted).toBe("03/04/21");
			});

			it("resolves unambiguous slash dates where one number exceeds 12", () => {
				expect(formatObsidianDate("25/04/2021")).toBe("2021-04-25");
				expect(formatObsidianDate("04/25/2021")).toBe("2021-04-25");
			});
		});

		describe("Numbers and Booleans", () => {
			it("stores numbers and booleans as true primitives in YAML without quotes", () => {
				const yaml = stringifyOrderedFrontmatter({
					read: false,
					in_progress: true,
					volume: 12,
					year: 2021,
				});
				expect(yaml).toContain("read: false");
				expect(yaml).toContain("in_progress: true");
				expect(yaml).toContain("volume: 12");
				expect(yaml).toContain("year: 2021");
				expect(yaml).not.toContain('"false"');
				expect(yaml).not.toContain('"2021"');
			});
		});

		describe("Identifiers", () => {
			it("canonicalizes DOIs to bare 10.xxxx/... with no https://doi.org/ prefix", () => {
				expect(canonicalizeDoi("https://doi.org/10.1000/182")).toBe("10.1000/182");
				expect(canonicalizeDoi("http://dx.doi.org/10.1000/182")).toBe("10.1000/182");
				expect(canonicalizeDoi("doi:10.1000/182")).toBe("10.1000/182");
				expect(canonicalizeDoi("10.1000/182")).toBe("10.1000/182");
			});

			it("preserves ISBN content with spaces and hyphens exactly as supplied", async () => {
				const noteWithIsbn = `---
citekey: Book24
---

> [!info]-
> **FirstAuthor**:: Doe, Jane
> **Author**:: Smith, Bob
> **Title**:: Book Title
> **ISBN**:: 978-3-16-148410-0
`;
				const res = await convertDataviewPropsToFrontmatter(noteWithIsbn, "lit/test.md");
				expect(res.updatedFm?.isbn).toBe("978-3-16-148410-0");
			});
		});

		describe("Empty values", () => {
			it("identifies empty values correctly", () => {
				expect(isEmptyValue(null)).toBe(true);
				expect(isEmptyValue(undefined)).toBe(true);
				expect(isEmptyValue("")).toBe(true);
				expect(isEmptyValue("   ")).toBe(true);
				expect(isEmptyValue("N/A")).toBe(true);
				expect(isEmptyValue("none")).toBe(true);
				expect(isEmptyValue([])).toBe(true);
				expect(isEmptyValue([""])).toBe(true);
				expect(isEmptyValue("Hello")).toBe(false);
				expect(isEmptyValue(0)).toBe(false);
				expect(isEmptyValue(false)).toBe(false);
			});

			it("omits empty properties from converted note frontmatter", async () => {
				const noteWithEmptyProps = `---
category: literaturenote
publisher: N/A
tags:
modified date: ""
citekey: Doe24
---

> [!info]-
> **FirstAuthor**:: Doe, Jane
> **Author**:: Smith, Bob
> **Title**:: Valid Title
> **DOI**:: none
`;

				const res = await convertDataviewPropsToFrontmatter(noteWithEmptyProps, "lit/test.md");
				expect(res.success).toBe(true);

				const content = res.updatedContent!;
				expect(content).not.toContain("publisher:");
				expect(content).not.toContain("tags:");
				expect(content).not.toContain("modified_date:");
				expect(content).not.toContain("modified date:");
				expect(content).not.toContain("doi:");
			});
		});

		describe("Author Fallback Parsing & Zotero Key Extraction", () => {
			it("parses single author with Last, First format", () => {
				expect(parseAuthorStringFallback("Morris, G. Elliott")).toEqual(["Morris, G. Elliott"]);
				expect(parseAuthorStringFallback("Kahneman, Daniel")).toEqual(["Kahneman, Daniel"]);
				expect(parseAuthorStringFallback("Plato")).toEqual(["Plato"]);
			});

			it("parses semicolon-separated author lists", () => {
				expect(
					parseAuthorStringFallback("Smith, John; Doe, Jane; Brown, Bob")
				).toEqual(["Smith, John", "Doe, Jane", "Brown, Bob"]);
			});

			it("parses conjunctions 'and' and '&'", () => {
				expect(parseAuthorStringFallback("Smith, John and Doe, Jane")).toEqual([
					"Smith, John",
					"Doe, Jane",
				]);
				expect(parseAuthorStringFallback("Smith, J. & Doe, J.")).toEqual([
					"Smith, J.",
					"Doe, J.",
				]);
			});

			it("parses even-comma paired author lists (Last, First, Last, First)", () => {
				expect(
					parseAuthorStringFallback(
						"Mølmen, Knut Sindre, Almquist, Nicki Winfield, Skattebo, Øyvind"
					)
				).toEqual([
					"Mølmen, Knut Sindre",
					"Almquist, Nicki Winfield",
					"Skattebo, Øyvind",
				]);
			});

			it("extracts Zotero item keys from multiple link formats", () => {
				expect(
					extractZoteroItemKey(
						"[**Zotero**](zotero://select/library/items/SXMSI2V5)"
					)
				).toBe("SXMSI2V5");
				expect(
					extractZoteroItemKey(
						"[**Zotero**](zotero://select/items/0_MRUCFQGD)"
					)
				).toBe("MRUCFQGD");
				expect(
					extractZoteroItemKey(
						"[**Zotero**](http://zotero.org/users/60638/items/K6GC6V5A)"
					)
				).toBe("K6GC6V5A");
				expect(
					extractZoteroItemKey(
						"[**Zotero**](https://zotero.org/groups/12345/items/ABCD1234)"
					)
				).toBe("ABCD1234");
				expect(extractZoteroItemKey("No link here")).toBeNull();
			});
		});
	});

	describe("3. Canonical Property Ordering & Timestamp Handling", () => {
		it("positions zotero_tags directly above created_date in FRONTMATTER_ORDER", () => {
			const zoteroTagsIdx = FRONTMATTER_ORDER.indexOf("zotero_tags");
			const createdDateIdx = FRONTMATTER_ORDER.indexOf("created_date");
			const modifiedDateIdx = FRONTMATTER_ORDER.indexOf("modified_date");
			const collectionsIdx = FRONTMATTER_ORDER.indexOf("zotero_collections");

			expect(collectionsIdx).toBeGreaterThan(-1);
			expect(zoteroTagsIdx).toBe(collectionsIdx + 1);
			expect(createdDateIdx).toBe(zoteroTagsIdx + 1);
			expect(modifiedDateIdx).toBe(createdDateIdx + 1);
		});

		it("orders frontmatter with zotero_tags just above created_date and modified_date", () => {
			const fm = {
				modified_date: "2024-02-02",
				zotero_tags: ["tag1", "tag2"],
				title: "My Note",
				created_date: "2024-01-01",
				zotero_collections: ["coll1"],
				category: ["literaturenote"],
				read: false,
			};

			const ordered = orderFrontmatter(fm);
			const keys = Object.keys(ordered);

			expect(keys).toEqual([
				"category",
				"read",
				"title",
				"zotero_collections",
				"zotero_tags",
				"created_date",
				"modified_date",
			]);
		});

		it("places zotero_tags at tail when created_date and modified_date are absent", () => {
			const fm = {
				zotero_tags: ["tag1"],
				title: "Fresh Note From Zotero",
				zotero_collections: ["coll1"],
				category: ["literaturenote"],
			};

			const ordered = orderFrontmatter(fm);
			const keys = Object.keys(ordered);

			expect(keys).toEqual([
				"category",
				"title",
				"zotero_collections",
				"zotero_tags",
			]);
			expect(ordered.created_date).toBeUndefined();
			expect(ordered.modified_date).toBeUndefined();
		});

		it("places zotero_tags directly above created_date when modified_date is absent", () => {
			const fm = {
				zotero_tags: ["tag1"],
				created_date: "2026-09-30T21:55",
				title: "Fresh Note From Zotero",
				zotero_collections: ["coll1"],
				category: ["literaturenote"],
			};

			const ordered = orderFrontmatter(fm);
			const keys = Object.keys(ordered);

			expect(keys).toEqual([
				"category",
				"title",
				"zotero_collections",
				"zotero_tags",
				"created_date",
			]);
			expect(ordered.modified_date).toBeUndefined();
		});

		it("converts 'created date' and 'modified date' frontmatter properties to 'created_date' and 'modified_date'", async () => {
			const rawNote = `---
category: literaturenote
"created date": 2024-05-08T14:01:11.313-07:00
modified date: 2024-05-09 15:30:00
tags:
  - test
citekey: Smith24
---

> [!info]-
> **Author**:: Smith, John
> **Title**:: A Test Study
`;

			const res = await convertDataviewPropsToFrontmatter(rawNote, "lit/test.md");
			expect(res.success).toBe(true);

			const fm = res.updatedFm!;
			expect(fm.created_date).toBe("2024-05-08T14:01:11-07:00");
			expect(fm.modified_date).toBe("2024-05-09T15:30:00-07:00");
			expect(fm["created date"]).toBeUndefined();
			expect(fm["modified date"]).toBeUndefined();

			const content = res.updatedContent!;
			expect(content).toContain("created_date: 2024-05-08T14:01:11-07:00");
			expect(content).toContain("modified_date: 2024-05-09T15:30:00-07:00");
			expect(content).not.toContain("created date:");
			expect(content).not.toContain("modified date:");

			// Check ordering in serialized YAML: zotero_tags should precede created_date
			const createdPos = content.indexOf("created_date:");
			const modifiedPos = content.indexOf("modified_date:");
			expect(createdPos).toBeLessThan(modifiedPos);
		});

		describe("formatTimestampWithOffset", () => {
			it("formats timestamps with explicit timezone offsets preserving offset and standardizing seconds", () => {
				expect(formatTimestampWithOffset("2026-10-01T09:27:42-07:00")).toBe("2026-10-01T09:27:42-07:00");
				expect(formatTimestampWithOffset("2024-05-08T14:01:11.313-07:00")).toBe("2024-05-08T14:01:11-07:00");
				expect(formatTimestampWithOffset("2026-10-01 09:27:42-07:00")).toBe("2026-10-01T09:27:42-07:00");
				expect(formatTimestampWithOffset("2026-10-01T09:27:42+02:00")).toBe("2026-10-01T09:27:42+02:00");
			});

			it("calculates correct local timezone offset for timestamps without an offset", () => {
				const resMay = formatTimestampWithOffset("2024-05-09 15:30:00");
				expect(resMay).toMatch(/^2024-05-09T15:30:00[+-]\d{2}:\d{2}$/);

				const resDateOnly = formatTimestampWithOffset("2024-01-01");
				expect(resDateOnly).toMatch(/^2024-01-01T00:00:00[+-]\d{2}:\d{2}$/);
			});

			it("formats Date instances into ISO offset format", () => {
				const d = new Date(2026, 9, 1, 9, 27, 42);
				const formatted = formatTimestampWithOffset(d);
				expect(formatted).toMatch(/^2026-10-01T09:27:42[+-]\d{2}:\d{2}$/);
			});

			it("converts UTC Z timestamps to local time and local offset", () => {
				const resUtc = formatTimestampWithOffset("2026-08-31T17:43:25.813Z");
				expect(resUtc).toMatch(/^2026-08-31T\d{2}:43:25[+-]\d{2}:\d{2}$/);
			});

			it("returns null for empty or invalid inputs", () => {
				expect(formatTimestampWithOffset(null)).toBeNull();
				expect(formatTimestampWithOffset("")).toBeNull();
				expect(formatTimestampWithOffset("   ")).toBeNull();
			});
		});
	});
});

