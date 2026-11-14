// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { MockMenu, setIcon } from "commons/testing";
import { VideoView } from "../../src/video/videoView";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	Menu: class extends MockMenu { addSeparator(): this { return this; } },
	setIcon,
	Platform: { isDesktopApp: true },
}));

async function toolbar(doc = document) {
	let action: "copy" | "insert" = "insert";
	let unit: "sentence" | "caption" = "caption";
	const insertTimestamp = vi.fn().mockResolvedValue(undefined);
	const insertScreenshot = vi.fn().mockResolvedValue(undefined);
	const jump = vi.fn();
	const onPlayback = vi.fn();
	const vaultEvents = new Map<string, (file: { path: string }, oldPath: string) => void>();
	const app = {
		hotkeyManager: { printHotkeyForCommand: (id: string) => id === "perplexity-saver:video-viewer-play-pause" ? "Ctrl + Alt + P" : "" },
		metadataCache: { on: vi.fn() },
		vault: { on: vi.fn((name: string, handler: (file: { path: string }, oldPath: string) => void) => { vaultEvents.set(name, handler); }) },
		workspace: { on: vi.fn() },
	};
	const view = new VideoView({ app } as unknown as WorkspaceLeaf, {
		getTranscriptHeading: () => "Transcript",
		getTimestampCopyFormat: () => "list",
		getToolbarCaptureAction: () => action,
		getShowYoutubeCaptions: () => false,
		getTranscriptUnit: () => unit,
		insertTimestamp,
		insertScreenshot,
		isTranscriptShown: () => false,
		toggleTranscript: async () => {},
		jumpToTranscriptTimestamp: jump,
		onPlayback,
		focusNote: async () => {},
	});
	view.register = vi.fn();
	view.contentEl = doc.createElement("div");
	const copy = vi.spyOn(view, "copyTimestampLink").mockResolvedValue();
	const screenshot = vi.spyOn(view, "screenshot").mockResolvedValue();
	await view.onOpen();
	doc.adoptNode(view.contentEl);
	const timestamp = view.contentEl.querySelector<HTMLElement>('[aria-label="Insert current timestamp into note"]')!;
	const camera = view.contentEl.querySelector<HTMLElement>('[data-icon="camera"]')!;
	return { view, timestamp, camera, copy, screenshot, insertTimestamp, insertScreenshot, jump, onPlayback, vaultEvents,
		setAction: (value: typeof action) => { action = value; }, setUnit: (value: typeof unit) => { unit = value; } };
}

