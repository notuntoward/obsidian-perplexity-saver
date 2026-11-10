import type { Plugin } from "obsidian";
import { forEachWindow } from "commons/windows";
import { getLeafFileKey, isInCollapsedSidebar } from "commons/workspace";

const FOCUSED_PANE = "perplexity-saver-focused-pane";
const CONTENT = ".markdown-source-view, .markdown-preview-view, .perplexity-saver-video-view, .perplexity-saver-transcript-view";

export function registerVideoNoteFocusIndicator(plugin: Plugin, enabled: () => boolean): () => void {
	let focused: HTMLElement | null = null;
	const refreshers = new Set<() => void>();
	const isVideoNote = (element: HTMLElement): boolean => {
		const { app } = plugin;
		const note = app.workspace.getLeavesOfType("markdown").find((leaf) => element.contains(leaf.view.containerEl));
		const file = note && getLeafFileKey(note);
		if (!file) return false;
		return ["perplexity-saver-video", "perplexity-saver-transcript"].some((type) =>
			app.workspace.getLeavesOfType(type).some((leaf) =>
				getLeafFileKey(leaf) === file && leaf.view.containerEl.isShown() && !isInCollapsedSidebar(app, leaf)
			)
		);
	};
	const clear = (): void => {
		focused?.classList.remove(FOCUSED_PANE);
		focused = null;
	};
	forEachWindow(plugin, (win) => {
		const doc = win.document;
		const mark = (element: Element | null): void => {
			clear();
			if (!enabled() || !element) return;
			const leaf = element.closest<HTMLElement>(".workspace-leaf");
			if (!leaf || !leaf.querySelector(CONTENT)) return;
			if (!leaf.querySelector(".perplexity-saver-video-view, .perplexity-saver-transcript-view") && !isVideoNote(leaf)) return;
			focused = leaf;
			leaf.classList.add(FOCUSED_PANE);
		};
		const refresh = (): void => {
			if (doc.hasFocus()) mark(doc.activeElement);
			else if (focused?.ownerDocument === doc) clear();
		};
		const onFocusIn = (): void => mark(doc.activeElement);
		const onFocusOut = (event: FocusEvent): void => {
			if (focused?.ownerDocument !== doc) return;
			const target = event.relatedTarget;
			mark(target && "nodeType" in target && target.nodeType === 1 ? target as Element : null);
		};
		const onBlur = (): void => {
			if (focused?.ownerDocument === doc) clear();
		};
		doc.addEventListener("focusin", onFocusIn);
		doc.addEventListener("focusout", onFocusOut);
		win.addEventListener("focus", refresh);
		// Entering an iframe blurs the parent window, but its document still has focus.
		win.addEventListener("blur", refresh);
		refreshers.add(refresh);
		refresh();
		return () => {
			doc.removeEventListener("focusin", onFocusIn);
			doc.removeEventListener("focusout", onFocusOut);
			win.removeEventListener("focus", refresh);
			win.removeEventListener("blur", refresh);
			refreshers.delete(refresh);
			onBlur();
		};
	});
	const refreshAll = (): void => {
		clear();
		for (const refresh of refreshers) refresh();
	};
	plugin.registerEvent(plugin.app.workspace.on("layout-change", refreshAll));
	plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", refreshAll));
	return refreshAll;
}
