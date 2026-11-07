// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import "commons/testing";
import { TranscriptView, type TranscriptSearchSettings, type TranscriptViewHost } from "../../src/litNote/transcriptView";

const scopeHandlers = vi.hoisted(() => new Map<string, (event: KeyboardEvent) => unknown>());

vi.mock("obsidian", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	return {
		...original,
		setIcon: (): void => {},
		Scope: class {
			register(_modifiers: string[], key: string, callback: (event: KeyboardEvent) => unknown): void {
				scopeHandlers.set(key, callback);
			}
		},
		SearchComponent: class {
			inputEl: HTMLInputElement;
			constructor(parent: HTMLElement) { this.inputEl = parent.createEl("input"); }
			setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
			setValue(value: string): this { this.inputEl.value = value; return this; }
			getValue(): string { return this.inputEl.value; }
			onChange(callback: (value: string) => void): this {
				this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
				return this;
			}
		},
	};
});

let settings: TranscriptSearchSettings;
let play: ReturnType<typeof vi.fn<TranscriptViewHost["playAt"]>>;

beforeEach(() => {
	document.body.empty();
	settings = { keyboard: "obsidian", matching: "all-words", highlights: "always" };
	play = vi.fn();
	scopeHandlers.clear();
	HTMLElement.prototype.createDiv = function (opts) { return this.createEl("div", opts); };
	HTMLElement.prototype.toggleClass = function (cls, value) { this.classList.toggle(cls, value); };
	HTMLElement.prototype.isShown = function () {
		return !this.parentElement?.classList.contains("is-filtered") || this.classList.contains("is-match");
	};
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

async function panel(doc = document): Promise<TranscriptView> {
	const file = { path: "note.md", basename: "note", extension: "md" };
	const app = {
		vault: {
			getFileByPath: () => file,
			cachedRead: async () => "# Transcript\n[00:00](https://youtu.be/abc?t=0) start\n[00:01](https://youtu.be/abc?t=1) target first\n[00:02](https://youtu.be/abc?t=2) context\n[00:03](https://youtu.be/abc?t=3) target last\n",
		},
		metadataCache: {
			getFileCache: () => ({ headings: [{ heading: "Transcript", level: 1, position: { start: { offset: 0 }, end: { offset: 12 } } }] }),
		},
		workspace: { requestSaveLayout: vi.fn() },
	} as unknown as App;
	const view = new TranscriptView({ app } as unknown as WorkspaceLeaf, {
		getHeadingName: () => "Transcript",
		getSearchSettings: () => settings,
		playAt: play,
	});
	view.contentEl = doc.createElement("div");
	doc.body.appendChild(view.contentEl);
	await view.setState({ file: file.path }, { history: false });
	return view;
}

function search(view: TranscriptView, query = "target"): HTMLInputElement {
	const input = view.contentEl.querySelector("input")!;
	input.focus();
	input.value = query;
	input.dispatchEvent(new Event("input"));
	return input;
}

function key(el: HTMLElement, name: string, init: KeyboardEventInit = {}): void {
	el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
}

function rows(view: TranscriptView): HTMLElement[] {
	return Array.from(view.contentEl.querySelectorAll<HTMLElement>('[role="option"]'));
}

describe("accepting transcript search", () => {
	it.each(["Tab", "Escape"])("%s accepts without playback and restores adjacent nonmatches", async (acceptKey) => {
		const view = await panel();
		const input = search(view);
		view.contentEl.querySelector<HTMLElement>('button[aria-label="Show only matching lines"]')!.click();
		key(input, "Enter");
		key(input, acceptKey);
		expect(input.value).toBe("");
		expect(view.contentEl.querySelector(".is-filtered")).toBeNull();
		expect(document.activeElement).toBe(rows(view)[3]);
		key(rows(view)[3], "ArrowUp");
		expect(document.activeElement).toBe(rows(view)[2]);
		expect(play).not.toHaveBeenCalled();
	});

	it("offers a visible accept button", async () => {
		const view = await panel();
		search(view);
		const accept = view.contentEl.querySelector<HTMLElement>('button[aria-label="Accept match and browse transcript (Tab)"]');
		expect(accept).not.toBeNull();
		accept!.click();
		expect(document.activeElement).toBe(rows(view)[1]);
		expect(play).not.toHaveBeenCalled();
	});

	it("supports Emacs Enter acceptance, Escape and Ctrl+G cancellation", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		let input = search(view);
		key(input, "Enter");
		expect(document.activeElement).toBe(rows(view)[1]);
		input = search(view);
		key(input, "F3");
		key(input, "Escape");
		expect(document.activeElement).toBe(rows(view)[1]);
		input = search(view);
		key(input, "F3");
		key(input, "g", { ctrlKey: true });
		expect(document.activeElement).toBe(rows(view)[1]);
		expect(play).not.toHaveBeenCalled();
	});

	it("keeps Ctrl+Enter as play, not accept", async () => {
		const view = await panel();
		const input = search(view);
		key(input, "Enter", { ctrlKey: true });
		expect(play).toHaveBeenCalledOnce();
		expect(input.value).toBe("target");
	});

	it("plays only once when the view scope sees Ctrl+Enter before the input", async () => {
		const view = await panel();
		const input = search(view);
		const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
		scopeHandlers.get("Enter")!(event);
		input.dispatchEvent(event);
		expect(play).toHaveBeenCalledOnce();
	});

	it("reserves Ctrl+G cancellation in the view scope while searching", async () => {
		const view = await panel();
		const input = search(view);
		expect(scopeHandlers.has("G")).toBe(true);
		const event = new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true });
		expect(scopeHandlers.get("G")!(event)).toBe(false);
		input.dispatchEvent(event);
		expect(input.value).toBe("");
		expect(document.activeElement).toBe(rows(view)[0]);
		expect(play).not.toHaveBeenCalled();
	});

	it("cancelling restores the pre-search scroll position", async () => {
		const view = await panel();
		const box = view.contentEl;
		box.style.overflowY = "auto";
		Object.defineProperty(box, "scrollHeight", { value: 1000 });
		Object.defineProperty(box, "clientHeight", { value: 100 });
		box.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 }) as DOMRect;
		box.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
			if (typeof options === "object") box.scrollTop = options.top ?? 0;
		});
		box.scrollTop = 200;
		const input = search(view);
		expect(box.scrollTop).not.toBe(200);
		key(input, "g", { metaKey: true });
		expect(box.scrollTop).toBe(200);
		expect(input.value).toBe("");
		expect(document.activeElement).toBe(rows(view)[0]);
	});

	it("accepts in the owning pop-out document", async () => {
		const doc = document.implementation.createHTMLDocument();
		let active: Element | null = null;
		Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		for (const el of [view.contentEl.querySelector("input")!, ...rows(view)]) {
			el.focus = () => { active = el; };
		}
		const input = search(view);
		key(input, "Tab");
		expect(active).toBe(rows(view)[1]);
		expect(input.value).toBe("");
		expect(document.activeElement).toBe(document.body);
	});

	it("handles no matches without playing or leaving a filtered empty list", async () => {
		const view = await panel();
		const input = search(view, "missing");
		key(input, "Tab");
		expect(input.value).toBe("");
		expect(document.activeElement).toBe(rows(view)[0]);
		expect(play).not.toHaveBeenCalled();
	});
});

