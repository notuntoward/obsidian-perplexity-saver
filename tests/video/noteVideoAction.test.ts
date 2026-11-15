// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MarkdownView, Plugin, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { openVideoLeaf, registerNoteVideoActions } from "../../src/video/noteVideoAction";

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
	const open = vi.fn(async (_file: TFile, _id: string) => {});
	const refresh = registerNoteVideoActions(plugin, open);
	const note = (doc: Document, content: string, name: string) => {
		const view = new MarkdownView({} as WorkspaceLeaf);
		view.file = { path: `${name}.md`, extension: "md", basename: name } as TFile;
		view.containerEl = doc.body.appendChild(doc.createElement("div"));
		view.editor.getValue = () => content;
		const leaf = { view } as unknown as WorkspaceLeaf;
		notes.push(leaf);
		return { view, leaf, update: (text: string) => { content = text; } };
	};
	const player = (id: string) => {
		const leaf = { view: {}, getViewState: () => ({ state: { videoId: id } }) } as unknown as WorkspaceLeaf;
		videos.push(leaf);
		return leaf;
	};
	return { app, plugin, notes, videos, events, cleanup, open, refresh, note, player };
}

describe("note video header action", () => {
	it("updates each note independently for players in any window, including deferred tabs", async () => {
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
			expect(aButton.dataset.icon).toBe("play");
			expect(bButton.getAttribute("aria-label")).toBe("Open video");
			const player = h.player(first);
			h.events.get("layout-change")?.();
			await vi.waitFor(() => expect(aButton.getAttribute("aria-label")).toBe("Show open video"));
			expect(aButton.dataset.icon).toBe("bring-to-front");
			expect(bButton.getAttribute("aria-label")).toBe("Open video");
			expect(openVideoLeaf(h.plugin, first)).toBe(player);
			bButton.click();
			expect(h.open).toHaveBeenCalledWith(b.view.file, second);
			h.videos.length = 0;
			h.events.get("layout-change")?.();
			await vi.waitFor(() => expect(aButton.getAttribute("aria-label")).toBe("Open video"));
			h.cleanup.forEach((dispose) => dispose());
			expect(popout.querySelector("button")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
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
