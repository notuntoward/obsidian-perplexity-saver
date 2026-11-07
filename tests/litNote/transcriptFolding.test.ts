// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plugin, type App, type HeadingCache, type MarkdownView, type TFile } from "obsidian";
import { registerTranscriptFolding } from "../../src/litNote/transcriptFolding";
import { foldHeadingInView } from "commons/workspace";

vi.mock("commons/workspace", async (original) => ({
	...await original<Record<string, unknown>>(),
	foldHeadingInView: vi.fn(() => "folded"),
}));

describe("transcript folding on note opening", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(foldHeadingInView).mockReset().mockReturnValue("folded");
	});
	afterEach(() => vi.useRealTimers());

	function setup(secondDocument = false, initiallyActive = true) {
		const doc = secondDocument ? document.implementation.createHTMLDocument() : document;
		const win = { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) };
		if (secondDocument) Object.defineProperty(doc, "defaultView", { value: win });
		const file = { path: "video.md" } as TFile;
		let content = "# Summary\nNotes\n# Transcript\nlong transcript\n## Child\nmore\n# Backlinks\nlink";
		const headings: HeadingCache[] = [
			{ heading: "Summary", level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 9, offset: 9 } } },
			{ heading: "Transcript", level: 1, position: { start: { line: 2, col: 0, offset: 16 }, end: { line: 2, col: 12, offset: 28 } } },
			{ heading: "Child", level: 2, position: { start: { line: 4, col: 0, offset: 45 }, end: { line: 4, col: 8, offset: 53 } } },
			{ heading: "Backlinks", level: 1, position: { start: { line: 6, col: 0, offset: 59 }, end: { line: 6, col: 11, offset: 70 } } },
		];
		const editor = {};
		const view = {
			file, editor, containerEl: doc.createElement("div"), getViewData: () => content,
		} as unknown as MarkdownView;
		doc.body.append(view.containerEl);
		const callbacks = new Map<string, (...args: unknown[]) => void>();
		const on = (name: string, callback: (...args: unknown[]) => void) => { callbacks.set(name, callback); };
		const getFileCache = vi.fn<() => { headings: HeadingCache[] } | null>(() => ({ headings }));
		let active: MarkdownView | null = initiallyActive ? view : null;
		const app = {
			workspace: { on, onLayoutReady: (fn: () => void) => fn(), getActiveViewOfType: () => active },
			metadataCache: { on, getFileCache },
		} as unknown as App;
		const plugin = new class extends Plugin {}(app, { id: "test", name: "Test", version: "1", minAppVersion: "1.14.0", author: "", description: "" });
		const cleanup = vi.spyOn(plugin, "register");
		const settings = { collapseTranscriptOnOpen: true, transcriptHeading: "Transcript" };
		const opened = registerTranscriptFolding(plugin, () => settings);
		return {
			view, file, settings, headings, getFileCache, cleanup, opened,
			emit: (name: string, ...args: unknown[]) => callbacks.get(name)?.(...args),
			setContent: (text: string) => { content = text; },
			setActive: (next: MarkdownView | null) => { active = next; },
		};
	}

	it.each([false, true])("folds once per opening in the owning document (pop-out: %s)", (secondDocument) => {
		const h = setup(secondDocument);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledWith(h.view, 2, 5);
		h.emit("layout-change");
		h.emit("changed", h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledTimes(1);
		h.emit("file-open", h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledTimes(2);
	});

	it("does nothing when disabled or the note has no transcript", () => {
		const h = setup();
		h.settings.collapseTranscriptOnOpen = false;
		vi.runAllTimers();
		expect(foldHeadingInView).not.toHaveBeenCalled();
		h.settings.collapseTranscriptOnOpen = true;
		h.headings.splice(1, 1);
		h.emit("file-open", h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).not.toHaveBeenCalled();
	});

	it("waits for metadata and native rendering, without folding after a user edit", () => {
		const h = setup();
		h.getFileCache.mockReturnValueOnce(null);
		vi.runAllTimers();
		expect(foldHeadingInView).not.toHaveBeenCalled();
		vi.mocked(foldHeadingInView).mockReturnValueOnce("not-ready");
		h.emit("changed", h.file);
		vi.runAllTimers();
		h.emit("layout-change");
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledTimes(2);
		h.emit("file-open", h.file);
		h.setContent("# Summary\nUser edit");
		h.view.containerEl.dispatchEvent(new Event("beforeinput", { bubbles: true }));
		h.emit("editor-change", h.view.editor, h.view);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledTimes(2);
	});

	it("supports a custom heading and the legacy default fallback", () => {
		const h = setup();
		h.settings.transcriptHeading = "## Captions";
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledWith(h.view, 2, 5);
		h.headings[1].heading = "Captions";
		h.headings[1].position.end.offset = 26;
		h.setContent("# Summary\nNotes\n# Captions\nlong transcript\n## Child\nmore\n# Backlinks\nlink");
		h.emit("file-open", h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledTimes(2);
	});

	it("does not fold a view that has since opened another file", () => {
		const h = setup();
		h.view.file = { path: "other.md" } as TFile;
		vi.runAllTimers();
		expect(foldHeadingInView).not.toHaveBeenCalled();
	});

	it("cancels owner-window timers on unload", () => {
		const h = setup(true);
		h.cleanup.mock.calls[0][0]();
		vi.runAllTimers();
		expect(foldHeadingInView).not.toHaveBeenCalled();
	});

	it("waits for a freshly written transcript to reach the metadata cache", () => {
		const h = setup();
		h.getFileCache.mockReturnValueOnce({ headings: [h.headings[0]] });
		vi.runAllTimers();
		expect(foldHeadingInView).not.toHaveBeenCalled();
		h.emit("changed", h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledWith(h.view, 2, 5);
	});

	it("folds to EOF when the transcript is the last section", () => {
		const h = setup();
		h.setContent("# Summary\nNotes\n# Transcript\nlong transcript\n## Child\nmore");
		h.headings.pop();
		h.emit("file-open", h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledWith(h.view, 2, 5);
	});

	it.each([false, true])("folds a restored background tab on its first activation (pop-out: %s)", (secondDocument) => {
		const h = setup(secondDocument, false);
		vi.runAllTimers();
		expect(foldHeadingInView).not.toHaveBeenCalled();
		h.setActive(h.view);
		h.emit("active-leaf-change", { view: h.view });
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledWith(h.view, 2, 5);
		h.emit("active-leaf-change", { view: h.view });
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledOnce();
	});

	it("initializes a restored tab whose Markdown view is deferred during activation", () => {
		const h = setup(false, false);
		h.emit("active-leaf-change", { view: {} });
		vi.runAllTimers();
		h.setActive(h.view);
		h.emit("layout-change");
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledWith(h.view, 2, 5);
	});

	it("does not treat programmatic note loading as a user edit", () => {
		const h = setup();
		h.setContent("");
		h.emit("file-open", h.file);
		vi.mocked(foldHeadingInView).mockReturnValueOnce("not-ready");
		vi.runAllTimers();
		h.setContent("# Summary\nNotes\n# Transcript\nlong transcript\n## Child\nmore\n# Backlinks\nlink");
		h.emit("editor-change", h.view.editor, h.view);
		vi.runAllTimers();
		h.emit("layout-change");
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenLastCalledWith(h.view, 2, 5);
		expect(foldHeadingInView).toHaveBeenCalledTimes(2);
	});

	it("retries after Zotero finishes cursor placement, even if the file was already active", () => {
		const h = setup();
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledOnce();
		h.opened(h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledTimes(2);
	});

	it("does not re-fold a section when the user clicks before a pending render retry", () => {
		const h = setup();
		vi.mocked(foldHeadingInView).mockReturnValueOnce("not-ready");
		vi.runAllTimers();
		h.view.containerEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		h.emit("layout-change");
		h.emit("changed", h.file);
		vi.runAllTimers();
		expect(foldHeadingInView).toHaveBeenCalledOnce();
	});
});
