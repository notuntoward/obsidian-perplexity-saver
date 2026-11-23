import { MarkdownView, Menu, Notice, setIcon, setTooltip, type Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
import { getEditorLeafLocations } from "commons/workspace";
import { findNoteVideoId } from "commons/youtube";
import { VIDEO_VIEW_TYPE, VideoView } from "./videoView";

/** Find a player for this video in any window, including a deferred tab. */
export function openVideoLeaf(plugin: Plugin, videoId: string): WorkspaceLeaf | null {
	return plugin.app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE).find((leaf) => {
		if (leaf.view instanceof VideoView) return leaf.view.getVideoId() === videoId;
		const state: unknown = leaf.getViewState().state;
		return !!state && typeof state === "object" && "videoId" in state && state.videoId === videoId;
	}) ?? null;
}

export interface NoteVideoActionsHost {
	getState(file: TFile): { player: boolean; transcript: boolean };
	open(file: TFile, videoId: string): Promise<void>;
	close(file: TFile): void | Promise<void>;
	bringForward(file: TFile): Promise<void>;
	togglePart(file: TFile, videoId: string, part: "player" | "transcript"): Promise<void>;
}

interface NoteVideoAction {
	element: HTMLElement | null;
	menuElement: HTMLElement | null;
	revision: number;
	pending: boolean;
}

/** Add note-header controls without changing the note or relying on the focused window. */
export function registerNoteVideoActions(
	plugin: Plugin,
	host: NoteVideoActionsHost,
): () => void {
	const actions = new Map<MarkdownView, NoteVideoAction>();
	const remove = (action: NoteVideoAction): void => {
		action.element?.remove();
		action.menuElement?.remove();
		action.element = action.menuElement = null;
	};
	let disposed = false;
	const refresh = (changedView?: MarkdownView): void => {
		const views = new Set(getEditorLeafLocations(plugin.app)
			.map(({ leaf }) => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView));
		for (const [view, action] of actions) {
			if (!views.has(view)) {
				remove(action);
				actions.delete(view);
			}
		}
		for (const view of views) {
			if (changedView && changedView !== view) continue;
			const file = view.file;
			let action = actions.get(view);
			if (!file) {
				if (action) remove(action);
				actions.delete(view);
				continue;
			}
			if (!action) {
				action = { element: null, menuElement: null, revision: 0, pending: false };
				actions.set(view, action);
			}
			const current = action;
			const revision = ++current.revision;
			const content = view.getMode() === "source" ? Promise.resolve(view.editor.getValue()) : plugin.app.vault.cachedRead(file);
			void content.then((text) => {
				if (disposed || view.file !== file || actions.get(view) !== current || current.revision !== revision) return;
				const videoId = findNoteVideoId(text);
				if (!videoId) {
					remove(current);
					return;
				}
				if (!current.element) {
					const run = async (file: TFile, videoId: string, operation: () => void | Promise<void>): Promise<void> => {
						if (disposed || current.pending || view.file !== file || actions.get(view) !== current ||
							current.element?.dataset.videoId !== videoId) return;
						current.pending = true;
						current.element.setAttribute("aria-disabled", "true");
						current.menuElement?.setAttribute("aria-disabled", "true");
						try {
							await operation();
						} catch (error: unknown) {
							console.error("Perplexity Saver: could not update video workspace", error);
							new Notice("Could not update video workspace.");
						} finally {
							current.pending = false;
							current.element?.removeAttribute("aria-disabled");
							current.menuElement?.removeAttribute("aria-disabled");
							if (!disposed) refresh(view);
						}
					};
					const element = view.addAction("square-play", "Open video workspace", () => {
						const currentFile = view.file;
						if (!currentFile) return;
						const currentId = element.dataset.videoId;
						if (!currentId) return;
						void run(currentFile, currentId, () => {
							const state = host.getState(currentFile);
							return state.player || state.transcript ? host.close(currentFile) : host.open(currentFile, currentId);
						});
					});
					element.addClass("perplexity-saver-video-workspace-toggle");
					current.element = element;
					const menuElement = view.addAction("chevron-down", "Video tools", () => {
						const currentFile = view.file;
						const currentId = element.dataset.videoId;
						if (!currentFile || !currentId || current.pending) return;
						const state = host.getState(currentFile);
						const open = state.player || state.transcript;
						const menu = new Menu();
						if (open) menu.addItem((item) => item.setTitle("Bring video workspace forward").setIcon("bring-to-front")
							.onClick(() => { void run(currentFile, currentId, () => host.bringForward(currentFile)); }));
						for (const part of ["player", "transcript"] as const) {
							const title = open ? part === "player" ? "Player" : "Transcript" : `Open ${part} only`;
							menu.addItem((item) => item.setTitle(title).setChecked(state[part])
								.onClick(() => { void run(currentFile, currentId, () => host.togglePart(currentFile, currentId, part)); }));
						}
						if (open) {
							menu.addSeparator();
							menu.addItem((item) => item.setTitle("Close video workspace").setIcon("x")
								.onClick(() => { void run(currentFile, currentId, () => host.close(currentFile)); }));
						}
						const rect = menuElement.getBoundingClientRect();
						menu.showAtPosition({ x: rect.left, y: rect.bottom }, menuElement.ownerDocument);
					});
					menuElement.addClass("perplexity-saver-video-workspace-menu");
					menuElement.setAttribute("aria-haspopup", "menu");
					setTooltip(menuElement, "Video tools");
					setIcon(menuElement, "chevron-down");
					element.after(menuElement);
					current.menuElement = menuElement;
				}
				const state = host.getState(file);
				const shown = state.player || state.transcript;
				const title = shown ? "Close video workspace" : "Open video workspace";
				current.element.dataset.videoId = videoId;
				current.element.setAttribute("aria-label", title);
				setTooltip(current.element, title);
				setIcon(current.element, shown ? "square-x" : "square-play");
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
		for (const action of actions.values()) remove(action);
		actions.clear();
	});
	plugin.app.workspace.onLayoutReady(() => refresh());
	return () => refresh();
}
