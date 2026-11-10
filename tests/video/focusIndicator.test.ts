// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Plugin, type App, type WorkspaceLeaf } from "obsidian";
import { registerVideoNoteFocusIndicator } from "../../src/video/focusIndicator";

const windows = vi.hoisted(() => ({ setup: null as null | ((win: Window) => void | (() => void)) }));
vi.mock("commons/windows", () => ({
	forEachWindow: (_plugin: Plugin, setup: typeof windows.setup) => { windows.setup = setup; },
}));

const leaves: WorkspaceLeaf[] = [];
const events = new Map<string, () => void>();
class FocusPlugin extends Plugin {}
function plugin(): Plugin {
	return new FocusPlugin({
		workspace: {
			getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
			on: (name: string, callback: () => void) => { events.set(name, callback); },
		},
	} as unknown as App, { id: "test", name: "test", version: "1", minAppVersion: "1", author: "", description: "" });
}

function pane(doc: Document, type: string, file = "video-note.md") {
	const leaf = doc.createElement("div");
	leaf.className = "workspace-leaf";
	const content = leaf.appendChild(doc.createElement("div"));
	content.className = type;
	const control = content.appendChild(doc.createElement("button"));
	doc.body.appendChild(leaf);
	const viewType = type.startsWith("markdown-") ? "markdown" : type.replace(/-view$/, "");
	leaves.push({
		view: { containerEl: leaf, getViewType: () => viewType },
		getViewState: () => ({ state: { file } }),
	} as unknown as WorkspaceLeaf);
	leaf.isShown = () => !leaf.hidden;
	return { leaf, control };
}

describe("video note focus indication", () => {
	beforeEach(() => {
		document.body.replaceChildren();
		leaves.length = 0;
		events.clear();
	});

	it("does not mark an ordinary note or a video note without a visible player or transcript", () => {
		registerVideoNoteFocusIndicator(plugin(), () => true);
		const cleanup = windows.setup?.(window);
		const note = pane(document, "markdown-source-view");
		note.control.focus();
		expect(note.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
		if (typeof cleanup === "function") cleanup();
	});

	it.each([
		["perplexity-saver-video-view", "layout-change"],
		["perplexity-saver-transcript-view", "layout-change"],
		["perplexity-saver-video-view", "active-leaf-change"],
		["perplexity-saver-transcript-view", "active-leaf-change"],
	])(
		"marks only the associated note while %s is visible and refreshes on %s", (type, event) => {
			registerVideoNoteFocusIndicator(plugin(), () => true);
			const cleanup = windows.setup?.(window);
			const note = pane(document, "markdown-preview-view");
			const unrelated = pane(document, "markdown-source-view", "unrelated.md");
			const media = pane(document, type);
			unrelated.control.focus();
			expect(unrelated.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
			note.control.focus();
			expect(note.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
			vi.spyOn(document, "hasFocus").mockReturnValue(true);
			media.leaf.hidden = true;
			events.get(event)?.();
			expect(note.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
			media.leaf.hidden = false;
			events.get(event)?.();
			expect(note.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
			leaves.pop();
			media.leaf.remove();
			events.get(event)?.();
			expect(note.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
			if (typeof cleanup === "function") cleanup();
		}
	);

	it("follows focus between note, video controls and transcript, supports disabling and cleans up", () => {
		let enabled = true;
		const refresh = registerVideoNoteFocusIndicator(plugin(), () => enabled);
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
		registerVideoNoteFocusIndicator(plugin(), () => true);
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

	it("marks the literature note in a pop-out for a main-window player but not an unrelated note", () => {
		registerVideoNoteFocusIndicator(plugin(), () => true);
		const mainCleanup = windows.setup?.(window);
		const otherDocument = document.implementation.createHTMLDocument();
		const otherWindow = new EventTarget() as Window;
		Object.defineProperty(otherWindow, "document", { value: otherDocument });
		const otherCleanup = windows.setup?.(otherWindow);
		const video = pane(document, "perplexity-saver-video-view");
		const note = pane(otherDocument, "markdown-source-view");
		const unrelated = pane(otherDocument, "markdown-preview-view", "unrelated.md");
		video.control.focus();
		Object.defineProperty(otherDocument, "activeElement", { value: note.control, configurable: true });
		note.control.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(video.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(false);
		expect(note.leaf.classList.contains("perplexity-saver-focused-pane")).toBe(true);
		Object.defineProperty(otherDocument, "activeElement", { value: unrelated.control, configurable: true });
		unrelated.control.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(otherDocument.querySelector(".perplexity-saver-focused-pane")).toBeNull();
		if (typeof mainCleanup === "function") mainCleanup();
		if (typeof otherCleanup === "function") otherCleanup();
	});

	it("marks the player when focus enters its iframe instead of treating the parent blur as leaving the app", () => {
		registerVideoNoteFocusIndicator(plugin(), () => true);
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
