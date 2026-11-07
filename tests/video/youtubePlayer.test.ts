import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYER_STATE, YouTubeEmbed } from "../../src/video/youtubePlayer";

type Listener = (evt: unknown) => void;

/** A window with its own listeners and fake-timer-backed setTimeout, like a pop-out. */
function fakeWindow() {
	const listeners = new Map<string, Set<Listener>>();
	return {
		addEventListener: (type: string, fn: Listener) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(fn);
		},
		removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		dispatch(type: string, evt: unknown) {
			for (const fn of [...(listeners.get(type) ?? [])]) fn(evt);
		},
		count: (type: string) => listeners.get(type)?.size ?? 0,
	};
}

function setup(options: { autoplay?: boolean } = {}) {
	const win = fakeWindow();
	const contentWindow = { postMessage: vi.fn() };
	const iframeListeners = new Map<string, Listener>();
	const iframe = {
		ownerDocument: { defaultView: win },
		contentWindow,
		addEventListener: (type: string, fn: Listener) => iframeListeners.set(type, fn),
		removeEventListener: (type: string) => iframeListeners.delete(type),
		remove: vi.fn(),
	};
	const parent = { createEl: vi.fn(() => iframe) };
	const onUpdate = vi.fn();
	const player = new YouTubeEmbed(parent as unknown as HTMLElement, "VID", 30, onUpdate, options);
	const posted = (): Record<string, unknown>[] =>
		contentWindow.postMessage.mock.calls.map(([data]) => JSON.parse(data as string) as Record<string, unknown>);
	const commands = (): string[] => posted().filter((m) => m.event === "command").map((m) => m.func as string);
	const load = (): void => iframeListeners.get("load")?.({});
	const reply = (info: Record<string, unknown>, source: unknown = contentWindow, extra: Record<string, unknown> = {}): void =>
		win.dispatch("message", {
			source,
			origin: "https://www.youtube.com",
			data: JSON.stringify({ event: "infoDelivery", info, ...extra }),
		});
	return { win, player, posted, commands, load, reply, onUpdate, contentWindow };
}

describe("YouTubeEmbed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("repeats the listening handshake until the player replies", () => {
		const t = setup();
		t.load();
		vi.advanceTimersByTime(2000);
		const before = t.posted().filter((m) => m.event === "listening").length;
		expect(before).toBeGreaterThan(1);
		t.reply({ currentTime: 30, playerState: PLAYER_STATE.cued });
		vi.advanceTimersByTime(2000);
		expect(t.posted().filter((m) => m.event === "listening").length).toBe(before);
	});

	it("accepts replies carrying its widget id even when the source window object differs", () => {
		const t = setup();
		t.load();
		vi.advanceTimersByTime(200);
		const id = t.posted().find((m) => m.event === "listening")?.id;
		expect(id).toBeTruthy();
		t.reply({ currentTime: 42 }, { other: true }, { id });
		expect(t.player.info.currentTime).toBe(42);
		t.reply({ currentTime: 50 }, { other: true }, { id: "someone-else" });
		expect(t.player.info.currentTime).toBe(42);
	});

	it("still pauses, seeks and changes speed when the player never replies", () => {
		const t = setup();
		t.load();
		t.player.toggle();
		t.player.toggle();
		t.player.seekTo(90);
		t.player.setPlaybackRate(1.5);
		expect(t.commands()).toEqual(["playVideo", "pauseVideo", "seekTo", "pauseVideo", "setPlaybackRate"]);
		expect(t.player.playing).toBe(false);
	});

	it("does not autoplay unless asked", () => {
		const t = setup();
		t.load();
		t.reply({ currentTime: 30, playerState: PLAYER_STATE.cued });
		expect(t.commands()).not.toContain("playVideo");
	});

	it("keeps a seek paused before readiness and after a delayed playing reply", () => {
		const t = setup();
		t.player.seekTo(65);
		expect(t.commands().slice(-2)).toEqual(["seekTo", "pauseVideo"]);
		t.load();
		t.reply({ currentTime: 65, playerState: PLAYER_STATE.playing });
		expect(t.commands().at(-1)).toBe("pauseVideo");
		expect(t.player.playing).toBe(false);
	});

	it("keeps paused seeks paused but does not interrupt an already-playing video", () => {
		const t = setup();
		t.reply({ currentTime: 30, playerState: PLAYER_STATE.paused });
		t.player.seekTo(65);
		expect(t.commands().slice(-2)).toEqual(["seekTo", "pauseVideo"]);
		t.player.play();
		t.player.seekTo(90);
		expect(t.commands().at(-1)).toBe("seekTo");
		expect(t.player.playing).toBe(true);
	});

	it("honors explicit playback before readiness and explicit cancellation of autoplay", () => {
		const playing = setup();
		playing.player.play();
		playing.reply({ currentTime: 30, playerState: PLAYER_STATE.cued });
		expect(playing.player.playing).toBe(true);
		const paused = setup({ autoplay: true });
		paused.player.pause();
		paused.reply({ currentTime: 30, playerState: PLAYER_STATE.cued });
		expect(paused.commands()).not.toContain("playVideo");
	});

	it("plays when opened with explicit timestamp playback", () => {
		const t = setup({ autoplay: true });
		t.reply({ currentTime: 30, playerState: PLAYER_STATE.cued });
		expect(t.commands().at(-1)).toBe("playVideo");
		expect(t.player.playing).toBe(true);
	});

	it("stops listening on destroy", () => {
		const t = setup();
		t.load();
		expect(t.win.count("message")).toBe(1);
		t.player.destroy();
		expect(t.win.count("message")).toBe(0);
	});
});
