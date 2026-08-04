import { describe, it, expect } from "vitest";
import { renderSourceLine, parseSourceLine } from "../../src/zotero/sourceLinkState";

describe("renderSourceLine", () => {
	it("renders a raw source with title, single turn", () => {
		const line = renderSourceLine("1_1", { kind: "raw", url: "https://example.com/x", title: "X" }, [1], "https://example.com/x");
		expect(line).toBe("[^1_1]: [X](https://example.com/x)");
	});

	it("renders a raw source without title (bare URL)", () => {
		const line = renderSourceLine("1_3", { kind: "raw", url: "https://example.com/y" }, [1], "https://example.com/y");
		expect(line).toBe("[^1_3]: <https://example.com/y>");
	});

	it("renders a lit-note source", () => {
		const line = renderSourceLine("1_5", { kind: "lit-note", citekey: "smith2024" }, [1], "https://example.com/w");
		expect(line).toBe("[^1_5]: [[smith2024]]");
	});
});

describe("parseSourceLine", () => {
	it("parses a raw source with a single turn", () => {
		const line = "[^1_1]: [X](https://example.com/x)";
		expect(parseSourceLine(line)).toEqual({
			id: "1_1",
			state: { kind: "raw", url: "https://example.com/x", title: "X" },
			turnIds: [1],
			rawUrl: "https://example.com/x",
		});
	});

	it("parses a raw source without title (bare URL form)", () => {
		const line = "[^4_3]: <https://example.com/y>";
		expect(parseSourceLine(line)).toEqual({
			id: "4_3",
			state: { kind: "raw", url: "https://example.com/y" },
			turnIds: [4],
			rawUrl: "https://example.com/y",
		});
	});

	it("parses a lit-note source", () => {
		const line = "[^3_5]: [[smith2024]]";
		expect(parseSourceLine(line)).toEqual({
			id: "3_5",
			state: { kind: "lit-note", citekey: "smith2024" },
			turnIds: [3],
			rawUrl: "",
		});
	});

	it("returns null for an empty string", () => {
		expect(parseSourceLine("")).toBeNull();
	});

	it("returns null for an unparseable line", () => {
		expect(parseSourceLine("not a source line")).toBeNull();
	});
});

describe("renderSourceLine / parseSourceLine round-trip", () => {
	const cases: Array<[string, Parameters<typeof renderSourceLine>]> = [
		["raw with title", ["1_1", { kind: "raw", url: "https://example.com/x", title: "X" }, [1], "https://example.com/x"]],
		["raw without title", ["4_3", { kind: "raw", url: "https://example.com/y" }, [4], "https://example.com/y"]],
		["lit-note", ["3_5", { kind: "lit-note", citekey: "smith2024" }, [3], "https://example.com/w"]],
	];

	for (const [label, args] of cases) {
		it(`preserves id, turnIds, rawUrl, and state for: ${label}`, () => {
			const line = renderSourceLine(...args);
			const parsed = parseSourceLine(line);
			expect(parsed).not.toBeNull();
			if (!parsed) return;
			expect(parsed.id).toBe(args[0]);
			expect(parsed.turnIds).toEqual([...new Set(args[2])].sort((a, b) => a - b));
			if (args[1].kind !== "lit-note") {
				expect(parsed.rawUrl).toBe(args[3]);
			}
			expect(parsed.state).toEqual(args[1]);
		});
	}
});
