import { describe, it, expect } from "vitest";
import {
	splitAuthors,
	parseName,
	parseAuthors,
	formatName,
	formatAuthors,
	suggestBibtexForm,
	suggestBibtexFormTwoField,
	stripBraces,
} from "../../src/litNote/bibtexName";

// ---------------------------------------------------------------------------
// splitAuthors
// ---------------------------------------------------------------------------

describe("splitAuthors", () => {
	it("splits two authors on ' and '", () => {
		expect(
			splitAuthors(
				"Rowlinson, John Shipley and Van Der Waals, Johannes Diderik"
			)
		).toEqual(["Rowlinson, John Shipley", "Van Der Waals, Johannes Diderik"]);
	});

	it("keeps {Barnes and Noble} as one author — 'and' inside braces is not a separator", () => {
		expect(splitAuthors("{Barnes and Noble}")).toEqual(["{Barnes and Noble}"]);
	});

	it("handles 'and others' as an et-al marker (drops it)", () => {
		const result = splitAuthors("Smith, John and others");
		expect(result).toEqual(["Smith, John"]);
	});

	it("handles a single author with no ' and '", () => {
		expect(splitAuthors("Einstein, Albert")).toEqual(["Einstein, Albert"]);
	});

	it("is case-insensitive for 'and'", () => {
		expect(splitAuthors("Smith, John AND Doe, Jane")).toEqual([
			"Smith, John",
			"Doe, Jane",
		]);
	});
});

// ---------------------------------------------------------------------------
// parseName — 0 commas: First von Last
// ---------------------------------------------------------------------------

describe("parseName — 0 commas (First von Last)", () => {
	it("handles a simple two-word name: Albert Einstein", () => {
		const n = parseName("Albert Einstein");
		expect(n).toEqual({ first: "Albert", von: "", last: "Einstein", jr: "" });
	});

	it("handles a mononym: Aristotle", () => {
		const n = parseName("Aristotle");
		expect(n).toEqual({ first: "", von: "", last: "Aristotle", jr: "" });
	});

	it("handles Ludwig van Beethoven — von='van', last='Beethoven'", () => {
		const n = parseName("Ludwig van Beethoven");
		expect(n).toEqual({
			first: "Ludwig",
			von: "van",
			last: "Beethoven",
			jr: "",
		});
	});

	it("handles multiple first-name words", () => {
		const n = parseName("Jean-Paul van den Berg");
		expect(n).toEqual({
			first: "Jean-Paul",
			von: "van den",
			last: "Berg",
			jr: "",
		});
	});

	it("handles a name where Von token is 'de la': Jean de la Fontaine", () => {
		const n = parseName("Jean de la Fontaine");
		expect(n).toEqual({
			first: "Jean",
			von: "de la",
			last: "Fontaine",
			jr: "",
		});
	});

	it("handles 0 commas with Jr suffix: John Smith Jr", () => {
		const n = parseName("John Smith Jr");
		expect(n).toEqual({
			first: "John",
			von: "",
			last: "Smith",
			jr: "Jr",
		});
	});

	it("handles 0 commas with Jr. suffix: Winifred Sackville Stoner Jr.", () => {
		const n = parseName("Winifred Sackville Stoner Jr.");
		expect(n).toEqual({
			first: "Winifred Sackville",
			von: "",
			last: "Stoner",
			jr: "Jr.",
		});
	});
});

// ---------------------------------------------------------------------------
// parseName — 1 comma: von Last, First
// ---------------------------------------------------------------------------

describe("parseName — 1 comma (von Last, First)", () => {
	it("handles Smith, John", () => {
		const n = parseName("Smith, John");
		expect(n).toEqual({ first: "John", von: "", last: "Smith", jr: "" });
	});

	it("handles Van Der Waals, Johannes Diderik — no von, Last is 'Van Der Waals'", () => {
		// Van/Der are capitalized → they belong to Last, not von
		const n = parseName("Van Der Waals, Johannes Diderik");
		expect(n).toEqual({
			first: "Johannes Diderik",
			von: "",
			last: "Van Der Waals",
			jr: "",
		});
	});

	it("handles van Beethoven, Ludwig — von='van', last='Beethoven'", () => {
		const n = parseName("van Beethoven, Ludwig");
		expect(n).toEqual({
			first: "Ludwig",
			von: "van",
			last: "Beethoven",
			jr: "",
		});
	});

	it("handles de la Fontaine, Jean — von='de la', last='Fontaine'", () => {
		const n = parseName("de la Fontaine, Jean");
		expect(n).toEqual({
			first: "Jean",
			von: "de la",
			last: "Fontaine",
			jr: "",
		});
	});

	it("handles a name with an accent: Mu{\\'n}oz, Carlos", () => {
		// The {\\'n} is depth-1, so 'n' is treated as part of the brace group
		// The token starts with 'M' (uppercase) → it is a Last name token
		const n = parseName("Mu{\\'n}oz, Carlos");
		expect(n).toEqual({
			first: "Carlos",
			von: "",
			last: "Mu{\\'n}oz",
			jr: "",
		});
	});
});

