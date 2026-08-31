import { describe, it, expect } from "vitest";
import {
	sanitizeFilename,
	suggestFilenameFromSelection,
	formatWikilinkAlias,
	determineWikilinkAlias,
	buildWikilink,
	isAiDialogNote,
} from "../src/utils";

describe("sanitizeFilename", () => {
	it("removes all illegal characters", () => {
		expect(sanitizeFilename('a\\b/c:d*e?f"g<h>i|j')).toBe("abcdefghij");
	});

	it("removes backslashes", () => {
		expect(sanitizeFilename("foo\\bar")).toBe("foobar");
	});

	it("removes forward slashes", () => {
		expect(sanitizeFilename("foo/bar")).toBe("foobar");
	});

	it("removes colons", () => {
		expect(sanitizeFilename("foo:bar")).toBe("foobar");
	});

	it("removes asterisks", () => {
		expect(sanitizeFilename("foo*bar")).toBe("foobar");
	});

	it("removes question marks", () => {
		expect(sanitizeFilename("foo?bar")).toBe("foobar");
	});

	it("removes double quotes", () => {
		expect(sanitizeFilename('foo"bar')).toBe("foobar");
	});

	it("removes angle brackets", () => {
		expect(sanitizeFilename("foo<bar>")).toBe("foobar");
	});

	it("removes pipe characters", () => {
		expect(sanitizeFilename("foo|bar")).toBe("foobar");
	});

	it("leaves valid filenames unchanged", () => {
		expect(sanitizeFilename("my-note-name")).toBe("my-note-name");
		expect(sanitizeFilename("note with spaces")).toBe("note with spaces");
		expect(sanitizeFilename("note_with_underscores")).toBe("note_with_underscores");
		expect(sanitizeFilename("note.with.dots")).toBe("note.with.dots");
	});

	it("handles empty string", () => {
		expect(sanitizeFilename("")).toBe("");
	});

	it("handles string with only illegal characters", () => {
		expect(sanitizeFilename("///")).toBe("");
		expect(sanitizeFilename("***")).toBe("");
		expect(sanitizeFilename("\\/:*?\"<>|")).toBe("");
	});

	it("handles mixed valid and invalid characters", () => {
		expect(sanitizeFilename("My:Note*Name?")).toBe("MyNoteName");
		expect(sanitizeFilename("test/file:name")).toBe("testfilename");
	});
});

describe("suggestFilenameFromSelection", () => {
	it("trims and strips invalid filename characters", () => {
		expect(suggestFilenameFromSelection("  What is Quantum Computing?  ")).toBe("What is Quantum Computing");
		expect(suggestFilenameFromSelection("Title with #hashtag and [brackets]^2")).toBe("Title with hashtag and brackets2");
	});

	it("collapses internal newlines and whitespace to a single space", () => {
		expect(suggestFilenameFromSelection("First line\nsecond line\r\n\tthird line")).toBe("First line second line third line");
	});

	it("limits total length to 60 characters", () => {
		const longText = "This is a very long selection that exceeds sixty characters in total length so it should be truncated properly";
		const suggested = suggestFilenameFromSelection(longText);
		expect(suggested.length).toBeLessThanOrEqual(60);
		expect(suggested).toBe("This is a very long selection that exceeds sixty characters");
	});

	it("handles input >60 chars that becomes <=60 chars after illegal characters are removed", () => {
		// 70 chars input with 20 '?' symbols -> 50 chars valid text
		const inputWithIllegal = "a".repeat(50) + "?".repeat(20);
		expect(inputWithIllegal.length).toBe(70);
		const suggested = suggestFilenameFromSelection(inputWithIllegal);
		expect(suggested).toBe("a".repeat(50));
		expect(suggested.length).toBe(50);
	});

	it("handles input >60 chars with newlines that collapses to <=60 chars", () => {
		const inputWithNewlines = "  a  \n\n  " + "b".repeat(50) + "  \t\r\n  ";
		const suggested = suggestFilenameFromSelection(inputWithNewlines);
		expect(suggested).toBe("a " + "b".repeat(50));
		expect(suggested.length).toBe(52);
	});

	it("returns empty string for empty or whitespace-only inputs", () => {
		expect(suggestFilenameFromSelection("")).toBe("");
		expect(suggestFilenameFromSelection("   \n\t  ")).toBe("");
	});

	it("returns empty string when selection becomes empty after sanitization", () => {
		expect(suggestFilenameFromSelection("   ###[]^   ")).toBe("");
		expect(suggestFilenameFromSelection("/:\\*?\"<>|")).toBe("");
	});
});

describe("formatWikilinkAlias", () => {
	it("collapses whitespace and newlines to a single space", () => {
		expect(formatWikilinkAlias("Hello\n\nworld\tthis\ris a test")).toBe("Hello world this is a test");
	});

	it("escapes closing brackets ']]'", () => {
		expect(formatWikilinkAlias("Array item [0]] end")).toBe("Array item [0\\]\\] end");
	});

	it("truncates at 1000 characters and appends bolded ellipsis", () => {
		const input = "a".repeat(1200);
		const formatted = formatWikilinkAlias(input);
		expect(formatted.length).toBe(1007); // 1000 + '**...**'.length
		expect(formatted.endsWith("**...**")).toBe(true);
		expect(formatted.startsWith("a".repeat(1000))).toBe(true);
	});
});

describe("determineWikilinkAlias", () => {
	it("returns undefined if target filename equals alias", () => {
		expect(determineWikilinkAlias("Quantum Computing", "Quantum Computing", "Quantum Computing", "Quantum Computing")).toBeUndefined();
	});

	it("returns alias if original text had stripped invalid filename characters", () => {
		expect(determineWikilinkAlias("What is Quantum Computing", "What is Quantum Computing?", "What is Quantum Computing", "What is Quantum Computing")).toBe("What is Quantum Computing?");
	});

	it("prioritizes user-typed text if edited", () => {
		expect(
			determineWikilinkAlias("Custom Title Part 1", "Original Selection", "Original Selection", "Custom Title: Part 1?")
		).toBe("Custom Title: Part 1?");

		expect(
			determineWikilinkAlias("Custom Title", "Original Selection", "Original Selection", "Custom Title")
		).toBeUndefined();
	});
});

describe("isAiDialogNote", () => {
	it("returns true for valid AI dialog note content with ^turn-N anchors", () => {
		const noteContent = `# Dialog\n\n## Summary ^turn-1\n> [!Prompt]-\n> test prompt\n\nAI response\n`;
		expect(isAiDialogNote(noteContent)).toBe(true);
	});

	it("returns false for regular notes without ^turn-N anchors", () => {
		const noteContent = `# Regular Note\n\nThis is just a standard obsidian markdown note.`;
		expect(isAiDialogNote(noteContent)).toBe(false);
	});

	it("returns false for empty or null string", () => {
		expect(isAiDialogNote("")).toBe(false);
	});
});

describe("buildWikilink", () => {
	it("creates plain wikilink when no alias is needed", () => {
		expect(buildWikilink("Quantum Computing", "Quantum Computing", "Quantum Computing", "Quantum Computing")).toBe("[[Quantum Computing]]");
	});

	it("creates aliased wikilink when original selection differs from sanitized target", () => {
		expect(buildWikilink("What is Quantum Computing", "What is Quantum Computing?", "What is Quantum Computing", "What is Quantum Computing")).toBe("[[What is Quantum Computing|What is Quantum Computing?]]");
	});
});
