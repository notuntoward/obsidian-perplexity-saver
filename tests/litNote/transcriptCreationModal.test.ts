// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import "commons/testing";
import {
	TranscriptVideoModal,
	type TranscriptVideoSource,
} from "../../src/litNote/transcriptCreation";
import { installEditorDomHelpers } from "../__mocks__/obsidian";

const state = vi.hoisted(() => ({
	doc: null as Document | null,
	modal: null as { contentEl: HTMLElement; modalEl: HTMLElement; closed: boolean } | null,
}));

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	Modal: class extends (await original<typeof import("../__mocks__/obsidian")>()).DomModal {
		constructor() {
			super(state.doc!);
			state.modal = this;
		}
	},
}));

const first: TranscriptVideoSource = {
	videoId: "abcdefghijk",
	url: "https://www.youtube.com/watch?v=abcdefghijk",
	label: "YouTube video 1",
	alias: "https://youtu.be/abcdefghijk",
	origin: "note",
};
const second: TranscriptVideoSource = {
	videoId: "dQw4w9WgXcQ",
	url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	label: "YouTube video 2",
	alias: "https://youtu.be/dQw4w9WgXcQ",
	origin: "note",
};

beforeEach(() => {
	state.doc = document;
	state.modal = null;
	installEditorDomHelpers(document);
});

function open(sources: TranscriptVideoSource[] = [first]) {
	const resolve = vi.fn();
	const modal = new TranscriptVideoModal({} as App, sources, sources[0]?.videoId ?? null, {
		action: "create",
		fileName: "plain_video_test_2",
		headingName: "Transcript",
	}, resolve);
	modal.open();
	return { modal: state.modal!, resolve };
}

function enter(target: Element): void {
	target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

describe("transcript source modal", () => {
	it("focuses the primary action and accepts the linked video with Enter", () => {
		const h = open();
		const primary = h.modal.contentEl.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		expect(document.activeElement).toBe(primary);

		enter(primary);

		expect(h.resolve).toHaveBeenCalledWith(first);
		expect(h.modal.closed).toBe(true);
	});

	it("clearly separates linked videos from an editable different URL", () => {
		const h = open([first, second]);
		const alternate = h.modal.contentEl.querySelector<HTMLInputElement>('input[type="url"]')!;
		expect(alternate.value).toBe("");
		expect(h.modal.contentEl.querySelectorAll('input[type="radio"]')).toHaveLength(2);
		expect(h.modal.contentEl.textContent).toContain("Use a different YouTube URL (optional)");

		alternate.value = "https://youtu.be/9bZkp7q19f0";
		alternate.dispatchEvent(new Event("input", { bubbles: true }));
		const warning = h.modal.contentEl.querySelector<HTMLElement>('[role="status"]')!;
		expect(warning.hidden).toBe(false);
		expect(warning.textContent).toContain("different from every video linked in the note");

		enter(alternate);
		expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({
			videoId: "9bZkp7q19f0",
			origin: "entered",
		}));
	});

	it("reports an invalid entered URL without closing the modal", () => {
		const h = open();
		const alternate = h.modal.contentEl.querySelector<HTMLInputElement>('input[type="url"]')!;
		alternate.value = "https://example.com/video";
		enter(alternate);

		expect(h.resolve).not.toHaveBeenCalled();
		expect(h.modal.closed).toBe(false);
		expect(h.modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain("Enter a valid YouTube");
	});

	it("allows a URL-only note to submit with Enter", () => {
		const h = open([]);
		const input = h.modal.contentEl.querySelector<HTMLInputElement>('input[type="url"]')!;
		input.value = "https://youtu.be/dQw4w9WgXcQ";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const warning = h.modal.contentEl.querySelector<HTMLElement>('[role="status"]')!;
		expect(warning.hidden).toBe(true);
		expect(warning.textContent).toBe("");

		enter(input);

		expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ videoId: "dQw4w9WgXcQ" }));
		expect(h.modal.closed).toBe(true);
	});
});
