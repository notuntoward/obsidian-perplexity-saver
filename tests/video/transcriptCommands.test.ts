// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import type { EditorView } from "@codemirror/view";
import PerplexitySaverPlugin from "../../src/main";
import { TranscriptView } from "../../src/litNote/transcriptView";
import { VideoView } from "../../src/video/videoView";
import { nextPart } from "../../src/video/switchParts";
import { createdNotices } from "../__mocks__/obsidian";
import type { NoteInsertionTarget } from "../../src/video/noteInsertion";
import "commons/testing";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	debounce: (callback: () => void) => callback,
	Scope: class { register(): void {} },
	Platform: { isDesktopApp: false },
}));
vi.mock("commons/windows", async (original) => ({
	...await original<Record<string, unknown>>(),
	requestFrameIn: (_win: Window, callback: () => void) => { callback(); },
}));
vi.mock("commons/workspace", async (original) => ({
	...await original<Record<string, unknown>>(),
	getActiveLeafInFocusedWindow: (app: App) => app.workspace.activeLeaf ?? null,
	getMainWindow: () => globalThis.window,
	getWindowForLeaf: (leaf: WorkspaceLeaf | null) => leaf?.view.containerEl.ownerDocument.defaultView ?? globalThis.window,
	focusLeafAndWindow: (app: App, leaf: WorkspaceLeaf) => app.workspace.setActiveLeaf(leaf, { focus: true }),
	loadLeafIfDeferred: async () => {},
}));

beforeEach(() => { document.body.empty(); vi.spyOn(window, "focus").mockImplementation(() => {}); });

async function harness() {
	const file = { path: "note.md", basename: "note", extension: "md" };
	const leaves: WorkspaceLeaf[] = [];
	const app = {
		vault: { getFileByPath: () => file, cachedRead: async () => "# Transcript\n[0:00](https://youtu.be/abc?t=0) start\n[0:25](https://youtu.be/abc?t=25) current" },
		metadataCache: { getFileCache: () => ({ headings: [{ heading: "Transcript", level: 1, position: { end: { offset: 12 } } }] }) },
		workspace: {
			getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
			iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback),
			revealLeaf: vi.fn(async () => {}),
			setActiveLeaf: vi.fn((leaf: WorkspaceLeaf) => { app.workspace.activeLeaf = leaf; }),
			ensureSideLeaf: vi.fn(async () => {
				if (!leaves.includes(transcriptLeaf)) leaves.push(transcriptLeaf);
				return transcriptLeaf;
			}),
		},
	} as unknown as App;
	const plugin = new PerplexitySaverPlugin(app, {
		id: "perplexity-saver", name: "Saver", version: "1.0.0", minAppVersion: "1.14.0", author: "", description: "",
	});
	await plugin.loadSettings();
	const transcript = new TranscriptView({ app } as unknown as WorkspaceLeaf, {
		getHeadingName: () => "Transcript",
		getSearchSettings: () => ({ keyboard: "emacs", matching: "all-words", highlights: "always" }),
		playAt: vi.fn(),
	});
	transcript.contentEl = document.createElement("div");
	transcript.containerEl = transcript.contentEl;
	transcript.containerEl.isShown = () => true;
	Object.assign(transcript, { filePath: file.path });
	const transcriptLeaf = { view: transcript, detach: vi.fn(), getViewState: () => ({ state: { file: file.path } }) } as unknown as WorkspaceLeaf;
	vi.spyOn(transcript, "showFile").mockResolvedValue();
	vi.spyOn(transcript, "getFilePath").mockReturnValue(file.path);
	vi.spyOn(transcript, "focusLines").mockImplementation(() => {});
	const viewer = new VideoView({ app } as unknown as WorkspaceLeaf, {
		getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
		isTranscriptShown: () => false, toggleTranscript: (f, l) => plugin.toggleTranscript(f, l), onPlayback: () => {}, focusNote: async () => {},
	});
	viewer.contentEl = document.createElement("div");
	viewer.containerEl = viewer.contentEl;
	viewer.contentEl.tabIndex = 0;
	Object.assign(viewer, { videoId: "abc", filePath: file.path, player: { info: { currentTime: 25.75 } } });
	const viewerLeaf = { view: viewer } as unknown as WorkspaceLeaf;
	leaves.push(viewerLeaf);
	return { plugin, app, file, leaves, transcript, transcriptLeaf, viewerLeaf };
}

