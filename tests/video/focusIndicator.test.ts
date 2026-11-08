// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "obsidian";
import { registerVideoNoteFocusIndicator } from "../../src/video/focusIndicator";

const windows = vi.hoisted(() => ({ setup: null as null | ((win: Window) => void | (() => void)) }));
vi.mock("commons/windows", () => ({
	forEachWindow: (_plugin: Plugin, setup: typeof windows.setup) => { windows.setup = setup; },
}));

function pane(doc: Document, type: string) {
	const leaf = doc.createElement("div");
	leaf.className = "workspace-leaf";
	const content = leaf.appendChild(doc.createElement("div"));
	content.className = type;
	const control = content.appendChild(doc.createElement("button"));
	doc.body.appendChild(leaf);
	return { leaf, control };
}

describe("video note focus indication", () => {
	beforeEach(() => { document.body.replaceChildren(); });

	it("follows focus between note, video controls and transcript, supports disabling and cleans up", () => {
		let enabled = true;
		const refresh = registerVideoNoteFocusIndicator({} as Plugin, () => enabled);
		const cleanup = windows.setup?.(window);
		const note = pane(document, "markdown-source-view");
		const video = pane(document, "perplexity-saver-video-view");
		const transcript = pane(document, "perplexity-saver-transcript-view");
		for (const current of [note, video, transcript]) {
			current.control.focus();
			expect(document.querySelectorAll(".perplexity-saver-focused-pane")).toHaveLength(1);
			expect(current.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
		}
		enabled = false;
		refresh();
		expect(document.querySelectorAll(".perplexity-saver-focused-pane")).toHaveLength(0);
		enabled = true;
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		refresh();
		expect(transcript.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
		if (typeof cleanup === "function") cleanup();
		expect(document.querySelectorAll(".perplexity-saver-focused-pane")).toHaveLength(0);
	});

	it("moves the single indicator to a pop-out document and clears it when that window loses focus", () => {
		registerVideoNoteFocusIndicator({} as Plugin, () => true);
		const mainCleanup = windows.setup?.(window);
		const otherDocument = document.implementation.createHTMLDocument();
		const otherWindow = new EventTarget() as Window;
		Object.defineProperty(otherWindow, "document", { value: otherDocument });
		const otherCleanup = windows.setup?.(otherWindow);
		const main = pane(document, "perplexity-saver-video-view");
		const other = pane(otherDocument, "perplexity-saver-transcript-view");
		main.control.focus();
		Object.defineProperty(otherDocument, "activeElement", { value: other.control, configurable: true });
		other.control.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(main.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
		expect(other.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
		main.control.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		expect(other.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
		otherWindow.dispatchEvent(new Event("blur"));
		expect(other.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
		if (typeof mainCleanup === "function") mainCleanup();
		if (typeof otherCleanup === "function") otherCleanup();
	});

	it("marks the player when focus enters its iframe instead of treating the parent blur as leaving the app", () => {
		registerVideoNoteFocusIndicator({} as Plugin, () => true);
		const cleanup = windows.setup?.(window);
		const note = pane(document, "markdown-source-view");
		const video = pane(document, "perplexity-saver-video-view");
		const frame = video.control.parentElement!.appendChild(document.createElement("iframe"));
		note.control.focus();
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		Object.defineProperty(document, "activeElement", { value: frame, configurable: true });
		window.dispatchEvent(new Event("blur"));
		expect(note.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
		expect(video.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		window.dispatchEvent(new Event("blur"));
		expect(video.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
		Reflect.deleteProperty(document, "activeElement");
		if (typeof cleanup === "function") cleanup();
	});
});
