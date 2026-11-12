// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { createdNotices } from "../__mocks__/obsidian";
import { VideoView, type VideoViewHost } from "../../src/video/videoView";
import { createNoteInsertionAnchor, noteInsertionAnchors, type NoteInsertionTarget } from "../../src/video/noteInsertion";

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

function videoView() {
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
		captureImage.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
		writeClipboard.mockReset().mockResolvedValue(true);
		createdNotices.length = 0;
	});

	afterEach(() => {
		for (const editor of editors.splice(0)) editor.destroy();
		document.body.replaceChildren();
	});

	it("pauses and inserts a timestamp bullet, then focuses the associated note", async () => {
		const target = insertionTarget("");
		const { view, focusNote, player } = videoView();

		await view.insertTimestampBullet(target);

		expect(player.pause).toHaveBeenCalledOnce();
		expect(target.anchor.view.state.doc.toString()).toBe("- [1:05](https://www.youtube.com/watch?v=VID&t=65): ");
		expect(target.anchor.view.state.selection.main.head).toBe(target.anchor.view.state.doc.length);
		expect(focusNote).toHaveBeenCalledWith(target);
		expect(createdNotices.at(-1)?.message).toBe("Timestamp inserted.");
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

	it("reports when a saved screenshot can no longer be inserted into its note", async () => {
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
		expect(createdNotices.at(-1)?.message).toBe(
			`Screenshot saved to ${image.path}, but the literature note changed before insertion.`
		);
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
});
