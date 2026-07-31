import { describe, it, expect } from "vitest";
import { renderSourceLine, parseSourceLine } from "../../src/zotero/sourceLinkState";

describe("renderSourceLine", () => {
	it("renders a raw source with title, single turn", () => {
		const line = renderSourceLine("s1", { kind: "raw", url: "https://example.com/x", title: "X" }, [2], "https://example.com/x");
		expect(line).toBe("^src-1 [X](https://example.com/x) (turn 2) <!-- src-url: https://example.com/x -->");
	});

	it("renders a raw source without title (bare URL)", () => {
		const line = renderSourceLine("s3", { kind: "raw", url: "https://example.com/y" }, [4], "https://example.com/y");
		expect(line).toBe("^src-3 <https://example.com/y> (turn 4) <!-- src-url: https://example.com/y -->");
	});

	it("renders a zotero-item source", () => {
		const line = renderSourceLine("s2", { kind: "zotero-item", citekey: "smith2024", zotkey: "ABC123" }, [1], "https://example.com/z");
		expect(line).toBe("^src-2 [Zotero: smith2024](zotero://select/library/items/ABC123) (turn 1) <!-- src-url: https://example.com/z -->");
	});

	it("renders a lit-note source", () => {
		const line = renderSourceLine("s5", { kind: "lit-note", citekey: "smith2024" }, [3], "https://example.com/w");
		expect(line).toBe("^src-5 [[smith2024]] (turn 3) <!-- src-url: https://example.com/w -->");
	});

	it("renders multiple owning turns as 'turns N, M' sorted ascending", () => {
		const line = renderSourceLine("s1", { kind: "raw", url: "https://example.com/x", title: "X" }, [5, 2], "https://example.com/x");
		expect(line).toBe("^src-1 [X](https://example.com/x) (turns 2, 5) <!-- src-url: https://example.com/x -->");
	});

	it("dedupes duplicate turn ids", () => {
		const line = renderSourceLine("s1", { kind: "raw", url: "https://example.com/x" }, [2, 2, 3], "https://example.com/x");
		expect(line).toBe("^src-1 <https://example.com/x> (turns 2, 3) <!-- src-url: https://example.com/x -->");
	});
});

describe("parseSourceLine", () => {
	it("parses a raw source with a single turn", () => {
		const line = "^src-1 [X](https://example.com/x) (turn 2) <!-- src-url: https://example.com/x -->";
		expect(parseSourceLine(line)).toEqual({
			id: "s1",
			state: { kind: "raw", url: "https://example.com/x", title: "X" },
			turnIds: [2],
			rawUrl: "https://example.com/x",
		});
	});

	it("parses a raw source without title (bare URL form)", () => {
		const line = "^src-3 <https://example.com/y> (turn 4) <!-- src-url: https://example.com/y -->";
		expect(parseSourceLine(line)).toEqual({
			id: "s3",
			state: { kind: "raw", url: "https://example.com/y" },
			turnIds: [4],
			rawUrl: "https://example.com/y",
		});
	});

	it("parses a zotero-item source", () => {
		const line = "^src-2 [Zotero: smith2024](zotero://select/library/items/ABC123) (turn 1) <!-- src-url: https://example.com/z -->";
		expect(parseSourceLine(line)).toEqual({
			id: "s2",
			state: { kind: "zotero-item", citekey: "smith2024", zotkey: "ABC123" },
			turnIds: [1],
			rawUrl: "https://example.com/z",
		});
	});

	it("parses a lit-note source", () => {
		const line = "^src-5 [[smith2024]] (turn 3) <!-- src-url: https://example.com/w -->";
		expect(parseSourceLine(line)).toEqual({
			id: "s5",
			state: { kind: "lit-note", citekey: "smith2024" },
			turnIds: [3],
			rawUrl: "https://example.com/w",
		});
	});

	it("parses multiple owning turns from 'turns N, M'", () => {
		const line = "^src-1 [X](https://example.com/x) (turns 2, 5) <!-- src-url: https://example.com/x -->";
		expect(parseSourceLine(line)).toEqual({
			id: "s1",
			state: { kind: "raw", url: "https://example.com/x", title: "X" },
			turnIds: [2, 5],
			rawUrl: "https://example.com/x",
		});
	});

	it("returns null for an empty string", () => {
		expect(parseSourceLine("")).toBeNull();
	});

	it("returns null for an unparseable line", () => {
		expect(parseSourceLine("not a source line")).toBeNull();
	});

	it("returns null for a line missing the src-url comment", () => {
		const line = "^src-1 [X](https://example.com/x) (turn 2)";
		expect(parseSourceLine(line)).toBeNull();
	});
});

describe("renderSourceLine / parseSourceLine round-trip", () => {
	const cases: Array<[string, Parameters<typeof renderSourceLine>]> = [
		["raw with title", ["s1", { kind: "raw", url: "https://example.com/x", title: "X" }, [2], "https://example.com/x"]],
		["raw without title", ["s3", { kind: "raw", url: "https://example.com/y" }, [4], "https://example.com/y"]],
		["zotero-item", ["s2", { kind: "zotero-item", citekey: "smith2024", zotkey: "ABC123" }, [1], "https://example.com/z"]],
		["lit-note", ["s5", { kind: "lit-note", citekey: "smith2024" }, [3], "https://example.com/w"]],
		["multi-digit ids", ["s42", { kind: "raw", url: "https://example.com/q" }, [99], "https://example.com/q"]],
		["multiple owning turns", ["s6", { kind: "raw", url: "https://example.com/r" }, [1, 3, 7], "https://example.com/r"]],
	];

	for (const [label, args] of cases) {
		it(`preserves id, turnIds, rawUrl, and state for: ${label}`, () => {
			const line = renderSourceLine(...args);
			const parsed = parseSourceLine(line);
			expect(parsed).not.toBeNull();
			if (!parsed) return;
			expect(parsed.id).toBe(args[0]);
			expect(parsed.turnIds).toEqual([...new Set(args[2])].sort((a, b) => a - b));
			expect(parsed.rawUrl).toBe(args[3]);
			expect(parsed.state).toEqual(args[1]);
		});
	}

	it("preserves a diverged rawUrl (simulating a future relink: visible link changed, rawUrl unchanged)", () => {
		const originalUrl = "https://original.example.com/a";
		const line = renderSourceLine("s7", { kind: "lit-note", citekey: "doe2020" }, [5], originalUrl);
		const parsed = parseSourceLine(line);
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		expect(parsed.state.kind).toBe("lit-note");
		expect(parsed.rawUrl).toBe(originalUrl);
	});
});