// ---------------------------------------------------------------------------
// parseName — 2 commas: von Last, Jr, First
// ---------------------------------------------------------------------------

describe("parseName — 2 commas (von Last, Jr, First)", () => {
	it("handles Stoner, Jr, Winifred Sackville", () => {
		const n = parseName("Stoner, Jr, Winifred Sackville");
		expect(n).toEqual({
			first: "Winifred Sackville",
			von: "",
			last: "Stoner",
			jr: "Jr",
		});
	});

	it("handles Smith, Jr., John", () => {
		const n = parseName("Smith, Jr., John");
		expect(n).toEqual({ first: "John", von: "", last: "Smith", jr: "Jr." });
	});
});

// ---------------------------------------------------------------------------
// parseName — corporate / brace-protected
// ---------------------------------------------------------------------------

describe("parseName — brace-protected corporate author", () => {
	it("treats {Barnes and Noble} as a single Last name", () => {
		const n = parseName("{Barnes and Noble}");
		expect(n).toEqual({
			first: "",
			von: "",
			last: "{Barnes and Noble}",
			jr: "",
		});
	});

	it("treats {World Health Organization} as a single Last name", () => {
		const n = parseName("{World Health Organization}");
		expect(n).toEqual({
			first: "",
			von: "",
			last: "{World Health Organization}",
			jr: "",
		});
	});
});

// ---------------------------------------------------------------------------
// parseAuthors (end-to-end split + parse)
// ---------------------------------------------------------------------------

describe("parseAuthors", () => {
	it("splits and parses Rowlinson + Van Der Waals", () => {
		const authors = parseAuthors(
			"Rowlinson, John Shipley and Van Der Waals, Johannes Diderik"
		);
		expect(authors).toHaveLength(2);
		expect(authors[0]).toMatchObject({ first: "John Shipley", last: "Rowlinson" });
		expect(authors[1]).toMatchObject({ first: "Johannes Diderik", last: "Van Der Waals" });
	});
});

// ---------------------------------------------------------------------------
// formatName
// ---------------------------------------------------------------------------

describe("formatName", () => {
	const beethoven = { first: "Ludwig", von: "van", last: "Beethoven", jr: "" };
	const stoner = { first: "Winifred Sackville", von: "", last: "Stoner", jr: "Jr" };
	const mono = { first: "", von: "", last: "Aristotle", jr: "" };

	it("last-first: van Beethoven, Ludwig", () => {
		expect(formatName(beethoven, "last-first")).toBe("van Beethoven, Ludwig");
	});

	it("last-first for mononym: Aristotle", () => {
		expect(formatName(mono, "last-first")).toBe("Aristotle");
	});

	it("bibtex with Jr: Stoner, Jr, Winifred Sackville", () => {
		expect(formatName(stoner, "bibtex")).toBe("Stoner, Jr, Winifred Sackville");
	});

	it("first-last: Ludwig van Beethoven", () => {
		expect(formatName(beethoven, "first-last")).toBe("Ludwig van Beethoven");
	});

	it("von-last: van Beethoven", () => {
		expect(formatName(beethoven, "von-last")).toBe("van Beethoven");
	});

	it("initials: L. van Beethoven", () => {
		expect(formatName(beethoven, "initials")).toBe("L. van Beethoven");
	});

	it("initials for hyphenated first name: Jean-Paul → J.-P.", () => {
		const n = { first: "Jean-Paul", von: "", last: "Sartre", jr: "" };
		expect(formatName(n, "initials")).toBe("J.-P. Sartre");
	});

	it("dropVon: true omits von particle: Beethoven, Ludwig", () => {
		expect(formatName(beethoven, "last-first", { dropVon: true })).toBe("Beethoven, Ludwig");
	});

	it("dropVon: false keeps von particle: van Beethoven, Ludwig", () => {
		expect(formatName(beethoven, "last-first", { dropVon: false })).toBe("van Beethoven, Ludwig");
	});

	it("stripBraces: true strips outer braces from display output", () => {
		const corporate = { first: "", von: "", last: "{Barnes and Noble}", jr: "" };
		expect(formatName(corporate, "last-first", { stripBraces: true })).toBe("Barnes and Noble");
		expect(formatName(corporate, "last-first", { stripBraces: false })).toBe("{Barnes and Noble}");
	});
});

