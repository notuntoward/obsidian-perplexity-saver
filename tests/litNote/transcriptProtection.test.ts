// @vitest-environment jsdom
import { EditorState, StateEffect, Text, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plugin, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { getActiveLeafInFocusedWindow } from "commons/workspace";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import {
	lockTranscript,
	approveTranscriptUpdate,
	protectedTranscriptRanges,
	registerTranscriptProtection,
	transcriptProtectionExtension,
	transcriptProtectionState,
	unlockTranscript,
} from "../../src/litNote/transcriptProtection";
import { createNoteInsertionAnchor, getNoteInsertionPosition, insertAtNoteInsertionAnchor, noteInsertionAnchors } from "../../src/video/noteInsertion";
import { createdNotices, editorInfoField, installEditorDomHelpers, MarkdownView } from "../__mocks__/obsidian";

vi.mock("../../src/litNote/decisionModal", () => ({ askNoteDecision: vi.fn() }));
vi.mock("commons/workspace", async (original) => ({
	...await original<Record<string, unknown>>(),
	getActiveLeafInFocusedWindow: vi.fn(),
}));

const content = "Notes\n\n# Transcript\n<!-- saver-word-timing:1 hash -->\n[0:01](url) caption\n\n# Other\nMore notes";
const transcriptStart = content.indexOf("# Transcript");
const captionStart = content.indexOf("caption");
const editors: EditorView[] = [];

function state(doc = content, heading = "Transcript"): EditorState {
	return EditorState.create({
		doc,
		extensions: [transcriptProtectionExtension({ heading: () => heading, requestUnlock: async () => {} })],
	});
}

function edit(editor: EditorState, from: number, to: number, insert: string, event = "input"): EditorState {
	return editor.update({ changes: { from, to, insert }, annotations: Transaction.userEvent.of(event) }).state;
}

function editor(doc = content, parent = document.body): EditorView {
	installEditorDomHelpers(parent.ownerDocument);
	const view = new EditorView({ state: state(doc), parent });
	editors.push(view);
	return view;
}

beforeEach(() => {
	installEditorDomHelpers(document);
	createdNotices.length = 0;
	vi.mocked(askNoteDecision).mockReset().mockResolvedValue("cancel");
});

afterEach(() => {
	for (const view of editors.splice(0)) view.destroy();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("transcript editor protection", () => {
	it.each(["input.type", "input.paste", "delete.cut", "input.drop", "undo", "redo"])(
		"rejects %s inside the transcript, preserving the entire edit", (event) => {
			const initial = state();
			const updated = edit(initial, captionStart, captionStart + 3, "changed", event);
			expect(updated.doc.toString()).toBe(content);
			expect(createdNotices.at(-1)?.message).toContain("Transcript is protected");
		});

	it("blocks heading/metadata edits, transcript-end insertion, and deletion spanning notes and transcript", () => {
		for (const [from, to] of [
			[transcriptStart, transcriptStart + 1],
			[content.indexOf("hash"), content.indexOf("hash") + 4],
			[0, captionStart + 3],
			[0, content.length],
		]) {
			expect(edit(state(), from, to, "").doc.toString()).toBe(content);
		}
		const eof = content.slice(0, content.indexOf("# Other"));
		expect(edit(state(eof), eof.length, eof.length, "image").doc.toString()).toBe(eof);
	});

	it("rejects all changes in a multi-range transaction when any touches the transcript", () => {
		const updated = state().update({
			changes: [{ from: 0, insert: "safe" }, { from: captionStart, insert: "unsafe" }],
			annotations: Transaction.userEvent.of("input.paste"),
		}).state;
		expect(updated.doc.toString()).toBe(content);
	});

	it("allows ordinary notes, navigation and selection, tracking the section after edits above it", () => {
		let updated = edit(state(), 0, 5, "My notes");
		expect(updated.doc.toString()).toBe(content.replace("Notes", "My notes"));
		updated = updated.update({ selection: { anchor: 0, head: updated.doc.length } }).state;
		expect(updated.selection.main.to).toBe(updated.doc.length);
		const position = updated.doc.toString().indexOf("caption");
		expect(edit(updated, position, position, "bad").doc.toString()).toBe(updated.doc.toString());
		const other = updated.doc.toString().indexOf("More notes");
		expect(edit(updated, other, other, "New ").doc.toString()).toContain("New More notes");
		expect(createdNotices).toHaveLength(1);
	});

	it("protects structural boundaries that could swallow notes into the transcript", () => {
		for (const [from, to] of [
			[transcriptStart - 2, transcriptStart],
			[content.indexOf("# Other"), content.indexOf("# Other") + 1],
		]) {
			expect(edit(state(), from, to, "").doc.toString()).toBe(content);
		}
	});

	it("rate-limits blocked-edit notices without suppressing protection", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		let updated = state();
		for (let i = 0; i < 10; i++) updated = edit(updated, captionStart, captionStart, "bad");
		expect(updated.doc.toString()).toBe(content);
		expect(createdNotices).toHaveLength(1);
		clock.mockReturnValue(3500);
		edit(updated, captionStart, captionStart, "bad");
		expect(createdNotices).toHaveLength(2);
	});

	it("recognises custom/default headings, nested sections, setext headings, and ignores code/frontmatter", () => {
		const doc = "---\nvalue: |\n  # Transcript\n---\n```\n# Transcript\n```\n# Captions #\ntext\n## Child\nchild\n# Notes\nsafe\n\nTranscript\n==========\nlegacy";
		const ranges = protectedTranscriptRanges(Text.of(doc.split("\n")), "Captions");
		expect(ranges).toHaveLength(2);
		expect(doc.slice(ranges[0].from, ranges[0].to)).toBe("# Captions #\ntext\n## Child\nchild\n");
		expect(doc.slice(ranges[1].from, ranges[1].to)).toBe("Transcript\n==========\nlegacy");
	});

	it("has no effect on notes without a transcript", () => {
		expect(edit(state("# Notes\nprose"), 8, 8, "new ").doc.toString()).toBe("# Notes\nnew prose");
		expect(createdNotices).toHaveLength(0);
	});

	it("relocks immediately without undoing edits, and relocks on document reload/new editor", () => {
		const view = editor();
		unlockTranscript(view);
		view.dispatch({ changes: { from: captionStart, insert: "edited " }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toContain("edited caption");
		lockTranscript(view);
		expect(view.state.field(transcriptProtectionState).unlocked).toBe(false);
		expect(view.state.doc.toString()).toContain("edited caption");
		view.dispatch({ changes: { from: captionStart, insert: "blocked " }, userEvent: "input.type" });
		expect(view.state.doc.toString()).not.toContain("blocked");
		unlockTranscript(view);
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
		expect(view.state.field(transcriptProtectionState).unlocked).toBe(false);
		expect(editor().state.field(transcriptProtectionState).unlocked).toBe(false);
	});

	it("allows intentional whole-document vault updates while locked", () => {
		const updated = state().update({ changes: { from: 0, to: content.length, insert: content.replace("caption", "fresh caption") } }).state;
		expect(updated.doc.toString()).toContain("fresh caption");
		expect(updated.field(transcriptProtectionState).unlocked).toBe(false);
	});

	it("allows only the exact approved repair when Obsidian applies a partial document update", () => {
		const file = { path: "video.md" } as TFile;
		const initial = EditorState.create({
			doc: content,
			extensions: [
				editorInfoField.init(() => ({ file })),
				transcriptProtectionExtension({ heading: () => "Transcript", requestUnlock: async () => {} }),
			],
		});
		approveTranscriptUpdate(file, content.replace("caption", "fresh caption"));
		expect(initial.update({ changes: { from: captionStart, insert: "fresh " } }).state.doc.toString()).toContain("fresh caption");
		expect(edit(initial, captionStart, captionStart, "fresh ").doc.toString()).toBe(content);
		expect(edit(initial, captionStart, captionStart, "different ").doc.toString()).toBe(content);
	});

	it.each([false, true])("blocks automatic captures even when unlocked (%s)", (unlocked) => {
		const view = new EditorView({
			state: EditorState.create({
				doc: content, selection: { anchor: captionStart },
				extensions: [
					noteInsertionAnchors,
					transcriptProtectionExtension({ heading: () => "Transcript", requestUnlock: async () => {} }),
				],
			}),
			parent: document.body,
		});
		editors.push(view);
		if (unlocked) unlockTranscript(view);
		const anchor = createNoteInsertionAnchor(view);
		if (!anchor) throw new Error("Expected insertion anchor.");
		expect(insertAtNoteInsertionAnchor(anchor, "![[capture.png]]")).toBe(false);
		expect(view.state.doc.toString()).toBe(content);
		expect(createdNotices.at(-1)?.message).toContain("Cannot insert into the transcript");
	});

	it("rechecks a tracked capture location after an unlocked edit moves it into the transcript", () => {
		const view = editor();
		view.dispatch({ effects: StateEffect.appendConfig.of(noteInsertionAnchors), selection: { anchor: content.indexOf("More notes") } });
		const anchor = createNoteInsertionAnchor(view);
		if (!anchor) throw new Error("Expected insertion anchor.");
		unlockTranscript(view);
		view.dispatch({ changes: { from: content.indexOf("# Other"), insert: "#" }, userEvent: "input.type" });
		const before = view.state.doc.toString();
		expect(insertAtNoteInsertionAnchor(anchor, "![[capture.png]]")).toBe(false);
		expect(view.state.doc.toString()).toBe(before);
		expect(getNoteInsertionPosition(anchor)).toBeNull();
	});
});

describe("transcript lock controls", () => {
	function registeredEditor(secondDocument = false) {
		const doc = secondDocument ? document.implementation.createHTMLDocument() : document;
		if (secondDocument) Object.defineProperty(doc, "defaultView", { value: window });
		installEditorDomHelpers(doc);
		const parent = doc.createElement("div");
		doc.body.append(parent);
		if (secondDocument) Object.defineProperty(doc, "activeElement", { value: parent, configurable: true });
		const app = {} as App;
		const plugin = new class extends Plugin {}(app, { id: "test", name: "Test", version: "1", minAppVersion: "1.14.0", author: "", description: "" });
		const extension = vi.spyOn(plugin, "registerEditorExtension");
		const commands = vi.spyOn(plugin, "addCommand");
		registerTranscriptProtection(plugin, () => "Transcript");
		const view = new EditorView({ state: EditorState.create({ doc: content, extensions: [extension.mock.calls[0][0]] }), parent });
		editors.push(view);
		const markdown = new MarkdownView();
		markdown.containerEl = parent;
		vi.mocked(getActiveLeafInFocusedWindow).mockReturnValue({ view: markdown } as unknown as WorkspaceLeaf);
		return { view, parent, commands };
	}

	it.each([false, true])("confirms unlock and offers a persistent immediate Lock button in its owning document (%s)", async (secondDocument) => {
		const { view, parent } = registeredEditor(secondDocument);
		vi.mocked(askNoteDecision).mockResolvedValue("unlock");
		const unlock = parent.querySelector<HTMLButtonElement>(".saver-transcript-lock button");
		expect(unlock?.ownerDocument).toBe(parent.ownerDocument);
		unlock?.click();
		await vi.waitFor(() => expect(view.state.field(transcriptProtectionState).unlocked).toBe(true));
		expect(askNoteDecision).toHaveBeenCalledWith(expect.anything(), "Unlock transcript for editing?",
			expect.stringContaining("invalidate word timings"), expect.anything());
		expect(parent.querySelector(".saver-transcript-lock")?.textContent).toContain("Transcript unlocked");
		parent.querySelector<HTMLButtonElement>(".saver-transcript-lock button")?.click();
		expect(view.state.field(transcriptProtectionState).unlocked).toBe(false);
		expect(askNoteDecision).toHaveBeenCalledTimes(1);
	});

	it("leaves the transcript locked after cancelling the confirmation", async () => {
		const { view, parent } = registeredEditor();
		parent.querySelector<HTMLButtonElement>(".saver-transcript-lock button")?.click();
		await vi.waitFor(() => expect(askNoteDecision).toHaveBeenCalledOnce());
		expect(view.state.field(transcriptProtectionState).unlocked).toBe(false);
	});

	it("refuses a delayed unlock if the note changed or the editor closed", async () => {
		for (const closed of [false, true]) {
			const { view, parent } = registeredEditor();
			let resolve!: (choice: "unlock") => void;
			vi.mocked(askNoteDecision).mockReturnValue(new Promise((done) => { resolve = done; }));
			parent.querySelector<HTMLButtonElement>(".saver-transcript-lock button")?.click();
			if (closed) parent.remove();
			else view.dispatch({ changes: { from: 0, insert: "new " }, userEvent: "input.type" });
			resolve("unlock");
			await vi.waitFor(() => expect(createdNotices.at(-1)?.message).toContain("remains protected"));
			expect(view.state.field(transcriptProtectionState).unlocked).toBe(false);
			createdNotices.length = 0;
		}
	});

	it("exposes the matching unlock/lock commands only in the appropriate state", async () => {
		const { view, commands } = registeredEditor();
		const unlock = commands.mock.calls.find(([command]) => command.id === "unlock-transcript-for-editing")?.[0];
		const lock = commands.mock.calls.find(([command]) => command.id === "lock-transcript")?.[0];
		expect(unlock?.checkCallback?.(true)).toBe(true);
		expect(lock?.checkCallback?.(true)).toBe(false);
		vi.mocked(askNoteDecision).mockResolvedValue("unlock");
		unlock?.checkCallback?.(false);
		await vi.waitFor(() => expect(view.state.field(transcriptProtectionState).unlocked).toBe(true));
		expect(unlock?.checkCallback?.(true)).toBe(false);
		expect(lock?.checkCallback?.(true)).toBe(true);
		lock?.checkCallback?.(false);
		expect(view.state.field(transcriptProtectionState).unlocked).toBe(false);
	});
});
