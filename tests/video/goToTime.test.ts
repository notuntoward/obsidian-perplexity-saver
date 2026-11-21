// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import "commons/testing";
import { openGoToTime } from "../../src/video/goToTime";
import { installEditorDomHelpers } from "../__mocks__/obsidian";

const state = vi.hoisted(() => ({ doc: null as Document | null, modal: null as { contentEl: HTMLElement; closed: boolean } | null }));
const VIDEO_ID = "dQw4w9WgXcQ";
vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	Modal: class extends (await original<typeof import("../__mocks__/obsidian")>()).DomModal {
		constructor() { super(state.doc!); state.modal = this; }
	},
}));

beforeEach(() => {
	state.doc = document;
	state.modal = null;
	installEditorDomHelpers(document);
});

function open(videoId = VIDEO_ID) {
	const token = { player: {}, revision: 1 };
	const playback = {
		getPlaybackToken: vi.fn((): typeof token | null => token),
		getVideoId: vi.fn((): string | null => videoId),
		getDuration: vi.fn(() => 4000),
		seekTo: vi.fn(),
	};
	openGoToTime({} as App, playback);
	const modal = state.modal!;
	const input = modal.contentEl.querySelector<HTMLInputElement>("input")!;
	const submit = (value: string) => {
		input.value = value;
		input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	};
	const paste = (value: string) => {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: { getData: () => value } });
		input.dispatchEvent(event);
	};
	return { playback, modal, input, submit, paste };
}

