// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { createdNotices, installEditorDomHelpers } from "../__mocks__/obsidian";
import { VideoView, type VideoViewHost } from "../../src/video/videoView";
import { createNoteInsertionAnchor, noteInsertionAnchors, type NoteInsertionTarget, type TimestampListStyle } from "../../src/video/noteInsertion";
import * as noteInsertion from "../../src/video/noteInsertion";

const captureImage = vi.hoisted(() => vi.fn());
const writeClipboard = vi.hoisted(() => vi.fn());
const requestFrame = vi.hoisted(() =>
	vi.fn((_win: unknown, callback: (time: number) => void) => {
		callback(0);
		return () => {};
	})
);
const setTimeoutIn = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("commons/os", async (original) => ({
	...await original<Record<string, unknown>>(),
	captureElementImage: captureImage,
}));

vi.mock("commons/windows", async (original) => ({
	...await original<Record<string, unknown>>(),
	writeClipboardIn: writeClipboard,
	requestFrameIn: requestFrame,
	setTimeoutIn,
}));

const editors: EditorView[] = [];

function insertionTarget(doc: string): NoteInsertionTarget {
	const editorView = new EditorView({
		state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [noteInsertionAnchors] }),
		parent: document.body,
	});
	editors.push(editorView);
	const anchor = createNoteInsertionAnchor(editorView);
	if (!anchor) throw new Error("Expected the note insertion anchor extension.");
	return {
		leaf: { view: { file: { path: "Lit.md" } } } as unknown as WorkspaceLeaf,
		filePath: "Lit.md",
		anchor,
		isValid: () => true,
	};
}

function videoView(listStyle: TimestampListStyle = "match") {
	const file = { path: "Lit.md", basename: "Lit" };
	const image = { path: "Attachments/capture.png" };
	const focusNote = vi.fn().mockResolvedValue(undefined);
	const app = {
		vault: {
			getFileByPath: vi.fn(() => file),
			createBinary: vi.fn().mockResolvedValue(image),
		},
		fileManager: {
			getAvailablePathForAttachment: vi.fn().mockResolvedValue(image.path),
			generateMarkdownLink: vi.fn().mockReturnValue("[[capture.png]]"),
		},
	};
	const host: VideoViewHost = {
		getTranscriptHeading: () => "Transcript",
		getTimestampCopyFormat: () => "list",
		getTimestampListStyle: () => listStyle,
		getShowYoutubeCaptions: () => false,
		getToolbarCaptureAction: () => "insert", insertTimestamp: async () => {}, insertScreenshot: async () => {},
		isTranscriptShown: () => false,
		toggleTranscript: async () => {},
		jumpToTranscriptTimestamp: () => {},
		onPlayback: () => {},
		focusNote,
	};
	const view = new VideoView({ app } as unknown as WorkspaceLeaf, host);
	const player = { info: { currentTime: 65.9 }, pause: vi.fn() };
	view.contentEl = document.createElement("div");
	Object.assign(view, {
		videoId: "VID",
		filePath: file.path,
		stageEl: document.createElement("div"),
		player,
	});
	return { view, app, focusNote, image, player };
}

