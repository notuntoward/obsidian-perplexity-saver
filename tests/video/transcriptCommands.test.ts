// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Platform, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import type { EditorView } from "@codemirror/view";
import PerplexitySaverPlugin from "../../src/main";
import { TranscriptView } from "../../src/litNote/transcriptView";
import { VideoView } from "../../src/video/videoView";
import { PLAYER_STATE, YouTubeEmbed, type PlayerInfo } from "../../src/video/youtubePlayer";
import { VideoWorkspaceModal } from "../../src/video/workspaceLayout";
import { createdNotices } from "../__mocks__/obsidian";
import type { NoteInsertionTarget } from "../../src/video/noteInsertion";
import "commons/testing";
import * as workspaceApi from "commons/workspace";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	debounce: (callback: () => void) => callback,
	Scope: class { register(): void {} },
	Platform: { isDesktopApp: false },
	setIcon: (el: HTMLElement, icon: string) => { el.dataset.icon = icon; },
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
	getWindowForLeaf: (leaf: WorkspaceLeaf | null) => (leaf?.view as unknown as { testWindow?: Window } | undefined)?.testWindow ?? leaf?.view.containerEl.ownerDocument.defaultView ?? globalThis.window,
	focusLeafAndWindow: (app: App, leaf: WorkspaceLeaf) => app.workspace.setActiveLeaf(leaf, { focus: true }),
	loadLeafIfDeferred: async () => {},
}));

beforeEach(() => {
	vi.restoreAllMocks();
	Object.assign(Platform, { isDesktopApp: false });
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
		isTranscriptShown: () => false, toggleTranscript: (f, l) => plugin.toggleTranscript(f, l),
		jumpToTranscriptTimestamp: (view, direction) => { void plugin["jumpToTranscriptTimestamp"](view, direction); },
		onPlayback: () => {}, focusNote: async () => {},
	});
	viewer.contentEl = document.createElement("div");
	viewer.containerEl = viewer.contentEl;
	viewer.contentEl.tabIndex = 0;
	Object.assign(viewer, { videoId: "abc", filePath: file.path, player: { info: { currentTime: 25.75 }, setCaptions: vi.fn() } });
	const viewerLeaf = { view: viewer } as unknown as WorkspaceLeaf;
	leaves.push(viewerLeaf);
	return { plugin, app, file, leaves, transcript, transcriptLeaf, viewerLeaf };
}

function addNote(h: Awaited<ReturnType<typeof harness>>) {
	const note = new MarkdownView(h.viewerLeaf);
	note.file = h.file as TFile;
	note.containerEl = document.body.createDiv();
	const leaf = { view: note, getViewState: () => ({ type: "markdown", state: { file: h.file.path } }) } as unknown as WorkspaceLeaf;
	h.leaves.push(leaf);
	h.app.workspace.activeLeaf = leaf;
	return leaf;
}

async function playbackPanel(h: Awaited<ReturnType<typeof harness>>, doc = document) {
	const events = new Map<string, () => void>();
	Object.assign(h.app.workspace, {
		on: (name: string, callback: () => void) => { events.set(name, callback); return {}; },
		onLayoutReady: vi.fn(),
		getLastOpenFiles: () => [],
	});
	Object.assign(h.app.vault, { on: vi.fn() });
	Object.assign(h.app.metadataCache, { on: vi.fn() });
	Object.assign(h.app, { hotkeyManager: { printHotkeyForCommand: () => "" } });
	vi.spyOn(h.plugin, "loadSettings").mockResolvedValue();
	Object.assign(h.plugin, { registerView: vi.fn() });
	const register = vi.mocked(h.plugin.registerView);
	const commands: import("obsidian").Command[] = [];
	vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
	await h.plugin.onload();
	const transcriptFactory = register.mock.calls.find(([type]) => type === h.transcript.getViewType())?.[1];
	const videoFactory = register.mock.calls.find(([type]) => type === h.viewerLeaf.view.getViewType())?.[1];
	if (!transcriptFactory || !videoFactory) throw new Error("Missing view registration");
	Object.assign(h.transcriptLeaf, { app: h.app });
	const panel = transcriptFactory(h.transcriptLeaf) as TranscriptView;
	Object.assign(h.transcriptLeaf, { view: panel });
	panel.contentEl = doc.createElement("div");
	panel.containerEl = panel.contentEl;
	Object.assign(panel, { registerDomEvent: vi.fn() });
	doc.body.appendChild(panel.contentEl);
	h.leaves.push(h.transcriptLeaf);
	await panel.setState({ file: h.file.path }, { history: false });
	await panel.onOpen();
	const button = panel.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-playback button")!;
	return { panel, button, commands, events, videoFactory };
}

