// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorInfoField, Plugin, type App, type CachedMetadata, type TFile } from "obsidian";
import { footnoteNavigationHighlight, footnoteTargetForEvent, registerFootnoteNavigation } from "../../src/normalize/footnoteNavigation";

vi.mock("obsidian", async importOriginal => ({
	...await importOriginal<object>(),
	editorInfoField: (await import("@codemirror/state")).StateField.define({ create: () => null, update: value => value }),
}));

vi.mock("commons/windows", async importOriginal => ({
	...await importOriginal<object>(), onEachDocument: vi.fn(),
}));
import { onEachDocument } from "commons/windows";

const views: EditorView[] = [];
afterEach(() => {
	for (const view of views.splice(0)) view.destroy();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function fixture(popout = false, source = "[Title](https://example.com)") {
	const doc = popout ? document.implementation.createHTMLDocument("pop-out") : document;
	const host = doc.createElement("div");
	host.className = "markdown-source-view is-live-preview";
	doc.body.append(host);
	const text = `A cited fact.[^1_1]\n\n# Sources\n\n[^1_1]: ${source}`;
	const from = text.indexOf("[^1_1]");
	const definition = text.lastIndexOf("[^1_1]");
	const position = (offset: number, length: number) => ({
		start: { offset, line: text.slice(0, offset).split("\n").length - 1, col: 0 },
		end: { offset: offset + length, line: text.slice(0, offset).split("\n").length - 1, col: length },
	});
	const cache: CachedMetadata = {
		footnoteRefs: [{ id: "1_1", position: position(from, 6) }],
		footnotes: [{ id: "1_1", position: position(definition, text.length - definition) }],
	};
	const file = { path: "test.md" } as TFile;
	const app = Object.assign({} as App, { metadataCache: { getFileCache: vi.fn(() => cache) } });
	const view = new EditorView({
		parent: host,
		state: EditorState.create({
			doc: text,
			extensions: [
				footnoteNavigationHighlight,
				editorInfoField.init(() => ({ file, app, hoverPopover: null })),
				EditorView.decorations.of(Decoration.set([Decoration.mark({ class: "cm-footref" }).range(from, from + 6)])),
			],
		}),
	});
	views.push(view);
	const target = view.dom.querySelector(".cm-footref")!;
	const event = (init: MouseEventInit = {}) => {
		const evt = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true, ...init });
		Object.defineProperty(evt, "target", { value: target });
		return evt;
	};
	return { app, cache, view, target, event, definition, host, text };
}