describe("video toolbar capture destinations", () => {
	beforeEach(() => {
		MockMenu.last = null;
		HTMLElement.prototype.createDiv = function (opts) { return this.createEl("div", opts); };
		HTMLElement.prototype.toggleClass = function (cls, value) { this.classList.toggle(cls, value); };
		HTMLElement.prototype.getText = function () { return this.textContent ?? ""; };
		HTMLElement.prototype.setAttr = function (name, value) { this.setAttribute(name, String(value)); };
		HTMLElement.prototype.setCssProps = function (props) {
			for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
		};
	});

	it.each([false, true])("offers separate timestamp actions and persistent shared-first help (popout=%s)", async (popout) => {
		const h = await toolbar(popout ? document.implementation.createHTMLDocument() : document);
		const el = h.view.contentEl;
		expect(el.querySelector('[aria-label="Timestamp alternatives"]')).toBeNull();
		el.querySelector<HTMLButtonElement>('[aria-label="Insert current timestamp into note"]')!.click();
		el.querySelector<HTMLButtonElement>('[aria-label="Copy current timestamp link"]')!.click();
		expect(h.insertTimestamp).toHaveBeenCalledWith(h.view);
		expect(h.copy).toHaveBeenCalledOnce();
		const help = el.querySelector<HTMLElement>(".perplexity-saver-video-help")!;
		expect(help.hidden).toBe(true);
		el.querySelector<HTMLButtonElement>('[aria-label="Video keyboard help"]')!.click();
		expect(help.hidden).toBe(false);
		expect(help.textContent!.indexOf("Note, player or transcript")).toBeLessThan(help.textContent!.indexOf("While the player is focused"));
		expect(help.textContent).toContain("Ctrl + Alt + P");
		expect(help.textContent).toContain("Unassigned");
		el.querySelector<HTMLButtonElement>('[aria-label="Close video keyboard help"]')!.click();
		expect(help.hidden).toBe(true);
		expect(el.querySelector(".perplexity-saver-video-control-group")!.contains(el.querySelector(".perplexity-saver-video-time"))).toBe(false);
	});

	it.each([false, true])("keeps video task groups intact and secondary actions in More (popout=%s)", async (popout) => {
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		const h = await toolbar(doc);
		const groups = h.view.contentEl.querySelectorAll<HTMLElement>(".perplexity-saver-video-control-group");
		expect(Array.from(groups, (group) => group.dataset.group)).toEqual(["transport", "navigation", "capture", "view"]);
		expect(Array.from(groups[0].querySelectorAll("[data-icon]"), (button) => button.getAttribute("data-icon")))
			.toEqual(["play", "gauge"]);
		expect(groups[0].querySelector('[aria-label^="Back"]')!.textContent).toBe("-10s");
		expect(groups[0].querySelector('[aria-label^="Forward"]')!.textContent).toBe("+10s");
		expect(h.view.contentEl.querySelector(".perplexity-saver-video-rate-label")?.textContent).toBe("1×");
		expect(groups[2].contains(h.timestamp)).toBe(true);
		expect(groups[2].contains(h.camera)).toBe(true);
		expect(h.view.contentEl.querySelector('[data-icon="captions"]')).toBeNull();
		expect(h.view.contentEl.querySelector('[aria-label="Open in browser at this time"]')).toBeNull();
		h.setUnit("sentence");
		h.view.refreshTranscriptControls();
		expect(groups[1].querySelector('[aria-label="Previous sentence ([)"]')).not.toBeNull();
		expect(groups[1].querySelector('[aria-label="Next sentence (])"]')).not.toBeNull();
		h.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="More video options"]')!.click();
		expect(MockMenu.last?.items.map((item) => item.title)).toEqual([
			"Zoom out (-)", "Reset zoom (0)", "Zoom in (+)", "Open in browser at this time",
		]);
	});

	it("reports state transitions without treating time updates as state changes", async () => {
		const h = await toolbar();
		Object.assign(h.view, { videoId: "dQw4w9WgXcQ", filePath: "note.md" });
		const info = { currentTime: 1, duration: 120, playbackRate: 1, playerState: 2 };
		h.view["update"](info);
		h.view["update"]({ ...info, currentTime: 2 });
		h.view["update"]({ ...info, currentTime: 2, playerState: 1 });
		h.view["update"]({ ...info, currentTime: 3, playerState: 1 });
		expect(h.onPlayback.mock.calls).toEqual([
			["dQw4w9WgXcQ", "note.md", 1, true],
			["dQw4w9WgXcQ", "note.md", 2, false],
			["dQw4w9WgXcQ", "note.md", 2, true],
			["dQw4w9WgXcQ", "note.md", 3, false],
		]);
	});

	it("refreshes state when a loaded video is associated with another note", async () => {
		const h = await toolbar();
		const info = { currentTime: 12, duration: 120, playbackRate: 1, playerState: 1 };
		const player = { info, seekTo: vi.fn(() => h.view["update"](info)) };
		Object.assign(h.view, {
			videoId: "dQw4w9WgXcQ", filePath: "note.md", player,
			refreshMarks: vi.fn().mockResolvedValue(undefined),
		});
		h.view["update"](info);
		h.onPlayback.mockClear();
		h.view.showVideo("dQw4w9WgXcQ", 12, "other.md");
		expect(h.onPlayback).toHaveBeenCalledWith("dQw4w9WgXcQ", "other.md", 12, true);
	});

	it("notifies transcript panels when the associated note is renamed", async () => {
		const h = await toolbar();
		const info = { currentTime: 12, duration: 120, playbackRate: 1, playerState: 1 };
		Object.assign(h.view, { videoId: "dQw4w9WgXcQ", filePath: "note.md", player: { info } });
		h.view["update"](info);
		h.onPlayback.mockClear();
		h.vaultEvents.get("rename")!({ path: "renamed.md" }, "note.md");
		expect(h.onPlayback).toHaveBeenCalledWith("dQw4w9WgXcQ", "renamed.md", 12, true);
	});

	it("routes the transcript row buttons to the host", async () => {
		const h = await toolbar();
		const previous = h.view.contentEl.querySelector<HTMLButtonElement>('button[aria-label="Previous caption ([)"]');
		const next = h.view.contentEl.querySelector<HTMLButtonElement>('button[aria-label="Next caption (])"]');
		expect(previous).not.toBeNull();
		expect(next).not.toBeNull();
		previous!.click();
		next!.click();
		expect(h.jump.mock.calls).toEqual([[h.view, -1], [h.view, 1]]);
	});

	it("opens screenshot alternatives from a separate accessible button in its owner document", async () => {
		const doc = document.implementation.createHTMLDocument();
		const h = await toolbar(doc);
		const button = h.view.contentEl.querySelector<HTMLButtonElement>('button[aria-label="Screenshot alternatives"]');
		expect(button).not.toBeNull();
		expect(button!.getAttribute("aria-haspopup")).toBe("menu");
		const show = vi.spyOn(MockMenu.prototype, "showAtPosition");
		button!.click();
		expect(show).toHaveBeenCalledWith(expect.any(Object), doc);
		expect(MockMenu.last?.items.map((item) => item.title)).toEqual([
			"Insert selected area into note...", "Copy selected area...", "Insert whole picture into note", "Copy whole picture",
		]);
		for (const item of MockMenu.last!.items) item.click();
		expect(h.insertScreenshot.mock.calls).toEqual([[h.view, false], [h.view, true]]);
		expect(h.screenshot.mock.calls).toEqual([[false], [true]]);
		show.mockRestore();
	});

	it.each(["insert", "copy"] as const)("uses the live %s setting for camera clicks but keeps timestamp actions explicit", async (action) => {
		const h = await toolbar();
		h.setAction(action);
		h.timestamp.click();
		h.camera.click();
		h.camera.dispatchEvent(new MouseEvent("click", { shiftKey: true }));
		expect(h.insertTimestamp).toHaveBeenCalledWith(h.view);
		expect(h.copy).not.toHaveBeenCalled();
		if (action === "insert") {
			expect(h.insertTimestamp).toHaveBeenCalledWith(h.view);
			expect(h.insertScreenshot.mock.calls).toEqual([[h.view, false], [h.view, true]]);
			expect(h.copy).not.toHaveBeenCalled();
			expect(h.screenshot).not.toHaveBeenCalled();
		} else {
			expect(h.screenshot.mock.calls).toEqual([[false], [true]]);
			expect(h.insertScreenshot).not.toHaveBeenCalled();
		}
	});

	it.each(["insert", "copy"] as const)("offers both timestamp destinations regardless of the %s default", async (action) => {
		const h = await toolbar();
		h.setAction(action);
		h.timestamp.click();
		h.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Copy current timestamp link"]')!.click();
		expect(MockMenu.last).toBeNull();
		expect(h.insertTimestamp).toHaveBeenCalledWith(h.view);
		expect(h.copy).toHaveBeenCalledOnce();
	});

	it.each(["insert", "copy"] as const)("offers explicit area and whole-picture destinations regardless of the %s default", async (action) => {
		const h = await toolbar();
		h.setAction(action);
		h.camera.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true, shiftKey: true }));
		expect(MockMenu.last?.items.map((item) => item.title)).toEqual([
			"Insert selected area into note...", "Copy selected area...",
			"Insert whole picture into note", "Copy whole picture",
		]);
		for (const item of MockMenu.last!.items) item.click();
		expect(h.insertScreenshot.mock.calls).toEqual([[h.view, false], [h.view, true]]);
		expect(h.screenshot.mock.calls).toEqual([[false], [true]]);
	});

	it("updates existing toolbar labels without rebuilding the player", async () => {
		const h = await toolbar();
		expect(h.timestamp.getAttribute("aria-label")).toBe("Insert current timestamp into note");
		expect(h.camera.getAttribute("aria-label")).toContain("Insert screenshot into note");
		h.setAction("copy");
		h.view.updateToolbarCaptureLabels();
		expect(h.timestamp.getAttribute("aria-label")).toBe("Insert current timestamp into note");
		expect(h.camera.getAttribute("aria-label")).toContain("Copy screenshot");
		expect(h.camera.getAttribute("aria-label")).toContain("alternatives button");
		expect(h.camera.getAttribute("aria-label")).toContain("Shift-click");
		expect(h.camera.getAttribute("aria-label")).toContain("right-click");
		h.timestamp.click();
		h.camera.click();
		expect(h.copy).not.toHaveBeenCalled();
		expect(h.screenshot).toHaveBeenCalledWith(false);
		expect(h.insertTimestamp).toHaveBeenCalledWith(h.view);
	});

	it("shows menus in the button's owning document, including a stand-in pop-out", async () => {
		const doc = document.implementation.createHTMLDocument();
		const h = await toolbar(doc);
		const show = vi.spyOn(MockMenu.prototype, "showAtPosition");
		h.camera.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
		expect(show).toHaveBeenCalledWith(expect.any(Object), doc);
		show.mockRestore();
	});
});
