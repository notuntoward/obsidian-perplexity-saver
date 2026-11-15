// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installEditorDomHelpers } from "../__mocks__/obsidian";
import { insertionTargetMarker } from "../../src/video/insertionMarker";
import { createNoteInsertionAnchor, insertBlockAtNoteInsertionAnchor, noteInsertionAnchors, releaseNoteInsertionAnchor } from "../../src/video/noteInsertion";
import { transcriptProtectionExtension } from "../../src/litNote/transcriptProtection";
import * as protection from "../../src/litNote/transcriptProtection";

const editors: EditorView[] = [];

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(), setIcon: vi.fn(), setTooltip: vi.fn(),
}));

function editor(text: string, doc = document, enabled: () => boolean = () => true) {
	installEditorDomHelpers(doc);
	const cursor = text.indexOf("|");
	const view = new EditorView({
		state: EditorState.create({
			doc: text.replace("|", ""), selection: { anchor: cursor < 0 ? 0 : cursor },
			extensions: [
				noteInsertionAnchors,
				transcriptProtectionExtension({ heading: () => "Transcript", requestUnlock: async () => {} }),
				insertionTargetMarker(() => ({ enabled: enabled(), literatureNote: true })),
			],
		}),
		parent: doc.body,
	});
	editors.push(view);
	return view;
}

function markedLine(view: EditorView) {
	return view.dom.querySelector(".perplexity-saver-insertion-target")?.textContent;
}

describe("unfocused insertion target marker", () => {
	beforeEach(() => { vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0); });
	afterEach(() => {
		editors.splice(0).forEach((view) => view.destroy());
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it.each([
		["> |source\n\n- first\n- last\n\n## Later", "- lastNext insert below"],
		["|> [!info] Source\n> Details\n\n> Citation\n\n- first\n- last\n\n## Later", "- lastNext insert below"],
		["Paragraph |middle\ncontinued.\n\n## Later", "continued.Next insert below"],
		["- |parent\n  - child\n\n## Later", "  - childNext insert below"],
		["# |Topic\n\n- first", "Next insert above- first"],
		["- |", "- Next insert here"],
		["- notes\n\n# Transcript\n|caption", "- notesNext insert below"],
	])("previews the shared adjusted position without editing or moving the cursor (%s)", (text, expected) => {
		const view = editor(text);
		expect(markedLine(view)).toBe(expected);
		expect(view.state.doc.toString()).toBe(text.replace("|", ""));
		expect(view.state.selection.main.head).toBe(text.indexOf("|"));
	});

	it("follows document edits and the cursor, disappears on focus and respects disabling", () => {
		let enabled = true;
		const view = editor("- |first\n- second", document, () => enabled);
		expect(markedLine(view)).toBe("- firstNext insert below");
		view.dispatch({ selection: { anchor: view.state.doc.length } });
		expect(markedLine(view)).toBe("- secondNext insert below");
		view.dispatch({ changes: { from: view.state.doc.length, insert: " edited" } });
		expect(markedLine(view)).toBe("- second editedNext insert below");
		view.focus();
		view.dispatch({ selection: view.state.selection });
		expect(markedLine(view)).toBeUndefined();
		view.contentDOM.blur();
		view.dispatch({ selection: view.state.selection });
		expect(markedLine(view)).toBe("- second editedNext insert below");
		enabled = false;
		view.dispatch({ selection: view.state.selection });
		expect(markedLine(view)).toBeUndefined();
	});

	it("previews the pending capture's tracked anchor rather than a later cursor move without splitting the insertion transaction", () => {
		const view = editor("- |first\n- second");
		const updates: ViewUpdate[] = [];
		view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => { if (update.docChanged) updates.push(update); })) });
		const anchor = createNoteInsertionAnchor(view)!;
		view.dispatch({ selection: { anchor: view.state.doc.length } });
		expect(markedLine(view)).toBe("- firstNext insert below");
		insertBlockAtNoteInsertionAnchor(anchor, { content: "inserted" });
		expect(view.state.doc.toString()).toBe("- first\n- inserted\n- second");
		expect(updates).toHaveLength(1);
		expect(updates[0].transactions).toHaveLength(1);
		const cancelled = createNoteInsertionAnchor(view)!;
		view.dispatch({ selection: { anchor: view.state.doc.length } });
		releaseNoteInsertionAnchor(cancelled);
		expect(markedLine(view)).toBe("- secondNext insert below");
	});

	it("uses the editor's owning document and its focus in a stand-in pop-out", () => {
		const doc = document.implementation.createHTMLDocument();
		const view = editor("- |popout", doc);
		expect(markedLine(view)).toBe("- popoutNext insert below");
		expect(view.dom.querySelector(".perplexity-saver-insertion-marker")?.ownerDocument).toBe(doc);
		let focused: Element | null = null;
		Object.defineProperty(doc, "activeElement", { configurable: true, get: () => focused });
		vi.spyOn(doc, "hasFocus").mockReturnValue(true);
		focused = view.contentDOM;
		view.dispatch({ selection: view.state.selection });
		expect(markedLine(view)).toBeUndefined();
		focused = doc.body;
		view.dispatch({ selection: view.state.selection });
		expect(markedLine(view)).toBe("- popoutNext insert below");
	});

	it("does not preview an unsafe block crossing the transcript boundary", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(protection, "transcriptStart").mockReturnValue(12);
		const view = editor("```\n|source\n# Transcript\ncaption");
		expect(markedLine(view)).toBeUndefined();
		expect(error).toHaveBeenCalled();
	});

	it("does not introduce bare main-window DOM, focus, clipboard or timer access", () => {
		for (const file of ["src/video/insertionMarker.ts", "src/video/noteInsertion.ts"]) {
			const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
			expect(source).not.toMatch(/(?<![\w.])(?:document|window|navigator)\s*\.\s*(?:activeElement|querySelector|body|createElement|setTimeout|clearTimeout|requestAnimationFrame|getSelection|clipboard|addEventListener)/);
		}
	});
});