describe("transcript playback state", () => {
	it("tracks toolbar, commands, transcript rows and background updates without moving focus", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.app.vault.cachedRead = vi.fn(async () => "# Transcript\n[0:00](https://youtu.be/dQw4w9WgXcQ?t=0) start\n[0:25](https://youtu.be/dQw4w9WgXcQ?t=25) current");
		const { panel, button, commands } = await playbackPanel(h);
		expect(button.getAttribute("aria-label")).toBe("Play");
		expect(button.dataset.icon).toBe("play");
		button.click();
		await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Pause"));
		const background = panel.getBackgroundPlayback()!;
		expect(background.isPlaying()).toBe(true);
		expect(button.dataset.icon).toBe("pause");
		const command = commands.find((c) => c.id === "video-viewer-play-pause")!;
		command.checkCallback!(false);
		await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Play"));
		expect(background.isPlaying()).toBe(false);
		const row = panel.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-row")!;
		row.focus();
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Pause"));
		background.pausePlayback();
		expect(button.getAttribute("aria-label")).toBe("Play");
		background.play();
		expect(button.getAttribute("aria-label")).toBe("Pause");
		Object.assign(background["player"], { ready: true });
		window.dispatchEvent(new MessageEvent("message", {
			source: background["player"].iframe.contentWindow,
			data: { info: { playerState: PLAYER_STATE.paused } },
		}));
		expect(button.getAttribute("aria-label")).toBe("Play");
		background.play();
		expect(button.getAttribute("aria-label")).toBe("Pause");
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
		panel.stopBackgroundPlayback();
		expect(button.getAttribute("aria-label")).toBe("Play");
		await panel.onClose();
	});

	it("does not traverse the workspace for unchanged background time updates", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.app.vault.cachedRead = vi.fn(async () => "# Transcript\n[0:00](https://youtu.be/dQw4w9WgXcQ?t=0) start\n[0:25](https://youtu.be/dQw4w9WgXcQ?t=25) current");
		const { panel, button } = await playbackPanel(h);
		button.click();
		await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Pause"));
		const background = panel.getBackgroundPlayback()!;
		const iterate = vi.spyOn(h.app.workspace, "iterateAllLeaves");
		background.seekTo(1);
		background.seekTo(2);
		expect(iterate).not.toHaveBeenCalled();
		background.pausePlayback();
		expect(button.getAttribute("aria-label")).toBe("Play");
		expect(iterate).toHaveBeenCalled();
		await panel.onClose();
	});

	it("does not traverse the workspace for unchanged viewer time updates", async () => {
		const h = await harness();
		addNote(h);
		const { panel, button, videoFactory } = await playbackPanel(h);
		Object.assign(h.viewerLeaf, { app: h.app });
		const viewer = videoFactory(h.viewerLeaf) as VideoView;
		viewer.contentEl = document.createElement("div");
		viewer.containerEl = viewer.contentEl;
		Object.assign(h.viewerLeaf, { view: viewer });
		const playBtn = document.createElement("button");
		Object.assign(playBtn, { setAttr: (name: string, value: string) => playBtn.setAttribute(name, value) });
		const info: PlayerInfo = { currentTime: 1, duration: 120, playbackRate: 1, playerState: PLAYER_STATE.playing };
		Object.assign(viewer, {
			videoId: "dQw4w9WgXcQ", filePath: h.file.path, player: { info },
			timeEl: { setText: vi.fn(), getText: () => "0:00" },
			trackEl: { setCssProps: vi.fn(), setAttribute: vi.fn() },
			playBtn, renderMarks: vi.fn(),
		});
		viewer["update"](info);
		expect(button.getAttribute("aria-label")).toBe("Pause");
		const iterate = vi.spyOn(h.app.workspace, "iterateAllLeaves");
		info.currentTime = 2;
		viewer["update"](info);
		info.currentTime = 3;
		viewer["update"](info);
		expect(iterate).not.toHaveBeenCalled();
		info.playerState = PLAYER_STATE.paused;
		viewer["update"](info);
		expect(iterate).toHaveBeenCalled();
		expect(button.getAttribute("aria-label")).toBe("Play");
		await panel.onClose();
	});

	it("updates real background controls in the transcript owner document", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.app.vault.cachedRead = vi.fn(async () => "# Transcript\n[0:00](https://youtu.be/dQw4w9WgXcQ?t=0) start");
		const doc = document.implementation.createHTMLDocument();
		const { panel, button } = await playbackPanel(h, doc);
		expect(button.ownerDocument).toBe(doc);
		button.click();
		await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Pause"));
		expect(button.dataset.icon).toBe("pause");
		panel.getBackgroundPlayback()!.pausePlayback();
		expect(button.getAttribute("aria-label")).toBe("Play");
		expect(button.dataset.icon).toBe("play");
		await panel.onClose();
	});

	it("reflects a playing viewer handed off to background audio by a layout change", async () => {
		const h = await harness();
		addNote(h);
		const viewer = h.viewerLeaf.view as VideoView;
		Object.assign(viewer, { player: { info: { currentTime: 25.75, playerState: PLAYER_STATE.playing } } });
		vi.spyOn(viewer, "pausePlayback").mockImplementation(() => { viewer["player"]!.info.playerState = PLAYER_STATE.paused; });
		Object.assign(h.viewerLeaf, { detach: () => { h.leaves.splice(h.leaves.indexOf(h.viewerLeaf), 1); } });
		vi.spyOn(h.plugin as unknown as { separateWorkspaceTabs(): Promise<void> }, "separateWorkspaceTabs").mockResolvedValue();
		vi.spyOn(h.plugin as unknown as { activatePartLeaf(): Promise<void> }, "activatePartLeaf").mockResolvedValue();
		vi.spyOn(h.plugin, "saveData").mockResolvedValue();
		const { panel, button, events } = await playbackPanel(h);
		const other = new TranscriptView({ app: h.app } as unknown as WorkspaceLeaf, panel["host"]);
		other.contentEl = document.createElement("div");
		other.containerEl = other.contentEl;
		document.body.appendChild(other.contentEl);
		const otherLeaf = { view: other } as unknown as WorkspaceLeaf;
		h.leaves.push(otherLeaf);
		await other.setState({ file: h.file.path }, { history: false });
		const otherButton = other.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-playback button")!;
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "transcript");
		events.get("layout-change")!();
		expect(panel.getBackgroundPlayback()?.isPlaying()).toBe(true);
		expect(button.getAttribute("aria-label")).toBe("Pause");
		expect(button.dataset.icon).toBe("pause");
		expect(otherButton.getAttribute("aria-label")).toBe("Pause");
		expect(otherButton.dataset.icon).toBe("pause");
		other.copySessionFrom(panel);
		const movedButton = other.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-playback button")!;
		expect(panel.getBackgroundPlayback()).toBeNull();
		expect(other.getBackgroundPlayback()?.isPlaying()).toBe(true);
		expect(button.getAttribute("aria-label")).toBe("Pause");
		expect(movedButton.getAttribute("aria-label")).toBe("Pause");
		other.stopBackgroundPlayback();
		expect(button.getAttribute("aria-label")).toBe("Play");
		expect(movedButton.getAttribute("aria-label")).toBe("Play");
		await panel.onClose();
		await other.onClose();
	});

	it("retargets a visible player from another note instead of starting duplicate audio", async () => {
		const h = await harness();
		Object.assign(h.viewerLeaf.view, { filePath: "other.md", player: { info: { playerState: PLAYER_STATE.playing } } });
		addNote(h);
		h.app.vault.cachedRead = vi.fn(async () => "# Transcript\n[0:00](https://youtu.be/dQw4w9WgXcQ?t=0) start");
		const { panel, button } = await playbackPanel(h);
		const setViewState = vi.fn(async () => {});
		Object.assign(h.viewerLeaf, { setViewState });
		expect(panel.getBackgroundPlayback()).toBeNull();
		button.click();
		await vi.waitFor(() => expect(setViewState).toHaveBeenCalledWith(expect.objectContaining({
			state: expect.objectContaining({ file: h.file.path, videoId: "dQw4w9WgXcQ", autoplay: true }),
		})));
		expect(panel.getBackgroundPlayback()).toBeNull();
		await panel.onClose();
	});

	it("keeps an attached transcript on its player's note when another note opens", async () => {
		const h = await harness();
		addNote(h);
		const { panel } = await playbackPanel(h);
		const read = vi.spyOn(h.app.vault, "cachedRead");
		await panel["followFile"]({ path: "other.md", extension: "md" } as TFile);
		expect(read).not.toHaveBeenCalled();
		expect(panel.getFilePath()).toBe(h.file.path);
		await panel.onClose();
	});

	it("opens a player for the clicked note without taking over another note's transcript", async () => {
		const h = await harness();
		h.leaves.length = 0;
		const note = addNote(h);
		h.leaves.push(h.transcriptLeaf);
		Object.assign(h.transcript, { filePath: "other.md" });
		vi.mocked(h.transcript.getFilePath).mockReturnValue("other.md");
		const showFile = vi.spyOn(h.transcript, "showFile").mockResolvedValue();
		const next = { setViewState: vi.fn(async () => {}), detach: vi.fn() };
		Object.assign(h.app.workspace, { createLeafBySplit: vi.fn(() => next) });
		const target = note.view.containerEl.createEl("a");
		await h.plugin["openTimestamp"]({ videoId: "dQw4w9WgXcQ", seconds: 73, target });
		expect(next.setViewState).toHaveBeenCalledWith(expect.objectContaining({
			state: expect.objectContaining({ file: h.file.path, videoId: "dQw4w9WgXcQ", time: 73 }),
		}));
		expect(showFile).not.toHaveBeenCalled();
		expect(h.transcript.getBackgroundPlayback()).toBeNull();
		await h.transcript.onClose();
	});

	it("moves the paired transcript when a row retargets the visible player", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.viewerLeaf, h.transcriptLeaf);
		const viewer = h.viewerLeaf.view as VideoView;
		Object.assign(viewer, { filePath: "other.md", videoId: "other", player: { info: { currentTime: 10 } } });
		Object.assign(h.transcript, { filePath: "other.md" });
		vi.mocked(h.transcript.getFilePath).mockReturnValue("other.md");
		const showFile = vi.spyOn(h.transcript, "showFile").mockResolvedValue();
		const setViewState = vi.fn(async (state: { state: { file: string; videoId: string } }) => {
			Object.assign(viewer, { filePath: state.state.file, videoId: state.state.videoId });
		});
		Object.assign(h.viewerLeaf, { setViewState });
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ?t=25", 25, true);
		expect(setViewState).toHaveBeenCalledWith(expect.objectContaining({
			state: expect.objectContaining({ file: h.file.path, videoId: "dQw4w9WgXcQ", time: 25, autoplay: true }),
		}));
		expect(showFile).toHaveBeenCalledWith(h.file.path);
		expect(h.transcript.getBackgroundPlayback()).toBeNull();
		await h.transcript.onClose();
	});

	it("drives a player in another window and moves its transcript with it", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.viewerLeaf, h.transcriptLeaf);
		const otherWindow = {} as Window;
		const viewer = h.viewerLeaf.view as VideoView;
		Object.assign(viewer, { filePath: "other.md", videoId: "other", player: { info: { currentTime: 10 } }, testWindow: otherWindow });
		Object.assign(h.transcript, { filePath: "other.md", testWindow: window });
		vi.mocked(h.transcript.getFilePath).mockReturnValue("other.md");
		const showFile = vi.spyOn(h.transcript, "showFile").mockResolvedValue();
		const setViewState = vi.fn(async (state: { state: { file: string; videoId: string } }) => {
			Object.assign(viewer, { filePath: state.state.file, videoId: state.state.videoId });
		});
		Object.assign(h.viewerLeaf, { setViewState });
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ?t=25", 25, true);
		expect(setViewState).toHaveBeenCalledWith(expect.objectContaining({
			state: expect.objectContaining({ file: h.file.path, videoId: "dQw4w9WgXcQ", time: 25 }),
		}));
		expect(showFile).toHaveBeenCalledWith(h.file.path);
		await h.transcript.onClose();
	});

	it("drives a hidden player for the note from the transcript toolbar", async () => {
		const h = await harness();
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.viewerLeaf.view.containerEl.isShown = () => false;
		Object.assign(h.viewerLeaf.view, { filePath: h.file.path, player: { info: { currentTime: 10, playerState: PLAYER_STATE.paused } } });
		const toggle = vi.spyOn(h.viewerLeaf.view as VideoView, "togglePlay").mockImplementation(() => {});
		const { panel, button } = await playbackPanel(h);
		button.click();
		await vi.waitFor(() => expect(toggle).toHaveBeenCalled());
		expect(panel.getBackgroundPlayback()).toBeNull();
		await panel.onClose();
	});

	it("initializes from an already-playing hidden matching viewer", async () => {
		const h = await harness();
		addNote(h);
		h.viewerLeaf.view.containerEl.isShown = () => false;
		Object.assign(h.viewerLeaf.view, { player: { info: { currentTime: 0, playerState: PLAYER_STATE.playing } } });
		const { panel, button } = await playbackPanel(h);
		expect(button.getAttribute("aria-label")).toBe("Pause");
		expect(button.dataset.icon).toBe("pause");
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
		await panel.onClose();
	});

	it("tracks the hidden matching player, including external player updates", async () => {
		const h = await harness();
		addNote(h);
		h.viewerLeaf.view.containerEl.isShown = () => false;
		const { panel, button, commands, events, videoFactory } = await playbackPanel(h);
		Object.assign(h.viewerLeaf, { app: h.app });
		const registered = videoFactory(h.viewerLeaf) as VideoView;
		const viewer = h.viewerLeaf.view as VideoView;
		Object.assign(viewer, { host: registered["host"] });
		const player = new YouTubeEmbed(viewer.containerEl, "abc", 0,
			(info) => registered["host"].onPlayback("abc", h.file.path, info.currentTime));
		Object.assign(viewer, { player });
		events.get("layout-change")!();
		expect(button.getAttribute("aria-label")).toBe("Play");
		viewer.togglePlay();
		expect(button.getAttribute("aria-label")).toBe("Pause");
		expect(button.dataset.icon).toBe("pause");
		commands.find((c) => c.id === "video-viewer-play-pause")!.checkCallback!(false);
		await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Play"));
		Object.assign(player, { ready: true });
		window.dispatchEvent(new MessageEvent("message", { source: player.iframe.contentWindow, data: { info: { playerState: PLAYER_STATE.playing } } }));
		expect(button.getAttribute("aria-label")).toBe("Pause");
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
		player.destroy();
		await panel.onClose();
	});
});