describe("transcript search settings", () => {
	it("supports literal phrases instead of all-words matching", async () => {
		settings.matching = "phrase";
		const view = await panel();
		const input = search(view, "first target");
		expect(view.contentEl.querySelectorAll(".is-match")).toHaveLength(0);
		input.value = "target first";
		input.dispatchEvent(new Event("input"));
		expect(view.contentEl.querySelectorAll(".is-match")).toHaveLength(1);
	});

	it.each(["off", "on-demand"] as const)("keeps only the current words highlighted in %s", async (mode) => {
		settings.highlights = mode;
		const view = await panel();
		const input = search(view);
		expect(rows(view)[1].querySelector(".suggestion-highlight")).not.toBeNull();
		expect(rows(view)[3].querySelector(".suggestion-highlight")).toBeNull();
		key(input, "Enter");
		expect(rows(view)[1].querySelector(".suggestion-highlight")).toBeNull();
		expect(rows(view)[3].querySelector(".suggestion-highlight")).not.toBeNull();
	});

	it("toggles on-demand highlights without changing playback or matches", async () => {
		settings.highlights = "on-demand";
		const view = await panel();
		search(view);
		const toggle = view.contentEl.querySelector<HTMLElement>('button[aria-label="Toggle other match highlights"]')!;
		expect(toggle).not.toBeNull();
		toggle.click();
		expect(rows(view)[3].querySelector(".suggestion-highlight")).not.toBeNull();
		toggle.click();
		expect(rows(view)[3].querySelector(".suggestion-highlight")).toBeNull();
		expect(view.contentEl.querySelectorAll(".is-match")).toHaveLength(2);
		expect(play).not.toHaveBeenCalled();
	});

	it("updates preferences in an open panel and preserves its query and selected match", async () => {
		const view = await panel();
		let input = search(view);
		key(input, "Enter");
		settings.keyboard = "emacs";
		settings.highlights = "off";
		view.refreshSearchSettings();
		input = view.contentEl.querySelector("input")!;
		expect(input.value).toBe("target");
		expect(rows(view)[3].classList.contains("is-search-current")).toBe(true);
		expect(rows(view)[1].querySelector(".suggestion-highlight")).toBeNull();
		expect(input.getAttribute("aria-label")).toContain("Enter or Tab: accept");
		key(input, "Enter");
		expect(document.activeElement).toBe(rows(view)[3]);
	});

	it("accepts a search after paragraph formatting without playing", async () => {
		const view = await panel();
		view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-controls button")!.click();
		const input = search(view);
		key(input, "Tab");
		expect(input.value).toBe("");
		expect(document.activeElement).toBe(rows(view)[0]);
		expect(play).not.toHaveBeenCalled();
	});
});
