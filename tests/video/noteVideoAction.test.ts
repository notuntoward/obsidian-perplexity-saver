// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Plugin, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { MockMenu } from "commons/testing";
import { openVideoLeaf, registerNoteVideoActions, type NoteVideoActionsHost } from "../../src/video/noteVideoAction";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	Menu: class extends (await import("commons/testing")).MockMenu { addSeparator(): this { return this; } },
}));

beforeEach(() => {
	MockMenu.last = null;
});

const first = "dQw4w9WgXcQ";
const second = "abcdefghijk";

class TestPlugin extends Plugin {}

function harness() {
	const notes: WorkspaceLeaf[] = [];
	const videos: WorkspaceLeaf[] = [];
	const events = new Map<string, (...args: unknown[]) => void>();
	const cleanup: (() => void)[] = [];
	const app = {
		workspace: {
			getLeavesOfType: (type: string) => type === "markdown" ? notes : videos,
			iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => notes.forEach(callback),
			on: (name: string, callback: (...args: unknown[]) => void) => { events.set(name, callback); return {}; },
			onLayoutReady: (callback: () => void) => callback(),
		},
		vault: {
			cachedRead: vi.fn(async () => ""),
			on: (name: string, callback: () => void) => { events.set(`vault-${name}`, callback); return {}; },
		},
		metadataCache: { on: (_name: string, callback: () => void) => { events.set("metadata", callback); return {}; } },
	} as unknown as App;
	const plugin = new TestPlugin(app, { id: "test", name: "test", version: "1", minAppVersion: "1", author: "", description: "" });
	vi.spyOn(plugin, "register").mockImplementation((fn: () => void) => { cleanup.push(fn); });
	const states = new Map<string, { player: boolean; transcript: boolean }>();
	const open = vi.fn(async (_file: TFile, _id: string) => {});
	const close = vi.fn();
	const bringForward = vi.fn(async () => {});
	const togglePart = vi.fn(async () => {});
	const host: NoteVideoActionsHost = {
		getState: (file) => states.get(file.path) ?? { player: false, transcript: false },
		open, close, bringForward, togglePart,
	};
	const refresh = registerNoteVideoActions(plugin, host);
	const note = (doc: Document, content: string, name: string, containerEl?: HTMLElement) => {
		if (!doc.defaultView) Object.defineProperty(doc, "defaultView", { configurable: true, value: window });
		const view = new MarkdownView({} as WorkspaceLeaf);
		view.file = { path: `${name}.md`, extension: "md", basename: name } as TFile;
		view.containerEl = containerEl ?? doc.body.appendChild(doc.createElement("div"));
		view.editor.getValue = () => content;
		const parent = { children: [] as WorkspaceLeaf[] };
		const leaf = { view, parent } as unknown as WorkspaceLeaf;
		parent.children.push(leaf);
		notes.push(leaf);
		return { view, leaf, update: (text: string) => { content = text; } };
	};
	const player = (id: string) => {
		const leaf = { view: {}, getViewState: () => ({ state: { videoId: id } }) } as unknown as WorkspaceLeaf;
		videos.push(leaf);
		return leaf;
	};
	return { app, plugin, notes, videos, events, cleanup, open, close, bringForward, togglePart, states, refresh, note, player };
}

