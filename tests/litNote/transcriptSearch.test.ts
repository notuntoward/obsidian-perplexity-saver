// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import "commons/testing";
import { dispatchSearchNavigation } from "commons/search";
import { transcriptSearchCommands, TranscriptView, type TranscriptSearchSettings, type TranscriptViewHost } from "../../src/litNote/transcriptView";

const scopeHandlers = vi.hoisted(() => new Map<string, (event: KeyboardEvent) => unknown>());
const menuChoices = vi.hoisted(() => [] as { title: string; checked: boolean; run?: () => void }[]);

vi.mock("obsidian", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	return {
		...original,
		setIcon: (el: HTMLElement, icon: string): void => { el.dataset.icon = icon; },
		Menu: class {
			addItem(build: (item: {
				setTitle(title: string): unknown;
				setChecked(checked: boolean): unknown;
				onClick(run: () => void): unknown;
			}) => void): this {
				const choice = { title: "", checked: false, run: undefined as (() => void) | undefined };
				const item = {
					setTitle(title: string) { choice.title = title; return item; },
					setChecked(checked: boolean) { choice.checked = checked; return item; },
					onClick(run: () => void) { choice.run = run; return item; },
				};
				build(item);
				menuChoices.push(choice);
				return this;
			}
			addSeparator(): this { return this; }
			showAtPosition(): void {}
		},
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
	menuChoices.length = 0;
	HTMLElement.prototype.createDiv = function (opts) { return this.createEl("div", opts); };
	HTMLElement.prototype.toggleClass = function (cls, value) { this.classList.toggle(cls, value); };
	HTMLElement.prototype.isShown = function () {
		return !this.parentElement?.classList.contains("is-filtered") || this.classList.contains("is-match");
	};
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => vi.unstubAllGlobals());

function stubPopout(doc: Document): void {
	Object.defineProperty(doc, "activeElement", { configurable: true, value: doc.body });
	const win = Object.create(window) as Window;
	Object.defineProperty(win, "document", { value: doc });
	vi.stubGlobal("activeDocument", doc);
	vi.stubGlobal("activeWindow", win);
}

async function panel(doc = document, host: Partial<TranscriptViewHost> = {}): Promise<TranscriptView> {
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
		hotkeyManager: {
			printHotkeyForCommand: (id: string) => id === "perplexity-saver:transcript-search-forward" ? "Ctrl + S"
				: id === "perplexity-saver:transcript-search-backward" ? "Ctrl + R" : "",
		},
	} as unknown as App;
	const view = new TranscriptView({ app } as unknown as WorkspaceLeaf, {
		getHeadingName: () => "Transcript",
		getSearchSettings: () => settings,
		playAt: play,
		...host,
	});
	view.contentEl = doc.createElement("div");
	doc.body.appendChild(view.contentEl);
	await view.setState({ file: file.path }, { history: false });
	return view;
}

