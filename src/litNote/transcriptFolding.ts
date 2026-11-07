import { MarkdownView, Notice, type Plugin, type TFile } from "obsidian";
import { foldHeadingInView } from "commons/workspace";
import { setTimeoutIn, type CancelTimer } from "commons/windows";
import { findTranscriptRange } from "./transcriptSection";

interface FoldingSettings {
	collapseTranscriptOnOpen: boolean;
	transcriptHeading: string;
}

interface PendingFold {
	file: TFile;
	content: string;
	cacheReady?: boolean;
	cancel?: CancelTimer;
}

/** Fold only during an opening; metadata/render retries must not fight subsequent editing or unfolding. */
export function registerTranscriptFolding(plugin: Plugin, settings: () => FoldingSettings): void {
	const pending = new Map<MarkdownView, PendingFold>();
	const { workspace, metadataCache } = plugin.app;
	let notified = false;

	const forget = (view: MarkdownView): void => {
		pending.get(view)?.cancel?.();
		pending.delete(view);
	};
	const attempt = (view: MarkdownView, request: PendingFold): void => {
		request.cancel = undefined;
		if (!settings().collapseTranscriptOnOpen || view.file !== request.file ||
			view.getViewData() !== request.content) {
			forget(view);
			return;
		}
		const cache = metadataCache.getFileCache(request.file);
		if (!cache) return;
		const headings = cache.headings;
		const range = findTranscriptRange(request.content, headings, settings().transcriptHeading);
		if (!range || !headings) {
			// A newly written note can still have the previous version's metadata.
			if (request.cacheReady) forget(view);
			return;
		}
		const heading = headings.find(item => item.position.end.offset === range.start);
		if (!heading) return;
		const from = heading.position.start.line;
		const to = range.end === request.content.length
			? request.content.split("\n").length - 1
			: request.content.slice(0, range.end).split("\n").length - 2;
		if (to <= from) {
			forget(view);
			return;
		}
		const result = foldHeadingInView(view, from, to);
		if (result === "not-ready") return;
		forget(view);
		if (result === "unsupported" && !notified) {
			notified = true;
			new Notice("Could not collapse the transcript automatically. Enable heading folding in the editor settings. If it is already enabled, see the console for details.");
		}
	};
	const schedule = (view: MarkdownView, request: PendingFold): void => {
		if (request.cancel) return;
		const win = view.containerEl.ownerDocument.defaultView;
		if (!win) return;
		request.cancel = setTimeoutIn(win, () => attempt(view, request), 0);
	};
	const open = (file: TFile | null): void => {
		const view = workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		forget(view);
		if (!file || view.file !== file || !settings().collapseTranscriptOnOpen) return;
		const request: PendingFold = { file, content: view.getViewData() };
		pending.set(view, request);
		schedule(view, request);
	};

	plugin.registerEvent(workspace.on("file-open", open));
	plugin.registerEvent(workspace.on("layout-change", () => {
		for (const [view, request] of pending) {
			if (!view.containerEl.isConnected) forget(view);
			else schedule(view, request);
		}
	}));
	plugin.registerEvent(metadataCache.on("changed", file => {
		for (const [view, request] of pending) {
			if (request.file === file) {
				request.cacheReady = true;
				schedule(view, request);
			}
		}
	}));
	plugin.registerEvent(workspace.on("editor-change", (_editor, info) => {
		for (const view of pending.keys()) {
			if (view.editor === info.editor) forget(view);
		}
	}));
	workspace.onLayoutReady(() => open(workspace.getActiveViewOfType(MarkdownView)?.file ?? null));
	plugin.register(() => {
		for (const view of pending.keys()) forget(view);
	});
}
