import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "../src/utils";

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