describe("note video header action", () => {
	it("keeps the chevron to the right when Obsidian prepends header actions", async () => {
		const h = harness();
		const note = h.note(document, `https://youtu.be/${first}`, "a");
		const addAction = note.view.addAction.bind(note.view);
		vi.spyOn(note.view, "addAction").mockImplementation((icon, title, callback) => {
			const element = addAction(icon, title, callback);
			note.view.containerEl.prepend(element);
			return element;
		});
		h.refresh();
		await vi.waitFor(() => expect(note.view.containerEl.querySelectorAll("button")).toHaveLength(2));
		const toggle = note.view.containerEl.querySelector('[aria-label="Open video workspace"]')!;
		expect(toggle.nextElementSibling?.getAttribute("aria-label")).toBe("Video tools");
	});

	it("does not duplicate actions while a moved tab reuses the old header DOM", async () => {
		const h = harness();
		const old = h.note(document, `https://youtu.be/${first}`, "moving");
		h.refresh();
		const headerActions = () =>
			old.view.containerEl.querySelectorAll(
				".perplexity-saver-video-workspace-toggle, .perplexity-saver-video-workspace-menu",
			);
		await vi.waitFor(() => expect(headerActions()).toHaveLength(2));
		(old.leaf.parent as unknown as { children: WorkspaceLeaf[] }).children = [];
		const moved = h.note(document, `https://youtu.be/${first}`, "moving", old.view.containerEl);
		const addAction = vi.spyOn(moved.view, "addAction");

		h.refresh();

		await vi.waitFor(() => expect(addAction).toHaveBeenCalledTimes(2));
		expect(headerActions()).toHaveLength(2);
	});

	it("opens or closes only the clicked note's workspace, including from a pop-out", async () => {
		const h = harness();
		const popout = document.implementation.createHTMLDocument();
		Object.defineProperty(popout, "activeElement", { configurable: true, value: popout.body });
		vi.stubGlobal("activeDocument", popout);
		vi.stubGlobal("activeWindow", window);
		try {
			const a = h.note(document, `https://youtu.be/${first}`, "a");
			const b = h.note(popout, `https://youtu.be/${second}`, "b");
			h.refresh();
			await vi.waitFor(() => expect(b.view.containerEl.querySelector("button")).not.toBeNull());
			const aButton = a.view.containerEl.querySelector("button")!;
			const bButton = b.view.containerEl.querySelector("button")!;
			expect(aButton.dataset.icon).toBe("square-play");
			expect(bButton.getAttribute("aria-label")).toBe("Open video workspace");
			const player = h.player(first);
			h.states.set("a.md", { player: true, transcript: true });
			h.events.get("layout-change")?.();
			await vi.waitFor(() => expect(aButton.getAttribute("aria-label")).toBe("Close video workspace"));
			expect(aButton.dataset.icon).toBe("square-x");
			expect(bButton.getAttribute("aria-label")).toBe("Open video workspace");
			expect(openVideoLeaf(h.plugin, first)).toBe(player);
			aButton.click();
			expect(h.close).toHaveBeenCalledWith(a.view.file);
			bButton.click();
			expect(h.open).toHaveBeenCalledWith(b.view.file, second);
			h.videos.length = 0;
			h.states.clear();
			h.events.get("layout-change")?.();
			await vi.waitFor(() => expect(aButton.getAttribute("aria-label")).toBe("Open video workspace"));
			h.cleanup.forEach((dispose) => dispose());
			expect(popout.querySelector("button")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it.each(["player", "transcript"] as const)("closes when only the %s is open, even if the rendered state is stale", async (part) => {
		const h = harness();
		const note = h.note(document, `https://youtu.be/${first}`, "a");
		h.refresh();
		await vi.waitFor(() => expect(note.view.containerEl.querySelector("button")).not.toBeNull());
		h.states.set("a.md", { player: part === "player", transcript: part === "transcript" });
		note.view.containerEl.querySelector("button")!.click();
		expect(h.close).toHaveBeenCalledWith(note.view.file);
		expect(h.open).not.toHaveBeenCalled();
		expect(h.bringForward).not.toHaveBeenCalled();
	});

	it.each([false, true])("puts part toggles and bring-forward in an owner-document menu (popout=%s)", async (popout) => {
		const h = harness();
		const doc = popout ? document.implementation.createHTMLDocument() : document;
		Object.defineProperty(doc, "activeElement", { configurable: true, value: doc.body });
		vi.stubGlobal("activeDocument", doc);
		vi.stubGlobal("activeWindow", window);
		try {
			const note = h.note(doc, `https://youtu.be/${first}`, "a");
			h.states.set("a.md", { player: false, transcript: true });
			h.refresh();
			await vi.waitFor(() => expect(note.view.containerEl.querySelector('[aria-label="Video tools"]')).not.toBeNull());
			const showMenu = vi.spyOn(MockMenu.prototype, "showAtPosition");
			const chevron = note.view.containerEl.querySelector<HTMLElement>('[aria-label="Video tools"]')!;
			chevron.click();
			expect(showMenu).toHaveBeenLastCalledWith(expect.any(Object), doc);
			expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
			expect(MockMenu.last?.items.map(({ title, checked }) => [title, checked])).toEqual([
				["Bring video workspace forward", false], ["Player", false], ["Transcript", true], ["Close video workspace", false],
			]);
			MockMenu.last!.items[0].click();
			expect(h.bringForward).toHaveBeenCalledWith(note.view.file);
			await Promise.resolve();
			chevron.click();
			MockMenu.last!.items[1].click();
			expect(h.togglePart).toHaveBeenCalledWith(note.view.file, first, "player");
			await Promise.resolve();
			chevron.click();
			MockMenu.last!.items[2].click();
			expect(h.togglePart).toHaveBeenLastCalledWith(note.view.file, first, "transcript");
			await Promise.resolve();
			chevron.click();
			MockMenu.last!.items[3].click();
			expect(h.close).toHaveBeenCalledWith(note.view.file);
			showMenu.mockRestore();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("offers opening either part alone without triggering the primary action", async () => {
		const h = harness();
		const note = h.note(document, `https://youtu.be/${first}`, "a");
		h.refresh();
		await vi.waitFor(() => expect(note.view.containerEl.querySelector('[aria-label="Video tools"]')).not.toBeNull());
		note.view.containerEl.querySelector<HTMLElement>('[aria-label="Video tools"]')!.click();
		expect(MockMenu.last?.items.map(({ title }) => title)).toEqual(["Open player only", "Open transcript only"]);
		MockMenu.last!.items[1].click();
		expect(h.togglePart).toHaveBeenCalledWith(note.view.file, first, "transcript");
		expect(h.open).not.toHaveBeenCalled();
		expect(h.close).not.toHaveBeenCalled();
	});

	it("ignores an old menu after its note changes and prevents duplicate opening clicks", async () => {
		const h = harness();
		const note = h.note(document, `https://youtu.be/${first}`, "a");
		h.refresh();
		await vi.waitFor(() => expect(note.view.containerEl.querySelector('[aria-label="Video tools"]')).not.toBeNull());
		note.view.containerEl.querySelector<HTMLElement>('[aria-label="Video tools"]')!.click();
		const oldMenu = MockMenu.last!;
		note.view.file = { path: "other.md" } as TFile;
		oldMenu.items[0].click();
		expect(h.togglePart).not.toHaveBeenCalled();
		note.view.file = { path: "a.md" } as TFile;
		h.refresh();
		await Promise.resolve();
		let finish!: () => void;
		h.open.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		const button = note.view.containerEl.querySelector<HTMLButtonElement>("button")!;
		button.click();
		button.click();
		expect(h.open).toHaveBeenCalledOnce();
		finish();
	});

	it("uses the first video in unsaved edits and removes the action when it is removed", async () => {
		const h = harness();
		const note = h.note(document, "ordinary note", "edited");
		h.refresh();
		await Promise.resolve();
		expect(note.view.containerEl.querySelector("button")).toBeNull();
		note.update(`https://youtu.be/${first} https://youtu.be/${second}`);
		h.events.get("editor-change")?.(undefined, note.view);
		await vi.waitFor(() => expect(note.view.containerEl.querySelector("button")).not.toBeNull());
		note.view.containerEl.querySelector("button")!.click();
		expect(h.open).toHaveBeenCalledWith(note.view.file, first);
		note.update("ordinary note again");
		h.events.get("editor-change")?.(undefined, note.view);
		await vi.waitFor(() => expect(note.view.containerEl.querySelector("button")).toBeNull());
	});

	it("ignores an older asynchronous read after the note changes", async () => {
		const h = harness();
		const note = h.note(document, "", "reading");
		vi.spyOn(note.view, "getMode").mockReturnValue("preview");
		let resolveOld!: (text: string) => void;
		vi.mocked(h.app.vault.cachedRead).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
			.mockResolvedValueOnce(`https://youtu.be/${second}`);
		h.refresh();
		h.refresh();
		await vi.waitFor(() => expect(note.view.containerEl.querySelector("button")).not.toBeNull());
		resolveOld(`https://youtu.be/${first}`);
		await Promise.resolve();
		note.view.containerEl.querySelector("button")!.click();
		expect(h.open).toHaveBeenCalledWith(note.view.file, second);
	});
});
