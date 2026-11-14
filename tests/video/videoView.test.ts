// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import { createdNotices } from "../__mocks__/obsidian";
import { VideoView, type VideoViewHost } from "../../src/video/videoView";
import { timestampLink, type TimestampCopyFormat } from "../../src/video/youtubeLinks";
import { MockMenu } from "commons/testing";

const writeClipboard = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async (original) => {
	const { MockMenu, setIcon } = await import("commons/testing");
	return { ...await original<Record<string, unknown>>(), Menu: MockMenu, setIcon };
});
vi.mock("commons/windows", async (original) => ({
	...await original<Record<string, unknown>>(),
	writeClipboardIn: writeClipboard,
}));

describe("video timestamp copy", () => {
	beforeEach(() => {
		writeClipboard.mockReset().mockResolvedValue(true);
		createdNotices.length = 0;
	});

	describe("explicit playback resumption", () => {
		function viewer(doc = document) {
			const rememberPlayback = vi.fn();
			const view = new VideoView({ app: { vault: { getFileByPath: () => null } } } as unknown as WorkspaceLeaf, {
				getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
				getShowYoutubeCaptions: () => false, getToolbarCaptureAction: () => "insert",
				insertTimestamp: async () => {}, insertScreenshot: async () => {},
				isTranscriptShown: () => false, toggleTranscript: async () => {},
				jumpToTranscriptTimestamp: () => {}, onPlayback: () => {}, focusNote: async () => {}, rememberPlayback,
			});
			view.contentEl = doc.createElement("div");
			const player = {
				info: { currentTime: 0, playerState: 2 }, destroy: vi.fn(), pause: vi.fn(), play: vi.fn(), toggle: vi.fn(),
				seekTo: vi.fn((seconds: number) => { player.info.currentTime = seconds; }),
			};
			Object.assign(view, { videoId: "abc", filePath: "note.md", marks: [0], player, playBtn: doc.createElement("button") });
			return { view, player, rememberPlayback };
		}

		beforeEach(() => { MockMenu.last = null; });

		it.each([
			{ popout: false, choice: 0, seconds: 125.75 },
			{ popout: false, choice: 1, seconds: 0 },
			{ popout: true, choice: 0, seconds: 125.75 },
			{ popout: true, choice: 1, seconds: 0 },
		])("waits for choice $choice in the owning document (popout: $popout)", async ({ popout, choice, seconds }) => {
			const doc = popout ? document.implementation.createHTMLDocument() : document;
			const { view, player } = viewer(doc);
			const showMenu = vi.spyOn(MockMenu.prototype, "showAtPosition");
			await view.setState({ videoId: "abc", file: "note.md", time: 0, resumeAt: 125.75, autoplay: true }, { history: false });
			expect(view.getState()).toHaveProperty("resumeAt", 125.75);
			expect(view.getPlaybackSeconds()).toBe(0);
			expect(player.play).not.toHaveBeenCalled();
			view.togglePlay();
			expect(player.toggle).not.toHaveBeenCalled();
			expect(showMenu).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0 }), doc);
			expect(MockMenu.last?.items.map((item) => item.title)).toEqual(["Resume at 2:05", "Start from beginning"]);
			MockMenu.last!.items[choice].click();
			expect(player.seekTo).toHaveBeenLastCalledWith(seconds);
			expect(player.play).toHaveBeenCalledOnce();
			expect(view.getState()).not.toHaveProperty("resumeAt");
			view.togglePlay();
			expect(player.toggle).toHaveBeenCalledOnce();
			showMenu.mockRestore();
		});

		it("keeps the bookmark when closed without choosing, including restored pending state", async () => {
			const { view } = viewer();
			await view.setState({ videoId: "abc", file: "note.md", time: 0, resumeAt: 125.75 }, { history: false });
			const restored = viewer();
			await restored.view.setState(view.getState(), { history: false });
			await restored.view.onClose();
			expect(restored.rememberPlayback).toHaveBeenCalledWith("abc", "note.md", 125.75);
		});

		it("timestamp navigation dismisses the choice and invalidates an already-open start menu", async () => {
			const { view, player } = viewer();
			await view.setState({ videoId: "abc", time: 0, resumeAt: 125.75 }, { history: false });
			view.togglePlay();
			const menu = MockMenu.last!;
			view.seekTo(64);
			expect(view.getState()).not.toHaveProperty("resumeAt");
			menu.items[0].click();
			expect(player.seekTo).toHaveBeenLastCalledWith(64);
			expect(player.play).not.toHaveBeenCalled();
			view.togglePlay();
			expect(player.toggle).toHaveBeenCalledOnce();
		});
	});

	it.each([1, 2])("exposes exact playback time independently of playing/paused state (%s)", (playerState) => {
		const view = new VideoView({} as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			getShowYoutubeCaptions: () => false,
			getToolbarCaptureAction: () => "insert", insertTimestamp: async () => {}, insertScreenshot: async () => {},
			isTranscriptShown: () => false, toggleTranscript: async () => {}, jumpToTranscriptTimestamp: () => {}, onPlayback: () => {}, focusNote: async () => {},
		});

		Object.assign(view, { startTime: 27.25 });
		expect(view.getPlaybackSeconds()).toBe(27.25);
		Object.assign(view, { player: { info: { currentTime: 55.75, playerState } } });
		expect(view.getPlaybackSeconds()).toBe(55.75);
	});

	it("remembers position before destroying a manually closed player", async () => {
		const rememberPlayback = vi.fn();
		const destroy = vi.fn();
		const view = new VideoView({} as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			getShowYoutubeCaptions: () => false, getToolbarCaptureAction: () => "insert",
			insertTimestamp: async () => {}, insertScreenshot: async () => {},
			isTranscriptShown: () => false, toggleTranscript: async () => {},
			jumpToTranscriptTimestamp: () => {},
			onPlayback: () => {}, focusNote: async () => {}, rememberPlayback,
		});
		Object.assign(view, { videoId: "abc", filePath: "note.md", player: { info: { currentTime: 123.75 }, destroy } });
		await view.onClose();
		expect(rememberPlayback).toHaveBeenCalledWith("abc", "note.md", 123.75);
		expect(rememberPlayback.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]);
	});

	it("surfaces transcript activation failures from the viewer button/command", async () => {
		const error = new Error("Could not reveal leaf");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = { vault: { getFileByPath: () => null } };
		const view = new VideoView({ app } as unknown as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			getShowYoutubeCaptions: () => false,
			getToolbarCaptureAction: () => "insert", insertTimestamp: async () => {}, insertScreenshot: async () => {},
			isTranscriptShown: () => false, toggleTranscript: async () => { throw error; }, jumpToTranscriptTimestamp: () => {}, onPlayback: () => {}, focusNote: async () => {},
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
			getShowYoutubeCaptions: () => false,
			getToolbarCaptureAction: () => "insert", insertTimestamp: async () => {}, insertScreenshot: async () => {},
			isTranscriptShown: () => false,
			toggleTranscript: async () => {},
			jumpToTranscriptTimestamp: () => {},
			onPlayback: () => {},
			focusNote: async () => {},
		};
		const view = new VideoView({} as WorkspaceLeaf, host);
		view.contentEl = document.createElement("div");
		const pause = vi.fn();
		Object.assign(view, { videoId: "VID", player: { info: { currentTime: 65.9 }, pause } });
		const link = timestampLink("VID", 65.9);
		await view.copyTimestampLink();
		expect(writeClipboard).toHaveBeenLastCalledWith(document.defaultView, format === "list" ? `- ${link}: ` : link);
		format = initial === "list" ? "link" : "list";
		await view.copyTimestampLink();
		expect(writeClipboard).toHaveBeenLastCalledWith(document.defaultView, format === "list" ? `- ${link}: ` : link);
		expect(pause).toHaveBeenCalledTimes(2);
	});

	it("reports clipboard failure instead of claiming the timestamp was copied", async () => {
		writeClipboard.mockRejectedValue(new Error("Clipboard denied"));
		const view = new VideoView({} as WorkspaceLeaf, {
			getTranscriptHeading: () => "Transcript",
			getTimestampCopyFormat: () => "list",
			getShowYoutubeCaptions: () => false,
			getToolbarCaptureAction: () => "insert", insertTimestamp: async () => {}, insertScreenshot: async () => {},
			isTranscriptShown: () => false,
			toggleTranscript: async () => {},
			jumpToTranscriptTimestamp: () => {},
			onPlayback: () => {},
			focusNote: async () => {},
		});
		view.contentEl = document.createElement("div");
		Object.assign(view, { videoId: "VID", player: { info: { currentTime: 65 }, pause: vi.fn() } });
		await view.copyTimestampLink();
		expect(createdNotices.map((notice) => notice.message)).toEqual(["Could not write to the clipboard."]);
	});
});
