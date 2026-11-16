// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import "commons/testing";
import { openGoToTime } from "../../src/video/goToTime";
import { installEditorDomHelpers } from "../__mocks__/obsidian";

const state = vi.hoisted(() => ({ doc: null as Document | null, modal: null as { contentEl: HTMLElement; closed: boolean } | null }));
vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	Modal: class {
		titleEl = state.doc!.createElement("h2");
		contentEl = state.doc!.createElement("div");
		closed = false;
		constructor() { state.modal = this; }
		open(): void { this.onOpen(); }
		close(): void { this.closed = true; this.onClose(); }
		onOpen(): void {}
		onClose(): void {}
	},
}));

beforeEach(() => {
	state.doc = document;
	state.modal = null;
	installEditorDomHelpers(document);
});

function open() {
	const token = { player: {}, revision: 1 };
	const playback = {
		getPlaybackToken: vi.fn((): typeof token | null => token),
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
	return { playback, modal, input, submit };
}

describe("go to time", () => {
	it.each([["83", 83], ["1:23", 83], ["1:02:03", 3723], ["0", 0], ["4000", 4000]])("seeks %s as %s seconds", (input, seconds) => {
		const h = open();
		h.submit(input);
		expect(h.playback.seekTo).toHaveBeenCalledOnce();
		expect(h.playback.seekTo).toHaveBeenCalledWith(seconds);
		expect(h.modal.closed).toBe(true);
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
			h.submit("1:23");
			expect(h.playback.seekTo).toHaveBeenCalledWith(83);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
