import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	validateItemAuthorFormats,
	getZoteroSelectUri,
	openZoteroItem,
} from "../../src/litNote/authorFormatValidator";
import type { ZoteroItemPayload } from "../../src/litNote/types";

describe("authorFormatValidator", () => {
	describe("validateItemAuthorFormats", () => {
		it("accepts valid two-field authors in <last_name>, <first_name> format", () => {
			const item: ZoteroItemPayload = {
				title: "Relativity",
				citekey: "Einstein05",
				creators: [
					{ creatorType: "author", firstName: "Albert", lastName: "Einstein" },
					{ creatorType: "author", firstName: "Niels", lastName: "Bohr" },
				],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(0);
		});

		it("accepts valid single-field authors with a comma separating last and first name", () => {
			const item: ZoteroItemPayload = {
				title: "Quantum Mechanics",
				citekey: "Bohr20",
				creators: [
					{ creatorType: "author", name: "Bohr, Niels" },
					{ creatorType: "author", name: "  Curie ,  Marie  " },
				],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(0);
		});

		it("accepts single-word lastName (mononym) with no firstName as two-field creator", () => {
			const item: ZoteroItemPayload = {
				title: "Paper by a Mononym",
				citekey: "Prince21",
				creators: [{ creatorType: "author", lastName: "Prince" }],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(0);
		});

		it("flags two-field creators where lastName has multiple words but no firstName", () => {
			const item: ZoteroItemPayload = {
				title: "Paper Without First Name",
				citekey: "SmithJr21",
				creators: [{ creatorType: "author", lastName: "Smith Jr" }],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(1);
			expect(issues[0].citekey).toBe("SmithJr21");
			expect(issues[0].creatorType).toBe("Author");
			expect(issues[0].detail).toContain("multi-word last name");
		});

		it("flags two-field creators with missing last name", () => {
			const item: ZoteroItemPayload = {
				title: "Paper Without Last Name",
				citekey: "John21",
				creators: [{ creatorType: "author", firstName: "John" }],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(1);
			expect(issues[0].citekey).toBe("John21");
			expect(issues[0].creatorType).toBe("Author");
			expect(issues[0].detail).toContain("missing a last name");
		});

		it("flags two-field creators where both names are blank or whitespace", () => {
			const item: ZoteroItemPayload = {
				title: "Paper With Empty Creator",
				citekey: "Empty21",
				creators: [{ creatorType: "author", firstName: "   ", lastName: "" }],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(1);
			expect(issues[0].detail).toContain("completely blank");
		});

		it("accepts single-word single-field names (mononyms) without a comma", () => {
			const item: ZoteroItemPayload = {
				title: "Ancient Philosophy",
				citekey: "Aristotle01",
				creators: [
					{ creatorType: "author", name: "Aristotle" },
					{ creatorType: "author", name: "Prince" },
				],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(0);
		});

		it("flags single-field creators with multiple words but no comma", () => {
			const item: ZoteroItemPayload = {
				title: "Organization Author",
				citekey: "Who20",
				creators: [
					{ creatorType: "author", name: "World Health Organization" },
					{ creatorType: "author", name: "John Doe" },
				],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(2);
			expect(issues[0].detail).toContain("multiple words but no comma");
			expect(issues[1].detail).toContain("multiple words but no comma");
		});

		it("flags single-field creators with comma but empty parts", () => {
			const item: ZoteroItemPayload = {
				title: "Malformed Comma Name",
				citekey: "Malformed20",
				creators: [
					{ creatorType: "author", name: "Smith," },
					{ creatorType: "author", name: ", John" },
				],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(2);
			expect(issues[0].detail).toContain("does not have both a valid last name and first name");
			expect(issues[1].detail).toContain("does not have both a valid last name and first name");
		});

		it("ignores non-author roles like editor and translator even if unformatted", () => {
			const item: ZoteroItemPayload = {
				title: "Collected Works",
				citekey: "Works20",
				creators: [
					{ creatorType: "author", firstName: "Leo", lastName: "Tolstoy" },
					{ creatorType: "editor", name: "Single Field Editor With No Comma" },
					{ creatorType: "translator", lastName: "OnlyTranslatorLast" },
					{ creatorType: "seriesEditor", firstName: "OnlyFirstSeries" },
				],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(0);
		});

		it("validates dynamic author-creator roles such as director and First*", () => {
			const item: ZoteroItemPayload = {
				title: "Multi-media Item",
				citekey: "Media24",
				creators: [
					{ creatorType: "director", name: "Christopher Nolan" }, // multi-word, no comma
					{ creatorType: "FirstProgrammer", firstName: "Ada" }, // missing last name
					{ creatorType: "FirstDirector", firstName: "Stanley", lastName: "Kubrick" }, // valid
				],
			};

			const issues = validateItemAuthorFormats(item);
			expect(issues).toHaveLength(2);
			expect(issues[0].creatorType).toBe("Director");
			expect(issues[0].detail).toContain("multiple words but no comma");
			expect(issues[1].creatorType).toBe("FirstProgrammer");
			expect(issues[1].detail).toContain("missing a last name");
		});
	});

	describe("getZoteroSelectUri", () => {
		it("returns zotero:// select URI directly when desktopURI starts with zotero://", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "Test21",
				desktopURI: "zotero://select/groups/12345/items/ABCXYZ",
			};
			expect(getZoteroSelectUri(item)).toBe("zotero://select/groups/12345/items/ABCXYZ");
		});

		it("builds library select URI from itemkey", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "Test21",
				itemkey: "SWDUCE7N",
			};
			expect(getZoteroSelectUri(item)).toBe("zotero://select/library/items/SWDUCE7N");
		});

		it("extracts item key from web desktopURI if itemkey is missing", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "Test21",
				desktopURI: "http://zotero.org/users/123/items/ABCDEF99",
			};
			expect(getZoteroSelectUri(item)).toBe("zotero://select/library/items/ABCDEF99");
		});

		it("returns null when no uri or itemkey is present", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "Test21",
			};
			expect(getZoteroSelectUri(item)).toBeNull();
		});
	});

	describe("openZoteroItem", () => {
		let originalWindow: any;

		beforeEach(() => {
			originalWindow = (global as any).window;
		});

		afterEach(() => {
			(global as any).window = originalWindow;
		});

		it("opens URI using electron shell if available", () => {
			const mockOpenExternal = vi.fn();
			(global as any).window = {
				electron: {
					shell: {
						openExternal: mockOpenExternal,
					},
				},
			};

			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "Test21",
				itemkey: "KEY123",
			};

			const result = openZoteroItem(item);
			expect(result).toBe(true);
			expect(mockOpenExternal).toHaveBeenCalledWith("zotero://select/library/items/KEY123");
		});

		it("falls back to window.open if electron shell is not present", () => {
			const mockWindowOpen = vi.fn();
			(global as any).window = {
				open: mockWindowOpen,
			};

			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "Test21",
				itemkey: "KEY456",
			};

			const result = openZoteroItem(item);
			expect(result).toBe(true);
			expect(mockWindowOpen).toHaveBeenCalledWith("zotero://select/library/items/KEY456");
		});

		it("returns false when URI cannot be constructed", () => {
			const item: ZoteroItemPayload = {
				title: "Test",
				citekey: "Test21",
			};
			const result = openZoteroItem(item);
			expect(result).toBe(false);
		});
	});
});