describe("video capture insertion", () => {
	beforeEach(() => {
		installEditorDomHelpers(document);
		captureImage.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
		writeClipboard.mockReset().mockResolvedValue(true);
		createdNotices.length = 0;
	});

	afterEach(() => {
		for (const editor of editors.splice(0)) editor.destroy();
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("pauses and inserts a timestamp list item, then focuses the associated note", async () => {
		const target = insertionTarget("");
		const { view, focusNote, player } = videoView();

		await view.insertTimestampBullet(target);

		expect(player.pause).toHaveBeenCalledOnce();
		expect(target.anchor.view.state.doc.toString()).toBe("- [1:05](https://www.youtube.com/watch?v=VID&t=65): ");
		expect(target.anchor.view.state.selection.main.head).toBe(target.anchor.view.state.doc.length);
		expect(focusNote).toHaveBeenCalledWith(target);
		expect(createdNotices.at(-1)?.message).toBe("Timestamp inserted.");
	});

	it("uses the configured list style and advances ordered items", async () => {
		const target = insertionTarget("3. existing");
		const { view } = videoView("ordered");

		await view.insertTimestampBullet(target);

		expect(target.anchor.view.state.doc.toString()).toBe(
			`3. existing\n4. [1:05](https://www.youtube.com/watch?v=VID&t=65): `
		);
	});

	it("saves a whole-frame screenshot before inserting it, and does not change the clipboard", async () => {
		const target = insertionTarget("");
		const { view, app, focusNote, image, player } = videoView();

		await view.insertScreenshotForNote(target, true);

		expect(player.pause).toHaveBeenCalledOnce();
		expect(app.vault.createBinary).toHaveBeenCalledOnce();
		expect(target.anchor.view.state.doc.toString()).toBe(
			"- [1:05](https://www.youtube.com/watch?v=VID&t=65):\n  ![[capture.png]]"
		);
		expect(focusNote).toHaveBeenCalledWith(target);
		expect(writeClipboard).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toBe(`Timestamped screenshot inserted.`);
		expect(image.path).toBe("Attachments/capture.png");
	});

	it("copies a saved screenshot when its note becomes unavailable during saving", async () => {
		const target = insertionTarget("");
		const { view, app, image } = videoView();
		let valid = true;
		target.isValid = () => valid;
		app.vault.createBinary.mockImplementation(async () => {
			valid = false;
			return image;
		});

		await view.insertScreenshotForNote(target, true);

		expect(app.vault.createBinary).toHaveBeenCalledOnce();
		expect(target.anchor.view.state.doc.toString()).toBe("");
		expect(writeClipboard).toHaveBeenCalledWith(window, "![[capture.png]]\n[1:05](https://www.youtube.com/watch?v=VID&t=65)");
		expect(createdNotices.at(-1)?.message).toContain(`Saved to ${image.path}. The note changed before insertion.`);
		expect(createdNotices.at(-1)?.message).toContain("copied to clipboard instead");
	});

	it.each([false, true])("freezes captured video identity and playback time while the attachment is saved (copy=%s)", async (copy) => {
		const target = insertionTarget("");
		const { view, app, player, image } = videoView();
		view["host"].getTimestampInsertionTime = () => ({ seconds: 763, selected: true });
		player.info.currentTime = 705.9;
		app.vault.createBinary.mockImplementation(async () => {
			player.info.currentTime = 763;
			Object.assign(view, { videoId: "OTHER" });
			return image;
		});
		if (copy) await view.screenshot(true);
		else await view.insertScreenshotForNote(target, true);
		const text = copy ? writeClipboard.mock.calls[0][1] : target.anchor.view.state.doc.toString();
		expect(text).toContain("[11:45](https://www.youtube.com/watch?v=VID&t=705)");
		expect(text).not.toContain("763");
		expect(text).not.toContain("OTHER");
		expect(app.fileManager.getAvailablePathForAttachment.mock.calls[0][0]).toContain("@11m45s.png");
	});

	it("does not save a possibly mismatched frame if the video changes during pixel capture", async () => {
		const { view, app } = videoView();
		vi.spyOn(console, "error").mockImplementation(() => {});
		captureImage.mockImplementation(async () => {
			Object.assign(view, { videoId: "OTHER" });
			return new Uint8Array([1]);
		});
		await view.screenshot(true);
		expect(app.vault.createBinary).not.toHaveBeenCalled();
		expect(writeClipboard).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toContain("Could not capture");
	});

	it("captures and copies instead of abandoning an image when its target is already gone", async () => {
		const target = insertionTarget("");
		target.isValid = () => false;
		const { view, app, player } = videoView();
		await view.insertScreenshotForNote(target, true);
		expect(player.pause).toHaveBeenCalledOnce();
		expect(app.vault.createBinary).toHaveBeenCalledOnce();
		expect(writeClipboard).toHaveBeenCalledOnce();
		expect(target.anchor.view.state.doc.toString()).toBe("");
	});

	it("captures to the clipboard when no editing target is available, but cancels a snip without copying", async () => {
		const { view, app, player } = videoView();
		await view.insertScreenshotForNote(undefined, true, "The note is not editable.");
		expect(player.pause).toHaveBeenCalledOnce();
		expect(writeClipboard).toHaveBeenCalledOnce();
		expect(createdNotices.at(-1)?.message).toContain("The note is not editable.");
		writeClipboard.mockClear();
		app.vault.createBinary.mockClear();
		await view.insertScreenshotForNote(undefined, false, "The note is not editable.");
		view["endSnip"](null, true);
		expect(app.vault.createBinary).not.toHaveBeenCalled();
		expect(writeClipboard).not.toHaveBeenCalled();
	});

	it.each([false, true])("reports denied/failed clipboard fallback while preserving the saved image (throws=%s)", async (throws) => {
		const { view, app, image } = videoView();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		if (throws) writeClipboard.mockRejectedValue(new Error("denied"));
		else writeClipboard.mockResolvedValue(false);
		await view.insertScreenshotForNote(undefined, true, "No editor.");
		expect(app.vault.createBinary).toHaveBeenCalledOnce();
		expect(createdNotices.at(-1)?.message).toContain("could not be copied");
		expect(createdNotices.at(-1)?.message).toContain(image.path);
		expect(error).toHaveBeenCalled();
	});

	it("does not copy after a successful insertion when returning focus fails", async () => {
		const target = insertionTarget("");
		const { view, focusNote } = videoView();
		vi.spyOn(console, "error").mockImplementation(() => {});
		focusNote.mockRejectedValue(new Error("lost focus"));
		expect(await view.insertTimestampBullet(target)).toBe(true);
		target.anchor = createNoteInsertionAnchor(target.anchor.view)!;
		await view.insertScreenshotForNote(target, true);
		expect(target.anchor.view.state.doc.toString()).toContain("![[capture.png]]");
		expect(writeClipboard).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toContain("inserted.");
	});

	it("does not copy a duplicate after an editor error occurring after the screenshot's document change", async () => {
		const target = insertionTarget("");
		const { view } = videoView();
		const insert = noteInsertion.insertBlockAtNoteInsertionAnchor;
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(noteInsertion, "insertBlockAtNoteInsertionAnchor").mockImplementation((...args) => {
			insert(...args);
			throw new Error("Renderer failed after applying the change");
		});
		await view.insertScreenshotForNote(target, true);
		expect(target.anchor.view.state.doc.toString()).toContain("![[capture.png]]");
		expect(writeClipboard).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toContain("Check the note before retrying; nothing was copied");
	});

	it.each([undefined, { x: 10, y: 20, width: 100, height: 50 }])("inserts whole pictures and snips as nested siblings (%j)", async (region) => {
		const target = insertionTarget("  - existing text");
		const { view } = videoView();
		await view["captureAndSave"](region, target);
		expect(target.anchor.view.state.doc.toString()).toBe(
			"  - existing text\n  - [1:05](https://www.youtube.com/watch?v=VID&t=65):\n    ![[capture.png]]"
		);
		expect(captureImage).toHaveBeenCalledWith(view["stageEl"], region);
	});

	it.each([undefined, { x: 10, y: 20, width: 100, height: 50 }])("uses safe local placement and the captured frame time, not a selected transcript time (%j)", async (region) => {
		const target = insertionTarget("> source\n\n- notes\n\n## Later");
		target.anchor.view.dispatch({ selection: { anchor: 3 } });
		const anchor = createNoteInsertionAnchor(target.anchor.view);
		if (!anchor) throw new Error("Missing insertion anchor.");
		target.anchor = anchor;
		const { view } = videoView();
		view["host"].getTimestampInsertionTime = () => ({ seconds: 763, selected: true });
		await view["captureAndSave"](region, target);
		expect(target.anchor.view.state.doc.toString()).toBe(
			"> source\n\n- notes\n- [1:05](https://www.youtube.com/watch?v=VID&t=65):\n  ![[capture.png]]\n\n## Later"
		);
		expect(writeClipboard).not.toHaveBeenCalled();
	});
});
