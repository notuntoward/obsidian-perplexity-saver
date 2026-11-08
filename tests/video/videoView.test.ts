// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { createdNotices } from "../__mocks__/obsidian";
import { VideoView, type VideoViewHost } from "../../src/video/videoView";
import { timestampLink, type TimestampCopyFormat } from "../../src/video/youtubeLinks";

const writeClipboard = vi.hoisted(() => vi.fn());
vi.mock("commons/windows", async (original) => ({
	...await original<Record<string, unknown>>(),
	writeClipboardIn: writeClipboard,
}));

describe("video timestamp copy", () => {
	beforeEach(() => {
		writeClipboard.mockReset().mockResolvedValue(true);
		createdNotices.length = 0;
	});

	it.each([1, 2])("exposes exact playback time independently of playing/paused state (%s)", (playerState) => {
		const view = new VideoView({} as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			isTranscriptShown: () => false, toggleTranscript: async () => {}, onPlayback: () => {}, focusNote: async () => {},
		});
		Object.assign(view, { startTime: 27.25 });
		expect(view.getPlaybackSeconds()).toBe(27.25);
		Object.assign(view, { player: { info: { currentTime: 55.75, playerState } } });
		expect(view.getPlaybackSeconds()).toBe(55.75);
	});

	it("surfaces transcript activation failures from the viewer button/command", async () => {
		const error = new Error("Could not reveal leaf");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = { vault: { getFileByPath: () => null } };
		const view = new VideoView({ app } as unknown as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			isTranscriptShown: () => false, toggleTranscript: async () => { throw error; }, onPlayback: () => {}, focusNote: async () => {},
		});
		await view.toggleTranscript();
		expect(log).toHaveBeenCalledWith("Perplexity Saver: could not toggle transcript", error);
		expect(createdNotices.at(-1)?.message).toBe("Could not show or hide transcript.");
		log.mockRestore();
	});

	it.each(["list", "link"] as const)("copies the live setting's exact %s format from the owning window", async (initial) => {
		let format: TimestampCopyFormat = initial;
		const host: VideoViewHost = {
			getTranscriptHeading: () => "Transcript",
			getTimestampCopyFormat: () => format,
			isTranscriptShown: () => false,
			toggleTranscript: async () => {},
			onPlayback: () => {},
			focusNote: async () => {},
		};
		const view = new VideoView({} as WorkspaceLeaf, host);
		view.contentEl = document.createElement("div");
		Object.assign(view, { videoId: "VID", player: { info: { currentTime: 65.9 } } });
		const link = timestampLink("VID", 65.9);
		await view.copyTimestampLink();
		expect(writeClipboard).toHaveBeenLastCalledWith(document.defaultView, format === "list" ? `- ${link}: ` : link);
		format = initial === "list" ? "link" : "list";
		await view.copyTimestampLink();
		expect(writeClipboard).toHaveBeenLastCalledWith(document.defaultView, format === "list" ? `- ${link}: ` : link);
	});

	it("reports clipboard failure instead of claiming the timestamp was copied", async () => {
		writeClipboard.mockRejectedValue(new Error("Clipboard denied"));
		const view = new VideoView({} as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript",
			getTimestampCopyFormat: () => "list",
			isTranscriptShown: () => false,
			toggleTranscript: async () => {},
			onPlayback: () => {},
			focusNote: async () => {},
		});
		view.contentEl = document.createElement("div");
		Object.assign(view, { videoId: "VID", player: { info: { currentTime: 65 } } });
		await view.copyTimestampLink();
		expect(createdNotices.map((notice) => notice.message)).toEqual(["Could not write to the clipboard."]);
	});
});