describe("hidden player screenshots", () => {
	it.each([
		["video-viewer-screenshot", false, false],
		["video-viewer-screenshot-whole", false, true],
		["video-viewer-insert-screenshot", true, false],
		["video-viewer-insert-screenshot-whole", true, true],
	] as const)("reveals the player before %s in one invocation", async (id, insert, whole) => {
		const h = await harness();
		addNote(h);
		Object.assign(h.viewerLeaf.view, { leaf: h.viewerLeaf });
		h.viewerLeaf.view.containerEl.isShown = () => false;
		const capture = vi.spyOn(h.viewerLeaf.view as VideoView, "screenshot").mockResolvedValue();
		const insertion = vi.spyOn(h.plugin as unknown as { insertScreenshotIntoNote(): Promise<void> }, "insertScreenshotIntoNote").mockResolvedValue();
		const activate = vi.spyOn(h.plugin as unknown as { activatePartLeaf(): Promise<void> }, "activatePartLeaf").mockResolvedValue();
		Object.assign(Platform, { isDesktopApp: true });
		const { commands } = navigationCommands(h);
		expect(commands.find((c) => c.id === id)!.checkCallback!(false)).toBe(true);
		await vi.waitFor(() => expect(insert ? insertion : capture).toHaveBeenCalledOnce());
		if (!insert) expect(activate).toHaveBeenCalledWith(h.viewerLeaf, null);
		if (insert) expect(insertion).toHaveBeenCalledWith(h.viewerLeaf.view, whole);
		else if (whole) expect(capture).toHaveBeenCalledWith(true);
		else expect(capture).toHaveBeenCalledWith();
	});
});

describe("ten second playback commands", () => {
	it.each([
		["note", false], ["note", true],
		["video", false], ["video", true],
		["transcript", false], ["transcript", true],
	] as const)("seeks the matching player from %s while playing=%s without changing focus", async (context, playing) => {
		const h = await harness();
		const player = navigationPlayer(h, playing);
		navigationContext(h, context);
		const { commands } = navigationCommands(h);
		const back = commands.find((c) => c.id === "video-seek-backward-10-seconds")!;
		const forward = commands.find((c) => c.id === "video-seek-forward-10-seconds")!;
		expect(back.name).toBe("Video: back 10 seconds");
		expect(forward.name).toBe("Video: forward 10 seconds");
		expect(back.hotkeys).toBeUndefined();
		expect(forward.hotkeys).toBeUndefined();
		expect(back.checkCallback!(true)).toBe(true);
		expect(player.seekTo).not.toHaveBeenCalled();
		back.checkCallback!(false);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(0.09999999999999964));
		forward.checkCallback!(false);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenLastCalledWith(10.1));
		expect((h.viewerLeaf.view as VideoView).isPlaying()).toBe(playing);
		expect(player.play).not.toHaveBeenCalled();
		expect(player.pause).not.toHaveBeenCalled();
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
	});

	it("uses an associated loaded player when the active player is empty", async () => {
		const h = await harness();
		const player = navigationPlayer(h, true);
		const empty = Object.create(VideoView.prototype) as VideoView;
		Object.assign(empty, { filePath: h.file.path, videoId: null, containerEl: document.createElement("div") });
		const emptyLeaf = { view: empty } as unknown as WorkspaceLeaf;
		h.leaves.push(emptyLeaf, h.transcriptLeaf);
		h.app.workspace.activeLeaf = emptyLeaf;
		const { commands } = navigationCommands(h);
		const forward = commands.find((c) => c.id === "video-seek-forward-10-seconds")!;
		expect(forward.checkCallback!(false)).toBe(true);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(20.1), { timeout: 500 });
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
	});

	it.each([false, true])("clamps background seek at the video end while preserving playing=%s", async (playing) => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.app.vault.cachedRead = vi.fn(async () => "https://youtu.be/dQw4w9WgXcQ");
		const playback = (await h.plugin["backgroundPlaybackFor"](h.file as TFile))!;
		playback["player"].info.duration = 100;
		playback.seekTo(95);
		if (playing) playback.play();
		const { commands } = navigationCommands(h);
		commands.find((c) => c.id === "video-seek-forward-10-seconds")!.checkCallback!(false);
		await vi.waitFor(() => expect(playback.getPlaybackSeconds()).toBe(100));
		expect(playback.isPlaying()).toBe(playing);
		await h.transcript.onClose();
	});

	it.each([false, true])("uses visible transcript audio when a matching player is empty (playing=%s)", async (playing) => {
		const h = await harness();
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		Object.assign(h.viewerLeaf.view, { videoId: null, player: null });
		h.app.vault.cachedRead = vi.fn(async () => "https://youtu.be/dQw4w9WgXcQ");
		const playback = await h.plugin["backgroundPlaybackFor"](h.file as TFile);
		expect(playback).not.toBeNull();
		playback!.seekTo(5);
		if (playing) playback!.play();
		const { commands } = navigationCommands(h);
		commands.find((c) => c.id === "video-seek-backward-10-seconds")!.checkCallback!(false);
		await vi.waitFor(() => expect(playback!.getPlaybackSeconds()).toBe(0));
		expect(playback!.isPlaying()).toBe(playing);
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
		await h.transcript.onClose();
	});
});

