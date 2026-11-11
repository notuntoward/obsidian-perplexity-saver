// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import "commons/testing";
import { BackgroundPlayback } from "../../src/video/backgroundPlayback";

const embeds = vi.hoisted(() => ({ instances: [] as Array<{
	info: { currentTime: number; playbackRate: number };
	playing: boolean;
	toggle: ReturnType<typeof vi.fn>;
	seekTo: ReturnType<typeof vi.fn>;
	setPlaybackRate: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}> }));
vi.mock("../../src/video/youtubePlayer", async (original) => {
	const actual = await original<Record<string, unknown>>();
	return {
		...actual,
		YouTubeEmbed: class {
			info: { currentTime: number; playbackRate: number };
			playing = false;
			iframe: HTMLIFrameElement;
			constructor(parent: HTMLElement, _id: string, seconds: number) {
				this.info = { currentTime: seconds, playbackRate: 1 };
				this.iframe = parent.createEl("iframe");
				embeds.instances.push(this);
			}
			toggle = vi.fn(() => { this.playing = !this.playing; });
			pause = vi.fn(() => { this.playing = false; });
			play = vi.fn(() => { this.playing = true; });
			seekTo = vi.fn((seconds: number) => { this.info.currentTime = seconds; });
			setPlaybackRate = vi.fn((rate: number) => { this.info.playbackRate = rate; });
			destroy = vi.fn();
		},
	};
});

describe("transcript background playback", () => {
	beforeEach(() => {
		document.body.replaceChildren();
		embeds.instances.length = 0;
	});

	it("runs play, seek and speed without a workspace leaf and saves position on cleanup", () => {
		const parent = document.body.createDiv();
		const remember = vi.fn();
		const playback = new BackgroundPlayback({} as App, parent, "note.md", "dQw4w9WgXcQ", 42, {
			getTranscriptHeading: () => "Transcript",
			getTimestampCopyFormat: () => "list",
			onPlayback: vi.fn(),
			remember,
			focusNote: vi.fn(),
		});
		const player = embeds.instances[0];
		playback.togglePlay();
		expect(player.playing).toBe(true);
		playback.skip(10);
		expect(player.seekTo).toHaveBeenLastCalledWith(52);
		playback.stepRate(1);
		expect(player.setPlaybackRate).toHaveBeenLastCalledWith(1.25);
		playback.setRate(1);
		expect(player.setPlaybackRate).toHaveBeenLastCalledWith(1);
		expect(parent.querySelector(".workspace-leaf")).toBeNull();
		expect(parent.querySelector("[aria-hidden='true']")).not.toBeNull();
		playback.destroy();
		expect(remember).toHaveBeenCalledWith("dQw4w9WgXcQ", "note.md", 52);
		expect(player.destroy).toHaveBeenCalledOnce();
		expect(parent.children).toHaveLength(0);
		playback.destroy();
		expect(player.destroy).toHaveBeenCalledOnce();
	});

	it("creates its embed in the transcript's document rather than the main window", () => {
		const other = document.implementation.createHTMLDocument();
		const parent = other.body.createDiv();
		const playback = new BackgroundPlayback({} as App, parent, "note.md", "dQw4w9WgXcQ", 0, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			onPlayback: vi.fn(), remember: vi.fn(), focusNote: vi.fn(),
		});
		expect(parent.querySelector("iframe")?.ownerDocument).toBe(other);
		expect(document.querySelector("iframe")).toBeNull();
		playback.destroy();
	});

	it("transfers playback to a replacement transcript only after destroying the old embed", () => {
		const parent = document.body.createDiv();
		const next = document.body.createDiv();
		const remember = vi.fn();
		const playback = new BackgroundPlayback({} as App, parent, "note.md", "dQw4w9WgXcQ", 31, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			onPlayback: vi.fn(), remember, focusNote: vi.fn(),
		});
		playback.play();
		playback.setRate(1.5);
		const moved = playback.transferTo(next);
		expect(embeds.instances[0].destroy).toHaveBeenCalledOnce();
		expect(parent.childElementCount).toBe(0);
		expect(next.querySelector("iframe")).not.toBeNull();
		expect(moved.getPlaybackSeconds()).toBe(31);
		expect(moved.getPlaybackRate()).toBe(1.5);
		expect(moved.isPlaying()).toBe(true);
		moved.destroy();
	});

	it("releases the embed even if position persistence throws", () => {
		const parent = document.body.createDiv();
		const playback = new BackgroundPlayback({} as App, parent, "note.md", "dQw4w9WgXcQ", 0, {
			getTranscriptHeading: () => "Transcript", getTimestampCopyFormat: () => "list",
			onPlayback: vi.fn(), remember: () => { throw new Error("Cannot save"); }, focusNote: vi.fn(),
		});
		expect(() => playback.destroy()).toThrow("Cannot save");
		expect(embeds.instances[0].destroy).toHaveBeenCalledOnce();
		expect(parent.childElementCount).toBe(0);
	});
});
