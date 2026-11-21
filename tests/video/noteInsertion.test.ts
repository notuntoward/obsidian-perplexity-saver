// @vitest-environment jsdom
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flashEditorLine = vi.hoisted(() => vi.fn());
vi.mock("commons/flash", () => ({
	flashEditorLine,
	LINE_FLASH_DEFAULT_PROFILE: {
		mode: "centered",
		durationMs: 1000,
		sizeChars: 15,
		opacity: 0.8,
	},
}));

import {
	blockInsertion,
	createNoteInsertionAnchor,
	flashInsertedLine,
	insertionThemeFlashAppearance,
	getNoteInsertionPosition,
	insertAtNoteInsertionAnchor,
	insertionMessage,
	noteInsertionAnchors,
	timestampListItemBlock,
	timestampListItemInsertion,
	timestampedScreenshotItem,
	type InsertionFlashSettings,
} from "../../src/video/noteInsertion";
import { timestampLink } from "../../src/video/youtubeLinks";

describe("video note insertion", () => {
	let view: EditorView | null = null;

	afterEach(() => {
		view?.destroy();
		view = null;
		flashEditorLine.mockClear();
		document.body.replaceChildren();
	});

	it("tracks the original insertion point through edits and inserts without replacing text", () => {
		view = new EditorView({
			state: EditorState.create({
				doc: "write here",
				selection: { anchor: 5 },
				extensions: [noteInsertionAnchors],
			}),
			parent: document.body,
		});
		const anchor = createNoteInsertionAnchor(view);
		expect(anchor).not.toBeNull();
		if (!anchor) throw new Error("Expected an insertion anchor.");

		view.dispatch({ changes: { from: 0, to: 0, insert: "Start " } });
		expect(getNoteInsertionPosition(anchor)).toBe(11);
		expect(insertAtNoteInsertionAnchor(anchor, " timestamp ")).toBe(true);
		expect(view.state.doc.toString()).toBe("Start write timestamp  here");
		expect(view.state.selection.main.head).toBe(22);
		expect(getNoteInsertionPosition(anchor)).toBeNull();
	});

	it("creates a timestamp list item at the cursor and reuses an empty list item", () => {
		const link = timestampLink("VID", 65);
		const blank = timestampListItemInsertion(Text.of([""]), 0, "VID", 65);
		expect(blank).toMatchObject({ text: `- ${link}: `, cursorOffset: `- ${link}: `.length });

		const emptyItem = timestampListItemInsertion(Text.of(["- "]), 2, "VID", 65);
		expect(emptyItem).toMatchObject({ text: `${link}: `, cursorOffset: `${link}: `.length, replace: { from: 2, to: 2 } });
	});

	it.each(["  - ", "\t* ", "    + "])("creates a timestamp sibling with the current indentation and marker (%s)", (marker) => {
		const line = `${marker}existing text`;
		const doc = Text.of(["- parent", line, `${marker}next item`]);
		const insertion = timestampListItemInsertion(doc, doc.line(2).to, "VID", 65);
		expect(insertion.text).toBe(`\n${marker}${timestampLink("VID", 65)}: `);
		expect(insertion.cursorOffset).toBe(insertion.text.length);
		expect(insertion.moved).toBeUndefined();
	});

	it("keeps a screenshot inside a new nested sibling instead of creating a top-level bullet", () => {
		const line = "  - existing text";
		const block = timestampedScreenshotItem("![[capture.png]]", "VID", 65);
		expect(blockInsertion(Text.of([line]), line.length, block).text).toBe(
			`\n  - ${timestampLink("VID", 65)}:\n    ![[capture.png]]`
		);
	});

	it("reuses an empty nested bullet for a screenshot, indenting its embed", () => {
		const block = timestampedScreenshotItem("![[capture.png]]", "VID", 65);
		expect(blockInsertion(Text.of(["  - "]), 4, block).text).toBe(
			`${timestampLink("VID", 65)}:\n    ![[capture.png]]`
		);
	});

	it("creates an ordered task sibling unchecked instead of repeating a checked state", () => {
		const line = "  3. [x] existing";
		const insertion = timestampListItemInsertion(Text.of([line]), line.length, "VID", 65);
		expect(insertion.text).toBe(`\n  4. [ ] ${timestampLink("VID", 65)}: `);
	});

	it("creates a task sibling when the current list is a task list", () => {
		const line = "- [x] existing";
		const insertion = timestampListItemInsertion(Text.of([line]), line.length, "VID", 65);
		expect(insertion.text).toBe(`\n- [ ] ${timestampLink("VID", 65)}: `);
	});

	it.each([
		["unordered", "  ", "- "],
		["ordered", "  ", "1. "],
		["task", "  ", "- [ ] "],
	] as const)("starts a blank line as a %s item", (style, indent, prefix) => {
		const insertion = timestampListItemInsertion(Text.of([indent]), indent.length, "VID", 65, style);
		expect(insertion.text).toBe(`${prefix}${timestampLink("VID", 65)}: `);
	});

	it("inserts a plain timestamp without a list marker or description suffix", () => {
		const link = timestampLink("VID", 65);
		expect(timestampListItemInsertion(Text.of([""]), 0, "VID", 65, "link")).toMatchObject({
			text: link,
			cursorOffset: link.length,
		});
		expect(timestampListItemInsertion(Text.of(["- existing"]), 10, "VID", 65, "link").text)
			.toBe(`\n\n${link}`);
		expect(timestampListItemInsertion(Text.of(["- "]), 2, "VID", 65, "link")).toMatchObject({
			text: link,
			replace: { from: 0, to: 2 },
		});
	});

	it("reuses an empty ordered item without advancing its number", () => {
		const insertion = timestampListItemInsertion(Text.of(["  2. "]), 5, "VID", 65);
		expect(insertion.text).toBe(`${timestampLink("VID", 65)}: `);
		expect(insertion.replace).toEqual({ from: 5, to: 5 });
	});

	it("reuses an empty checked task item without changing its state", () => {
		const insertion = timestampListItemInsertion(Text.of(["- [x] "]), 6, "VID", 65);
		expect(insertion.text).toBe(`${timestampLink("VID", 65)}: `);
		expect(insertion.replace).toEqual({ from: 6, to: 6 });
	});

	it("converts an empty list item to the selected form on the same line", () => {
		const insertion = timestampListItemInsertion(Text.of(["- "]), 2, "VID", 65, "ordered");
		expect(insertion.text).toBe(`1. ${timestampLink("VID", 65)}: `);
		expect(insertion.replace).toEqual({ from: 0, to: 2 });
	});

	it("applies a marker replacement when an empty item changes form", () => {
		view = new EditorView({
			state: EditorState.create({
				doc: "- ",
				selection: { anchor: 2 },
				extensions: [noteInsertionAnchors],
			}),
			parent: document.body,
		});
		const anchor = createNoteInsertionAnchor(view);
		if (!anchor) throw new Error("Expected an insertion anchor.");
		const insertion = timestampListItemInsertion(view.state.doc, 2, "VID", 65, "task");
		expect(insertAtNoteInsertionAnchor(anchor, insertion.text, insertion.cursorOffset, insertion.replace)).toBe(true);
		expect(view.state.doc.toString()).toBe(`- [ ] ${timestampLink("VID", 65)}: `);
	});

	it("uses the selected form for a new sibling while keeping the current indentation", () => {
		const line = "  2. existing";
		expect(timestampListItemInsertion(Text.of([line]), line.length, "VID", 65, "task").text)
			.toBe(`\n  - [ ] ${timestampLink("VID", 65)}: `);
		expect(timestampListItemInsertion(Text.of(["  - existing"]), 12, "VID", 65, "ordered").text)
			.toBe(`\n  1. ${timestampLink("VID", 65)}: `);
	});

	it("continues ordered numbering only when matching the current list", () => {
		const line = "  7) existing";
		expect(timestampListItemInsertion(Text.of([line]), line.length, "VID", 65, "match").text)
			.toBe(`\n  8) ${timestampLink("VID", 65)}: `);
		expect(timestampListItemInsertion(Text.of([line]), line.length, "VID", 65, "ordered").text)
			.toBe(`\n  8) ${timestampLink("VID", 65)}: `);
	});
});