// ---------------------------------------------------------------------------
// formatAuthors
// ---------------------------------------------------------------------------

describe("formatAuthors", () => {
	it("formats an author string containing ' and '", () => {
		const res = formatAuthors("Ludwig van Beethoven and Albert Einstein", "last-first");
		expect(res).toEqual(["van Beethoven, Ludwig", "Einstein, Albert"]);
	});

	it("formats an array of author strings", () => {
		const res = formatAuthors(["Ludwig van Beethoven", "Albert Einstein"], "last-first");
		expect(res).toEqual(["van Beethoven, Ludwig", "Einstein, Albert"]);
	});

	it("respects dropVon option across all authors", () => {
		const res = formatAuthors(
			"Ludwig van Beethoven and Jean de la Fontaine",
			"last-first",
			{ dropVon: true }
		);
		expect(res).toEqual(["Beethoven, Ludwig", "Fontaine, Jean"]);
	});

	it("respects initials style", () => {
		const res = formatAuthors(
			["Jean-Paul Sartre", "Ludwig van Beethoven"],
			"initials"
		);
		expect(res).toEqual(["J.-P. Sartre", "L. van Beethoven"]);
	});
});

// ---------------------------------------------------------------------------
// suggestBibtexForm
// ---------------------------------------------------------------------------

describe("suggestBibtexForm", () => {
	it("suggests reordering 'Albert Einstein' → 'Einstein, Albert'", () => {
		expect(suggestBibtexForm("Albert Einstein")).toBe("Einstein, Albert");
	});

	it("suggests 'Ludwig van Beethoven' → 'van Beethoven, Ludwig'", () => {
		expect(suggestBibtexForm("Ludwig van Beethoven")).toBe(
			"van Beethoven, Ludwig"
		);
	});

	it("returns null for a mononym (no spaces)", () => {
		expect(suggestBibtexForm("Aristotle")).toBeNull();
	});

	it("returns null when already in 'Last, First' form", () => {
		expect(suggestBibtexForm("Einstein, Albert")).toBeNull();
	});

	it("returns null for {Barnes and Noble} corporate author", () => {
		// A brace-protected token produces no first name → null
		expect(suggestBibtexForm("{Barnes and Noble}")).toBeNull();
	});

	it("suggests 'Jean de la Fontaine' → 'de la Fontaine, Jean'", () => {
		expect(suggestBibtexForm("Jean de la Fontaine")).toBe(
			"de la Fontaine, Jean"
		);
	});
});

// ---------------------------------------------------------------------------
// suggestBibtexFormTwoField
// ---------------------------------------------------------------------------

describe("suggestBibtexFormTwoField", () => {
	it("formats two-field Albert + Einstein → 'Einstein, Albert'", () => {
		expect(suggestBibtexFormTwoField("Albert", "Einstein")).toBe(
			"Einstein, Albert"
		);
	});

	it("handles van particle in lastName: Ludwig + van Beethoven → 'van Beethoven, Ludwig'", () => {
		expect(suggestBibtexFormTwoField("Ludwig", "van Beethoven")).toBe(
			"van Beethoven, Ludwig"
		);
	});

	it("returns null when firstName is empty (mononym case)", () => {
		expect(suggestBibtexFormTwoField("", "Aristotle")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// stripBraces
// ---------------------------------------------------------------------------

describe("stripBraces", () => {
	it("removes braces from a protected name", () => {
		expect(stripBraces("{Barnes and Noble}")).toBe("Barnes and Noble");
	});

	it("leaves names without braces unchanged", () => {
		expect(stripBraces("Einstein, Albert")).toBe("Einstein, Albert");
	});
});
