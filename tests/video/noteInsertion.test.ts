// @vitest-environment jsdom
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
	blockInsertion,
	createNoteInsertionAnchor,
	getNoteInsertionPosition,
	insertAtNoteInsertionAnchor,
	noteInsertionAnchors,
	timestampListItemInsertion,
	timestampedScreenshotItem,
} from "../../src/video/noteInsertion";
import { timestampLink } from "../../src/video/youtubeLinks";

describe("video note insertion", () => {
	let view: EditorView | null = null;

	afterEach(() => {
		view?.destroy();
		view = null;
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

	it("preserves selected note text when inserting at the selection head", () => {
		view = new EditorView({
			state: EditorState.create({
				doc: "selected prose",
				selection: { anchor: 0, head: 8 },
				extensions: [noteInsertionAnchors],
			}),
			parent: document.body,
		});
		const anchor = createNoteInsertionAnchor(view);
		expect(anchor).not.toBeNull();
		if (!anchor) throw new Error("Expected an insertion anchor.");
		const insertion = timestampListItemInsertion(view.state.doc, 8, "VID", 65);

		expect(insertAtNoteInsertionAnchor(anchor, insertion.text, insertion.cursorOffset, insertion.replace)).toBe(true);
		expect(view.state.doc.toString()).toBe(`selected\n\n- ${timestampLink("VID", 65)}: \n\n prose`);
	});

	it("creates a timestamp list item at the cursor and reuses an empty list item", () => {
		const link = timestampLink("VID", 65);
		const blank = timestampListItemInsertion(Text.of([""]), 0, "VID", 65);
		expect(blank).toEqual({ text: `- ${link}: `, cursorOffset: `- ${link}: `.length });

		const emptyItem = timestampListItemInsertion(Text.of(["- "]), 2, "VID", 65);
		expect(emptyItem).toEqual({ text: `${link}: `, cursorOffset: `${link}: `.length });
	});

	it("keeps surrounding text and indentation when inserting mid-list", () => {
		const line = "  - before after";
		const position = line.indexOf("after");
		expect(timestampListItemInsertion(Text.of([line]), position, "VID", 65).text)
			.toBe(`\n\n  - ${timestampLink("VID", 65)}: \n\n`);
	});

	it("puts a timestamp list item on its own line without dropping adjacent text", () => {
		const link = timestampLink("VID", 65);
		const insertion = timestampListItemInsertion(Text.of(["before after"]), 6, "VID", 65);
		expect(insertion.text).toBe(`\n\n- ${link}: \n\n`);
		expect(insertion.cursorOffset).toBe(`\n\n- ${link}: `.length);
	});

	it("formats screenshots as timestamped list items and keeps blocks separate from adjacent text", () => {
		const block = timestampedScreenshotItem("![[capture.png]]", "VID", 65);
		expect(blockInsertion(Text.of(["before after"]), 6, block)).toEqual({
			text: `\n\n- ${timestampLink("VID", 65)}:\n  ![[capture.png]]\n\n`,
			cursorOffset: `\n\n- ${timestampLink("VID", 65)}:\n  ![[capture.png]]`.length,
		});
	});

	it.each(["  - ", "\t* ", "    + "])("creates a timestamp sibling with the current indentation and marker (%s)", (marker) => {
		const line = `${marker}existing text`;
		const insertion = timestampListItemInsertion(Text.of([line, `${marker}next item`]), line.length, "VID", 65);
		expect(insertion.text).toBe(`\n${marker}${timestampLink("VID", 65)}: `);
		expect(insertion.cursorOffset).toBe(insertion.text.length);
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

	it("reuses an empty ordered item without advancing its number", () => {
		const insertion = timestampListItemInsertion(Text.of(["  2. "]), 5, "VID", 65);
		expect(insertion.text).toBe(`${timestampLink("VID", 65)}: `);
		expect(insertion.replace).toBeUndefined();
	});

	it("reuses an empty checked task item without changing its state", () => {
		const insertion = timestampListItemInsertion(Text.of(["- [x] "]), 6, "VID", 65);
		expect(insertion.text).toBe(`${timestampLink("VID", 65)}: `);
		expect(insertion.replace).toBeUndefined();
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