describe("inserted line flash colors", () => {
	beforeEach(() => {
		flashEditorLine.mockClear();
		document.body.classList.remove("theme-light", "theme-dark");
	});

	const settings: InsertionFlashSettings = {
		mode: "left",
		durationMs: 1000,
		sizeChars: 15,
		useThemeColors: true,
		lightColor: "#f0a000",
		darkColor: "#00a0f0",
	};

	function renderFlash(ownerDocument: Document, overrides: Partial<InsertionFlashSettings> = {}): void {
		const coords = { top: 10, bottom: 30, left: 5, right: 6 };
		const fakeView = {
			dom: { isConnected: true, ownerDocument },
			state: { selection: { main: { head: 0 } } },
			coordsAtPos: () => coords,
			requestMeasure: (request: {
				read: (target: EditorView) => typeof coords;
				write?: (measure: typeof coords, target: EditorView) => void;
			}) => {
				const target = fakeView as unknown as EditorView;
				request.write?.(request.read(target), target);
			},
		} as unknown as EditorView;
		flashInsertedLine(fakeView, { ...settings, ...overrides });
	}

	it("uses the theme accent without resolving a custom color", () => {
		expect(insertionThemeFlashAppearance()).toEqual({ color: "var(--interactive-accent)", opacity: 0.8 });
		renderFlash(document);
		expect(flashEditorLine).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ color: "var(--interactive-accent)", opacity: 0.8 })
		);
	});

	it.each([
		["theme-light", "#f0a000"],
		["theme-dark", "#00a0f0"],
	] as const)("uses the owning document's %s custom color", (themeClass, color) => {
		const popout = document.implementation.createHTMLDocument();
		popout.body.classList.add(themeClass);
		document.body.classList.add(themeClass === "theme-dark" ? "theme-light" : "theme-dark");
		renderFlash(popout, { useThemeColors: false });
		expect(flashEditorLine).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ color })
		);
	});

	it("does not schedule a flash when highlighting is off", () => {
		renderFlash(document, { mode: "off" });
		expect(flashEditorLine).not.toHaveBeenCalled();
	});
});

