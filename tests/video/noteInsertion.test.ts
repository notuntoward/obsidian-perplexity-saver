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
	timestampBulletInsertion,
	timestampedScreenshotBlock,
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
		const insertion = timestampBulletInsertion(view.state.doc, 8, "VID", 65);

		expect(insertAtNoteInsertionAnchor(anchor, insertion.text, insertion.cursorOffset)).toBe(true);
		expect(view.state.doc.toString()).toBe(`selected\n\n- ${timestampLink("VID", 65)}: \n\n prose`);
	});

	it("creates a timestamp bullet at the cursor and reuses an empty list item", () => {
		const link = timestampLink("VID", 65);
		const blank = timestampBulletInsertion(Text.of([""]), 0, "VID", 65);
		expect(blank).toEqual({ text: `- ${link}: `, cursorOffset: `- ${link}: `.length });

		const emptyItem = timestampBulletInsertion(Text.of(["- "]), 2, "VID", 65);
		expect(emptyItem).toEqual({ text: `${link}: `, cursorOffset: `${link}: `.length });
	});

	it("puts a timestamp bullet on its own line without dropping adjacent text", () => {
		const link = timestampLink("VID", 65);
		const insertion = timestampBulletInsertion(Text.of(["before after"]), 6, "VID", 65);
		expect(insertion.text).toBe(`\n\n- ${link}: \n\n`);
		expect(insertion.cursorOffset).toBe(`\n\n- ${link}: `.length);
	});

	it("formats screenshots as timestamped list items and keeps blocks separate from adjacent text", () => {
		const block = timestampedScreenshotBlock("![[capture.png]]", "VID", 65);
		expect(block).toBe(`- ${timestampLink("VID", 65)}:\n  ![[capture.png]]`);
		expect(blockInsertion(Text.of(["before after"]), 6, block)).toEqual({
			text: `\n\n${block}\n\n`,
			cursorOffset: `\n\n${block}`.length,
		});
	});

	it.each(["  - ", "\t* ", "    + "])("creates a timestamp sibling with the current indentation and marker (%s)", (marker) => {
		const line = `${marker}existing text`;
		const insertion = timestampBulletInsertion(Text.of([line, `${marker}next item`]), line.length, "VID", 65);
		expect(insertion.text).toBe(`\n${marker}${timestampLink("VID", 65)}: `);
		expect(insertion.cursorOffset).toBe(insertion.text.length);
	});

	it("keeps a screenshot inside a new nested sibling instead of creating a top-level bullet", () => {
		const line = "  - existing text";
		const block = timestampedScreenshotBlock("![[capture.png]]", "VID", 65);
		expect(blockInsertion(Text.of([line]), line.length, block).text).toBe(
			`\n  - ${timestampLink("VID", 65)}:\n    ![[capture.png]]`
		);
	});

	it("reuses an empty nested bullet for a screenshot, indenting its embed", () => {
		const block = timestampedScreenshotBlock("![[capture.png]]", "VID", 65);
		expect(blockInsertion(Text.of(["  - "]), 4, block).text).toBe(
			`${timestampLink("VID", 65)}:\n    ![[capture.png]]`
		);
	});

	it("creates an ordered sibling without repeating a checkbox's checked state", () => {
		const line = "  3. [x] existing";
		const insertion = timestampBulletInsertion(Text.of([line]), line.length, "VID", 65);
		expect(insertion.text).toBe(`\n  4. ${timestampLink("VID", 65)}: `);
	});
});