describe("transcript activation commands", () => {
	it.each([false, true])("full registration preserves remaining legacy hotkeys only when bound (%s)", async (bound) => {
		const h = await harness();
		const duplicates = ["video-viewer-toggle-transcript", "transcript-location-sidebar", "transcript-location-viewer", "transcript-location-beside"];
		const removedHotkeyCommands = ["open-youtube-video-viewer"];
		Object.assign(h.app, { hotkeyManager: {
			printHotkeyForCommand: (id: string) => bound && [...duplicates, ...removedHotkeyCommands].some((duplicate) => id.endsWith(`:${duplicate}`)) ? "Ctrl + Alt + T" : "",
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
		const removedCommandIds = [
			"go-to-literature-note",
			"go-to-transcript-panel",
			"go-to-video-viewer",
			"open-youtube-video-viewer",
			"video-viewer-back-5",
			"video-viewer-back-10",
			"video-viewer-forward-5",
			"video-viewer-forward-10",
			"video-viewer-zoom-in",
			"video-viewer-zoom-out",
			"video-viewer-zoom-reset",
		];
		for (const id of removedCommandIds) expect(ids).not.toContain(id);
		expect(ids).toContain("video-viewer-insert-timestamp");
		h.app.workspace.activeLeaf = h.viewerLeaf;
		expect(commands.find((c) => c.id === "video-viewer-play-pause")!.checkCallback!(true)).toBe(true);
		expect(commands.find((c) => c.id === "video-viewer-screenshot")!.checkCallback!(true)).toBe(false);
		Object.assign(h.viewerLeaf.view, { videoId: null });
		expect(commands.find((c) => c.id === "video-viewer-play-pause")!.checkCallback!(true)).toBe(false);
		Object.assign(h.viewerLeaf.view, { videoId: "abc" });
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
		expect(toggle.name).toBe("Video: show or hide transcript");
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

	it("validates transcript before creating a viewer for orientation", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.app.vault.cachedRead = vi.fn(async () => "# Transcript\nno timestamps\nhttps://youtu.be/dQw4w9WgXcQ");
		const open = vi.spyOn(h.plugin, "openViewerForNote" as never);
		await h.plugin.toggleTranscriptOrientation(h.file as TFile, null);
		expect(open).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toContain("No timestamped transcript");
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

	it.each(["show", "toggle", "search"] as const)("%s opens a missing panel and assigns keyboard focus", async (action) => {
		const h = await harness();
		const search = vi.spyOn(h.transcript, "focusSearch").mockImplementation(() => {});
		if (action === "show") await h.plugin.showTranscript(h.file as TFile, h.viewerLeaf);
		else if (action === "toggle") await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
		else await h.plugin["focusTranscriptSearch"](null, h.file as TFile);
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(h.transcriptLeaf, { focus: true });
		expect(action === "search" ? search : h.transcript.focusLines).toHaveBeenCalled();
	});

	it.each(["video", "transcript", "both", "note"] as const)("applies the %s workspace without opening unwanted parts", async (layout) => {
		const h = await harness();
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		const transcript = vi.spyOn(h.plugin, "showTranscript");
		Object.assign(h.viewerLeaf, { detach: vi.fn() });
		await h.plugin["applyVideoWorkspace"](h.file as TFile, layout);
		expect(transcript).not.toHaveBeenCalled();
		expect(h.viewerLeaf.detach).toHaveBeenCalledTimes(layout === "note" || layout === "transcript" ? 1 : 0);
		expect(h.transcriptLeaf.detach).toHaveBeenCalledTimes(layout === "note" || layout === "video" ? 1 : 0);
		expect(h.app.workspace.setActiveLeaf).toHaveBeenCalled();
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("video");
		expect(h.plugin.settings.videoPlayback[h.file.path]).toMatchObject({ videoId: "abc", seconds: 25.75 });
	});

	it("cycles only to the next visible pane without opening anything", async () => {
		const h = await harness();
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.transcript.containerEl.isShown = () => false;
		const show = vi.spyOn(h.plugin, "showTranscript");
		await h.plugin["cycleVisibleParts"](h.file as TFile, "note");
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(h.viewerLeaf, { focus: true });
		expect(show).not.toHaveBeenCalled();
	});

	it.each(["sidebar", "viewer", "beside"] as const)("opens a transcript-only workspace at %s without creating a player", async (location) => {
		const h = await harness();
		h.leaves.length = 0;
		const note = addNote(h);
		h.plugin.settings.transcriptPanelLocation = location;
		const split = vi.fn(() => {
			h.leaves.push(h.transcriptLeaf);
			return h.transcriptLeaf;
		});
		Object.assign(h.app.workspace, { createLeafBySplit: split });
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "transcript");
		expect(h.app.workspace.getLeavesOfType("perplexity-saver-video")).toHaveLength(0);
		expect(h.transcriptLeaf.setViewState).toHaveBeenCalledWith(expect.objectContaining({ type: "perplexity-saver-transcript" }));
		if (location !== "sidebar") expect(split).toHaveBeenCalledWith(note, location === "viewer" ? "horizontal" : "vertical");
		else expect(h.app.workspace.getRightLeaf).toHaveBeenCalledWith(true);
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("video");
	});

	it("opens a missing player at its saved position without repurposing an unrelated viewer", async () => {
		const h = await harness();
		addNote(h);
		Object.assign(h.viewerLeaf.view, { filePath: "other.md" });
		vi.spyOn(h.app.vault, "cachedRead").mockResolvedValue("https://youtu.be/dQw4w9WgXcQ");
		h.plugin.settings.videoPlayback[h.file.path] = { videoId: "dQw4w9WgXcQ", seconds: 123.75 };
		const next = { setViewState: vi.fn(async () => {}), detach: vi.fn() } as unknown as WorkspaceLeaf;
		const split = vi.fn(() => next);
		Object.assign(h.app.workspace, { createLeafBySplit: split });
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "video");
		expect(next.setViewState).toHaveBeenCalledWith(expect.objectContaining({
			state: { videoId: "dQw4w9WgXcQ", time: 123.75, file: h.file.path, autoplay: false },
		}));
		expect(h.viewerLeaf.view.getState().file).toBe("other.md");
	});

	it("opens both missing panes and leaves the note ready for typing", async () => {
		const h = await harness();
		h.leaves.length = 0;
		const note = addNote(h);
		vi.spyOn(h.app.vault, "cachedRead").mockResolvedValue("# Transcript\n[0:00](https://youtu.be/dQw4w9WgXcQ?t=0) start");
		Object.assign(h.viewerLeaf, {
			setViewState: vi.fn(async () => { h.leaves.push(h.viewerLeaf); }),
		});
		Object.assign(h.app.workspace, { createLeafBySplit: vi.fn(() => h.viewerLeaf) });
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "both");
		expect(h.viewerLeaf.setViewState).toHaveBeenCalledOnce();
		expect(h.app.workspace.getRightLeaf).toHaveBeenCalledWith(true);
		expect(h.transcriptLeaf.setViewState).toHaveBeenCalledOnce();
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(note, { focus: true });
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("video");
	});

	it("cleans up a failed new player without closing an existing transcript or changing preference", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		vi.spyOn(h.app.vault, "cachedRead").mockResolvedValue("https://youtu.be/dQw4w9WgXcQ");
		const failure = new Error("Cannot initialize player");
		const next = { setViewState: vi.fn().mockRejectedValue(failure), detach: vi.fn() } as unknown as WorkspaceLeaf;
		Object.assign(h.app.workspace, { createLeafBySplit: vi.fn(() => next) });
		await expect(h.plugin["applyVideoWorkspace"](h.file as TFile, "both")).rejects.toThrow(failure);
		expect(next.detach).toHaveBeenCalledOnce();
		expect(h.transcriptLeaf.detach).not.toHaveBeenCalled();
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("video");
	});

	it("keeps the previous layout and preference when a requested transcript is missing", async () => {
		const h = await harness();
		addNote(h);
		Object.assign(h.viewerLeaf, { detach: vi.fn() });
		const save = vi.spyOn(h.plugin, "saveData");
		vi.spyOn(h.app.vault, "cachedRead").mockResolvedValue("# Transcript\nno timestamps");
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "transcript");
		expect(h.viewerLeaf.detach).not.toHaveBeenCalled();
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("video");
		expect(save).not.toHaveBeenCalled();
	});

	it("persists preferences and playback across reload without sharing fresh-default records", async () => {
		const h = await harness();
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("video");
		vi.spyOn(h.plugin, "loadData").mockResolvedValue({
			preferredVideoWorkspace: "both",
			videoPlayback: { "note.md": { videoId: "abc", seconds: 55 } },
		});
		await h.plugin.loadSettings();
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("both");
		expect(h.plugin.settings.videoPlayback["note.md"].seconds).toBe(55);
		const fresh = await harness();
		expect(fresh.plugin.settings.videoPlayback).toEqual({});
	});

	it("registers the workspace picker and forward cycle command", async () => {
		const h = await harness();
		addNote(h);
		const commands: import("obsidian").Command[] = [];
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
		const open = vi.spyOn(VideoWorkspaceModal.prototype, "open");
		Object.assign(h.app.workspace, { on: vi.fn() });
		h.plugin["registerVideoWorkspaceCommands"]();
		expect(commands.map((command) => command.id)).toEqual([
			"video-workspace", "cycle-note-video-transcript",
		]);
		expect(commands[1].name).toBe("Video: cycle panes");
		commands[0].checkCallback!(true);
		expect(open).not.toHaveBeenCalled();
		commands[0].checkCallback!(false);
		await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
		expect(h.app.workspace.getRightLeaf).not.toHaveBeenCalled();
	});

	it("cycles between a pop-out note and its main-window transcript", async () => {
		const h = await harness();
		h.leaves.length = 0;
		const note = addNote(h);
		const doc = document.implementation.createHTMLDocument();
		const win = { document: doc, closed: false, focus: vi.fn() } as unknown as Window;
		Object.defineProperty(doc, "defaultView", { value: win });
		note.view.containerEl = doc.createElement("div");
		Object.defineProperty(doc, "activeElement", { value: note.view.containerEl, configurable: true });
		h.leaves.push(h.transcriptLeaf);
		await h.plugin["cycleVisibleParts"](h.file as TFile, "note");
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(h.transcriptLeaf, { focus: true });
		await h.plugin["cycleVisibleParts"](h.file as TFile, "transcript");
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(note, { focus: true });
		expect(win.focus).toHaveBeenCalled();
	});

	it("stays in a lone note and skips a collapsed transcript sidebar", async () => {
		const h = await harness();
		h.leaves.length = 0;
		const note = addNote(h);
		h.leaves.push(h.transcriptLeaf);
		vi.spyOn(workspaceApi, "isInCollapsedSidebar").mockImplementation((_app, leaf) => leaf === h.transcriptLeaf);
		await h.plugin["cycleVisibleParts"](h.file as TFile, "note");
		expect(h.app.workspace.setActiveLeaf).toHaveBeenLastCalledWith(note, { focus: true });
		expect(h.app.workspace.getRightLeaf).not.toHaveBeenCalled();
	});

	it("enables playback commands for a transcript-only workspace without opening a video pane", async () => {
		const h = await harness();
		h.app.vault.cachedRead = vi.fn(async () => "https://youtu.be/dQw4w9WgXcQ");
		h.leaves.length = 0;
		const note = addNote(h);
		h.leaves.push(h.transcriptLeaf);
		const commands: import("obsidian").Command[] = [];
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
		h.plugin["registerVideoCommands"]();
		const toggle = commands.find((command) => command.id === "video-viewer-play-pause")!;
		expect(toggle.checkCallback!(true)).toBe(true);
		expect(h.transcript.getBackgroundPlayback()).toBeNull();
		toggle.checkCallback!(false);
		await vi.waitFor(() => expect(h.transcript.getBackgroundPlayback()?.isPlaying()).toBe(true));
		expect(h.app.workspace.getLeavesOfType("perplexity-saver-video")).toHaveLength(0);
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
		expect(h.app.workspace.activeLeaf).toBe(note);
		toggle.checkCallback!(false);
		await vi.waitFor(() => expect(h.transcript.getBackgroundPlayback()?.isPlaying()).toBe(false));
		await h.transcript.onClose();
	});

	it("transcript row playback seeks in the background without opening a third pane", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ?t=25", 25, true);
		expect(h.transcript.getBackgroundPlayback()?.getPlaybackSeconds()).toBe(25);
		expect(h.transcript.getBackgroundPlayback()?.isPlaying()).toBe(true);
		expect(h.app.workspace.getLeavesOfType("perplexity-saver-video")).toHaveLength(0);
		await h.transcript.onClose();
		expect(h.transcript.getBackgroundPlayback()).toBeNull();
	});

	it("routes speed commands from the focused transcript and gates picture-only commands", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.app.workspace.activeLeaf = h.transcriptLeaf;
		h.app.vault.cachedRead = vi.fn(async () => "https://youtu.be/dQw4w9WgXcQ");
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ", 25, true);
		const playback = h.transcript.getBackgroundPlayback()!;
		const commands: import("obsidian").Command[] = [];
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
		h.plugin["registerVideoCommands"]();
		const speed = commands.find((c) => c.id === "video-viewer-faster")!;
		expect(speed.checkCallback!(true)).toBe(true);
		speed.checkCallback!(false);
		await vi.waitFor(() => expect(playback.getPlaybackRate()).toBe(1.25));
		for (const id of ["video-viewer-screenshot", "video-viewer-insert-screenshot"]) {
			expect(commands.find((c) => c.id === id)!.checkCallback!(true)).toBe(false);
		}
		expect(h.app.workspace.setActiveLeaf).not.toHaveBeenCalled();
		await h.transcript.onClose();
	});

	it.each(["note", "unload", "close"] as const)("stops audio and remembers position on %s", async (action) => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.plugin.settings.preferredVideoWorkspace = "transcript";
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ", 51, true);
		const destroy = vi.spyOn(h.transcript.getBackgroundPlayback()!, "destroy");
		if (action === "note") await h.plugin["applyVideoWorkspace"](h.file as TFile, "note");
		else if (action === "unload") h.plugin.onunload();
		else await h.transcript.onClose();
		expect(destroy).toHaveBeenCalledOnce();
		expect(h.transcript.getBackgroundPlayback()).toBeNull();
		expect(h.plugin.settings.videoPlayback[h.file.path]).toEqual({ videoId: "dQw4w9WgXcQ", seconds: 51 });
		expect(h.plugin.settings.preferredVideoWorkspace).toBe("transcript");
	});

	it("hands background audio to a visible player at the same time and speed, without duplicate audio", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.app.vault.cachedRead = vi.fn(async () => "https://youtu.be/dQw4w9WgXcQ");
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ", 64, true);
		h.transcript.getBackgroundPlayback()!.setRate(1.5);
		const stop = vi.spyOn(h.transcript.getBackgroundPlayback()!, "destroy");
		const setRate = vi.spyOn(h.viewerLeaf.view as VideoView, "setRate").mockImplementation(() => {});
		Object.assign(h.viewerLeaf, { setViewState: vi.fn(async () => {
			expect(stop).toHaveBeenCalledOnce();
			h.leaves.push(h.viewerLeaf);
		}) });
		Object.assign(h.app.workspace, { createLeafBySplit: vi.fn(() => h.viewerLeaf) });
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "both");
		expect(h.viewerLeaf.setViewState).toHaveBeenCalledWith(expect.objectContaining({
			state: { videoId: "dQw4w9WgXcQ", time: 64, file: h.file.path, autoplay: true },
		}));
		expect(setRate).toHaveBeenCalledWith(1.5);
		expect(h.transcript.getBackgroundPlayback()).toBeNull();
	});

	it("hands playing video to transcript-only audio without showing a third pane", async () => {
		const h = await harness();
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		const viewer = h.viewerLeaf.view as VideoView;
		vi.spyOn(viewer, "isPlaying").mockReturnValue(true);
		vi.spyOn(viewer, "pausePlayback").mockImplementation(() => {});
		vi.spyOn(viewer, "getPlaybackRate").mockReturnValue(1.5);
		Object.assign(h.viewerLeaf, { detach: vi.fn(() => {
			h.leaves.splice(h.leaves.indexOf(h.viewerLeaf), 1);
		}) });
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "transcript");
		expect(viewer.pausePlayback).toHaveBeenCalledOnce();
		const playback = h.transcript.getBackgroundPlayback()!;
		expect(playback.getPlaybackSeconds()).toBe(25.75);
		expect(playback.getPlaybackRate()).toBe(1.5);
		expect(playback.isPlaying()).toBe(true);
		expect(h.app.workspace.getLeavesOfType("perplexity-saver-video")).toHaveLength(0);
		await h.transcript.onClose();
	});

	it("propagates background time to transcript highlighting and visible-pane cycling", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		const highlight = vi.spyOn(h.transcript, "showPlayback");
		const focus = vi.spyOn(h.transcript, "focusPlayback").mockImplementation(() => {});
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ", 28, true);
		expect(highlight).toHaveBeenLastCalledWith(28, true, true);
		await h.plugin["cycleVisibleParts"](h.file as TFile, "note");
		expect(focus).toHaveBeenCalledWith(28, true);
		await h.transcript.onClose();
	});

	it("does not start background audio while a visible player is open", async () => {
		const h = await harness();
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		Object.assign(h.viewerLeaf.view, { filePath: "other.md" });
		const toggleOther = vi.spyOn(h.viewerLeaf.view as VideoView, "togglePlay").mockImplementation(() => {});
		h.app.vault.cachedRead = vi.fn(async () => "https://youtu.be/dQw4w9WgXcQ");
		const playback = await h.plugin["backgroundPlaybackFor"](h.file as TFile);
		expect(playback).toBeNull();
		expect(h.transcript.containerEl.querySelector("iframe")).toBeNull();
		expect(createdNotices.at(-1)?.message).toContain("video pane is open");
		expect(toggleOther).not.toHaveBeenCalled();
		await h.transcript.onClose();
	});

	it("timestamp clicks seek the transcript's audio session without opening a player", async () => {
		const h = await harness();
		h.leaves.length = 0;
		const note = addNote(h);
		h.leaves.push(h.transcriptLeaf);
		const target = note.view.containerEl.createEl("a");
		await h.plugin["openTimestamp"]({ videoId: "dQw4w9WgXcQ", seconds: 73, target });
		expect(h.transcript.getBackgroundPlayback()?.getPlaybackSeconds()).toBe(73);
		expect(h.transcript.getBackgroundPlayback()?.isPlaying()).toBe(true);
		expect(h.app.workspace.getLeavesOfType("perplexity-saver-video")).toHaveLength(0);
		await h.transcript.onClose();
	});

	it("restores remembered audio paused, and seek-only transcript actions never start it", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.app.vault.cachedRead = vi.fn(async () => "https://youtu.be/dQw4w9WgXcQ");
		h.plugin.settings.videoPlayback[h.file.path] = { videoId: "dQw4w9WgXcQ", seconds: 123 };
		const playback = await h.plugin["backgroundPlaybackFor"](h.file as TFile);
		expect(playback?.getPlaybackSeconds()).toBe(123);
		expect(playback?.isPlaying()).toBe(false);
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ", 52, false);
		expect(playback?.getPlaybackSeconds()).toBe(52);
		expect(playback?.isPlaying()).toBe(false);
		playback?.play();
		await h.plugin["playTranscriptAt"](h.file.path, "https://youtu.be/dQw4w9WgXcQ", 64, false);
		expect(playback?.getPlaybackSeconds()).toBe(64);
		expect(playback?.isPlaying()).toBe(true);
		await h.transcript.onClose();
	});

	it("does not start orphaned audio if the transcript closes during metadata loading", async () => {
		const h = await harness();
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		let resolveRead!: (value: string) => void;
		h.app.vault.cachedRead = vi.fn(() => new Promise<string>((resolve) => { resolveRead = resolve; }));
		const pending = h.plugin["backgroundPlaybackFor"](h.file as TFile);
		h.leaves.splice(h.leaves.indexOf(h.transcriptLeaf), 1);
		resolveRead("https://youtu.be/dQw4w9WgXcQ");
		expect(await pending).toBeNull();
		expect(h.transcript.containerEl.querySelector("iframe")).toBeNull();
		expect(createdNotices.at(-1)?.message).toContain("workspace changed");
	});

	it("splits a background media tab out of the note's tab group while preserving playback", async () => {
		const h = await harness();
		const note = addNote(h);
		const group = {
			group: {} as import("obsidian").WorkspaceParent, window,
			leaves: [note, h.viewerLeaf], representative: note,
			lastActive: 0, isCurrent: true, direction: null,
		};
		vi.spyOn(workspaceApi, "getGroupForLeaf").mockImplementation((_model, leaf) => leaf === note || leaf === h.viewerLeaf ? group : null);
		Object.assign(h.viewerLeaf, { detach: vi.fn() });
		const next = { view: h.viewerLeaf.view, setViewState: vi.fn(async () => {}), detach: vi.fn() } as unknown as WorkspaceLeaf;
		const split = vi.fn(() => next);
		Object.assign(h.app.workspace, { createLeafBySplit: split });
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "video");
		expect(split).toHaveBeenCalledWith(note, "vertical");
		expect(next.setViewState).toHaveBeenCalledWith(expect.objectContaining({
			state: expect.objectContaining({ file: h.file.path, time: 25.75, autoplay: false }),
		}));
		expect(h.viewerLeaf.detach).toHaveBeenCalledOnce();
		expect(next.detach).not.toHaveBeenCalled();
	});

	it("keeps a workspace transcript associated with its note when another file opens", async () => {
		const h = await harness();
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "both");
		const read = vi.spyOn(h.app.vault, "cachedRead");
		await h.transcript["followFile"]({ path: "other.md", extension: "md" } as TFile);
		expect(read).not.toHaveBeenCalled();
		expect(h.transcript.getState().pinned).toBe(true);
		expect(h.transcript.getFilePath()).toBe(h.file.path);
	});

	it("does not close unrelated media when choosing note only", async () => {
		const h = await harness();
		addNote(h);
		Object.assign(h.viewerLeaf.view, { filePath: "other.md" });
		Object.assign(h.viewerLeaf, { detach: vi.fn() });
		Object.assign(h.transcript, { filePath: "other.md" });
		vi.mocked(h.transcript.getFilePath).mockReturnValue("other.md");
		h.leaves.push(h.transcriptLeaf);
		await h.plugin["applyVideoWorkspace"](h.file as TFile, "note");
		expect(h.viewerLeaf.detach).not.toHaveBeenCalled();
		expect(h.transcriptLeaf.detach).not.toHaveBeenCalled();
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
			jumpToTranscriptTimestamp: () => {},
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

	it("opening a transcript panel honors paused time even when follow playback is off", async () => {
		const h = await harness();
		h.plugin.settings.followTranscript = false;
		const mark = vi.spyOn(h.transcript, "showPlayback");
		await h.plugin.toggleTranscript(h.file as TFile, h.viewerLeaf);
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

});

const NAVIGATION_VIDEO = "dQw4w9WgXcQ";
const OTHER_VIDEO = "BaW_jenozKc";
const NAVIGATION_NOTE = [
	`[0:12](https://youtu.be/${NAVIGATION_VIDEO}?t=12) note timestamp`,
	"# Transcript",
	`[0:10](https://youtu.be/${NAVIGATION_VIDEO}?t=10 "10.1–10.2") first`,
	`[0:10](https://youtu.be/${OTHER_VIDEO}?t=10 "10.15–10.2") unrelated`,
	`[0:10](https://youtu.be/${NAVIGATION_VIDEO}?t=10 "10.3–10.6") second`,
	`[0:10](https://youtu.be/${NAVIGATION_VIDEO}?t=10 "10.1–10.2") duplicate`,
	`[0:20](https://youtu.be/${NAVIGATION_VIDEO}?t=20 "20.2–21") third`,
].join("\n");

type NavigationHarness = Awaited<ReturnType<typeof harness>>;

function navigationFixture(h: NavigationHarness, content = NAVIGATION_NOTE): void {
	const start = content.indexOf("# Transcript");
	Object.assign(h.app.metadataCache, {
		getFileCache: () => ({ headings: start < 0 ? [] : [{
			heading: "Transcript", level: 1,
			position: { start: { offset: start }, end: { offset: start + "# Transcript".length } },
		}] }),
	});
	h.app.vault.cachedRead = vi.fn(async () => content);
}

function navigationCommands(h: NavigationHarness) {
	const commands: import("obsidian").Command[] = [];
	vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => { commands.push(command); return command; });
	h.plugin["registerVideoCommands"]();
	return {
		next: commands.find((command) => command.id === "video-viewer-next-note-timestamp")!,
		previous: commands.find((command) => command.id === "video-viewer-previous-note-timestamp")!,
		commands,
	};
}

function navigationPlayer(h: NavigationHarness, playing = false) {
	const info = { currentTime: 10.1, playerState: playing ? 1 : 2, duration: 120, playbackRate: 1 };
	const player = {
		info,
		seekTo: vi.fn((seconds: number) => { info.currentTime = seconds; }),
		play: vi.fn(), pause: vi.fn(), destroy: vi.fn(),
	};
	Object.assign(h.viewerLeaf.view, { videoId: NAVIGATION_VIDEO, player, marks: [12] });
	return player;
}

function navigationContext(h: NavigationHarness, context: "note" | "video" | "transcript"): void {
	const note = addNote(h);
	h.leaves.push(h.transcriptLeaf);
	h.app.workspace.activeLeaf = context === "note" ? note : context === "video" ? h.viewerLeaf : h.transcriptLeaf;
}

function delayedNavigationRead(h: NavigationHarness) {
	let resolveRead!: (content: string) => void;
	const read = vi.fn(() => new Promise<string>((resolve) => { resolveRead = resolve; }));
	h.app.vault.cachedRead = read;
	return {
		waitForStart: () => vi.waitFor(() => expect(read).toHaveBeenCalledOnce(), { timeout: 500 }),
		finish: () => resolveRead(NAVIGATION_NOTE),
	};
}

describe("transcript timestamp navigation", () => {
	beforeEach(() => { createdNotices.length = 0; });

	it("retains command IDs and registers the transcript-specific display names", async () => {
		const h = await harness();
		const { next, previous, commands } = navigationCommands(h);
		expect(next.name).toBe("Video: next transcript timestamp");
		expect(previous.name).toBe("Video: previous transcript timestamp");
		expect(commands.filter((command) => command.id === next.id)).toHaveLength(1);
		expect(commands.filter((command) => command.id === previous.id)).toHaveLength(1);
	});

	it.each([
		["note", "lines", 10.3],
		["video", "lines", 10.3],
		["transcript", "lines", 10.3],
		["note", "paragraphs", 20.2],
		["video", "paragraphs", 20.2],
		["transcript", "paragraphs", 20.2],
	] as const)("uses %s focus and %s rows to seek to %s", async (context, mode, target) => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, context);
		Object.assign(h.transcript, { mode });
		const playing = context === "video";
		const player = navigationPlayer(h, playing);
		const { next } = navigationCommands(h);
		expect(next.checkCallback!(true)).toBe(true);
		expect(player.seekTo).not.toHaveBeenCalled();
		expect(next.checkCallback!(false)).toBe(true);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(target));
		expect((h.viewerLeaf.view as VideoView).isPlaying()).toBe(playing);
		expect(player.play).not.toHaveBeenCalled();
		expect(player.pause).not.toHaveBeenCalled();
		expect((h.viewerLeaf.view as VideoView)["marks"]).toEqual([12]);
	});

	it("uses caption lines when the transcript panel is closed", async () => {
		const h = await harness();
		navigationFixture(h);
		addNote(h);
		Object.assign(h.transcript, { mode: "paragraphs" });
		const player = navigationPlayer(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(10.3));
	});

	it("prefers the focused viewer when two videos belong to the same note", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		const other = new VideoView({ app: h.app } as unknown as WorkspaceLeaf, (h.viewerLeaf.view as VideoView)["host"]);
		other.containerEl = document.createElement("div");
		const otherSeek = vi.fn();
		Object.assign(other, { filePath: h.file.path, videoId: OTHER_VIDEO, marks: [30], player: {
			info: { currentTime: 10.1 }, seekTo: otherSeek,
		} });
		h.leaves.unshift({ view: other } as unknown as WorkspaceLeaf);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(10.3));
		expect(otherSeek).not.toHaveBeenCalled();
	});

	it.each([
		["note", "lines", false, 10.5],
		["video", "lines", true, 10.5],
		["transcript", "lines", false, 10.5],
		["note", "paragraphs", false, 20.5],
		["video", "paragraphs", true, 20.5],
		["transcript", "paragraphs", true, 20.5],
	] as const)("moves to the previous row from %s in %s mode while playing=%s", async (context, mode, playing, now) => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, context);
		Object.assign(h.transcript, { mode });
		const player = navigationPlayer(h, playing);
		player.info.currentTime = now;
		const { previous } = navigationCommands(h);
		expect(previous.checkCallback!(false)).toBe(true);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(10.1), { timeout: 500 });
		expect((h.viewerLeaf.view as VideoView).isPlaying()).toBe(playing);
		expect(player.play).not.toHaveBeenCalled();
		expect(player.pause).not.toHaveBeenCalled();
	});

	it.each([
		["note", false],
		["transcript", true],
	] as const)("moves to the previous row of background audio from %s while playing=%s", async (context, playing) => {
		const h = await harness();
		navigationFixture(h);
		h.leaves.length = 0;
		const note = addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.app.workspace.activeLeaf = context === "note" ? note : h.transcriptLeaf;
		const playback = await h.plugin["backgroundPlaybackFor"](h.file as TFile, {
			videoId: NAVIGATION_VIDEO, seconds: 10.5, autoplay: playing,
		});
		expect(playback).not.toBeNull();
		try {
			const { previous } = navigationCommands(h);
			expect(previous.checkCallback!(false)).toBe(true);
			await vi.waitFor(() => expect(playback!.getPlaybackSeconds()).toBe(10.1), { timeout: 500 });
			expect(playback!.isPlaying()).toBe(playing);
			expect(h.app.workspace.getLeavesOfType("perplexity-saver-video")).toHaveLength(0);
		} finally {
			await h.transcript.onClose();
		}
	});

	it("does not restart the first row when there is no previous row", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "transcript");
		const player = navigationPlayer(h);
		player.info.currentTime = 10.1001;
		const { previous } = navigationCommands(h);
		previous.checkCallback!(false);
		await vi.waitFor(() => expect(createdNotices.at(-1)?.message).toMatch(/no.*previous.*transcript/i), { timeout: 500 });
		expect(player.seekTo).not.toHaveBeenCalled();
	});

	it("moves between distinct fractional rows and does not wrap at either end", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "transcript");
		const player = navigationPlayer(h);
		const { next, previous } = navigationCommands(h);
		previous.checkCallback!(false);
		await vi.waitFor(() => expect(createdNotices).toHaveLength(1));
		expect(createdNotices[0]?.message).toMatch(/no.*previous.*transcript/i);
		expect(player.seekTo).not.toHaveBeenCalled();
		player.info.currentTime = 20.2001;
		previous.checkCallback!(false);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenLastCalledWith(10.3));
		previous.checkCallback!(false);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenLastCalledWith(10.1));
		previous.checkCallback!(false);
		await vi.waitFor(() => expect(createdNotices).toHaveLength(2));
		expect(player.seekTo).toHaveBeenCalledTimes(2);
		player.info.currentTime = 20.2;
		player.seekTo.mockClear();
		next.checkCallback!(false);
		await vi.waitFor(() => expect(createdNotices).toHaveLength(3));
		expect(createdNotices[2]?.message).toMatch(/no.*later.*transcript/i);
		expect(player.seekTo).not.toHaveBeenCalled();
	});

	it.each([
		["missing heading", "# Notes\n[0:12](https://youtu.be/dQw4w9WgXcQ?t=12)"],
		["empty section", "# Transcript\nNo timed captions"],
		["unrelated video", `# Transcript\n[0:12](https://youtu.be/${OTHER_VIDEO}?t=12) other`],
	] as const)("notices %s without seeking", async (_label, content) => {
		const h = await harness();
		navigationFixture(h, content);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await vi.waitFor(() => expect(createdNotices.at(-1)?.message).toMatch(/no.*transcript/i));
		expect(player.seekTo).not.toHaveBeenCalled();
	});

	it.each([
		["note", false, "lines", 10.3],
		["note", true, "paragraphs", 20.2],
		["transcript", false, "paragraphs", 20.2],
		["transcript", true, "lines", 10.3],
	] as const)("navigates background audio from %s, playing=%s, with %s rows", async (context, playing, mode, target) => {
		const h = await harness();
		navigationFixture(h);
		h.leaves.length = 0;
		const note = addNote(h);
		h.leaves.push(h.transcriptLeaf);
		h.app.workspace.activeLeaf = context === "note" ? note : h.transcriptLeaf;
		Object.assign(h.transcript, { mode });
		const playback = await h.plugin["backgroundPlaybackFor"](h.file as TFile, {
			videoId: NAVIGATION_VIDEO, seconds: 10.1, autoplay: playing,
		});
		expect(playback).not.toBeNull();
		try {
			const { next } = navigationCommands(h);
			expect(next.checkCallback!(true)).toBe(true);
			next.checkCallback!(false);
			await vi.waitFor(() => expect(playback!.getPlaybackSeconds()).toBe(target));
			expect(playback!.isPlaying()).toBe(playing);
			expect(h.app.workspace.getLeavesOfType("perplexity-saver-video")).toHaveLength(0);
		} finally {
			await h.transcript.onClose();
		}
	});

	it("routes bracket keys through transcript navigation in the registered viewer", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		Object.assign(h.app.workspace, { on: vi.fn(), onLayoutReady: vi.fn(), getLastOpenFiles: () => [] });
		Object.assign(h.app.vault, { on: vi.fn() });
		Object.assign(h.plugin, { registerView: vi.fn() });
		h.plugin.settings.autoRelinkSources = false;
		vi.spyOn(h.plugin, "loadSettings").mockResolvedValue();
		vi.spyOn(h.plugin, "addCommand").mockImplementation((command) => command);
		await h.plugin.onload();
		const factory = vi.mocked(h.plugin.registerView).mock.calls.find(([type]) => type === h.viewerLeaf.view.getViewType())?.[1];
		if (!factory) throw new Error("Missing video view registration");
		const view = h.viewerLeaf.view as VideoView;
		Object.assign(view, { host: (factory(h.viewerLeaf) as VideoView)["host"] });
		const press = (key: string): KeyboardEvent => {
			const event = new KeyboardEvent("keydown", { key, cancelable: true });
			Object.defineProperty(event, "target", { value: view.contentEl });
			view["onKey"](event);
			return event;
		};
		expect(press("]").defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenLastCalledWith(10.3));
		player.info.currentTime = 10.5;
		expect(press("[").defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenLastCalledWith(10.1));
	});

	it.each(["closed", "note", "video", "player"] as const)("does not seek a stale viewer after the %s changes during a read", async (change) => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		const view = h.viewerLeaf.view as VideoView;
		const replacementSeek = vi.fn();
		if (change === "closed") await view.onClose();
		else if (change === "note") Object.assign(view, { filePath: "other.md" });
		else if (change === "video") Object.assign(view, { videoId: OTHER_VIDEO });
		else Object.assign(view, { player: { info: { currentTime: 10.1 }, seekTo: replacementSeek } });
		pending.finish();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(player.seekTo).not.toHaveBeenCalled();
		expect(replacementSeek).not.toHaveBeenCalled();
	});

	it("does not seek destroyed background audio after a read completes", async () => {
		const h = await harness();
		navigationFixture(h);
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		const playback = await h.plugin["backgroundPlaybackFor"](h.file as TFile, { videoId: NAVIGATION_VIDEO, seconds: 10.1 });
		const seek = vi.spyOn(playback!, "seekTo");
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		h.transcript.stopBackgroundPlayback();
		pending.finish();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(seek).not.toHaveBeenCalled();
	});

	it("uses the active transcript's mode when panels for the same note differ", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "transcript");
		const other = Object.create(TranscriptView.prototype) as TranscriptView;
		Object.assign(other, { filePath: h.file.path, mode: "paragraphs", containerEl: document.createElement("div") });
		h.leaves.unshift({ view: other } as unknown as WorkspaceLeaf);
		const player = navigationPlayer(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(10.3));
	});

	it("uses the current panel mode after a delayed read", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		Object.assign(h.transcript, { mode: "paragraphs" });
		pending.finish();
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(20.2));
	});

	it("uses the current playback position after a delayed read", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		player.info.currentTime = 10.3;
		pending.finish();
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(20.2));
	});

	it("uses captions if the paragraph panel closes during a read", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		Object.assign(h.transcript, { mode: "paragraphs" });
		const player = navigationPlayer(h);
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		h.leaves.splice(h.leaves.indexOf(h.transcriptLeaf), 1);
		pending.finish();
		await vi.waitFor(() => expect(player.seekTo).toHaveBeenCalledWith(10.3));
	});

	it("ignores a delayed viewer read after switching away and back to the note", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		const view = h.viewerLeaf.view as VideoView;
		vi.spyOn(view as unknown as { refreshMarks(): Promise<void> }, "refreshMarks").mockResolvedValue();
		view.showVideo(NAVIGATION_VIDEO, 10.1, "other.md");
		view.showVideo(NAVIGATION_VIDEO, 10.1, h.file.path);
		player.seekTo.mockClear();
		pending.finish();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(player.seekTo).not.toHaveBeenCalled();
	});

	it("ignores a delayed background read after its note is renamed away and back", async () => {
		const h = await harness();
		navigationFixture(h);
		h.leaves.length = 0;
		addNote(h);
		h.leaves.push(h.transcriptLeaf);
		const playback = await h.plugin["backgroundPlaybackFor"](h.file as TFile, { videoId: NAVIGATION_VIDEO, seconds: 10.1 });
		const seek = vi.spyOn(playback!, "seekTo");
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		playback!.renameFile("other.md");
		playback!.renameFile(h.file.path);
		pending.finish();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(seek).not.toHaveBeenCalled();
		await h.transcript.onClose();
	});

	it("ignores a delayed read when the associated note is replaced at the same path", async () => {
		const h = await harness();
		navigationFixture(h);
		navigationContext(h, "video");
		const player = navigationPlayer(h);
		const pending = delayedNavigationRead(h);
		const { next } = navigationCommands(h);
		next.checkCallback!(false);
		await pending.waitForStart();
		h.app.vault.getFileByPath = vi.fn(() => ({ ...h.file } as TFile));
		pending.finish();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(player.seekTo).not.toHaveBeenCalled();
	});
});