describe("footnote definition navigation", () => {
	it.each([false, true])("resolves the clicked citation in its own editor/document (popout=%s)", popout => {
		const f = fixture(popout);
		vi.stubGlobal("activeDocument", document);
		vi.stubGlobal("activeWindow", window);
		vi.spyOn(f.target.ownerDocument, "activeElement", "get").mockReturnValue(f.view.contentDOM);
		expect(footnoteTargetForEvent(f.event({ ctrlKey: true }), f.app)).toEqual({ view: f.view, offset: f.definition });
	});

	it.each(["[Title](https://example.com)", "**[[Literature note|Title]]**", "**[Title](zotero://select/library/items/ABCD1234)**"])(
		"targets the definition, independent of its destination: %s", source => {
			const f = fixture(false, source);
			expect(footnoteTargetForEvent(f.event({ metaKey: true }), f.app)?.offset).toBe(f.definition);
		},
	);

	it("allows plain Live Preview navigation away from the editing line, preserving raw editing", () => {
		const f = fixture();
		f.view.dispatch({ selection: { anchor: f.definition } });
		expect(footnoteTargetForEvent(f.event(), f.app)?.offset).toBe(f.definition);
		f.view.dispatch({ selection: { anchor: 0 } });
		vi.spyOn(f.view, "hasFocus", "get").mockReturnValue(true);
		expect(footnoteTargetForEvent(f.event(), f.app)).toBeNull();
		expect(footnoteTargetForEvent(f.event({ ctrlKey: true }), f.app)?.offset).toBe(f.definition);
		f.host.classList.remove("is-live-preview");
		expect(footnoteTargetForEvent(f.event(), f.app)).toBeNull();
		expect(footnoteTargetForEvent(f.event({ ctrlKey: true }), f.app)?.offset).toBe(f.definition);
	});

	it("leaves other clicks, missing definitions and stale cache coordinates untouched", () => {
		const f = fixture();
		for (const init of [{ button: 1 }, { altKey: true }, { shiftKey: true }]) {
			expect(footnoteTargetForEvent(f.event({ ctrlKey: true, ...init }), f.app)).toBeNull();
		}
		const cancelled = f.event({ ctrlKey: true });
		cancelled.preventDefault();
		expect(footnoteTargetForEvent(cancelled, f.app)).toBeNull();
		f.cache.footnotes = [];
		expect(footnoteTargetForEvent(f.event({ ctrlKey: true }), f.app)).toBeNull();
		const g = fixture();
		g.view.dispatch({ changes: { from: 0, insert: "Shifted " } });
		expect(footnoteTargetForEvent(g.event({ ctrlKey: true }), g.app)).toBeNull();
		const h = fixture();
		h.target.classList.remove("cm-footref");
		expect(footnoteTargetForEvent(h.event({ ctrlKey: true }), h.app)).toBeNull();
	});

	it("registers capture handlers through commons and scrolls/focuses only on click", () => {
		const f = fixture(true);
		const plugin = Object.assign(Object.create(Plugin.prototype) as Plugin, { app: f.app });
		registerFootnoteNavigation(plugin);
		const registrations = vi.mocked(onEachDocument).mock.calls;
		expect(registrations.map(call => call[1])).toEqual(["mousedown", "mouseup", "click"]);
		expect(registrations.every(call => call[3] === true)).toBe(true);
		const focus = vi.spyOn(f.view, "focus").mockImplementation(() => {});
		for (const call of registrations) {
			const evt = f.event({ ctrlKey: true });
			const callback = call[2] as (event: MouseEvent) => void;
			callback(evt);
			expect(evt.defaultPrevented).toBe(true);
			if (call[1] !== "click") expect(focus).not.toHaveBeenCalled();
		}
		expect(f.view.state.selection.main.head).toBe(f.definition);
		expect(focus).toHaveBeenCalledOnce();
		expect(f.view.state.doc.toString()).toBe(f.text);
		expect(f.view.dom.querySelector(".perplexity-saver-footnote-target")?.textContent).toBe(f.text.slice(f.definition));
	});

	it("uses no bare main-window globals in the navigation implementation", () => {
		const code = readFileSync(resolve(__dirname, "../../src/normalize/footnoteNavigation.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
		expect(code).not.toMatch(/(?<![\w.$])(?:document|window|navigator|localStorage)\b/);
	});

	it.each([false, true])("clears the destination highlight after two seconds, restarting on another jump (popout=%s)", popout => {
		vi.useFakeTimers();
		vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
		const f = fixture(popout);
		if (popout) Object.defineProperty(f.target.ownerDocument, "defaultView", { value: window });
		const setTimer = vi.spyOn(f.view.dom.ownerDocument.defaultView!, "setTimeout");
		const clearTimer = vi.spyOn(f.view.dom.ownerDocument.defaultView!, "clearTimeout");
		const plugin = Object.assign(Object.create(Plugin.prototype) as Plugin, { app: f.app });
		registerFootnoteNavigation(plugin);
		const click = vi.mocked(onEachDocument).mock.calls.find(call => call[1] === "click")![2] as (event: MouseEvent) => void;
		vi.spyOn(f.view, "focus").mockImplementation(() => {});
		const highlighted = () => f.view.dom.querySelector(".perplexity-saver-footnote-target");
		click(f.event({ ctrlKey: true }));
		expect(highlighted()?.textContent).toBe(f.text.slice(f.definition));
		expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 2000);
		vi.advanceTimersByTime(1500);
		click(f.event({ ctrlKey: true }));
		expect(clearTimer).toHaveBeenCalled();
		vi.advanceTimersByTime(1500);
		expect(highlighted()).not.toBeNull();
		vi.advanceTimersByTime(500);
		expect(highlighted()).toBeNull();
		expect(f.view.state.doc.toString()).toBe(f.text);
	});

	it("removes highlights on edits and cancels pending cleanup when the editor closes", () => {
		vi.useFakeTimers();
		vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
		const f = fixture();
		const clearTimer = vi.spyOn(window, "clearTimeout");
		const plugin = Object.assign(Object.create(Plugin.prototype) as Plugin, { app: f.app });
		registerFootnoteNavigation(plugin);
		const click = vi.mocked(onEachDocument).mock.calls.find(call => call[1] === "click")![2] as (event: MouseEvent) => void;
		vi.spyOn(f.view, "focus").mockImplementation(() => {});
		click(f.event({ ctrlKey: true }));
		f.view.dispatch({ changes: { from: f.text.length, insert: " edited" } });
		expect(f.view.dom.querySelector(".perplexity-saver-footnote-target")).toBeNull();
		expect(clearTimer).toHaveBeenCalled();
		click(f.event({ ctrlKey: true }));
		clearTimer.mockClear();
		f.view.destroy();
		views.splice(views.indexOf(f.view), 1);
		expect(clearTimer).toHaveBeenCalled();
	});
});