describe("safe note insertion placement", () => {
	const item = `- ${timestampLink("VID", 65)}: `;

	/** Insert at the `‸` in `source` and return the document with `^` marking the new cursor. */
	function place(source: string, options: { transcript?: string; literature?: boolean } = {}): { result: string; moved?: string } {
		const position = source.indexOf("‸");
		const doc = Text.of(source.replace("‸", "").split("\n"));
		const notesEnd = options.transcript ? doc.toString().indexOf(options.transcript) : doc.length;
		const insertion = blockInsertion(doc, position, timestampListItemBlock("VID", 65), "match",
			notesEnd, options.transcript !== undefined && position >= notesEnd, options.literature);
		const from = insertion.replace?.from ?? position;
		const to = insertion.replace?.to ?? position;
		const text = doc.toString();
		const inserted = insertion.text.slice(0, insertion.cursorOffset) + "^" + insertion.text.slice(insertion.cursorOffset);
		return { result: text.slice(0, from) + inserted + text.slice(to), moved: insertion.moved };
	}

	it("adds a sibling after the whole bullet, not inside its text, when the cursor is mid-bullet", () => {
		expect(place("- first ‸half\n- next")).toEqual({
			result: `- first half\n${item}^\n- next`,
			moved: "below the list item",
		});
	});

	it("puts the sibling after the bullet's children so it does not adopt them", () => {
		expect(place("- parent‸\n  - child\n    more\n- next").result)
			.toBe(`- parent\n  - child\n    more\n${item}^\n- next`);
	});

	it("adds a sibling after a screenshot item's indented embed", () => {
		expect(place("- [[t]]:\n  ![[a.png]]‸\n\nText").result).toBe(`- [[t]]:\n  ![[a.png]]\n${item}^\n\nText`);
	});

	it("puts the item after the paragraph instead of splitting it", () => {
		expect(place("Some ‸words\nwrapped line\n\nNext")).toEqual({
			result: `Some words\nwrapped line\n\n${item}^\n\nNext`,
			moved: "after the paragraph",
		});
	});

	it("keeps a following paragraph from becoming part of the new item", () => {
		expect(place("Para‸\n# Head\nText").result).toBe(`Para\n\n${item}^\n# Head\nText`);
		expect(place("‸\nText").result).toBe(`\nText\n\n${item}^`);
	});

	it("inserts the first item under a heading, ahead of an existing list", () => {
		expect(place("## Notes‸\n\n- old\n").result).toBe(`## Notes\n\n${item}^\n- old\n`);
		expect(place("## Notes‸\nText").result).toBe(`## Notes\n${item}^\n\nText`);
		expect(place("# Title‸").moved).toBe("under the heading");
	});

	it("moves an insert in the properties to the initial notes list, keeping the properties intact", () => {
		expect(place("---\nta‸gs: [a]\n---\n- one\n- two\n")).toEqual({
			result: `---\ntags: [a]\n---\n- one\n- two\n${item}^\n`,
			moved: "in the initial notes area (the cursor was in the properties)",
		});
		expect(place("‸---\ntitle: x\n---\n").result).toBe(`---\ntitle: x\n---\n${item}^`);
	});

	it.each([
		["callout or quote", "> [!note]\n> in‸side"],
		["code block", "Before\n\n```\nco‸de\n```"],
		["table", "| a | b |\n| - | - |\n| 1 | 2‸ |"],
	])("moves an insert outside a %s", (reason, source) => {
		const placed = place(source);
		expect(placed.moved).toBe(`below the ${reason}`);
		expect(placed.result.endsWith(`\n\n${item}^`)).toBe(true);
	});

	it("moves an insert in the transcript above it, continuing the notes' final list", () => {
		expect(place("- one\n\n# Transcript\nwor‸ds\n", { transcript: "# Transcript" })).toEqual({
			result: `- one\n${item}^\n\n# Transcript\nwords\n`,
			moved: "in the initial notes area (the cursor was in the transcript)",
		});
		expect(place("---\na: 1\n---\n# Transcript\nwor‸ds", { transcript: "# Transcript" }).result)
			.toBe(`---\na: 1\n---\n${item}^\n\n# Transcript\nwords`);
	});

	describe("local fallbacks", () => {
		it.each(["‸\n", "> [!info]- Zotero\n\n‸\n", "> [!info]- Zotero\n\n> citation‸\n"])(
			"continues the opening notes list without crossing the next heading (%s)", (prefix) => {
				expect(place(`${prefix}\n- one\n- parent\n  - child\n\n# Later\n\n# Transcript\nwords`,
					{ literature: true, transcript: "# Transcript" }).result)
					.toBe(`${prefix.replace("‸", "")}\n- one\n- parent\n  - child\n${item}^\n\n# Later\n\n# Transcript\nwords`);
			});

		it("skips the complete generated literature preamble, including imported Zotero notes", () => {
			const prefix = "> [!info]- Zotero\n\n> citation\n\n___\n> [!note]- Zotero Note (1)\n> imported";
			expect(place(`‸${prefix}\n\n- notes\n\n## Other`, { literature: true }).result)
				.toBe(`${prefix}\n\n- notes\n${item}^\n\n## Other`);
			expect(place(`‸${prefix}\n\n## Other`, { literature: true }).result)
				.toBe(`${prefix}\n\n${item}^\n\n## Other`);
		});

		it.each(["‸", "‸\n", "---\nkind: ordinary‸\n---\n"])("supports an ordinary note without a source preamble (%s)", (prefix) => {
			expect(place(`${prefix}- one\n- two\n\n## Later`).result)
				.toBe(`${prefix.replace("‸", "")}- one\n- two\n${item}^\n\n## Later`);
		});

		it("uses the first paragraph in an ordinary note, not a later topic's list", () => {
			expect(place("‸\nOpening paragraph.\n\n## Later\n- unrelated").result)
				.toBe(`\nOpening paragraph.\n\n${item}^\n\n## Later\n- unrelated`);
		});

		it("creates a list below a source-only note rather than above its callout", () => {
			expect(place("‸\n> [!info]- Zotero\n\n> citation\n", { literature: true }).result)
				.toBe(`\n> [!info]- Zotero\n\n> citation\n\n${item}^\n`);
		});

		it("does not jump across prose when the literature preamble has no adjacent list", () => {
			expect(place("> [!info]- Zotero‸\n\n> citation\n\nMy paragraph.\n\n- later", { literature: true }).result)
				.toBe(`> [!info]- Zotero\n\n> citation\n\n${item}^\n\nMy paragraph.\n\n- later`);
		});

		it("reuses an empty final list item and continues ordered numbering at the default location", () => {
			expect(place("‸1. first\n2. \n\n## Later").result)
				.toBe(`1. first\n2. ${timestampLink("VID", 65)}: ^\n\n## Later`);
			expect(place("‸3. first\n4. last\n\n## Later").result)
				.toBe(`3. first\n4. last\n5. ${timestampLink("VID", 65)}: ^\n\n## Later`);
		});

		it("rejects a malformed block spanning the transcript boundary instead of inserting into it", () => {
			expect(() => place("```\nbro‸ken\n# Transcript\nwords", { transcript: "# Transcript" }))
				.toThrow("a Markdown block crosses its boundary");
		});

		it("does not treat a generic divider and note callout as literature metadata", () => {
			expect(place("‸> [!info] ordinary\n\n___\n> [!note] user writing\n\n- later").result)
				.toBe(`> [!info] ordinary\n\n${item}^\n\n___\n> [!note] user writing\n\n- later`);
		});

		it("keeps a later quote's fallback local and does not cross prose or headings", () => {
			expect(place("- initial\n\n## Topic\n> quote‸\n\n- local\n\n## Other\n- other").result)
				.toBe(`- initial\n\n## Topic\n> quote\n\n- local\n${item}^\n\n## Other\n- other`);
			expect(place("> quote‸\n\nProse\n\n- later").result)
				.toBe(`> quote\n\n${item}^\n\nProse\n\n- later`);
		});

		it("puts a sibling outside a nested quote without stealing the parent item's children", () => {
			expect(place("- parent\n  > quote‸\n  - child\n- next").result)
				.toBe(`- parent\n  > quote\n  - child\n${item}^\n- next`);
		});

		it("uses the initial list for a transcript fallback even with a later heading", () => {
			expect(place("- one\n\n## Later\n- other\n\n# Transcript\nwor‸ds", { transcript: "# Transcript" }).result)
				.toBe(`- one\n${item}^\n\n## Later\n- other\n\n# Transcript\nwords`);
		});
	});

	it("describes moved insertions in the notice", () => {
		expect(insertionMessage("Timestamp", { text: "", cursorOffset: 0 })).toBe("Timestamp inserted.");
		expect(insertionMessage("Timestamp", { text: "", cursorOffset: 0, moved: "after the paragraph" }))
			.toBe("Timestamp inserted after the paragraph.");
	});
});
