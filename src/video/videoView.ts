import { ItemView, Menu, Notice, Platform, TFile, setIcon } from "obsidian";
import type { App, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { captureElementImage } from "commons/os";
import { findLeafForFile, getActiveLeafInFocusedWindow, getWindowForLeaf, loadLeafIfDeferred } from "commons/workspace";
import { requestFrameIn, setTimeoutIn, writeClipboardIn } from "commons/windows";
import { getCommandHotkeyLabel, renderKeyHints } from "commons/modal";
import { findTranscriptRange } from "../litNote/transcriptSection";
import {
	blockInsertion,
	getNoteInsertionPosition,
	insertAtNoteInsertionAnchor,
	releaseNoteInsertionAnchor,
	insertPlaybackTimestamp,
	timestampedScreenshotItem,
	type NoteInsertionTarget,
	type TimestampListStyle,
} from "./noteInsertion";
import {
	clampPan,
	collectNoteTimestamps,
	findNoteVideoId,
	formatClock,
	screenshotClipboardText,
	screenshotFileName,
	snipRect,
	timestampClipboardText,
	watchUrl,
	zoomAt,
	type SnipRect,
	type ZoomState,
	type TimestampCopyFormat,
} from "./youtubeLinks";
import { PLAYER_STATE, YouTubeEmbed, type PlayerInfo } from "./youtubePlayer";

export const VIDEO_VIEW_TYPE = "perplexity-saver-video";

export type VideoViewerLocation = "split" | "window";
export type VideoToolbarCaptureAction = "copy" | "insert";

export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export async function loadNoteVideoMarks(app: App, filePath: string, videoId: string, heading: string): Promise<number[]> {
	const file = app.vault.getFileByPath(filePath);
	if (!file) return [];
	const content = await app.vault.cachedRead(file);
	const headings = app.metadataCache.getFileCache(file)?.headings;
	return collectNoteTimestamps(content, videoId, findTranscriptRange(content, headings, heading));
}

const SKIP_SECONDS = 10;
const ARROW_SECONDS = 5;
const ZOOM_STEP = 1.25;
const PAGE_SECONDS = 60;

interface VideoViewState {
	videoId?: string | null;
	file?: string | null;
	time?: number;
	autoplay?: boolean;
	resumeAt?: number;
}

export interface VideoViewHost {
	getTranscriptHeading(): string;
	getTimestampCopyFormat(): TimestampCopyFormat;
	getTimestampListStyle?(): TimestampListStyle;
	getToolbarCaptureAction(): VideoToolbarCaptureAction;
	getShowYoutubeCaptions(): boolean;
	getTranscriptUnit?(filePath: string | null): "sentence" | "caption";
	insertTimestamp(view: VideoView): Promise<void>;
	insertScreenshot(view: VideoView, whole: boolean): Promise<void>;
	/** True when a transcript panel the button controls is on screen. */
	isTranscriptShown(viewer: WorkspaceLeaf): boolean;
	/** Close that transcript panel if it is on screen, otherwise show the note's transcript (beside a pop-out viewer, else per the plugin setting). */
	toggleTranscript(file: TFile | null, viewer: WorkspaceLeaf): Promise<void>;
	jumpToTranscriptTimestamp(view: VideoView, direction: 1 | -1): void;
	/** Called on every player update with the current position, so transcript panels can follow playback. */
	onPlayback(videoId: string, filePath: string | null, seconds: number, stateChanged?: boolean): void;
	rememberPlayback?(videoId: string, filePath: string | null, seconds: number): void;
	focusNote(target: NoteInsertionTarget): Promise<void>;
}

/** YouTube player with custom controls, a timeline marked with the note's own timestamps, zoom/pan, and screenshots. */
export class VideoView extends ItemView {
	private videoId: string | null = null;
	private filePath: string | null = null;
	private startTime = 0;
	private resumeAt: number | null = null;
	private player: YouTubeEmbed | null = null;
	private lastReportedPlayerState: number | null = null;
	private playbackRevision = 0;
	private marks: number[] = [];
	private zoom: ZoomState = { zoom: 1, x: 0, y: 0 };
	private marksToken = 0;

	private stageEl!: HTMLElement;
	private frameEl!: HTMLElement;
	private playBtn!: HTMLElement;
	private timeEl!: HTMLElement;
	private rateBtn!: HTMLElement;
	private rateLabel!: HTMLElement;
	private rate = 1;
	private snip: SnipSession | null = null;
	private trackEl!: HTMLElement;
	private marksEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private transcriptBtn!: HTMLElement;
	private previousTranscriptBtn!: HTMLElement;
	private nextTranscriptBtn!: HTMLElement;
	private transcriptUnitLabel!: HTMLElement;
	private screenshotBtn?: HTMLElement;
	private helpEl!: HTMLElement;
	private helpBtn!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private readonly host: VideoViewHost) {
		super(leaf);
	}

	getViewType(): string {
		return VIDEO_VIEW_TYPE;
	}

	getDisplayText(): string {
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		return file ? `Video: ${file.basename}` : "Video";
	}

	getIcon(): string {
		return "youtube";
	}

	async onOpen(): Promise<void> {
		this.build();
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path === this.filePath) void this.refreshMarks();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (oldPath === this.filePath) {
					this.filePath = file.path;
					this.playbackRevision++;
					if (this.videoId && this.player) {
						this.lastReportedPlayerState = this.player.info.playerState;
						this.host.onPlayback(this.videoId, this.filePath, this.getPlaybackSeconds(), true);
					}
				}
			})
		);
		this.register(() => this.player?.destroy());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updateTranscriptButton()));
		this.loadPlayer();
		await this.refreshMarks();
	}

	async onClose(): Promise<void> {
		this.playbackRevision++;
		if (this.videoId) this.host.rememberPlayback?.(this.videoId, this.filePath, this.getBookmarkSeconds());
		this.player?.destroy();
		this.player = null;
	}

	onResize(): void {
		const el = this.contentEl;
		const win = el.ownerDocument.defaultView;
		if (!win || !this.stageEl || el.clientWidth <= 0 || el.clientHeight <= 0) return;
		const css = win.getComputedStyle(el);
		const width = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
		const chrome = Array.from(el.querySelectorAll<HTMLElement>(":scope > .perplexity-saver-video-position, :scope > .perplexity-saver-video-timeline, :scope > .perplexity-saver-video-controls, :scope > .perplexity-saver-video-help"))
			.filter((child) => child.getBoundingClientRect().height > 0);
		const height = el.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)
			- chrome.reduce((sum, child) => sum + child.getBoundingClientRect().height, 0)
			- (parseFloat(css.rowGap) || 0) * chrome.length;
		const previousWidth = this.stageEl.getBoundingClientRect().width;
		const nextWidth = Math.max(0, Math.min(width, height * 16 / 9));
		this.stageEl.style.width = `${nextWidth}px`;
		if (this.zoom && previousWidth > 0 && nextWidth !== previousWidth) {
			const scale = nextWidth / previousWidth;
			this.setZoom({ ...this.zoom, x: this.zoom.x * scale, y: this.zoom.y * scale });
		}
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as VideoViewState;
		await super.setState(state, result);
		if (typeof s.videoId === "string") {
			this.showVideo(s.videoId, typeof s.time === "number" ? s.time : 0, s.file ?? null, s.autoplay === true, s.resumeAt);
		}
	}

	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			videoId: this.videoId,
			file: this.filePath,
			time: Math.floor(this.player?.info.currentTime ?? this.startTime),
			...(this.resumeAt !== null ? { resumeAt: this.resumeAt } : {}),
		};
	}

	/** Path of the note the viewer was opened from (its timeline marks come from it). */
	getFilePath(): string | null {
		return this.filePath;
	}

	getVideoId(): string | null {
		return this.videoId;
	}

	/** Exact current position, including paused playback and restored viewers. */
	getPlaybackSeconds(): number {
		return this.player?.info.currentTime ?? this.startTime;
	}

	/** Closing an unstarted viewer must not erase its unchosen saved position. */
	getBookmarkSeconds(): number {
		return this.resumeAt ?? this.getPlaybackSeconds();
	}

	getPlaybackToken(): { player: object; revision: number } | null {
		return this.player ? { player: this.player, revision: this.playbackRevision } : null;
	}

	seekTo(seconds: number): void {
		this.resumeAt = null;
		this.updatePlayButton();
		this.player?.seekTo(seconds);
	}

	getPlaybackRate(): number { return this.rate; }

	isPlaying(): boolean {
		const state = this.player?.info.playerState;
		return state === PLAYER_STATE.playing || state === PLAYER_STATE.buffering;
	}

	/** True once the embed can accept commands and report real playback (false while offline). */
	isReady(): boolean {
		const player = this.player as { isReady?: () => boolean } | null;
		return !!player && (typeof player.isReady !== "function" || player.isReady());
	}

	/** Give the viewer keyboard focus, so its keys (Space, arrows, …) work. */
	focusKeys(): void {
		this.contentEl.focus({ preventScroll: true });
	}

	/** Show `videoId` at `seconds`; seeks without reloading when the video is already loaded. */
	showVideo(videoId: string, seconds: number, filePath: string | null, autoplay = false, resumeAt?: number): void {
		this.resumeAt = typeof resumeAt === "number" && Number.isFinite(resumeAt) && resumeAt > 0 ? resumeAt : null;
		if (this.resumeAt !== null) {
			seconds = 0;
			autoplay = false;
		}
		const fileChanged = filePath !== null && filePath !== this.filePath;
		if (fileChanged || this.videoId !== videoId) {
			this.playbackRevision++;
			this.lastReportedPlayerState = null;
		}
		if (filePath !== null) this.filePath = filePath;
		if (this.player && this.videoId === videoId) {
			if (this.resumeAt !== null) this.player.pause();
			this.player.seekTo(seconds);
			if (autoplay) this.player.play();
		} else {
			this.videoId = videoId;
			this.startTime = seconds;
			this.loadPlayer(autoplay);
		}
		this.updatePlayButton();
		if (fileChanged || !this.marks.length) void this.refreshMarks();
	}

	private build(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("perplexity-saver-video-view");
		el.tabIndex = 0;

		this.emptyEl = el.createDiv({
			cls: "perplexity-saver-video-empty",
			text: "Click a timestamp link to a YouTube video, or run \"Video: choose workspace...\" from a literature note.",
		});

		this.stageEl = el.createDiv({ cls: "perplexity-saver-video-stage" });
		this.frameEl = this.stageEl.createDiv({ cls: "perplexity-saver-video-frame" });
		const overlay = this.stageEl.createDiv({ cls: "perplexity-saver-video-overlay" });
		this.bindOverlay(overlay);

		const position = el.createDiv({ cls: "perplexity-saver-video-position" });
		this.timeEl = position.createSpan({ cls: "perplexity-saver-video-time", text: "0:00" });
		const timeline = el.createDiv({ cls: "perplexity-saver-video-timeline" });
		this.trackEl = timeline.createDiv({
			cls: "perplexity-saver-video-track",
			attr: {
				tabindex: "0",
				role: "slider",
				"aria-label": "Position (arrows: 5 seconds, page up/down: 1 minute, [ and ]: transcript timestamps)",
				"aria-valuemin": "0",
			},
		});
		this.trackEl.createDiv({ cls: "perplexity-saver-video-progress" });
		this.marksEl = this.trackEl.createDiv({ cls: "perplexity-saver-video-marks" });
		this.trackEl.createDiv({ cls: "perplexity-saver-video-playhead" });
		this.bindTimeline();

		const bar = el.createDiv({ cls: "perplexity-saver-video-controls" });
		const group = (name: string, label: string): HTMLElement => bar.createDiv({
			cls: "perplexity-saver-video-control-group", attr: { "data-group": name, role: "group", "aria-label": label },
		});
		const transport = group("transport", "Playback");
		this.button(transport, "", `Back ${SKIP_SECONDS} seconds (J)`, () => this.skip(-SKIP_SECONDS), "J").setText(`-${SKIP_SECONDS}s`);
		this.playBtn = this.button(transport, "play", "Play (space)", () => this.togglePlay(), "K");
		this.button(transport, "", `Forward ${SKIP_SECONDS} seconds (L)`, () => this.skip(SKIP_SECONDS), "L").setText(`+${SKIP_SECONDS}s`);

		this.rateBtn = this.button(transport, "gauge", "Playback speed", (evt) => this.showRateMenu(evt));
		this.rateBtn.addClass("perplexity-saver-video-rate");
		this.rateBtn.setAttribute("aria-keyshortcuts", "Shift+Period Shift+Comma");
		this.rateBtn.setAttribute("aria-haspopup", "menu");
		this.rateLabel = this.rateBtn.createSpan({ cls: "perplexity-saver-video-rate-label" });
		this.rateBtn.addEventListener(
			"wheel",
			(evt) => {
				evt.preventDefault();
				this.stepRate(evt.deltaY < 0 ? 1 : -1);
			},
			{ passive: false }
		);
		this.showRate(1);

		const navigation = group("navigation", "Transcript navigation");
		this.previousTranscriptBtn = this.button(navigation, "chevron-up", "", () => this.host.jumpToTranscriptTimestamp(this, -1), "[");
		this.transcriptUnitLabel = navigation.createSpan({ cls: "perplexity-saver-video-unit" });
		this.nextTranscriptBtn = this.button(navigation, "chevron-down", "", () => this.host.jumpToTranscriptTimestamp(this, 1), "]");
		const capture = group("capture", "Capture into note");
		const timestamp = this.button(capture, "file-plus-2", "Insert current timestamp into note", () => void this.host.insertTimestamp(this));
		timestamp.createSpan({ text: "Insert time" });
		this.button(capture, "copy", "Copy current timestamp link", () => void this.copyTimestampLink());
		if (Platform.isDesktopApp) {
			this.screenshotBtn = this.button(capture, "camera", "", (evt) => {
				if (this.host.getToolbarCaptureAction() === "insert") void this.host.insertScreenshot(this, evt.shiftKey);
				else void this.screenshot(evt.shiftKey);
			});
			const screenshotBtn = this.screenshotBtn;
			screenshotBtn.setAttribute("aria-haspopup", "menu");
			screenshotBtn.addEventListener("contextmenu", (evt) => this.showCaptureMenu(evt, screenshotBtn));
			const screenshotMenu = this.button(capture, "chevron-down", "Screenshot alternatives", (evt) => this.showCaptureMenu(evt, screenshotMenu));
			screenshotMenu.setAttribute("aria-haspopup", "menu");
		}
		this.updateToolbarCaptureLabels();
		const view = group("view", "View options");
		this.transcriptBtn = this.button(view, "file-text", "Show transcript (C)", () => void this.toggleTranscript(), "C");
		this.helpBtn = this.button(view, "circle-help", "Video keyboard help", () => this.toggleHelp());
		this.helpBtn.setAttribute("aria-expanded", "false");
		const more = this.button(view, "ellipsis", "More video options", () => {
			const menu = new Menu();
			menu.addItem((item) => item.setTitle("Zoom out (-)").onClick(() => this.zoomBy(1 / ZOOM_STEP)));
			menu.addItem((item) => item.setTitle("Reset zoom (0)").onClick(() => this.resetZoom()));
			menu.addItem((item) => item.setTitle("Zoom in (+)").onClick(() => this.zoomBy(ZOOM_STEP)));
			menu.addSeparator();
			menu.addItem((item) => item.setTitle("Open in browser at this time").onClick(() => this.openInBrowser()));
			const rect = more.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom }, more.ownerDocument);
		});
		more.setAttribute("aria-haspopup", "menu");
		this.helpEl = el.createDiv({ cls: "perplexity-saver-video-help", attr: { role: "region", "aria-label": "Video keyboard shortcuts" } });
		this.helpEl.hidden = true;
		this.helpEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape") return;
			evt.stopPropagation();
			this.toggleHelp(false);
			this.helpBtn.focus();
		});
		this.updateTranscriptButton();

		el.addEventListener("keydown", (evt) => this.onKey(evt));
		this.updateEmpty();
	}

	private toggleHelp(show = this.helpEl.hidden): void {
		this.helpEl.hidden = !show;
		this.helpBtn.setAttribute("aria-expanded", String(show));
		this.helpBtn.toggleClass("is-active", show);
		if (show) {
			this.helpEl.empty();
			const header = this.helpEl.createDiv({ cls: "perplexity-saver-video-help-heading", text: "Video keyboard shortcuts" });
			this.button(header, "x", "Close video keyboard help", () => this.toggleHelp(false));
			this.helpEl.createDiv({ text: "Note, player or transcript" });
			const shared = [
				["video-viewer-play-pause", "play / pause"], ["video-seek-backward-10-seconds", "back 10 seconds"],
				["video-seek-forward-10-seconds", "forward 10 seconds"], ["video-viewer-previous-note-timestamp", "previous segment"],
				["video-viewer-next-note-timestamp", "next segment"], ["video-viewer-insert-timestamp", "insert timestamp"],
				["video-viewer-copy-timestamp", "copy timestamp"], ["show-youtube-transcript", "show / hide transcript"],
				["video-viewer-faster", "faster"], ["video-viewer-slower", "slower"],
			].map(([id, action]) => {
				const key = getCommandHotkeyLabel(this.app, `perplexity-saver:${id}`);
				return [{ key: key || "Unassigned", action, disabled: !key }];
			});
			renderKeyHints(this.helpEl.createDiv({ cls: "perplexity-saver-video-shared-keys" }), shared, "perplexity-saver");
			this.helpEl.createDiv({ text: "Assign shared shortcuts in Settings → Hotkeys." });
			this.helpEl.createDiv({ text: "While the player is focused" });
			renderKeyHints(this.helpEl.createDiv(), [
				[{ key: "Space / K", action: "play / pause" }, { key: "J / L", action: "back / forward 10 seconds" }],
				[{ key: "← / →", action: "back / forward 5 seconds" }, { key: "Page Up / Down", action: "back / forward 1 minute" }],
				[{ key: "Home / End", action: "start / end" }, { key: "↑ / ↓", action: "seek 5 seconds (timeline only)" }],
				[{ key: "[ / ]", action: "previous / next segment" }, { key: "< / >", action: "speed" }],
				[{ key: "+ / -", action: "zoom" }, { key: "0", action: "reset zoom" }, { key: "C", action: "transcript" }],
			], "perplexity-saver");
		}
		this.onResize();
	}

	/** Show or hide the note's transcript panel. */
	async toggleTranscript(): Promise<void> {
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		try {
			await this.host.toggleTranscript(file, this.leaf);
		} catch (error) {
			console.error("Perplexity Saver: could not toggle transcript", error);
			new Notice("Could not show or hide transcript.");
			return;
		}
		this.updateTranscriptButton();
	}

	togglePlay(): void {
		const player = this.player;
		const resumeAt = this.resumeAt;
		if (!player || resumeAt === null) {
			player?.toggle();
			return;
		}
		const revision = this.playbackRevision;
		const start = (seconds: number): void => {
			if (this.player !== player || this.playbackRevision !== revision || this.resumeAt !== resumeAt) {
				new Notice("Playback changed. Use the current playback controls.");
				return;
			}
			this.seekTo(seconds);
			player.play();
		};
		const menu = new Menu();
		menu.addItem((item) => item.setTitle(`Resume at ${formatClock(resumeAt)}`).setIcon("play").onClick(() => start(resumeAt)));
		menu.addItem((item) => item.setTitle("Start from beginning").setIcon("rotate-ccw").onClick(() => start(0)));
		const rect = this.playBtn.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom }, this.playBtn.ownerDocument);
	}

	private updatePlayButton(playing = this.isPlaying()): void {
		if (!this.playBtn) return;
		this.playBtn.empty();
		setIcon(this.playBtn, playing ? "pause" : "play");
		if (this.resumeAt !== null) {
			this.playBtn.createSpan({ text: "Play..." });
			this.playBtn.setAttribute("aria-label", `Choose resume at ${formatClock(this.resumeAt)} or start from beginning`);
			this.playBtn.setAttribute("aria-haspopup", "menu");
		} else {
			this.playBtn.setAttribute("aria-label", playing ? "Pause (space)" : "Play (space)");
			this.playBtn.removeAttribute("aria-haspopup");
		}
	}

	/** Pause without moving focus; used by note-taking commands outside the viewer. */
	pausePlayback(): void {
		this.player?.pause();
	}

	/** Insert a paused timestamp list item into the note's tracked editor position. */
	async insertTimestampBullet(target: NoteInsertionTarget): Promise<void> {
		if (insertPlaybackTimestamp(target, this.videoId, this.getPlaybackSeconds(), () => this.pausePlayback(), this.host.getTimestampListStyle?.() ?? "match")) {
			await this.focusNoteAfterInsertion(target, "Timestamp inserted.");
		}
	}

	/** Capture a paused frame and insert it into the note; `whole` skips region selection. */
	async insertScreenshotForNote(target: NoteInsertionTarget, whole = false): Promise<void> {
		if (!this.player || !this.videoId || !target.isValid()) {
			releaseNoteInsertionAnchor(target.anchor);
			new Notice("The video or literature note insertion point is no longer available.");
			return;
		}
		if (this.snip) {
			this.endSnip(null, true);
			releaseNoteInsertionAnchor(target.anchor);
			return;
		}
		this.player.pause();
		if (whole) {
			await this.captureAndSave(undefined, target);
			return;
		}
		this.beginSnip(false, target);
	}

	/** Pause here and open the video at the current time in the system browser. */
	openInBrowser(): void {
		if (!this.player || !this.videoId) return;
		const seconds = Math.floor(this.player.info.currentTime);
		this.player.pause();
		this.ownerWin?.open(watchUrl(this.videoId, seconds), "_blank");
	}

	resetZoom(): void {
		this.setZoom({ zoom: 1, x: 0, y: 0 });
	}

	private updateTranscriptButton(): void {
		if (!this.transcriptBtn) return;
		const shown = this.host.isTranscriptShown(this.leaf);
		this.transcriptBtn.toggleClass("is-active", shown);
		this.transcriptBtn.setAttribute("aria-label", shown ? "Hide transcript (C)" : "Show transcript (C)");
		this.transcriptBtn.setAttribute("aria-pressed", String(shown));
		const unit = this.host.getTranscriptUnit?.(this.filePath) ?? "caption";
		this.transcriptUnitLabel?.setText(unit === "sentence" ? "Sentence" : "Caption");
		this.previousTranscriptBtn?.setAttribute("aria-label", `Previous ${unit} ([)`);
		this.nextTranscriptBtn?.setAttribute("aria-label", `Next ${unit} (])`);
	}

	refreshTranscriptControls(): void {
		this.updateTranscriptButton();
	}

	private button(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: (evt: MouseEvent) => void,
		keys?: string
	): HTMLElement {
		const btn = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		if (keys) btn.setAttribute("aria-keyshortcuts", keys);
		if (icon) setIcon(btn, icon);
		btn.addEventListener("click", onClick);
		return btn;
	}

	updateToolbarCaptureLabels(): void {
		const insert = this.host.getToolbarCaptureAction() === "insert";
		this.screenshotBtn?.setAttribute("aria-label",
			`${insert ? "Insert screenshot into note" : "Copy screenshot"}: drag an area, or click for the whole picture (Shift-click: whole picture now; alternatives button or right-click for both actions)`);
	}

	updateYoutubeCaptions(): void {
		this.player?.setCaptions(this.host.getShowYoutubeCaptions());
	}

	private showCaptureMenu(evt: MouseEvent, button: HTMLElement): void {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Insert selected area into note...").onClick(() => void this.host.insertScreenshot(this, false)));
		menu.addItem((item) => item.setTitle("Copy selected area...").onClick(() => void this.screenshot(false)));
		menu.addItem((item) => item.setTitle("Insert whole picture into note").onClick(() => void this.host.insertScreenshot(this, true)));
		menu.addItem((item) => item.setTitle("Copy whole picture").onClick(() => void this.screenshot(true)));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom }, button.ownerDocument);
	}

	private showRate(rate: number): void {
		this.rate = rate;
		this.rateLabel.setText(`${rate}×`);
		this.rateBtn.toggleClass("is-active", rate !== 1);
		this.rateBtn.setAttribute("aria-label", `Playback speed: ${rate}× (< and > to change)`);
	}

	setRate(rate: number): void {
		this.showRate(rate);
		this.player?.setPlaybackRate(rate);
	}

	/** Next faster (1) or slower (-1) playback speed. */
	stepRate(direction: 1 | -1): void {
		const i = PLAYBACK_RATES.indexOf(this.rate);
		const next = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, (i < 0 ? PLAYBACK_RATES.indexOf(1) : i) + direction))];
		if (next !== this.rate) this.setRate(next);
	}

	private showRateMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const rate of PLAYBACK_RATES) {
			menu.addItem((item) =>
				item
					.setTitle(rate === 1 ? "Normal (1×)" : `${rate}×`)
					.setChecked(rate === this.rate)
					.onClick(() => this.setRate(rate))
			);
		}
		const rect = this.rateBtn.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.top, left: false }, this.rateBtn.ownerDocument);
		evt.preventDefault();
	}

	private loadPlayer(autoplay = false): void {
		if (!this.frameEl) return;
		this.player?.destroy();
		this.player = null;
		this.lastReportedPlayerState = null;
		this.setZoom({ zoom: 1, x: 0, y: 0 });
		if (this.videoId) {
			this.player = new YouTubeEmbed(this.frameEl, this.videoId, this.startTime, (info) => this.update(info), {
				autoplay,
				playbackRate: this.rate,
				captions: this.host.getShowYoutubeCaptions(),
			});
			// If the YouTube page takes focus anyway (e.g. a click that reaches it), hand focus back to the viewer so hotkeys keep working.
			this.player.iframe.addEventListener("focus", () => this.focusKeys());
			this.update(this.player.info);
		}
		this.updateEmpty();
	}

	private updateEmpty(): void {
		const empty = !this.videoId;
		this.emptyEl.toggleClass("is-hidden", !empty);
		this.contentEl.toggleClass("has-video", !empty);
		this.onResize();
	}

	private update(info: PlayerInfo): void {
		const duration = info.duration;
		this.timeEl.setText(duration > 0 ? `${formatClock(info.currentTime)} / ${formatClock(duration)}` : formatClock(info.currentTime));
		const pct = duration > 0 ? Math.min(100, (info.currentTime / duration) * 100) : 0;
		this.trackEl.setCssProps({ "--perplexity-saver-video-pos": `${pct}%` });
		this.trackEl.setAttribute("aria-valuemax", String(Math.floor(duration)));
		this.trackEl.setAttribute("aria-valuenow", String(Math.floor(info.currentTime)));
		this.trackEl.setAttribute("aria-valuetext", this.timeEl.getText());
		const playing = info.playerState === PLAYER_STATE.playing || info.playerState === PLAYER_STATE.buffering;
		// Direct use of the embedded player also resolves the start choice.
		if (info.playerState === PLAYER_STATE.playing) this.resumeAt = null;
		this.updatePlayButton(playing);
		if (info.playbackRate !== this.rate && PLAYBACK_RATES.includes(info.playbackRate)) {
			this.showRate(info.playbackRate);
		}
		this.renderMarks();
		if (this.videoId) {
			const stateChanged = this.lastReportedPlayerState !== info.playerState;
			this.lastReportedPlayerState = info.playerState;
			this.host.onPlayback(this.videoId, this.filePath, info.currentTime, stateChanged);
		}
	}

	/** Jump `delta` seconds forward (negative: back). */
	skip(delta: number): void {
		if (this.player) this.seekTo(this.player.info.currentTime + delta);
	}

	/** Re-read the user's own timestamp links (outside the transcript) for the timeline. */
	private async refreshMarks(): Promise<void> {
		const token = ++this.marksToken;
		const marks = this.filePath && this.videoId
			? await loadNoteVideoMarks(this.app, this.filePath, this.videoId, this.host.getTranscriptHeading()) : [];
		if (token !== this.marksToken) return;
		this.marks = marks;
		delete this.marksEl.dataset.key;
		this.renderMarks();
	}

	private renderMarks(): void {
		const duration = this.player?.info.duration ?? 0;
		const key = `${duration}|${this.marks.join(",")}`;
		if (this.marksEl.dataset.key === key) return;
		this.marksEl.dataset.key = key;
		this.marksEl.empty();
		if (duration <= 0) return;
		for (const t of this.marks) {
			if (t > duration) continue;
			const mark = this.marksEl.createDiv({
				cls: "perplexity-saver-video-mark",
				attr: { "aria-label": formatClock(t) },
			});
			mark.setCssProps({ "--perplexity-saver-video-mark": `${(t / duration) * 100}%` });
		}
	}

	private bindTimeline(): void {
		const track = this.trackEl;
		const timeAt = (evt: PointerEvent): number => {
			const rect = track.getBoundingClientRect();
			const duration = this.player?.info.duration ?? 0;
			if (rect.width <= 0 || duration <= 0) return Number.NaN;
			return (Math.min(rect.width, Math.max(0, evt.clientX - rect.left)) / rect.width) * duration;
		};
		const snapToMark = (t: number): number => {
			const duration = this.player?.info.duration ?? 0;
			const width = track.getBoundingClientRect().width;
			if (!width || !duration) return t;
			const tolerance = (6 / width) * duration;
			const near = this.marks.find((m) => Math.abs(m - t) <= tolerance);
			return near ?? t;
		};
		let dragging = false;
		track.addEventListener("pointerdown", (evt) => {
			const t = timeAt(evt);
			if (Number.isNaN(t) || !this.player) return;
			dragging = true;
			track.setPointerCapture(evt.pointerId);
			this.seekTo(snapToMark(t));
		});
		track.addEventListener("pointermove", (evt) => {
			const t = timeAt(evt);
			if (!Number.isNaN(t)) track.setAttr("aria-label", formatClock(snapToMark(t)));
			if (dragging && !Number.isNaN(t)) this.seekTo(t);
		});
		const stop = (evt: PointerEvent): void => {
			if (!dragging) return;
			dragging = false;
			if (track.hasPointerCapture(evt.pointerId)) track.releasePointerCapture(evt.pointerId);
		};
		track.addEventListener("pointerup", stop);
		track.addEventListener("pointercancel", stop);
	}

	private bindOverlay(overlay: HTMLElement): void {
		let down: { x: number; y: number; zoom: ZoomState; moved: boolean } | null = null;
		overlay.addEventListener(
			"wheel",
			(evt) => {
				evt.preventDefault();
				const rect = this.stageEl.getBoundingClientRect();
				const factor = Math.exp(-evt.deltaY * 0.0015);
				this.setZoom(zoomAt(this.zoom, factor, evt.clientX - rect.left, evt.clientY - rect.top, rect.width, rect.height));
			},
			{ passive: false }
		);
		overlay.addEventListener("pointerdown", (evt) => {
			if (evt.button !== 0) return;
			// Keep keyboard control with the viewer, not the note, after clicking the picture.
			this.contentEl.focus({ preventScroll: true });
			down = { x: evt.clientX, y: evt.clientY, zoom: { ...this.zoom }, moved: false };
			overlay.setPointerCapture(evt.pointerId);
		});
		overlay.addEventListener("pointermove", (evt) => {
			if (!down) return;
			const dx = evt.clientX - down.x;
			const dy = evt.clientY - down.y;
			if (!down.moved && Math.hypot(dx, dy) < 4) return;
			down.moved = true;
			if (this.zoom.zoom <= 1) return;
			overlay.addClass("is-panning");
			const rect = this.stageEl.getBoundingClientRect();
			this.setZoom(clampPan({ ...down.zoom, x: down.zoom.x + dx, y: down.zoom.y + dy }, rect.width, rect.height));
		});
		const finish = (evt: PointerEvent, cancelled: boolean): void => {
			if (!down) return;
			const clicked = !down.moved && !cancelled;
			down = null;
			overlay.removeClass("is-panning");
			if (overlay.hasPointerCapture(evt.pointerId)) overlay.releasePointerCapture(evt.pointerId);
			if (clicked) this.togglePlay();
		};
		overlay.addEventListener("pointerup", (evt) => finish(evt, false));
		overlay.addEventListener("pointercancel", (evt) => finish(evt, true));
		overlay.addEventListener("dblclick", () => this.setZoom({ zoom: 1, x: 0, y: 0 }));
	}

	/** Zoom about the centre of the picture. */
	zoomBy(factor: number): void {
		const rect = this.stageEl.getBoundingClientRect();
		this.setZoom(zoomAt(this.zoom, factor, rect.width / 2, rect.height / 2, rect.width, rect.height));
	}

	private setZoom(state: ZoomState): void {
		this.zoom = state;
		this.frameEl?.setCssProps({
			"--perplexity-saver-video-zoom": String(state.zoom),
			"--perplexity-saver-video-x": `${state.x}px`,
			"--perplexity-saver-video-y": `${state.y}px`,
		});
		this.stageEl?.toggleClass("is-zoomed", state.zoom > 1);
	}

	private onKey(evt: KeyboardEvent): void {
		if (this.helpEl?.contains(evt.target as Node | null)) return;
		if (this.snip) {
			if (evt.key === "Escape" || evt.key === "Enter") {
				evt.preventDefault();
				evt.stopPropagation();
				this.endSnip(evt.key === "Enter" ? undefined : null, evt.key === "Escape");
			}
			return;
		}
		if (!this.player || evt.ctrlKey || evt.metaKey || evt.altKey) return;
		const target = evt.target as HTMLElement | null;
		const tag = target?.tagName;
		if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
		// A focused button keeps its own Enter/Space activation; Up/Down only move the focused timeline.
		if ((evt.key === " " || evt.key === "Enter") && tag === "BUTTON") return;
		const player = this.player;
		const onTrack = target === this.trackEl;
		const actions: Record<string, () => void> = {
			ArrowUp: () => this.skip(ARROW_SECONDS),
			ArrowDown: () => this.skip(-ARROW_SECONDS),
			PageUp: () => this.skip(PAGE_SECONDS),
			PageDown: () => this.skip(-PAGE_SECONDS),
			Home: () => this.seekTo(0),
			End: () => this.seekTo(Math.max(0, player.info.duration - 1)),
			"[": () => this.host.jumpToTranscriptTimestamp(this, -1),
			"]": () => this.host.jumpToTranscriptTimestamp(this, 1),
			">": () => this.stepRate(1),
			"<": () => this.stepRate(-1),
			c: () => void this.toggleTranscript(),
			" ": () => this.togglePlay(),
			k: () => this.togglePlay(),
			j: () => this.skip(-SKIP_SECONDS),
			l: () => this.skip(SKIP_SECONDS),
			ArrowLeft: () => this.skip(-ARROW_SECONDS),
			ArrowRight: () => this.skip(ARROW_SECONDS),
			"+": () => this.zoomBy(ZOOM_STEP),
			"=": () => this.zoomBy(ZOOM_STEP),
			"-": () => this.zoomBy(1 / ZOOM_STEP),
			"0": () => this.resetZoom(),
		};
		const action = actions[evt.key];
		if (!action || (!onTrack && (evt.key === "ArrowUp" || evt.key === "ArrowDown"))) return;
		evt.preventDefault();
		action();
	}

	private get ownerWin(): Window | null {
		return this.contentEl.ownerDocument.defaultView;
	}

	/** Copy the current position using the configured plain-text Markdown format. */
	async copyTimestampLink(): Promise<void> {
		if (!this.player || !this.videoId) return;
		const win = this.ownerWin;
		const seconds = this.player.info.currentTime;
		this.pausePlayback();
		const text = timestampClipboardText(this.videoId, seconds, this.host.getTimestampCopyFormat());
		if (win && (await writeClipboardIn(win, text).catch(() => false))) {
			new Notice(`Copied ${formatClock(seconds)} link.`);
		} else {
			new Notice("Could not write to the clipboard.");
		}
	}

	/**
	 * Camera button: pause and let the user drag a rectangle over the picture
	 * (a click or Enter takes the whole picture, Esc cancels). With `whole`,
	 * capture the whole picture at once.
	 */
	async screenshot(whole = false): Promise<void> {
		if (!this.player || !this.videoId) return;
		if (this.snip) {
			this.endSnip(null, true);
			return;
		}
		if (whole) {
			await this.captureAndSave(undefined);
			return;
		}
		const resume = this.player.playing;
		if (resume) this.player.pause();
		this.beginSnip(resume);
	}

	private beginSnip(resume: boolean, target?: NoteInsertionTarget): void {
		const layer = this.stageEl.createDiv({ cls: "perplexity-saver-video-snip" });
		const box = layer.createDiv({ cls: "perplexity-saver-video-snip-box" });
		layer.createDiv({
			cls: "perplexity-saver-video-snip-hint",
			text: "Drag to select an area. Click or press Enter for the whole picture. Esc cancels.",
		});
		this.snip = { layer, resume, target };
		this.contentEl.focus();

		let start: { x: number; y: number } | null = null;
		const local = (evt: PointerEvent): { x: number; y: number } => {
			const rect = this.stageEl.getBoundingClientRect();
			return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
		};
		const current = (evt: PointerEvent): SnipRect | null => {
			if (!start) return null;
			const p = local(evt);
			const rect = this.stageEl.getBoundingClientRect();
			return snipRect(start.x, start.y, p.x, p.y, rect.width, rect.height);
		};
		layer.addEventListener("pointerdown", (evt) => {
			if (evt.button !== 0) return;
			evt.preventDefault();
			start = local(evt);
			layer.setPointerCapture(evt.pointerId);
		});
		layer.addEventListener("pointermove", (evt) => {
			const r = current(evt);
			box.toggleClass("is-visible", !!r);
			if (r) {
				box.setCssProps({
					"--perplexity-saver-snip-x": `${r.x}px`,
					"--perplexity-saver-snip-y": `${r.y}px`,
					"--perplexity-saver-snip-w": `${r.width}px`,
					"--perplexity-saver-snip-h": `${r.height}px`,
				});
			}
		});
		layer.addEventListener("pointerup", (evt) => {
			if (!start) return;
			const r = current(evt);
			start = null;
			this.endSnip(r ?? undefined, false);
		});
		layer.addEventListener("pointercancel", () => this.endSnip(null, true));
	}

	/** Finish a snip: `null` cancels, `undefined` is the whole picture. */
	private endSnip(region: SnipRect | null | undefined, cancelled: boolean): void {
		const snip = this.snip;
		if (!snip) return;
		this.snip = null;
		snip.layer.remove();
		const done = (): void => {
			if (snip.resume) this.player?.play();
		};
		if (cancelled || region === null) {
			if (snip.target) releaseNoteInsertionAnchor(snip.target.anchor);
			done();
			return;
		}
		void this.captureAndSave(region, snip.target).finally(done);
	}

	/** Capture the visible picture, save it beside the linked note, then insert or copy its Markdown. */
	private async captureAndSave(region: SnipRect | undefined, target?: NoteInsertionTarget): Promise<void> {
		try {
			if (!this.player || !this.videoId) {
				new Notice("The video is no longer available for capture.");
				return;
			}
			const win = this.ownerWin;
			// Let the removed selection layer leave the screen before capturing composited pixels.
			if (win) await nextPaint(win);
			const seconds = this.player.info.currentTime;
			const png = await captureElementImage(this.stageEl, region);
			if (!png) {
				new Notice("Could not capture the video picture.");
				return;
			}
			if (target && !target.isValid()) {
				new Notice("The literature note changed before the screenshot could be saved.");
				return;
			}
			const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
			const sourcePath = target?.filePath ?? file?.path ?? "";
			const name = screenshotFileName(file?.basename ?? this.videoId, seconds, new Date());
			const path = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
			const data = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
			const image = await this.app.vault.createBinary(path, data);
			const embed = "!" + this.app.fileManager.generateMarkdownLink(image, sourcePath);
			if (target) {
				if (!target.isValid()) {
					new Notice(`Screenshot saved to ${image.path}, but the literature note changed before insertion.`);
					return;
				}
				const position = getNoteInsertionPosition(target.anchor);
				if (position === null) {
					new Notice(`Screenshot saved to ${image.path}, but its insertion point is no longer available.`);
					return;
				}
				const block = timestampedScreenshotItem(embed, this.videoId, seconds);
				const insertion = blockInsertion(target.anchor.view.state.doc, position, block);
				if (!insertAtNoteInsertionAnchor(target.anchor, insertion.text, insertion.cursorOffset, insertion.replace)) {
					new Notice(`Screenshot saved to ${image.path}, but it could not be inserted into the note.`);
					return;
				}
				await this.focusNoteAfterInsertion(target, "Timestamped screenshot inserted.");
				return;
			}
			const text = screenshotClipboardText(embed, this.videoId, seconds);
			const copied = win ? await writeClipboardIn(win, text).catch(() => false) : false;
			new Notice(copied ? `Screenshot saved to ${image.path}; paste it into your note.` : `Screenshot saved to ${image.path}.`);
		} catch (error) {
			console.error("Perplexity Saver: could not capture or insert screenshot", error);
			new Notice(target ? "Could not capture or insert the screenshot." : "Could not capture or save the screenshot.");
		} finally {
			if (target) releaseNoteInsertionAnchor(target.anchor);
		}
	}

	private async focusNoteAfterInsertion(target: NoteInsertionTarget, message: string): Promise<void> {
		try {
			await this.host.focusNote(target);
			new Notice(message);
		} catch (error) {
			console.error("Perplexity Saver: could not focus note after insertion", error);
			new Notice(`${message} Could not return focus to the note.`);
		}
	}
}

