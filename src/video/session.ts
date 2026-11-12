import type { App, TFile, WorkspaceLeaf } from "obsidian";
import { getLeafFileKey, getWindowForLeaf, isInCollapsedSidebar } from "commons/workspace";
import { TRANSCRIPT_VIEW_TYPE, TranscriptView } from "../litNote/transcriptView";
import { VIDEO_VIEW_TYPE, VideoView } from "./videoView";

export interface VisiblePart<T> {
	leaf: WorkspaceLeaf;
	view: T;
}

/** A pane the user can see: shown, and not folded into a collapsed sidebar. */
export function isVisiblePart(app: App, leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
	return !!leaf && leaf.view.containerEl.isShown() && !isInCollapsedSidebar(app, leaf);
}

function parts<T>(app: App, type: string, accept: (view: unknown) => view is T): VisiblePart<T>[] {
	const found: VisiblePart<T>[] = [];
	for (const leaf of app.workspace.getLeavesOfType(type)) {
		const view = leaf.view;
		if (accept(view)) found.push({ leaf, view });
	}
	return found;
}

/** Loaded video players in any window, optionally limited to one window. */
export function loadedPlayers(app: App, win?: Window | null): VisiblePart<VideoView>[] {
	return parts(app, VIDEO_VIEW_TYPE, (view): view is VideoView => view instanceof VideoView && !!view.getVideoId())
		.filter((part) => !win || getWindowForLeaf(part.leaf) === win);
}

/** Loaded video players on screen, optionally limited to one window. */
export function visiblePlayers(app: App, win?: Window | null): VisiblePart<VideoView>[] {
	return loadedPlayers(app, win).filter((part) => isVisiblePart(app, part.leaf));
}

/** Any loaded player bound to the note, visible first, across every window. */
export function playerForNote(app: App, file: TFile): VisiblePart<VideoView> | null {
	const players = loadedPlayers(app).filter((part) => part.view.getFilePath() === file.path);
	return players.find((part) => isVisiblePart(app, part.leaf)) ?? players[0] ?? null;
}

/** A player to reuse when the target note has none: on screen first, then any loaded one. */
export function primaryPlayer(app: App, preferWindow?: Window | null): VisiblePart<VideoView> | null {
	const visible = visiblePlayers(app);
	const preferred = preferWindow ? visible.find((part) => getWindowForLeaf(part.leaf) === preferWindow) : null;
	return preferred ?? visible[0] ?? loadedPlayers(app)[0] ?? null;
}

/** Visible transcripts for a note, preferring one in `preferWindow`. */
export function transcriptsForNote(app: App, file: TFile, preferWindow?: Window | null): VisiblePart<TranscriptView>[] {
	const panels = visibleTranscripts(app).filter((part) => part.view.getFilePath() === file.path);
	if (!preferWindow) return panels;
	const preferred = panels.filter((part) => getWindowForLeaf(part.leaf) === preferWindow);
	return [...preferred, ...panels.filter((part) => !preferred.includes(part))];
}

/** Transcript panels on screen, optionally limited to one window. */
export function visibleTranscripts(app: App, win?: Window | null): VisiblePart<TranscriptView>[] {
	return parts(app, TRANSCRIPT_VIEW_TYPE, (view): view is TranscriptView => view instanceof TranscriptView)
		.filter((part) => isVisiblePart(app, part.leaf))
		.filter((part) => !win || getWindowForLeaf(part.leaf) === win);
}

/** The window a note's media should act in: its transcript's window, else its note pane's. */
export function mediaWindowFor(app: App, file: TFile): Window | null {
	const transcript = visibleTranscripts(app).find((part) => part.view.getFilePath() === file.path);
	if (transcript) return getWindowForLeaf(transcript.leaf) ?? null;
	const note = app.workspace.getLeavesOfType("markdown").find((leaf) => getLeafFileKey(leaf) === file.path);
	return note ? getWindowForLeaf(note) ?? null : null;
}