describe("go to time", () => {
	it.each([["83", 83], ["1:23", 83], ["1:02:03", 3723], ["0", 0], ["4000", 4000]])("seeks %s as %s seconds", (input, seconds) => {
		const h = open();
		h.submit(input);
		expect(h.playback.seekTo).toHaveBeenCalledOnce();
		expect(h.playback.seekTo).toHaveBeenCalledWith(seconds);
		expect(h.modal.closed).toBe(true);
	});

	it.each([
		[`https://youtu.be/${VIDEO_ID}?si=share&t=83`, 83],
		[`https://www.youtube.com/watch?v=${VIDEO_ID}&t=1m23s`, 83],
		[`https://www.youtube.com/embed/${VIDEO_ID}?start=0`, 0],
		[`https://m.youtube.com/watch?v=${VIDEO_ID}#t=1h2m3s`, 3723],
	])("accepts a timestamped URL for this video: %s", (url, seconds) => {
		const h = open();
		h.submit(url);
		expect(h.playback.seekTo).toHaveBeenCalledWith(seconds);
		expect(h.modal.closed).toBe(true);
	});

	it.each(["1:23", `https://youtu.be/${VIDEO_ID}?t=83`])("seeks immediately on paste: %s", (value) => {
		const h = open();
		h.paste(value);
		expect(h.playback.seekTo).toHaveBeenCalledWith(83);
		expect(h.modal.closed).toBe(true);
	});

	it("replaces only the selected input when pasting", () => {
		const h = open();
		h.input.value = "1:00";
		h.input.setSelectionRange(2, 4);
		h.paste("23");
		expect(h.playback.seekTo).toHaveBeenCalledWith(83);
	});

	it("rejects another video's URL without seeking or discarding the paste", () => {
		const h = open();
		const url = "https://youtu.be/aaaaaaaaaaa?t=83";
		h.paste(url);
		expect(h.input.value).toBe(url);
		expect(h.modal.closed).toBe(false);
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.contentEl.textContent).toContain("not for the current video");
	});

	it.each([
		`https://youtu.be/${VIDEO_ID}`,
		`https://youtu.be/${VIDEO_ID}?t=invalid`,
		`https://youtu.be/${VIDEO_ID}?t=1:60`,
		`https://youtu.be/${VIDEO_ID}/extra?t=83`,
		`https://youtube.com.evil.example/watch?v=${VIDEO_ID}&t=83`,
		`https://example.com/?url=https://youtu.be/${VIDEO_ID}?t=83`,
	])("rejects malformed or untimestamped links: %s", (url) => {
		const h = open();
		h.paste(url);
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.closed).toBe(false);
		expect(h.modal.contentEl.querySelector('[role="alert"]')?.textContent).toBeTruthy();
	});

	it("validates the actual watch parameter rather than a video id embedded in another parameter", () => {
		const h = open();
		h.paste(`https://www.youtube.com/watch?other=v=${VIDEO_ID}&v=aaaaaaaaaaa&t=83`);
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.contentEl.textContent).toContain("not for the current video");
	});

	it("routes each paste only to the playback session that opened its dialog", () => {
		const first = open();
		const second = open("aaaaaaaaaaa");
		first.paste("https://youtu.be/aaaaaaaaaaa?t=42");
		expect(first.playback.seekTo).not.toHaveBeenCalled();
		second.paste("https://youtu.be/aaaaaaaaaaa?t=42");
		expect(second.playback.seekTo).toHaveBeenCalledWith(42);
		first.input.value = "";
		first.paste(`https://youtu.be/${VIDEO_ID}?t=83`);
		expect(first.playback.seekTo).toHaveBeenCalledWith(83);
		expect(second.playback.seekTo).toHaveBeenCalledOnce();
	});

	it.each(["", "-1", "1:60", "1:60:00", "no", "1:2:3:4", "1e309"])("keeps the form open with an error for %s", (value) => {
		const h = open();
		h.submit(value);
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.closed).toBe(false);
		expect(h.modal.contentEl.querySelector('[role="alert"]')?.textContent).toBeTruthy();
	});

	it("reports timestamps beyond the duration and unavailable duration", () => {
		const h = open();
		h.submit("4001");
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.contentEl.textContent).toContain("duration");
		h.input.value = "";
		h.paste(`https://youtu.be/${VIDEO_ID}?t=4001`);
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.contentEl.textContent).toContain("duration");
		h.playback.getDuration.mockReturnValue(0);
		h.submit("1:00");
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.contentEl.textContent).toContain("not available");
	});

	it("does not seek a playback session that changed while the prompt was open", () => {
		const h = open();
		h.playback.getPlaybackToken.mockReturnValue(null);
		h.submit("1:23");
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.contentEl.textContent).toContain("Playback changed");
	});

	it("rejects a paste if the playback video changes while the dialog is open", () => {
		const h = open();
		h.playback.getVideoId.mockReturnValue("aaaaaaaaaaa");
		h.paste(`https://youtu.be/${VIDEO_ID}?t=83`);
		expect(h.playback.seekTo).not.toHaveBeenCalled();
		expect(h.modal.contentEl.textContent).toContain("Playback changed");
	});

	it("cancels without seeking", () => {
		const h = open();
		h.modal.contentEl.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
		expect(h.modal.closed).toBe(true);
		expect(h.playback.seekTo).not.toHaveBeenCalled();
	});

	it("builds the form in the active pop-out document", () => {
		const doc = document.implementation.createHTMLDocument();
		Object.defineProperty(doc, "activeElement", { configurable: true, value: doc.body });
		vi.stubGlobal("activeDocument", doc);
		vi.stubGlobal("activeWindow", window);
		try {
			state.doc = doc;
			installEditorDomHelpers(doc);
			const h = open();
			expect(h.input.ownerDocument).toBe(doc);
			expect(doc.head.querySelector("style[data-commons-modal]")).not.toBeNull();
			expect(h.input.closest("label")?.textContent).toContain("timestamped YouTube URL");
			expect(h.input.getAttribute("aria-description")).toContain("Paste to seek");
			h.paste(`https://youtu.be/${VIDEO_ID}?t=83`);
			expect(h.playback.seekTo).toHaveBeenCalledWith(83);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps the input focused and clears validation feedback when editing", () => {
		const h = open();
		expect(document.activeElement).toBe(h.input);
		expect(h.input.closest(".commons-modal-compact")).not.toBeNull();
		h.submit("invalid");
		h.input.value = "1:23";
		h.input.dispatchEvent(new Event("input", { bubbles: true }));
		expect(h.modal.contentEl.querySelector('[role="alert"]')?.textContent).toBe("");
		h.submit(h.input.value);
		expect(h.playback.seekTo).toHaveBeenCalledWith(83);
	});
});
