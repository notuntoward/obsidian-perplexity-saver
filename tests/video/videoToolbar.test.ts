// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { MockMenu, setIcon } from "commons/testing";
import { VideoView } from "../../src/video/videoView";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	Menu: MockMenu,
	setIcon,
	Platform: { isDesktopApp: true },
}));

async function toolbar(doc = document) {
	let action: "copy" | "insert" = "insert";
	const insertTimestamp = vi.fn().mockResolvedValue(undefined);
	const insertScreenshot = vi.fn().mockResolvedValue(undefined);
	const app = {
		metadataCache: { on: vi.fn() },
		vault: { on: vi.fn() },
		workspace: { on: vi.fn() },
	};
	const view = new VideoView({ app } as unknown as WorkspaceLeaf, {
		getTranscriptHeading: () => "Transcript",
		getTimestampCopyFormat: () => "list",
		getToolbarCaptureAction: () => action,
		getShowYoutubeCaptions: () => false,
		insertTimestamp,
		insertScreenshot,
		isTranscriptShown: () => false,
		toggleTranscript: async () => {},
		onPlayback: () => {},
		focusNote: async () => {},
	});
	view.register = vi.fn();
	view.contentEl = doc.createElement("div");
	const copy = vi.spyOn(view, "copyTimestampLink").mockResolvedValue();
	const screenshot = vi.spyOn(view, "screenshot").mockResolvedValue();
	await view.onOpen();
	doc.adoptNode(view.contentEl);
	const timestamp = view.contentEl.querySelector<HTMLElement>('[data-icon="link"]')!;
	const camera = view.contentEl.querySelector<HTMLElement>('[data-icon="camera"]')!;
	return { view, timestamp, camera, copy, screenshot, insertTimestamp, insertScreenshot, setAction: (value: typeof action) => { action = value; } };
}

describe("video toolbar capture destinations", () => {
	beforeEach(() => {
		MockMenu.last = null;
		HTMLElement.prototype.toggleClass = function (cls, value) { this.classList.toggle(cls, value); };
		HTMLElement.prototype.setCssProps = function (props) {
			for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
		};
	});

	it.each(["insert", "copy"] as const)("uses the live %s setting for timestamp and camera clicks", async (action) => {
		const h = await toolbar();
		h.setAction(action);
		h.timestamp.click();
		h.camera.click();
		h.camera.dispatchEvent(new MouseEvent("click", { shiftKey: true }));
		if (action === "insert") {
			expect(h.insertTimestamp).toHaveBeenCalledWith(h.view);
			expect(h.insertScreenshot.mock.calls).toEqual([[h.view, false], [h.view, true]]);
			expect(h.copy).not.toHaveBeenCalled();
			expect(h.screenshot).not.toHaveBeenCalled();
		} else {
			expect(h.copy).toHaveBeenCalledOnce();
			expect(h.screenshot.mock.calls).toEqual([[false], [true]]);
			expect(h.insertTimestamp).not.toHaveBeenCalled();
			expect(h.insertScreenshot).not.toHaveBeenCalled();
		}
	});

	it.each(["insert", "copy"] as const)("offers both timestamp destinations regardless of the %s default", async (action) => {
		const h = await toolbar();
		h.setAction(action);
		const event = new MouseEvent("contextmenu", { cancelable: true });
		h.timestamp.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(MockMenu.last?.items.map((item) => item.title)).toEqual(["Insert timestamp into note", "Copy timestamp"]);
		MockMenu.last!.items[0].click();
		MockMenu.last!.items[1].click();
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
		expect(h.timestamp.getAttribute("aria-label")).toContain("Insert timestamp into note");
		expect(h.camera.getAttribute("aria-label")).toContain("Insert screenshot into note");
		h.setAction("copy");
		h.view.updateToolbarCaptureLabels();
		expect(h.timestamp.getAttribute("aria-label")).toContain("Copy timestamp");
		expect(h.camera.getAttribute("aria-label")).toContain("Copy screenshot");
		expect(h.camera.getAttribute("aria-label")).toContain("Shift-click");
		expect(h.camera.getAttribute("aria-label")).toContain("right-click");
		h.timestamp.click();
		h.camera.click();
		expect(h.copy).toHaveBeenCalledOnce();
		expect(h.screenshot).toHaveBeenCalledWith(false);
		expect(h.insertTimestamp).not.toHaveBeenCalled();
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