function search(view: TranscriptView, query = "target"): HTMLInputElement {
	const input = view.contentEl.querySelector("input")!;
	view.focusSearch();
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

describe("transcript-only playback controls", () => {
	it.each([false, true])("shows controls only without a visible matching player (%s)", async (visible) => {
		const runPlaybackControl = vi.fn();
		const view = await panel(document, { isVideoVisible: () => visible, runPlaybackControl } as Partial<TranscriptViewHost>);
		const bar = view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-playback")!;
		expect(bar.parentElement).toBe(view.contentEl.querySelector(".perplexity-saver-transcript-controls"));
		expect(bar.hidden).toBe(visible);
		for (const [label, action] of [["Play", "play"], ["Previous transcript row", "previous"], ["Next transcript row", "next"], ["Insert current timestamp", "insert"]]) {
			bar.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!.click();
			if (visible) expect(runPlaybackControl).not.toHaveBeenCalled();
			else expect(runPlaybackControl).toHaveBeenLastCalledWith("note.md", action);
		}
	});

	it.each([false, true])("refreshes play state for updates in the same row (popout=%s)", async (popout) => {
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		let playing = false;
		const view = await panel(doc, {
			isVideoVisible: () => false,
			isPlaybackPlaying: () => playing,
			runPlaybackControl: vi.fn(),
		} as Partial<TranscriptViewHost>);
		const button = view.contentEl.querySelector<HTMLElement>('.perplexity-saver-transcript-playback button')!;
		expect(button.ownerDocument).toBe(doc);
		expect(button.getAttribute("aria-label")).toBe("Play");
		expect(button.dataset.icon).toBe("play");
		view.showPlayback(1.1);
		playing = true;
		view.showPlayback(1.2);
		expect(button.getAttribute("aria-label")).toBe("Pause");
		expect(button.dataset.icon).toBe("pause");
		playing = false;
		view.showPlayback(1.3);
		expect(button.getAttribute("aria-label")).toBe("Play");
		expect(button.dataset.icon).toBe("play");
	});

	it.each([[false, false], [false, true], [true, false], [true, true]] as const)("skips workspace lookups for unchanged playback state (popout=%s, player visible=%s)", async (popout, visible) => {
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		if (popout) stubPopout(doc);
		let playing = false;
		const isVideoVisible = vi.fn(() => visible);
		const isPlaybackPlaying = vi.fn(() => playing);
		const view = await panel(doc, { isVideoVisible, isPlaybackPlaying, runPlaybackControl: vi.fn() });
		isVideoVisible.mockClear();
		isPlaybackPlaying.mockClear();
		view.showPlayback(1.1, true, false);
		view.showPlayback(1.2, true, false);
		expect(isVideoVisible).not.toHaveBeenCalled();
		expect(isPlaybackPlaying).not.toHaveBeenCalled();
		expect(rows(view)[1].classList.contains("is-playing")).toBe(true);
		playing = true;
		view.showPlayback(1.3, true, true);
		expect(isVideoVisible).toHaveBeenCalledOnce();
		expect(isPlaybackPlaying).toHaveBeenCalledOnce();
		expect(view.contentEl.querySelector('[data-icon="pause"]')).not.toBeNull();
	});

	it.each([false, true])("refreshes on an active-leaf change (popout=%s)", async (popout) => {
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		if (popout) stubPopout(doc);
		let playing = false;
		const view = await panel(doc, { isVideoVisible: () => false, isPlaybackPlaying: () => playing, runPlaybackControl: vi.fn() });
		const handlers = new Map<string, () => void>();
		Object.assign(view.app.workspace, { on: (name: string, handler: () => void) => { handlers.set(name, handler); return {}; } });
		Object.assign(view.app.metadataCache, { on: vi.fn(() => ({})) });
		Object.assign(view.app.vault, { on: vi.fn(() => ({})) });
		Object.assign(view, { registerDomEvent: vi.fn() });
		await view.onOpen();
		playing = true;
		expect(handlers.get("active-leaf-change")).toBeTypeOf("function");
		handlers.get("active-leaf-change")!();
		expect(view.contentEl.querySelector('[data-icon="pause"]')).not.toBeNull();
	});

	it("notifies other transcript panels when background audio's note is renamed", async () => {
		const changed = vi.fn();
		const view = await panel(document, { isVideoVisible: () => false, isPlaybackPlaying: () => true, onPlaybackSessionChanged: changed });
		const vaultEvents = new Map<string, (file: { path: string }, oldPath: string) => void>();
		Object.assign(view.app.workspace, { on: vi.fn(() => ({})) });
		Object.assign(view.app.metadataCache, { on: vi.fn(() => ({})) });
		Object.assign(view.app.vault, { on: (name: string, handler: (file: { path: string }, oldPath: string) => void) => { vaultEvents.set(name, handler); return {}; } });
		Object.assign(view, { registerDomEvent: vi.fn() });
		await view.onOpen();
		let filePath = "note.md";
		const playback = {
			getFilePath: () => filePath,
			getVideoId: () => "dQw4w9WgXcQ",
			renameFile: (path: string) => { filePath = path; },
			destroy: vi.fn(),
		} as unknown as Parameters<TranscriptView["setBackgroundPlayback"]>[0];
		view.setBackgroundPlayback(playback);
		changed.mockClear();
		vaultEvents.get("rename")!({ path: "renamed.md" }, "note.md");
		expect(changed).toHaveBeenCalledWith("renamed.md", "dQw4w9WgXcQ");
	});

	it("renders controls in the transcript owner document", async () => {
		const doc = document.implementation.createHTMLDocument();
		const runPlaybackControl = vi.fn();
		const view = await panel(doc, { isVideoVisible: () => false, runPlaybackControl } as Partial<TranscriptViewHost>);
		const button = view.contentEl.querySelector<HTMLElement>('button[aria-label="Play"]')!;
		expect(button.ownerDocument).toBe(doc);
		button.click();
		expect(runPlaybackControl).toHaveBeenCalledWith("note.md", "play");
	});
});

describe("accepting transcript search", () => {
	it("exposes the same orientation toggle in the labeled Layout menu", async () => {
		const toggleOrientation = vi.fn(async () => {});
		const view = await panel(document, { movePanel: vi.fn(async () => {}), toggleOrientation });
		view.contentEl.querySelector<HTMLElement>('button[aria-label="Transcript layout"]')!.click();
		expect(menuChoices.map((item) => item.title)).toEqual([
			"Show pane tabs and navigation",
			"Toggle transcript below / beside video",
		]);
		menuChoices[1].run!();
		expect(toggleOrientation).toHaveBeenCalledWith("note.md");
	});

	it("restores native pane chrome from the layout menu and closes using the host", async () => {
		const closePanel = vi.fn(async () => {});
		const view = await panel(document, { toggleOrientation: vi.fn(async () => {}), closePanel });
		const layout = view.contentEl.querySelector<HTMLElement>('button[aria-label="Transcript layout"]')!;
		expect(layout.textContent).toContain("Layout");
		layout.click();
		const choice = menuChoices.find((item) => item.title === "Show pane tabs and navigation")!;
		expect(choice.checked).toBe(false);
		choice.run!();
		expect(view.contentEl.hasClass("show-pane-chrome")).toBe(true);
		view.refreshSearchSettings();
		expect(view.contentEl.hasClass("show-pane-chrome")).toBe(true);
		menuChoices.length = 0;
		view.contentEl.querySelector<HTMLElement>('button[aria-label="Transcript layout"]')!.click();
		expect(menuChoices[0].checked).toBe(true);
		menuChoices[0].run!();
		expect(view.contentEl.hasClass("show-pane-chrome")).toBe(false);
		view.contentEl.querySelector<HTMLElement>('button[aria-label="Close transcript pane"]')!.click();
		expect(closePanel).toHaveBeenCalledWith(view.leaf);
	});

	it("keeps search and help out of the browsing layout and reveals search on demand", async () => {
		const view = await panel();
		const bar = view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-search")!;
		expect(bar.hidden).toBe(true);
		view.focusSearch();
		expect(bar.hidden).toBe(false);
		key(search(view), "Tab");
		expect(bar.hidden).toBe(true);
		expect(document.activeElement).toBe(rows(view)[1]);
		expect(view.contentEl.classList.contains("show-help")).toBe(false);
		view.contentEl.querySelector<HTMLElement>('button[aria-label="Transcript keyboard help"]')!.click();
		expect(view.contentEl.classList.contains("show-help")).toBe(true);
	});

	it("cancels search on leaving the panel without stealing the new focus, retaining recall", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		search(view);
		const outside = document.body.createEl("button");
		outside.focus();
		await Promise.resolve();
		expect(document.activeElement).toBe(outside);
		expect(view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-search")!.hidden).toBe(true);
		expect(view.contentEl.querySelector("input")!.value).toBe("");
		expect(rows(view).some((row) => row.classList.contains("is-search-current"))).toBe(false);
		view.focusSearch();
		dispatchSearchNavigation(view.contentEl.querySelector("input"), "forward", false);
		expect(view.contentEl.querySelector("input")!.value).toBe("target");
	});

	it("keeps search open while clicking its controls or browsing filtered rows", async () => {
		const view = await panel();
		search(view);
		const filter = view.contentEl.querySelector<HTMLElement>('button[aria-label="Show only matching lines"]')!;
		filter.focus();
		filter.click();
		rows(view)[1].focus();
		await Promise.resolve();
		expect(view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-search")!.hidden).toBe(false);
		expect(view.contentEl.querySelector("input")!.value).toBe("target");
	});

	it("dismisses pop-out search using its own document without focusing either window", async () => {
		const doc = document.implementation.createHTMLDocument();
		let active: Element | null = null;
		Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		const input = view.contentEl.querySelector("input")!;
		input.focus = () => { active = input; };
		rows(view)[0].focus = vi.fn();
		search(view);
		active = doc.body.createEl("button");
		input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: active }));
		await Promise.resolve();
		expect(doc.activeElement).toBe(active);
		expect(view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-search")!.hidden).toBe(true);
		expect(input.value).toBe("");
		expect(rows(view)[0].focus).not.toHaveBeenCalled();
	});

	it("keeps search visibility through rerenders and cleans up window listeners on close", async () => {
		const remove = vi.spyOn(window, "removeEventListener");
		const view = await panel();
		search(view);
		view.refreshSearchSettings();
		expect(view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-search")!.hidden).toBe(false);
		key(view.contentEl.querySelector("input")!, "Tab");
		view.refreshSearchSettings();
		expect(view.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-search")!.hidden).toBe(true);
		await view.onClose();
		expect(remove).toHaveBeenCalledWith("blur", expect.any(Function));
	});

	it.each([false, true])("recalls accepted or cancelled Emacs queries only on repeat, in either direction (popout=%s)", async (popout) => {
		settings.keyboard = "emacs";
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		let active: Element | null = null;
		if (popout) Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		const input = view.contentEl.querySelector("input")!;
		if (popout) for (const el of [input, ...rows(view)]) el.focus = () => {
			active = el;
			el.dispatchEvent(new FocusEvent("focus"));
			el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		};
		Object.assign(view.app.workspace, { getLeavesOfType: () => [{ view }] });
		const commands = transcriptSearchCommands(view.app);
		for (const exit of ["Enter", "Escape", "Tab", "g"]) {
			for (const native of [true, false]) {
				for (const direction of ["forward", "backward"] as const) {
					rows(view)[2].focus();
					search(view);
					key(input, exit, exit === "g" ? { ctrlKey: true } : {});
					const origin = exit === "Escape" || exit === "g" ? 2 : 1;
					expect(doc.activeElement).toBe(rows(view)[origin]);
					const invoke = (checking: boolean): boolean => native
						? commands[direction === "forward" ? 0 : 1].checkCallback!(checking) === true
						: dispatchSearchNavigation(doc.activeElement, direction, checking);
					expect(invoke(false)).toBe(true);
					expect(doc.activeElement).toBe(input);
					expect(input.value).toBe("");
					expect(invoke(true)).toBe(true);
					expect(input.value).toBe("");
					expect(invoke(false)).toBe(true);
					expect(input.value).toBe("target");
					const next = direction === "forward" || origin === 1 ? 3 : 1;
					expect(rows(view)[next].classList.contains("is-search-current")).toBe(true);
					expect(doc.activeElement).toBe(input);
					expect(input.selectionStart).toBe(input.value.length);
					expect(invoke(false)).toBe(true);
					expect(rows(view)[next === 3 ? 1 : 3].classList.contains("is-search-current")).toBe(true);
					key(input, "Escape");
				}
			}
		}
		expect(play).not.toHaveBeenCalled();
	});

	it("does not replace typed text or recall history in Obsidian mode", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		const input = search(view);
		key(input, "Enter");
		view.focusSearch();
		search(view, "context");
		dispatchSearchNavigation(input, "forward", false);
		expect(input.value).toBe("context");
		key(input, "Escape");
		settings.keyboard = "obsidian";
		view.focusSearch();
		dispatchSearchNavigation(input, "backward", false);
		expect(input.value).toBe("");
		expect(play).not.toHaveBeenCalled();
	});

	it("preserves history across empty cancellation and rerender, uses the repeat direction and wraps", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		let input = search(view);
		key(input, "F3");
		key(input, "Enter");
		expect(document.activeElement).toBe(rows(view)[3]);
		dispatchSearchNavigation(document.activeElement, "backward", false);
		key(input, "Escape");
		view.refreshSearchSettings();
		input = view.contentEl.querySelector("input")!;
		dispatchSearchNavigation(document.activeElement, "backward", false);
		expect(input.value).toBe("");
		dispatchSearchNavigation(input, "forward", false);
		expect(input.value).toBe("target");
		expect(rows(view)[1].classList.contains("is-search-current")).toBe(true);
		expect(play).not.toHaveBeenCalled();
	});

	it.each([false, true])("Ctrl+Home/End focus the first/last timestamp from rows and controls without playback (popout=%s)", async (popout) => {
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		let active: Element | null = null;
		if (popout) Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		const input = view.contentEl.querySelector("input")!;
		const button = view.contentEl.querySelector("button")!;
		if (popout) for (const el of [input, button, ...rows(view)]) el.focus = () => {
			active = el;
			el.dispatchEvent(new FocusEvent("focus"));
			el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		};
		for (const source of [rows(view)[2], input, button]) {
			for (const name of ["Home", "End"]) {
				if (source === input) view.focusSearch();
				else source.focus();
				const event = new KeyboardEvent("keydown", { key: name, ctrlKey: true, bubbles: true, cancelable: true });
				source.dispatchEvent(event);
				expect(event.defaultPrevented).toBe(true);
				expect(doc.activeElement).toBe(rows(view)[name === "Home" ? 0 : 3]);
			}
		}
		rows(view)[2].focus();
		key(rows(view)[2], "Home", { ctrlKey: true, shiftKey: true });
		expect(doc.activeElement).toBe(rows(view)[2]);
		expect(play).not.toHaveBeenCalled();
	});

	it("reserves Ctrl+Home/End in the native scope, handles each event once and respects filtered rows", async () => {
		const view = await panel();
		const input = search(view);
		view.contentEl.querySelector<HTMLElement>('button[aria-label="Show only matching lines"]')!.click();
		for (const name of ["End", "Home"]) {
			const event = new KeyboardEvent("keydown", { key: name, ctrlKey: true, bubbles: true, cancelable: true });
			expect(scopeHandlers.get(name)?.(event)).toBe(false);
			input.dispatchEvent(event);
			expect(document.activeElement).toBe(rows(view)[name === "Home" ? 1 : 3]);
		}
		expect(play).not.toHaveBeenCalled();
	});

	it.each([false, true])("explicit activation selects and scrolls the current chunk, even after searching (popout=%s)", async (popout) => {
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		let active: Element | null = null;
		if (popout) Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		if (popout) for (const el of [view.contentEl.querySelector("input")!, ...rows(view)]) el.focus = () => { active = el; };
		const input = search(view);
		view.showPlayback(2.5);
		view["focusPlayback"](2.5);
		expect(doc.activeElement).toBe(rows(view)[2]);
		expect(rows(view)[2].classList.contains("is-playing")).toBe(true);
		expect(input.value).toBe("");
		expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
		key(rows(view)[2], "ArrowUp");
		expect(doc.activeElement).toBe(rows(view)[1]);
		expect(play).not.toHaveBeenCalled();
	});

	it.each([false, true])("provides standalone native transcript commands with no Incremental Search installed (popout=%s)", async (popout) => {
		settings.keyboard = "emacs";
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		let active: Element | null = null;
		if (popout) Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		const input = view.contentEl.querySelector("input")!;
		if (popout) {
			input.focus = () => { active = input; };
			for (const row of rows(view)) row.focus = () => { active = row; };
		}
		Object.assign(view.app.workspace, { getLeavesOfType: () => [{ view }] });
		const commands = transcriptSearchCommands(view.app);
		expect(commands.map((command) => command.name)).toEqual([
			"Transcript search: Forward Emacs", "Transcript search: Reverse Emacs",
		]);
		expect(commands.every((command) => command.hotkeys === undefined)).toBe(true);
		search(view);
		expect(commands[0].checkCallback!(true)).toBe(true);
		expect(rows(view)[1].classList.contains("is-search-current")).toBe(true);
		expect(commands[0].checkCallback!(false)).toBe(true);
		expect(rows(view)[3].classList.contains("is-search-current")).toBe(true);
		expect(commands[1].checkCallback!(false)).toBe(true);
		expect(rows(view)[1].classList.contains("is-search-current")).toBe(true);
		expect(doc.activeElement).toBe(input);
		expect(play).not.toHaveBeenCalled();
		key(input, "Tab");
		expect(commands[0].checkCallback!(true)).toBe(true);
	});

	it.each([false, true])("starts transcript search from a row before advancing, with either command owner (popout=%s)", async (popout) => {
		settings.keyboard = "emacs";
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		let active: Element | null = null;
		if (popout) Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		const input = view.contentEl.querySelector("input")!;
		if (popout) {
			for (const el of [input, ...rows(view)]) el.focus = () => { active = el; };
		}
		Object.assign(view.app.workspace, { getLeavesOfType: () => [{ view }] });
		const commands = transcriptSearchCommands(view.app);
		for (const native of [true, false]) {
			for (const direction of ["forward", "backward"] as const) {
				const command = (checking: boolean): boolean => native
					? commands[direction === "forward" ? 0 : 1].checkCallback!(checking) === true
					: dispatchSearchNavigation(doc.activeElement, direction, checking);
				input.value = "";
				input.dispatchEvent(new Event("input"));
				rows(view)[2].focus();
				expect(command(true)).toBe(true);
				expect(doc.activeElement).toBe(rows(view)[2]);
				expect(command(false)).toBe(true);
				expect(doc.activeElement).toBe(input);
				expect(input.value).toBe("");
				search(view);
				expect(command(false)).toBe(true);
				expect(rows(view)[3].classList.contains("is-search-current")).toBe(true);
				expect(doc.activeElement).toBe(input);
			}
		}
		const outside = doc.body.createEl("input");
		if (popout) outside.focus = () => { active = outside; };
		outside.focus();
		expect(commands[0].checkCallback!(true)).toBe(false);
		expect(dispatchSearchNavigation(outside, "forward", true)).toBe(false);
		expect(play).not.toHaveBeenCalled();
	});

	it.each(["emacs", "obsidian"] as const)("advances with the shared commands without exiting or playing (%s)", async (keyboard) => {
		settings.keyboard = keyboard;
		const view = await panel();
		const input = search(view);
		expect(dispatchSearchNavigation(input, "forward", true)).toBe(true);
		expect(rows(view)[1].classList.contains("is-search-current")).toBe(true);
		expect(dispatchSearchNavigation(input, "forward", false)).toBe(true);
		expect(rows(view)[3].classList.contains("is-search-current")).toBe(true);
		expect(dispatchSearchNavigation(input, "backward", false)).toBe(true);
		expect(rows(view)[1].classList.contains("is-search-current")).toBe(true);
		expect(input.value).toBe("target");
		expect(document.activeElement).toBe(input);
		expect(play).not.toHaveBeenCalled();
	});

	it("shows the existing command bindings in Emacs navigation hints", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		const input = search(view);
		const hints = view.contentEl.querySelector(".is-search")!;
		expect(hints.textContent).toContain("Ctrl + S next match");
		expect(hints.textContent).toContain("Ctrl + R previous");
		expect(hints.textContent).not.toContain("F3");
		key(input, "s", { ctrlKey: true });
		expect(rows(view)[1].classList.contains("is-search-current")).toBe(true);
	});

	it("uses native shortcut dispatch exactly once and follows rebinding without a second keymap", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		const input = search(view);
		let forwardKey = "s";
		Object.assign(view.app.workspace, { getLeavesOfType: () => [{ view }] });
		const commands = transcriptSearchCommands(view.app);
		const nativeCommandDispatcher = (event: KeyboardEvent): void => {
			const direction = event.ctrlKey && event.key === forwardKey ? "forward"
				: event.ctrlKey && event.key === "r" ? "backward" : null;
			if (direction && commands[direction === "forward" ? 0 : 1].checkCallback!(false)) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		input.ownerDocument.addEventListener("keydown", nativeCommandDispatcher, true);
		try {
			key(input, "s", { ctrlKey: true });
			expect(view.contentEl.querySelector(".perplexity-saver-transcript-matches")?.textContent).toBe("2/2");
			key(input, "r", { ctrlKey: true });
			expect(view.contentEl.querySelector(".perplexity-saver-transcript-matches")?.textContent).toBe("1/2");
			forwardKey = "n";
			key(input, "s", { ctrlKey: true });
			expect(view.contentEl.querySelector(".perplexity-saver-transcript-matches")?.textContent).toBe("1/2");
			key(input, "n", { ctrlKey: true });
			expect(view.contentEl.querySelector(".perplexity-saver-transcript-matches")?.textContent).toBe("2/2");
			expect(document.activeElement).toBe(input);
			expect(input.value).toBe("target");
			expect(play).not.toHaveBeenCalled();
		} finally {
			input.ownerDocument.removeEventListener("keydown", nativeCommandDispatcher, true);
		}
	});

	it("refreshes rebound and unassigned navigation hints on focus", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		search(view);
		Object.assign(view.app, { hotkeyManager: { printHotkeyForCommand: () => "Alt + N" } });
		rows(view)[0].focus();
		view.focusSearch();
		expect(view.contentEl.querySelector(".is-search")?.textContent).toContain("Alt + N next match");
		expect(view.contentEl.querySelector('button[aria-label="Next match (Alt + N)"]')).not.toBeNull();
		Object.assign(view.app, { hotkeyManager: { printHotkeyForCommand: () => "" } });
		rows(view)[0].focus();
		view.focusSearch();
		expect(view.contentEl.querySelector(".is-search")?.textContent).toContain("Unassigned next match");
		expect(view.contentEl.querySelector(".is-search .is-disabled")).not.toBeNull();
	});

	it("shows optional Incremental Search bindings when Saver commands are unassigned", async () => {
		settings.keyboard = "emacs";
		const view = await panel();
		Object.assign(view.app, { hotkeyManager: {
			printHotkeyForCommand: (id: string) => id === "incremental-search:forward" ? "Ctrl + S"
				: id === "incremental-search:backward" ? "Ctrl + R" : "",
		} });
		search(view);
		expect(view.contentEl.querySelector(".is-search")?.textContent).toContain("Ctrl + S next match");
		expect(view.contentEl.querySelector(".is-search")?.textContent).toContain("Ctrl + R previous");
		expect(view.contentEl.querySelector(".is-search .is-disabled")).toBeNull();
	});

	it("removes command receivers on rerender and close", async () => {
		const view = await panel();
		const old = search(view);
		view.refreshSearchSettings();
		expect(dispatchSearchNavigation(old, "forward", false)).toBe(false);
		const input = search(view);
		expect(dispatchSearchNavigation(input, "forward", false)).toBe(true);
		await view.onClose();
		expect(dispatchSearchNavigation(input, "forward", false)).toBe(false);
	});

	it("routes shared navigation in a pop-out and starts searching again after acceptance", async () => {
		const doc = document.implementation.createHTMLDocument();
		let active: Element | null = null;
		Object.defineProperty(doc, "activeElement", { get: () => active });
		const view = await panel(doc);
		for (const el of [view.contentEl.querySelector("input")!, ...rows(view)]) el.focus = () => { active = el; };
		const input = search(view);
		expect(dispatchSearchNavigation(active, "forward", false)).toBe(true);
		expect(rows(view)[3].classList.contains("is-search-current")).toBe(true);
		key(input, "Tab");
		expect(active).toBe(rows(view)[3]);
		expect(dispatchSearchNavigation(active, "forward", false)).toBe(true);
		expect(active).toBe(input);
		expect(play).not.toHaveBeenCalled();
	});

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

	it("moves the focused transcript row with Ctrl+N and Ctrl+P without playback", async () => {
		const view = await panel();
		const input = view.contentEl.querySelector("input")!;
		input.focus();
		expect(scopeHandlers.get("N")!(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }))).toBe(true);
		rows(view)[1].focus();
		const down = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true, cancelable: true });
		expect(scopeHandlers.get("N")!(down)).toBe(false);
		rows(view)[1].dispatchEvent(down);
		expect(document.activeElement).toBe(rows(view)[2]);
		const up = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true });
		expect(scopeHandlers.get("P")!(up)).toBe(false);
		rows(view)[2].dispatchEvent(up);
		expect(document.activeElement).toBe(rows(view)[1]);
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
