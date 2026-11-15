import type { App } from "obsidian";
import { ItemSuggestModal } from "commons/modal";
import { isPaneArrangement, paneArrangementKeys, type PaneArrangement } from "commons/workspace";

export type VideoWorkspaceLayout = "note" | "video" | "transcript" | "both";
export type PreferredVideoWorkspace = Exclude<VideoWorkspaceLayout, "note">;
export interface VideoPlaybackPosition {
	videoId: string;
	seconds: number;
}

export interface SavedVideoWorkspace {
	videoId: string;
	layout: PreferredVideoWorkspace;
	geometry?: PaneArrangement;
}

export function isSavedVideoWorkspace(value: unknown): value is SavedVideoWorkspace {
	if (!value || typeof value !== "object") return false;
	const saved = value as Partial<SavedVideoWorkspace>;
	if (typeof saved.videoId !== "string" || !saved.videoId ||
		(saved.layout !== "video" && saved.layout !== "transcript" && saved.layout !== "both")) return false;
	if (saved.geometry === undefined) return true;
	if (!isPaneArrangement(saved.geometry)) return false;
	const keys = paneArrangementKeys(saved.geometry).sort();
	const expected = ["note", ...(saved.layout !== "transcript" ? ["video"] : []), ...(saved.layout !== "video" ? ["transcript"] : [])].sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export const VIDEO_WORKSPACE_LABELS: Record<VideoWorkspaceLayout, string> = {
	note: "Note only",
	video: "Note + video",
	transcript: "Note + transcript",
	both: "Note + video + transcript",
};

interface WorkspaceChoice {
	layout: VideoWorkspaceLayout;
	title: string;
	action?: () => void;
}

export function workspaceChoices(current: VideoWorkspaceLayout, preferred: PreferredVideoWorkspace): WorkspaceChoice[] {
	const first = current === "note" ? preferred : current;
	const layouts: VideoWorkspaceLayout[] = [first, ...(["note", "video", "transcript", "both"] as const)
		.filter((layout) => layout !== first && (current !== "note" || layout !== "note"))];
	return layouts.map((layout) => ({ layout, title: VIDEO_WORKSPACE_LABELS[layout] }));
}

export class VideoWorkspaceModal extends ItemSuggestModal<WorkspaceChoice> {
	constructor(app: App, current: VideoWorkspaceLayout, preferred: PreferredVideoWorkspace, choose: (layout: VideoWorkspaceLayout, restore: boolean) => void, remembered?: PreferredVideoWorkspace, videoAction?: { title: string; run: () => void }) {
		const choices = workspaceChoices(current, remembered ?? preferred);
		if (current === "note") choices[0].title = `${remembered ? "Reopen last workspace" : "Open initial workspace"}: ${choices[0].title}`;
		const restoreChoice = choices[0];
		if (videoAction) choices.unshift({ layout: current, title: videoAction.title, action: videoAction.run });
		super(app, choices, (choice) => {
			if (choice.action) choice.action();
			else choose(choice.layout, current === "note" && !!remembered && choice === restoreChoice);
		}, {
			placeholder: "Reopen or change video workspace...",
			getTitle: (choice) => choice.title,
			sort: (a, b) => choices.indexOf(a.item) - choices.indexOf(b.item),
		});
	}
}
