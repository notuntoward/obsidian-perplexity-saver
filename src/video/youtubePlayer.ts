import { setTimeoutIn, type CancelTimer } from "commons/windows";
import { embedUrl } from "./youtubeLinks";

/** YouTube player states reported in `infoDelivery` messages. */
export const PLAYER_STATE = { unstarted: -1, ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 } as const;

export interface PlayerInfo {
	currentTime: number;
	duration: number;
	playerState: number;
	playbackRate: number;
}

/** Merge a YouTube `infoDelivery`/`initialDelivery` payload into the known player info. */
export function applyPlayerMessage(info: PlayerInfo, data: unknown): boolean {
	let message: unknown = data;
	if (typeof data === "string") {
		try {
			message = JSON.parse(data);
		} catch {
			return false;
		}
	}
	const payload = (message as { info?: Record<string, unknown> } | null)?.info;
	if (!payload || typeof payload !== "object") return false;
	let changed = false;
	for (const key of ["currentTime", "duration", "playerState", "playbackRate"] as const) {
		const value = payload[key];
		if (typeof value === "number" && Number.isFinite(value) && info[key] !== value) {
			info[key] = value;
			changed = true;
		}
	}
	return changed;
}

const LISTEN_INTERVAL_MS = 250;
const LISTEN_ATTEMPTS = 40;
let nextWidgetId = 1;

function messageId(data: unknown): unknown {
	if (typeof data !== "string") return (data as { id?: unknown } | null)?.id;
	try {
		return (JSON.parse(data) as { id?: unknown } | null)?.id;
	} catch {
		return undefined;
	}
}

/**
 * A YouTube embed driven through the iframe postMessage protocol (the same
 * protocol Media Extended uses), without loading YouTube's iframe_api script.
 */
export class YouTubeEmbed {
	readonly iframe: HTMLIFrameElement;
	readonly info: PlayerInfo = { currentTime: 0, duration: 0, playerState: PLAYER_STATE.unstarted, playbackRate: 1 };
	private boundWindow: Window | null = null;
	private cancelListen: CancelTimer | null = null;
	private pendingSeek: number | null = null;
	private desiredRate = 1;
	private autoplay: boolean;
	private ready = false;
	private listenAttempts = 0;
	private readonly widgetId = `perplexity-saver-${nextWidgetId++}`;
	private readonly onMessage = (evt: MessageEvent): void => {
		// In a pop-out the event's source may not be identical to contentWindow, so the widget id also identifies the player.
		if (evt.source !== this.iframe.contentWindow && messageId(evt.data) !== this.widgetId) return;
		if (!applyPlayerMessage(this.info, evt.data)) return;
		if (!this.ready) {
			this.ready = true;
			this.cancelListen?.();
			this.cancelListen = null;
			if (this.pendingSeek !== null) this.seekTo(this.pendingSeek);
			this.pendingSeek = null;
			if (this.desiredRate !== 1) this.setPlaybackRate(this.desiredRate);
			if (this.autoplay) this.play();
			else this.pause();
			this.autoplay = false;
		}
		this.onUpdate(this.info);
	};
	private readonly onLoad = (): void => {
		this.bindWindow();
		this.ready = false;
		this.listenAttempts = 0;
		this.scheduleListen(100);
	};

	/** Repeat YouTube's "listening" handshake until the player starts reporting its state. */
	private scheduleListen(ms: number): void {
		this.cancelListen?.();
		this.cancelListen = null;
		const win = this.boundWindow;
		if (!win || this.ready || this.listenAttempts >= LISTEN_ATTEMPTS) return;
		this.cancelListen = setTimeoutIn(
			win,
			() => {
				this.listenAttempts++;
				this.post({ event: "listening", id: this.widgetId, channel: "widget" });
				this.scheduleListen(LISTEN_INTERVAL_MS);
			},
			ms
		);
	}

	constructor(
		parent: HTMLElement,
		readonly videoId: string,
		startSeconds: number,
		private readonly onUpdate: (info: PlayerInfo) => void,
		options: { autoplay?: boolean; playbackRate?: number } = {}
	) {
		this.info.currentTime = startSeconds;
		this.autoplay = options.autoplay ?? false;
		this.desiredRate = options.playbackRate ?? 1;
		this.iframe = parent.createEl("iframe", {
			cls: "perplexity-saver-video-iframe",
			attr: {
				src: embedUrl(videoId, startSeconds),
				frameborder: "0",
				allow: "autoplay; encrypted-media; picture-in-picture",
				referrerpolicy: "strict-origin-when-cross-origin",
				title: "YouTube video player",
				// Keyboard focus stays in Obsidian: keys typed inside the YouTube page never reach Obsidian's hotkeys.
				tabindex: "-1",
			},
		});
		this.iframe.addEventListener("load", this.onLoad);
		this.bindWindow();
	}

	/** Listen for player messages on the window that currently owns the iframe (main window or pop-out). */
	private bindWindow(): void {
		const win = this.iframe.ownerDocument.defaultView;
		if (win === this.boundWindow) return;
		this.boundWindow?.removeEventListener("message", this.onMessage);
		this.boundWindow = win;
		win?.addEventListener("message", this.onMessage);
	}

	private post(message: Record<string, unknown>): void {
		this.bindWindow();
		try {
			this.iframe.contentWindow?.postMessage(JSON.stringify(message), "*");
		} catch {
			// The iframe is navigating or gone.
		}
	}

	private command(func: string, args: unknown[] = []): void {
		this.post({ event: "command", func, args, id: this.widgetId, channel: "widget" });
	}

	get playing(): boolean {
		return this.info.playerState === PLAYER_STATE.playing || this.info.playerState === PLAYER_STATE.buffering;
	}

	// Updates the state optimistically so the controls keep working if the player's replies are lost.
	play(): void {
		if (!this.ready) this.autoplay = true;
		this.command("playVideo");
		this.setOptimisticState(PLAYER_STATE.playing);
	}

	pause(): void {
		if (!this.ready) this.autoplay = false;
		this.command("pauseVideo");
		this.setOptimisticState(PLAYER_STATE.paused);
	}

	private setOptimisticState(state: number): void {
		if (this.info.playerState === state) return;
		this.info.playerState = state;
		this.onUpdate(this.info);
	}

	toggle(): void {
		if (this.playing) this.pause();
		else this.play();
	}

	seekTo(seconds: number): void {
		const keepPlaying = this.ready ? this.playing : this.autoplay;
		const max = this.info.duration > 0 ? this.info.duration : Number.POSITIVE_INFINITY;
		const target = Math.min(max, Math.max(0, seconds));
		this.info.currentTime = target;
		if (!this.ready) this.pendingSeek = target;
		this.command("seekTo", [target, true]);
		// YouTube can start a cued video when seeking; seeking alone is not a play request.
		if (!keepPlaying) this.pause();
		this.onUpdate(this.info);
	}

	setPlaybackRate(rate: number): void {
		this.desiredRate = rate;
		this.command("setPlaybackRate", [rate]);
	}

	destroy(): void {
		this.cancelListen?.();
		this.iframe.removeEventListener("load", this.onLoad);
		this.boundWindow?.removeEventListener("message", this.onMessage);
		this.boundWindow = null;
		this.iframe.remove();
	}
}
