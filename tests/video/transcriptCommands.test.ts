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
import * as workspaceApi from "commons/workspace";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	debounce: (callback: () => void) => callback,
	Scope: class { register(): void {} },
	Platform: { isDesktopApp: false },
	setIcon: () => {},
	SearchComponent: class {
		inputEl: HTMLInputElement;
		constructor(parent: HTMLElement) { this.inputEl = parent.createEl("input"); }
		setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
		setValue(value: string): this { this.inputEl.value = value; return this; }
		onChange(): this { return this; }
	},
}));
vi.mock("commons/windows", async (original) => ({
	...await original<Record<string, unknown>>(),
	requestFrameIn: (_win: Window, callback: () => void) => { callback(); },
}));
vi.mock("../../src/video/focusIndicator", () => ({ registerVideoNoteFocusIndicator: () => () => {} }));
vi.mock("../../src/litNote/transcriptFolding", () => ({ registerTranscriptFolding: () => () => {} }));
vi.mock("../../src/litNote/litNoteServer", () => ({ startLitNoteServer: () => null, stopLitNoteServer: () => {} }));
vi.mock("commons/workspace", async (original) => ({
	...await original<Record<string, unknown>>(),
	getActiveLeafInFocusedWindow: (app: App) => app.workspace.activeLeaf ?? null,
	getMainWindow: () => globalThis.window,
	getWindowForLeaf: (leaf: WorkspaceLeaf | null) => leaf?.view.containerEl.ownerDocument.defaultView ?? globalThis.window,
	focusLeafAndWindow: (app: App, leaf: WorkspaceLeaf) => app.workspace.setActiveLeaf(leaf, { focus: true }),
	loadLeafIfDeferred: async () => {},
}));

