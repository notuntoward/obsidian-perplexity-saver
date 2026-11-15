import { MarkdownView, Notice, setIcon, setTooltip, type Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
import { findNoteVideoId } from "./youtubeLinks";
import { VIDEO_VIEW_TYPE, VideoView } from "./videoView";

/** Find a player for this video in any window, including a deferred tab. */
export function openVideoLeaf(plugin: Plugin, videoId: string): WorkspaceLeaf | null {
	return plugin.app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE).find((leaf) => {
		if (leaf.view instanceof VideoView) return leaf.view.getVideoId() === videoId;
		const state: unknown = leaf.getViewState().state;
		return !!state && typeof state === "object" && "videoId" in state && state.videoId === videoId;
	}) ?? null;
}

/** Add a note-header action without changing the note or relying on the focused window. */
export function registerNoteVideoActions(
	plugin: Plugin,
	open: (file: TFile, videoId: string) => Promise<void>,
): () => void {
	const actions = new Map<MarkdownView, { element: HTMLElement | null; revision: number }>();
	let disposed = false;
	const refresh = (changedView?: MarkdownView): void => {
		const views = new Set(plugin.app.workspace.getLeavesOfType("markdown")
			.map((leaf) => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView));
		for (const [view, action] of actions) {
			if (!views.has(view)) {
				action.element?.remove();
				actions.delete(view);
			}
		}
		for (const view of views) {
			if (changedView && changedView !== view) continue;
			const file = view.file;
			let action = actions.get(view);
			if (!file) {
				action?.element?.remove();
				actions.delete(view);
				continue;
			}
			if (!action) {
				action = { element: null, revision: 0 };
				actions.set(view, action);
			}
			const current = action;
			const revision = ++current.revision;
			const content = view.getMode() === "source" ? Promise.resolve(view.editor.getValue()) : plugin.app.vault.cachedRead(file);
			void content.then((text) => {
				if (disposed || view.file !== file || actions.get(view) !== current || current.revision !== revision) return;
				const videoId = findNoteVideoId(text);
				if (!videoId) {
					current.element?.remove();
					current.element = null;
					return;
				}
				if (!current.element) {
					const element = view.addAction("play", "Open video", () => {
						const currentFile = view.file;
						if (!currentFile) return;
						const currentId = element.dataset.videoId;
						if (!currentId) return;
						void open(currentFile, currentId).catch((error: unknown) => {
							console.error("Perplexity Saver: could not open or show video", error);
							new Notice("Could not open or show video.");
						});
					});
					current.element = element;
				}
				const shown = !!openVideoLeaf(plugin, videoId);
				const title = shown ? "Show open video" : "Open video";
				current.element.dataset.videoId = videoId;
				current.element.setAttribute("aria-label", title);
				setTooltip(current.element, title);
				setIcon(current.element, shown ? "bring-to-front" : "play");
			}).catch((error: unknown) => {
				console.error("Perplexity Saver: could not read note for video action", error);
				new Notice("Could not update the note's video action.");
			});
		}
	};
	plugin.registerEvent(plugin.app.workspace.on("layout-change", () => refresh()));
	plugin.registerEvent(plugin.app.workspace.on("file-open", () => refresh()));
	plugin.registerEvent(plugin.app.workspace.on("editor-change", (_editor, info) => {
		if (info instanceof MarkdownView) refresh(info);
	}));
	plugin.registerEvent(plugin.app.metadataCache.on("changed", () => refresh()));
	plugin.registerEvent(plugin.app.vault.on("rename", () => refresh()));
	plugin.registerEvent(plugin.app.vault.on("delete", () => refresh()));
	plugin.register(() => {
		disposed = true;
		for (const action of actions.values()) action.element?.remove();
		actions.clear();
	});
	plugin.app.workspace.onLayoutReady(() => refresh());
	return () => refresh();
}