interface SnipSession {
	layer: HTMLElement;
	/** Resume playback when the snip ends (the video was playing when it started). */
	resume: boolean;
	target?: NoteInsertionTarget;
}

/** Resolve after the window has painted twice (or 150 ms, if frames are throttled). */
function nextPaint(win: Window): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolve();
		};
		requestFrameIn(win, () => requestFrameIn(win, finish));
		setTimeoutIn(win, finish, 150);
	});
}

/** Find the YouTube video a note is about (first YouTube link in it). */
export async function noteVideoId(app: App, file: TFile): Promise<string | null> {
	return findNoteVideoId(await app.vault.cachedRead(file));
}

/**
 * The video viewer to use: the one in `preferWindow` when there is one, otherwise
 * the one in the window the user is working in, otherwise any open viewer.
 */
export function getVideoLeaf(app: App, preferWindow?: Window | null): WorkspaceLeaf | null {
	const leaves = app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE);
	if (leaves.length < 2) return leaves[0] ?? null;
	const active = getActiveLeafInFocusedWindow(app);
	for (const win of [preferWindow, active ? getWindowForLeaf(active) : null]) {
		const match = win ? leaves.find((leaf) => getWindowForLeaf(leaf) === win) : undefined;
		if (match) return match;
	}
	return leaves[0];
}

