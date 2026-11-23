import { describe, expect, it } from "vitest";
import {
	cleanTextValue,
	canonicalizeDoi,
	parseObsidianDate,
	formatObsidianDate,
	isEmptyValue,
	FRONTMATTER_ORDER,
	orderFrontmatter,
	formatTimestampWithOffset,
} from "../../src/litNote/propertyUtils";

describe("Property Normalization Rules", () => {
	describe("Property values", () => {
		describe("Text & Stray Trailing Punctuation", () => {
			it("trims whitespace and removes stray trailing commas and semicolons while preserving valid punctuation", () => {
				expect(cleanTextValue("  Smith, John,  ")).toBe("Smith, John");
				expect(cleanTextValue("Journal of Testing; ")).toBe("Journal of Testing");
				expect(cleanTextValue('"What is Life?"')).toBe("What is Life?");
				expect(cleanTextValue("Notice!")).toBe("Notice!");
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

		describe("Identifiers", () => {
			it("canonicalizes DOIs to bare 10.xxxx/... with no https://doi.org/ prefix", () => {
				expect(canonicalizeDoi("https://doi.org/10.1000/182")).toBe("10.1000/182");
				expect(canonicalizeDoi("http://dx.doi.org/10.1000/182")).toBe("10.1000/182");
				expect(canonicalizeDoi("doi:10.1000/182")).toBe("10.1000/182");
				expect(canonicalizeDoi("10.1000/182")).toBe("10.1000/182");
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

		});

	});

	describe("Canonical Property Ordering & Timestamp Handling", () => {
		it("positions tags immediately after category in FRONTMATTER_ORDER", () => {
			const categoryIdx = FRONTMATTER_ORDER.indexOf("category");
			const tagsIdx = FRONTMATTER_ORDER.indexOf("tags");
			expect(categoryIdx).toBe(0);
			expect(tagsIdx).toBe(1);
		});

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

