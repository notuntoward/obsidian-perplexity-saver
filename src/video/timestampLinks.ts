import { EditorView } from "@codemirror/view";
import type { Plugin } from "obsidian";
import { onEachDocument } from "commons/windows";
import { registerLinkActivation, registerNativeLinkActivation } from "commons/links";
import { Notice } from "obsidian";
import { linkUrlAt, parseYouTubeUrl } from "./youtubeLinks";

export type TimestampClickAction = "viewer" | "browser";

export interface TimestampRequest {
	videoId: string;
	seconds: number;
	/** The element that was clicked, to find the note it belongs to. */
	target: Element;
}

/** Whether a click opens the viewer: the setting picks the plain-click action; Ctrl/Cmd does the other one. */
export function opensInViewer(action: TimestampClickAction, modifier: boolean): boolean {
	return (action === "viewer") !== modifier;
}

/** URL of the link under `target`: an anchor (reading view, panels) or a live-preview editor link. */
export function clickedLinkUrl(target: Element): string | null {
	const anchor = target.closest("a[href]");
	if (anchor) return anchor.getAttribute("href");

	const editorEl = target.closest(".cm-editor");
	if (!editorEl || !target.closest(".cm-link, .cm-url, .cm-underline")) return null;
	// Source mode edits on click; only live preview opens links.
	if (!target.closest(".markdown-source-view.is-live-preview")) return null;
	const view = EditorView.findFromDOM(editorEl as HTMLElement);
	if (!view) return null;
	try {
		const pos = view.posAtDOM(target);
		const line = view.state.doc.lineAt(pos);
		// The link under the cursor is shown as raw markdown for editing; leave that click alone.
		if (view.hasFocus && view.state.doc.lineAt(view.state.selection.main.head).number === line.number) {
			return null;
		}
		return linkUrlAt(line.text, pos - line.from);
	} catch {
		return null;
	}
}

/** The YouTube timestamp a mouse event would open in the viewer, or null to let Obsidian handle it. */
export function timestampForEvent(evt: MouseEvent, action: TimestampClickAction): TimestampRequest | null {
	if (evt.button !== 0 || evt.defaultPrevented || evt.shiftKey || evt.altKey) return null;
	if (!opensInViewer(action, evt.ctrlKey || evt.metaKey)) return null;
	const target = evt.target as Element | null;
	if (!target || typeof target.closest !== "function") return null;
	const url = clickedLinkUrl(target);
	const parsed = url ? parseYouTubeUrl(url) : null;
	if (!parsed || parsed.seconds === null) return null;
	return { videoId: parsed.videoId, seconds: parsed.seconds, target };
}

/** Native keyboard following reads the cursor, not the mouse hit-test or rendered link span. */
export function keyboardTimestamp(target: Element, action: TimestampClickAction): TimestampRequest | null {
	if (action !== "viewer") return null;
	const editorEl = target.closest(".cm-editor");
	let url: string | null;
	if (editorEl) {
		const view = EditorView.findFromDOM(editorEl as HTMLElement);
		if (!view || view.composing || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return null;
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		url = linkUrlAt(line.text, head - line.from);
	} else {
		url = target.closest("a[href]")?.getAttribute("href") ?? null;
	}
	const parsed = url ? parseYouTubeUrl(url) : null;
	return parsed && parsed.seconds !== null ? { ...parsed, seconds: parsed.seconds, target } : null;
}

/**
 * Route clicks on YouTube timestamp links (in notes and in the transcript panel)
 * to the video viewer, in the main window and every pop-out.
 */
export function registerTimestampLinks(
	plugin: Plugin,
	getAction: () => TimestampClickAction,
	open: (request: TimestampRequest) => void
): void {
	registerLinkActivation(plugin, (target, checking) => {
		const request = keyboardTimestamp(target, getAction());
		if (!request) return false;
		if (!checking) open(request);
		return true;
	});
	const restore = registerNativeLinkActivation(plugin.app);
	if (restore) plugin.register(restore);
	else new Notice("Keyboard timestamp links unavailable: native follow link command could not be registered.");
	const swallow = (evt: MouseEvent): void => {
		if (!timestampForEvent(evt, getAction())) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
	};
	const onClick = (evt: MouseEvent): void => {
		const request = timestampForEvent(evt, getAction());
		if (!request) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
		open(request);
	};
	onEachDocument(plugin, "mousedown", swallow, true);
	onEachDocument(plugin, "mouseup", swallow, true);
	onEachDocument(plugin, "click", onClick, true);
}