/**
 * Show `videoId` at `seconds` in the viewer, reusing an open viewer. A new viewer
 * opens in a split next to the source note, or in its own window.
 */
export async function openVideoViewer(
	app: App,
	request: {
		videoId: string;
		seconds: number;
		sourcePath: string | null;
		autoplay?: boolean;
		resumeAt?: number;
		associatedOnly?: boolean;
		/** Reuse this specific player (the session's player) rather than any other. */
		preferLeaf?: WorkspaceLeaf | null;
		/** Open in this window's player when no leaf is preferred. */
		preferWindow?: Window | null;
	},
	location: VideoViewerLocation
): Promise<WorkspaceLeaf> {
	const autoplay = request.autoplay ?? false;
	const noteLeaf = request.sourcePath ? findLeafForFile(app, request.sourcePath) : null;
	const preferred = request.preferLeaf;
	const existing = preferred && app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE).includes(preferred)
		? preferred
		: request.associatedOnly
			? app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE).find((leaf) =>
				leaf.view instanceof VideoView && leaf.view.getFilePath() === request.sourcePath)
			: getVideoLeaf(app, request.preferWindow ?? (noteLeaf ? getWindowForLeaf(noteLeaf) : null));
	if (existing) {
		await loadLeafIfDeferred(existing);
		await app.workspace.revealLeaf(existing);
		if (existing.view instanceof VideoView) {
			// setViewState refreshes the tab title; setState seeks without reloading the same video.
			await existing.setViewState({
				type: VIDEO_VIEW_TYPE,
				active: false,
				state: { videoId: request.videoId, time: request.seconds, file: request.sourcePath, autoplay,
					...(request.resumeAt !== undefined ? { resumeAt: request.resumeAt } : {}) },
			});
			return existing;
		}
	}
	let leaf: WorkspaceLeaf;
	if (location === "window") {
		leaf = app.workspace.openPopoutLeaf({ size: { width: 960, height: 640 } });
	} else {
		leaf = noteLeaf ? app.workspace.createLeafBySplit(noteLeaf, "vertical") : app.workspace.getLeaf("split", "vertical");
	}
	try {
		await leaf.setViewState({
			type: VIDEO_VIEW_TYPE,
			active: false,
			state: { videoId: request.videoId, time: request.seconds, file: request.sourcePath, autoplay,
				...(request.resumeAt !== undefined ? { resumeAt: request.resumeAt } : {}) },
		});
	} catch (error) {
		leaf.detach();
		throw error;
	}
	return leaf;
}
