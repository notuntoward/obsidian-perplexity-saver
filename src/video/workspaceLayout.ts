import type { App } from "obsidian";
import { ItemSuggestModal } from "commons/modal";

export type VideoWorkspaceLayout = "note" | "video" | "transcript" | "both";
export type PreferredVideoWorkspace = Exclude<VideoWorkspaceLayout, "note">;
export interface VideoPlaybackPosition {
	videoId: string;
	seconds: number;
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
}

export function workspaceChoices(current: VideoWorkspaceLayout, preferred: PreferredVideoWorkspace): WorkspaceChoice[] {
	const first = current === "note" ? preferred : current;
	const layouts: VideoWorkspaceLayout[] = [first, ...(["note", "video", "transcript", "both"] as const)
		.filter((layout) => layout !== first && (current !== "note" || layout !== "note"))];
	return layouts.map((layout) => ({ layout, title: VIDEO_WORKSPACE_LABELS[layout] }));
}

export class VideoWorkspaceModal extends ItemSuggestModal<WorkspaceChoice> {
	constructor(app: App, current: VideoWorkspaceLayout, preferred: PreferredVideoWorkspace, choose: (layout: VideoWorkspaceLayout) => void) {
		const choices = workspaceChoices(current, preferred);
		super(app, choices, (choice) => choose(choice.layout), {
			placeholder: "Video workspace...",
			getTitle: (choice) => choice.title,
			sort: (a, b) => choices.indexOf(a.item) - choices.indexOf(b.item),
		});
	}
}
