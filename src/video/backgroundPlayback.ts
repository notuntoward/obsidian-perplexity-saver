import { Notice, type App } from "obsidian";
import { writeClipboardIn } from "commons/windows";
import { PLAYBACK_RATES, type TimestampInsertionTime, type VideoView } from "./videoView";
import { YouTubeEmbed } from "./youtubePlayer";
import { formatClock, timestampClipboardText, watchUrl, type TimestampCopyFormat } from "./youtubeLinks";
import { insertionMessage, insertPlaybackTimestamp, type NoteInsertionTarget, type TimestampListStyle } from "./noteInsertion";

export type NotePlayback = Pick<VideoView,
	"getVideoId" | "getFilePath" | "getPlaybackSeconds" | "getPlaybackToken" | "getDuration" | "seekTo" |
	"isPlaying" | "isReady" | "togglePlay" | "pausePlayback" | "stepRate" | "setRate" |
	"copyTimestampLink" | "openInBrowser" | "insertTimestampBullet">;

interface BackgroundPlaybackHost {
	getTimestampCopyFormat(): TimestampCopyFormat;
	getTimestampListStyle?(): TimestampListStyle;
	getPausePlaybackOnMediaActions?(): boolean;
	getTimestampInsertionTime?(playback: BackgroundPlayback): TimestampInsertionTime;
	onPlayback(videoId: string, filePath: string, seconds: number, stateChanged?: boolean): void;
	remember(videoId: string, filePath: string, seconds: number): void;
	focusNote(target: NoteInsertionTarget): Promise<void>;
}

/** Audio transport owned by a transcript, never a workspace leaf or a focus target. */
export class BackgroundPlayback implements NotePlayback {
	private readonly container: HTMLElement;
	private readonly player: YouTubeEmbed;
	private destroyed = false;
	private playbackRevision = 0;
	private rate = 1;

	constructor(
		private readonly app: App,
		parent: HTMLElement,
		private filePath: string,
		private readonly videoId: string,
		seconds: number,
		private readonly host: BackgroundPlaybackHost,
		options: { autoplay?: boolean; playbackRate?: number } = {}
	) {
		this.container = parent.createDiv({ cls: "perplexity-saver-background-playback" });
		this.container.setAttribute("aria-hidden", "true");
		this.rate = options.playbackRate ?? 1;
		let lastPlayerState: number | null = null;
		this.player = new YouTubeEmbed(this.container, videoId, seconds, (info) => {
			const stateChanged = lastPlayerState !== info.playerState;
			lastPlayerState = info.playerState;
			this.host.onPlayback(videoId, this.filePath, info.currentTime, stateChanged);
		}, { ...options, captions: false });
		if (options.autoplay) this.player.play();
	}

	getVideoId(): string { return this.videoId; }
	renameFile(path: string): void {
		if (path !== this.filePath) this.playbackRevision++;
		this.filePath = path;
	}
	getFilePath(): string { return this.filePath; }
	getPlaybackSeconds(): number { return this.player.info.currentTime; }
	getDuration(): number { return this.player.info.duration; }
	getPlaybackToken(): { player: object; revision: number } | null {
		return this.destroyed ? null : { player: this.player, revision: this.playbackRevision };
	}
	getPlaybackRate(): number { return this.rate; }
	isPlaying(): boolean { return this.player.playing; }
	isReady(): boolean { return this.player.isReady(); }
	togglePlay(): void { this.player.toggle(); }
	pausePlayback(): void { this.player.pause(); }
	seekTo(seconds: number): void { this.player.seekTo(seconds); }
	play(): void { this.player.play(); }
	setRate(rate: number): void {
		this.rate = rate;
		this.player.setPlaybackRate(rate);
	}
	stepRate(direction: 1 | -1): void {
		const index = PLAYBACK_RATES.indexOf(this.rate);
		this.setRate(PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0,
			(index < 0 ? PLAYBACK_RATES.indexOf(1) : index) + direction))]);
	}
	async copyTimestampLink(): Promise<void> {
		const win = this.container.ownerDocument.defaultView;
		const time = this.host.getTimestampInsertionTime?.(this) ?? { seconds: this.getPlaybackSeconds(), selected: false };
		if ("error" in time) {
			new Notice(time.error);
			return;
		}
		if (this.host.getPausePlaybackOnMediaActions?.() ?? true) this.pausePlayback();
		const text = timestampClipboardText(this.videoId, time.seconds, this.host.getTimestampCopyFormat());
		const copied = win ? await writeClipboardIn(win, text).catch(() => false) : false;
		new Notice(copied ? `Copied ${formatClock(time.seconds)} timestamp.` : "Could not write to the clipboard.");
	}
	openInBrowser(): void {
		this.pausePlayback();
		this.container.ownerDocument.defaultView?.open(watchUrl(this.videoId, Math.floor(this.getPlaybackSeconds())), "_blank");
	}
	async insertTimestampBullet(target: NoteInsertionTarget, seconds = this.getPlaybackSeconds()): Promise<boolean> {
		const insertion = insertPlaybackTimestamp(target, this.videoId, seconds, () => {
			if (this.host.getPausePlaybackOnMediaActions?.() ?? true) this.pausePlayback();
		}, this.host.getTimestampListStyle?.() ?? "match");
		if (insertion) {
			const message = insertionMessage("Timestamp", insertion);
			try {
				await this.host.focusNote(target);
				new Notice(message);
			} catch (error) {
				console.error("Perplexity Saver: could not focus note after insertion", error);
				new Notice(`${message} Could not return focus to the note.`);
			}
		}
		return !!insertion;
	}
	transferTo(parent: HTMLElement): BackgroundPlayback {
		const seconds = this.getPlaybackSeconds();
		const autoplay = this.isPlaying();
		this.destroy();
		return new BackgroundPlayback(this.app, parent, this.filePath, this.videoId, seconds, this.host,
			{ autoplay, playbackRate: this.rate });
	}
	destroy(remember = true): void {
		if (this.destroyed) return;
		this.destroyed = true;
		try {
			if (remember) this.host.remember(this.videoId, this.filePath, this.getPlaybackSeconds());
		} finally {
			this.player.destroy();
			this.container.remove();
		}
	}
}