describe("transcript activation commands", () => {
	it("defaults the focus indicator on while preserving an explicitly disabled setting", async () => {
		const h = await harness();
		expect(h.plugin.settings.videoNoteFocusIndicator).toBe(true);
		vi.spyOn(h.plugin, "loadData").mockResolvedValue({ videoNoteFocusIndicator: false });
		await h.plugin.loadSettings();
		expect(h.plugin.settings.videoNoteFocusIndicator).toBe(false);
	});

	it.each(["show", "toggle", "go-to", "cycle", "search"] as const)("%s opens a missing panel and assigns keyboard focus", async (action) => {
		const h = await harness();
		const search = vi.spyOn(h.transcript, "focusSearch").mockImplementation(() => {});
		if (action === "show") await h.plugin.showTranscript(h.file as TFile, h.viewerLeaf);
		else if (action === "toggle") await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		else if (action === "search") await h.plugin["focusTranscriptSearch"](null, h.file as TFile);
		else await h.plugin["goToPart"](action === "cycle" ? nextPart("video") : "transcript", h.file as TFile, { note: null, video: h.viewerLeaf, transcript: null });
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(h.transcriptLeaf, { focus: true });
		expect(action === "search" ? search : h.transcript.focusLines).toHaveBeenCalled();
	});

	it("hiding the panel restores viewer keyboard focus without seeking", async () => {
		const h = await harness();
		h.leaves.push(h.transcriptLeaf);
		const focus = vi.spyOn(h.viewerLeaf.view as VideoView, "focusKeys");
		await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		expect(h.transcriptLeaf.detach).toHaveBeenCalledOnce();
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(h.viewerLeaf, { focus: true });
		expect(focus).toHaveBeenCalledOnce();
	});

	it("targets the viewer associated with the focused note when other videos share its window", async () => {
		const h = await harness();
		const note = Object.create(MarkdownView.prototype) as MarkdownView;
		note.file = h.file as TFile;
		note.containerEl = document.createElement("div");
		const noteLeaf = {
			view: note,
			parent: {},
			getViewState: () => ({ state: { file: h.file.path } }),
		} as unknown as WorkspaceLeaf;
		const other = new VideoView(h.viewerLeaf as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript",
			getTimestampCopyFormat: () => "list",
			isTranscriptShown: () => false,
			toggleTranscript: async () => {},
			onPlayback: () => {},
			focusNote: async () => {},
		});
		other.containerEl = document.createElement("div");
		Object.assign(other, { filePath: "other.md" });
		const otherLeaf = { view: other, parent: {} } as unknown as WorkspaceLeaf;
		h.leaves.unshift(otherLeaf);
		h.leaves.push(noteLeaf);
		h.app.workspace.activeLeaf = noteLeaf;

		expect(h.plugin["videoViewForActivePart"]()).toBe(h.viewerLeaf.view);
	});

	it("returns focus to the note editor in a pop-out document after insertion", async () => {
		const h = await harness();
		const popoutDocument = document.implementation.createHTMLDocument();
		const popoutWindow = { document: popoutDocument, closed: false, focus: vi.fn() } as unknown as Window;
		Object.defineProperty(popoutDocument, "defaultView", { value: popoutWindow });
		const activeElement = popoutDocument.createElement("div");
		Object.defineProperty(popoutDocument, "activeElement", { value: activeElement, configurable: true });

		const note = Object.create(MarkdownView.prototype) as MarkdownView;
		note.file = h.file as TFile;
		note.containerEl = popoutDocument.createElement("div");
		const leaf = { view: note } as unknown as WorkspaceLeaf;
		const editorFocus = vi.fn();
		const target: NoteInsertionTarget = {
			leaf,
			filePath: h.file.path,
			anchor: { view: { focus: editorFocus } as unknown as EditorView, id: 1 },
			isValid: () => true,
		};

		await h.plugin["focusNoteInsertionTarget"](target);

		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(leaf, { focus: true });
		expect(editorFocus).toHaveBeenCalledOnce();
	});

	it("does not close an unrelated note's visible transcript", async () => {
		const h = await harness();
		const other = Object.create(TranscriptView.prototype) as TranscriptView;
		other.containerEl = document.createElement("div");
		other.containerEl.isShown = () => true;
		vi.spyOn(other, "getFilePath").mockReturnValue("other.md");
		const otherLeaf = { view: other, detach: vi.fn() } as unknown as WorkspaceLeaf;
		h.leaves.push(otherLeaf);
		await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		expect(otherLeaf.detach).not.toHaveBeenCalled();
		expect(h.transcript.focusLines).toHaveBeenCalled();
	});

	it("an unrelated viewer cannot mark this transcript or reset its playback", async () => {
		const h = await harness();
		Object.assign(h.viewerLeaf.view, { filePath: "other.md", videoId: "other" });
		const mark = vi.spyOn(h.transcript, "showPlayback");
		await h.plugin["goToPart"]("transcript", h.file as TFile, { note: null, video: h.viewerLeaf, transcript: h.transcriptLeaf });
		expect(mark).toHaveBeenCalledWith(null, h.plugin.settings.followTranscript);
	});

	it("explicit navigation honors paused time even when follow playback is off", async () => {
		const h = await harness();
		h.plugin.settings.followTranscript = false;
		const mark = vi.spyOn(h.transcript, "showPlayback");
		await h.plugin["goToPart"]("transcript", h.file as TFile, { note: null, video: h.viewerLeaf, transcript: h.transcriptLeaf });
		expect(mark).toHaveBeenCalledWith(25.75, false);
		expect(h.transcript.focusLines).toHaveBeenCalled();
	});

	it("reveals a hidden panel beside a pop-out viewer in that viewer's window", async () => {
		const h = await harness();
		const doc = document.implementation.createHTMLDocument();
		const win = { document: doc, closed: false, focus: vi.fn() } as unknown as Window;
		Object.defineProperty(doc, "defaultView", { value: win });
		h.viewerLeaf.view.containerEl = doc.createElement("div");
		h.transcript.containerEl = doc.createElement("div");
		h.transcript.contentEl = h.transcript.containerEl;
		h.transcript.containerEl.isShown = () => false;
		h.leaves.push(h.transcriptLeaf);
		vi.spyOn(h.transcript, "showPlayback");
		await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		expect(h.transcriptLeaf.detach).not.toHaveBeenCalled();
		expect(h.app.workspace.ensureSideLeaf).not.toHaveBeenCalled();
		expect(h.transcript.showPlayback).toHaveBeenCalledWith(25.75, true);
		expect(h.transcript.focusLines).toHaveBeenCalled();
		expect(win.focus).toHaveBeenCalled();
	});

	it("reports a missing transcript without activating an unrelated panel", async () => {
		const h = await harness();
		vi.spyOn(h.app.vault, "cachedRead").mockResolvedValue("# Transcript\nno timestamps");
		createdNotices.length = 0;
		await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toContain("No timestamped transcript");
	});

	it("an unlinked viewer cannot close another note's panel", async () => {
		const h = await harness();
		h.leaves.push(h.transcriptLeaf);
		createdNotices.length = 0;
		await h.plugin.toggleTranscript(null, h.viewerLeaf);
		expect(h.transcriptLeaf.detach).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toBe("This video is not linked to a note.");
	});

	it("viewer toggle reveals, activates and focuses the opened transcript", async () => {
		const h = await harness();
		await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		expect(h.app.workspace.setActiveLeaf).toHaveBeenCalledWith(h.transcriptLeaf, { focus: true });
		expect(h.transcript.focusLines).toHaveBeenCalled();
	});

	it("go-to synchronizes current paused time without waiting for a player update", async () => {
		const h = await harness();
		const show = vi.spyOn(h.transcript, "showPlayback").mockImplementation(() => {});
		await h.plugin["goToPart"]("transcript", h.file as TFile, { note: null, video: h.viewerLeaf, transcript: h.transcriptLeaf });
		expect(show).toHaveBeenCalledWith(25.75, h.plugin.settings.followTranscript);
		expect(h.transcript.focusLines).toHaveBeenCalled();
	});
});