beforeEach(() => {
	document.body.empty();
	vi.spyOn(window, "focus").mockImplementation(() => {});
	HTMLElement.prototype.toggleClass = function (cls, value) { this.classList.toggle(cls, value); };
	HTMLElement.prototype.isShown = function () { return true; };
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

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
			getRightLeaf: vi.fn(() => {
				if (!leaves.includes(transcriptLeaf)) leaves.push(transcriptLeaf);
				return transcriptLeaf;
			}),
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
	const transcriptLeaf = { view: transcript, setViewState: vi.fn(async () => {}), detach: vi.fn(), getViewState: () => ({ state: { file: file.path } }) } as unknown as WorkspaceLeaf;
	vi.spyOn(transcript, "showFile").mockResolvedValue();
	vi.spyOn(transcript, "getFilePath").mockReturnValue(file.path);
	vi.spyOn(transcript, "focusLines").mockImplementation(() => {});
	const viewer = new VideoView({ app } as unknown as WorkspaceLeaf, {
		getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
		getShowYoutubeCaptions: () => false,
		getToolbarCaptureAction: () => "insert", insertTimestamp: async () => {}, insertScreenshot: async () => {},
		isTranscriptShown: () => false, toggleTranscript: (f, l) => plugin.toggleTranscript(f, l), onPlayback: () => {}, focusNote: async () => {},
	});
	viewer.contentEl = document.createElement("div");
	viewer.containerEl = viewer.contentEl;
	viewer.contentEl.tabIndex = 0;
	Object.assign(viewer, { videoId: "abc", filePath: file.path, player: { info: { currentTime: 25.75 }, setCaptions: vi.fn() } });
	const viewerLeaf = { view: viewer } as unknown as WorkspaceLeaf;
	leaves.push(viewerLeaf);
	return { plugin, app, file, leaves, transcript, transcriptLeaf, viewerLeaf };
}

describe("transcript activation commands", () => {
	it.each([false, true])("full registration preserves duplicate hotkeys only when bound (%s)", async (bound) => {
		const h = await harness();
		const duplicates = ["open-youtube-video-viewer", "video-viewer-toggle-transcript", "transcript-location-sidebar", "transcript-location-viewer", "transcript-location-beside"];
		Object.assign(h.app, { hotkeyManager: {
			printHotkeyForCommand: (id: string) => bound && duplicates.some((duplicate) => id.endsWith(`:${duplicate}`)) ? "Ctrl + Alt + T" : "",
		} });
		Object.assign(h.app.workspace, { on: vi.fn(), onLayoutReady: vi.fn(), getLastOpenFiles: () => [] });
		Object.assign(h.app.vault, { on: vi.fn() });
		Object.assign(h.plugin, { registerView: vi.fn() });
		h.plugin.settings.autoRelinkSources = false;
		vi.spyOn(h.plugin, "loadSettings").mockResolvedValue();
		const commands: import("obsidian").Command[] = [];
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
		await h.plugin.onload();
		const factory = vi.mocked(h.plugin.registerView).mock.calls.find(([type]) => type === h.viewerLeaf.view.getViewType())?.[1];
		if (!factory) throw new Error("Missing video view registration");
		const registered = factory(h.viewerLeaf) as VideoView;
		expect(registered["host"].getToolbarCaptureAction()).toBe("insert");
		h.plugin.settings.videoToolbarCaptureAction = "copy";
		expect(registered["host"].getToolbarCaptureAction()).toBe("copy");
		expect(registered["host"].getShowYoutubeCaptions()).toBe(false);
		h.plugin.settings.showYoutubeCaptions = true;
		expect(registered["host"].getShowYoutubeCaptions()).toBe(true);
		const noticeCount = createdNotices.length;
		await registered["host"].insertTimestamp(h.viewerLeaf.view as VideoView);
		await registered["host"].insertScreenshot(h.viewerLeaf.view as VideoView, true);
		expect(createdNotices.slice(noticeCount).map((notice) => notice.message)).toEqual([
			"Open the literature note in editing view before inserting a video capture.",
			"Open the literature note in editing view before inserting a video capture.",
		]);
		const ids = commands.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of duplicates) expect(ids.includes(id)).toBe(bound);
		expect(ids).toContain("go-to-video-viewer");
		expect(ids).toContain("video-viewer-insert-timestamp");
		h.app.workspace.activeLeaf = h.viewerLeaf;
		expect(commands.find((c) => c.id === "video-viewer-play-pause")!.checkCallback!(true)).toBe(true);
		expect(commands.find((c) => c.id === "video-viewer-screenshot")!.checkCallback!(true)).toBe(false);
		Object.assign(h.viewerLeaf.view, { videoId: null });
		expect(commands.find((c) => c.id === "video-viewer-play-pause")!.checkCallback!(true)).toBe(false);
		Object.assign(h.viewerLeaf.view, { videoId: "abc" });
		if (bound) {
			h.app.workspace.activeLeaf = h.viewerLeaf;
			const open = commands.find((c) => c.id === "open-youtube-video-viewer")!;
			const focus = vi.spyOn(h.viewerLeaf.view as VideoView, "focusKeys");
			open.checkCallback!(true);
			expect(focus).not.toHaveBeenCalled();
			open.checkCallback!(false);
			await vi.waitFor(() => expect(focus).toHaveBeenCalled());
		}
	});

	it("refreshes labels on existing viewers when the toolbar destination setting is saved", async () => {
		const h = await harness();
		const refresh = vi.spyOn(h.viewerLeaf.view as VideoView, "updateToolbarCaptureLabels");
		const save = vi.spyOn(h.plugin, "saveData").mockResolvedValue();
		h.plugin.settings.videoToolbarCaptureAction = "copy";
		await h.plugin.saveSettings();
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ videoToolbarCaptureAction: "copy" }));
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("applies saved captions to open viewers without moving playback or toggling the transcript", async () => {
		const h = await harness();
		const setCaptions = vi.fn();
		Object.assign(h.viewerLeaf.view, { player: { setCaptions, info: { currentTime: 25.75 } } });
		const transcript = vi.spyOn(h.plugin, "toggleTranscript").mockResolvedValue();
		const getter = vi.spyOn((h.viewerLeaf.view as VideoView)["host"], "getShowYoutubeCaptions");
		getter.mockImplementation(() => h.plugin.settings.showYoutubeCaptions);
		h.plugin.settings.showYoutubeCaptions = true;
		await h.plugin.saveSettings();
		expect(setCaptions).toHaveBeenLastCalledWith(true);
		h.plugin.settings.showYoutubeCaptions = false;
		await h.plugin.saveSettings();
		expect(setCaptions).toHaveBeenLastCalledWith(false);
		expect((h.viewerLeaf.view as VideoView).getPlaybackSeconds()).toBe(25.75);
		expect(transcript).not.toHaveBeenCalled();
	});

	it("registers one visibility toggle and one orientation toggle without unbound placement aliases", async () => {
		const h = await harness();
		const commands: import("obsidian").Command[] = [];
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
		h.app.workspace.activeLeaf = h.viewerLeaf;
		h.plugin["registerTranscriptCommands"]();
		expect(commands.map((c) => c.id)).toEqual([
			"show-youtube-transcript", "search-youtube-transcript",
			"transcript-search-forward", "transcript-search-backward", "transcript-toggle-orientation",
		]);
		const toggle = commands.find((c) => c.id === "show-youtube-transcript")!;
		expect(toggle.name).toBe("Toggle YouTube transcript panel");
		const run = vi.spyOn(h.plugin, "toggleTranscript").mockResolvedValue();
		expect(toggle.checkCallback!(true)).toBe(true);
		expect(run).not.toHaveBeenCalled();
		expect(toggle.checkCallback!(false)).toBe(true);
		expect(run).toHaveBeenCalledWith(h.file, h.viewerLeaf);
	});

	it("preserves bound placement aliases without writing hotkeys or settings", async () => {
		const h = await harness();
		Object.assign(h.app, { hotkeyManager: { printHotkeyForCommand: (id: string) => id.endsWith("transcript-location-sidebar") ? "Ctrl + Alt + T" : "" } });
		const commands: import("obsidian").Command[] = [];
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
		h.app.workspace.activeLeaf = h.viewerLeaf;
		h.plugin["registerTranscriptCommands"]();
		const alias = commands.find((c) => c.id === "transcript-location-sidebar")!;
		expect(alias).toBeDefined();
		const move = vi.spyOn(h.plugin, "showTranscript").mockResolvedValue();
		alias.checkCallback!(true);
		expect(move).not.toHaveBeenCalled();
		alias.checkCallback!(false);
		expect(move).toHaveBeenCalledWith(h.file, h.viewerLeaf, "sidebar");
	});

	it("toggles below/beside without changing the saved default", async () => {
		const h = await harness();
		const move = vi.spyOn(h.plugin, "showTranscript").mockImplementation(async (file, _viewer, location) => {
			if (location) h.plugin["transcriptLocations"].set(file.path, location);
		});
		await h.plugin.toggleTranscriptOrientation(h.file as TFile, h.viewerLeaf);
		await h.plugin.toggleTranscriptOrientation(h.file as TFile, h.viewerLeaf);
		expect(move).toHaveBeenNthCalledWith(1, h.file, h.viewerLeaf, "viewer");
		expect(move).toHaveBeenNthCalledWith(2, h.file, h.viewerLeaf, "beside");
		expect(h.plugin.settings.transcriptPanelLocation).toBe("sidebar");
	});

	it("toggles the restored pane's actual orientation instead of reapplying the default", async () => {
		const h = await harness();
		h.leaves.push(h.transcriptLeaf);
		vi.spyOn(workspaceApi, "getGroupForLeaf").mockReturnValue({
			group: {} as import("obsidian").WorkspaceParent, window,
			leaves: [h.transcriptLeaf], representative: h.transcriptLeaf,
			lastActive: 0, isCurrent: false, direction: "below",
		});
		const move = vi.spyOn(h.plugin, "showTranscript").mockResolvedValue();
		await h.plugin.toggleTranscriptOrientation(h.file as TFile, h.viewerLeaf);
		expect(move).toHaveBeenCalledWith(h.file, h.viewerLeaf, "beside");
	});

	it("rejects transcript commands without a markdown note and performs no action while checking", async () => {
		const h = await harness();
		Object.assign(h.app.workspace, { getActiveViewOfType: () => null, getActiveFile: () => null });
		const commands: import("obsidian").Command[] = [];
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
		h.plugin["registerTranscriptCommands"]();
		for (const c of commands.filter((c) => c.id === "show-youtube-transcript" || c.id === "transcript-toggle-orientation" || c.id === "search-youtube-transcript")) {
			expect(c.checkCallback!(true)).toBe(false);
			expect(c.checkCallback!(false)).toBe(false);
		}
		expect(h.app.workspace.getRightLeaf).not.toHaveBeenCalled();
	});

	it("a pop-out viewer can hide its explicitly sidebar-placed transcript", async () => {
		const h = await harness();
		const popDoc = document.implementation.createHTMLDocument();
		Object.defineProperty(popDoc, "defaultView", { value: { closed: false } });
		h.viewerLeaf.view.containerEl = popDoc.createElement("div");
		h.leaves.push(h.transcriptLeaf);
		await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		expect(h.transcriptLeaf.detach).toHaveBeenCalledOnce();
		expect(h.app.workspace.getRightLeaf).not.toHaveBeenCalled();
	});

	it.each(["viewer", "beside"] as const)("opens the %s layout with the correct split direction", async (location) => {
		const h = await harness();
		const split = vi.fn(() => {
			h.leaves.push(h.transcriptLeaf);
			return h.transcriptLeaf;
		});
		Object.assign(h.transcriptLeaf, { setViewState: vi.fn(async () => {}) });
		Object.assign(h.app.workspace, { createLeafBySplit: split });
		h.plugin.settings.transcriptPanelLocation = location;
		await h.plugin.showTranscript(h.file as TFile, h.viewerLeaf);
		expect(split).toHaveBeenCalledWith(h.viewerLeaf, location === "viewer" ? "horizontal" : "vertical");
	});

	it("moves an existing panel, preserving its mode and leaving the default unchanged", async () => {
		const h = await harness();
		h.leaves.push(h.transcriptLeaf);
		Object.assign(h.transcript, { mode: "paragraphs", previousQuery: "target" });
		const next = new TranscriptView(Object.assign(h.transcriptLeaf, { app: h.app }), {
			getHeadingName: () => "Transcript",
			getSearchSettings: () => ({ keyboard: "emacs", matching: "all-words", highlights: "always" }),
			playAt: vi.fn(),
		});
		next.contentEl = document.body.createDiv();
		next.containerEl = next.contentEl;
		const newLeaf = { view: next, setViewState: vi.fn(async () => {}), detach: vi.fn() } as unknown as WorkspaceLeaf;
		const split = vi.fn(() => newLeaf);
		Object.assign(h.app.workspace, { createLeafBySplit: split });
		await h.plugin.showTranscript(h.file as TFile, h.viewerLeaf, "viewer");
		expect(split).toHaveBeenCalledWith(h.viewerLeaf, "horizontal");
		expect(h.transcriptLeaf.detach).toHaveBeenCalledOnce();
		expect(next.getState().mode).toBe("paragraphs");
		expect(next["previousQuery"]).toBe("target");
		expect(h.plugin.settings.transcriptPanelLocation).toBe("sidebar");
		h.leaves.splice(h.leaves.indexOf(h.transcriptLeaf), 1);
		await h.plugin.showTranscript(h.file as TFile, h.viewerLeaf);
		expect(split).toHaveBeenCalledTimes(2);
		expect(split).toHaveBeenLastCalledWith(h.viewerLeaf, "horizontal");
	});

	it("keeps the old panel and default when creating the replacement fails", async () => {
		const h = await harness();
		h.leaves.push(h.transcriptLeaf);
		const error = new Error("Could not initialize pane");
		const next = { setViewState: vi.fn().mockRejectedValue(error), detach: vi.fn() };
		Object.assign(h.app.workspace, { createLeafBySplit: () => next });
		await expect(h.plugin.showTranscript(h.file as TFile, h.viewerLeaf, "beside")).rejects.toThrow(error);
		expect(h.transcriptLeaf.detach).not.toHaveBeenCalled();
		expect(h.plugin.settings.transcriptPanelLocation).toBe("sidebar");
		expect(h.plugin["transcriptLocations"].size).toBe(0);
		expect(next.detach).toHaveBeenCalledOnce();
	});

	it("honors below-video placement inside the viewer's pop-out", async () => {
		const h = await harness();
		const popDoc = document.implementation.createHTMLDocument();
		const popWin = { closed: false } as Window;
		Object.defineProperty(popDoc, "defaultView", { value: popWin });
		h.viewerLeaf.view.containerEl = popDoc.createElement("div");
		const split = vi.fn(() => h.transcriptLeaf);
		Object.assign(h.transcriptLeaf, { setViewState: vi.fn(async () => {}) });
		Object.assign(h.app.workspace, { createLeafBySplit: split });
		h.plugin.settings.transcriptPanelLocation = "viewer";
		await h.plugin.showTranscript(h.file as TFile, h.viewerLeaf);
		expect(split).toHaveBeenCalledWith(h.viewerLeaf, "horizontal");
	});

	it("sizes the video from its pop-out document and scales zoomed pan with the picture", async () => {
		const h = await harness();
		const doc = document.implementation.createHTMLDocument();
		const win = { getComputedStyle: vi.fn(() => ({
			paddingLeft: "8px", paddingRight: "8px", paddingTop: "8px", paddingBottom: "8px", rowGap: "8px",
		})) };
		Object.defineProperty(doc, "defaultView", { value: win });
		const content = doc.createElement("div");
		Object.defineProperties(content, { clientWidth: { value: 700 }, clientHeight: { value: 260 } });
		const stage = doc.createElement("div");
		stage.getBoundingClientRect = () => new DOMRect(0, 0, 684, 384.75);
		content.appendChild(stage);
		for (const [cls, height] of [["timeline", 20], ["controls", 30]] as const) {
			const chrome = doc.createElement("div");
			chrome.className = `perplexity-saver-video-${cls}`;
			chrome.getBoundingClientRect = () => new DOMRect(0, 0, 684, height);
			content.appendChild(chrome);
		}
		const view = h.viewerLeaf.view;
		if (!(view instanceof VideoView)) throw new Error("Expected video view");
		Object.assign(view, { contentEl: content, stageEl: stage, zoom: { zoom: 2, x: -100, y: -50 } });
		view.onResize();
		const width = 178 * 16 / 9;
		expect(parseFloat(stage.style.width)).toBeCloseTo(width);
		expect(win.getComputedStyle).toHaveBeenCalledWith(content);
		expect(view["zoom"].x).toBeCloseTo(-100 * width / 684);
		expect(view["zoom"].y).toBeCloseTo(-50 * width / 684);
	});

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

	it("closing the transcript toolbar targets its own window and restores the associated viewer", async () => {
		const h = await harness();
		const popDoc = document.implementation.createHTMLDocument();
		Object.defineProperty(popDoc, "defaultView", { value: { closed: false } });
		h.viewerLeaf.view.containerEl = popDoc.createElement("div");
		h.leaves.push(h.transcriptLeaf);
		const focus = vi.spyOn(h.viewerLeaf.view as VideoView, "focusKeys");
		await h.plugin["closeTranscript"](h.transcriptLeaf);
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
			getShowYoutubeCaptions: () => false,
			getToolbarCaptureAction: () => "insert", insertTimestamp: async () => {}, insertScreenshot: async () => {},
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
