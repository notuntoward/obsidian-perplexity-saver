import { ItemView, Menu, Notice, Platform, TFile, setIcon } from "obsidian";
import type { App, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { captureElementImage } from "commons/os";
import { findLeafForFile, getActiveLeafInFocusedWindow, getWindowForLeaf, loadLeafIfDeferred } from "commons/workspace";
import { requestFrameIn, setTimeoutIn, writeClipboardIn } from "commons/windows";
import { findTranscriptRange } from "../litNote/transcriptSection";
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

export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SKIP_SECONDS = 10;
const ARROW_SECONDS = 5;
const ZOOM_STEP = 1.25;
const PAGE_SECONDS = 60;

interface VideoViewState {
	videoId?: string | null;
	file?: string | null;
	time?: number;
	autoplay?: boolean;
}

export interface VideoViewHost {
	getTranscriptHeading(): string;
	getTimestampCopyFormat(): TimestampCopyFormat;
	/** True when a transcript panel the button controls is on screen. */
	isTranscriptShown(viewer: WorkspaceLeaf): boolean;
	/** Close that transcript panel if it is on screen, otherwise show the note's transcript (beside a pop-out viewer, else per the plugin setting). */
	toggleTranscript(file: TFile | null, viewer: WorkspaceLeaf): Promise<void>;
	/** Called on every player update with the current position, so transcript panels can follow playback. */
	onPlayback(videoId: string, filePath: string | null, seconds: number): void;
}

/** YouTube player with custom controls, a timeline marked with the note's own timestamps, zoom/pan, and screenshots. */
export class VideoView extends ItemView {
	private videoId: string | null = null;
	private filePath: string | null = null;
	private startTime = 0;
	private player: YouTubeEmbed | null = null;
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
	private zoomLabel!: HTMLElement;
	private trackEl!: HTMLElement;
	private marksEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private transcriptBtn!: HTMLElement;

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
				if (oldPath === this.filePath) this.filePath = file.path;
			})
		);
		this.register(() => this.player?.destroy());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updateTranscriptButton()));
		this.loadPlayer();
		await this.refreshMarks();
	}

	async onClose(): Promise<void> {
		this.player?.destroy();
		this.player = null;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as VideoViewState;
		await super.setState(state, result);
		if (typeof s.videoId === "string") {
			this.showVideo(s.videoId, typeof s.time === "number" ? s.time : 0, s.file ?? null, s.autoplay === true);
		}
	}

	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			videoId: this.videoId,
			file: this.filePath,
			time: Math.floor(this.player?.info.currentTime ?? this.startTime),
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

	/** Give the viewer keyboard focus, so its keys (Space, arrows, …) work. */
	focusKeys(): void {
		this.contentEl.focus({ preventScroll: true });
	}

	/** Show `videoId` at `seconds`; seeks without reloading when the video is already loaded. */
	showVideo(videoId: string, seconds: number, filePath: string | null, autoplay = false): void {
		const fileChanged = filePath !== null && filePath !== this.filePath;
		if (filePath !== null) this.filePath = filePath;
		if (this.player && this.videoId === videoId) {
			this.player.seekTo(seconds);
			if (autoplay) this.player.play();
		} else {
			this.videoId = videoId;
			this.startTime = seconds;
			this.loadPlayer(autoplay);
		}
		if (fileChanged || !this.marks.length) void this.refreshMarks();
	}

	private build(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("perplexity-saver-video-view");
		el.tabIndex = 0;

		this.emptyEl = el.createDiv({
			cls: "perplexity-saver-video-empty",
			text: "Click a timestamp link to a YouTube video, or run \"Open YouTube video viewer\" in a literature note.",
		});

		this.stageEl = el.createDiv({ cls: "perplexity-saver-video-stage" });
		this.frameEl = this.stageEl.createDiv({ cls: "perplexity-saver-video-frame" });
		const overlay = this.stageEl.createDiv({ cls: "perplexity-saver-video-overlay" });
		this.bindOverlay(overlay);

		const timeline = el.createDiv({ cls: "perplexity-saver-video-timeline" });
		this.trackEl = timeline.createDiv({
			cls: "perplexity-saver-video-track",
			attr: {
				tabindex: "0",
				role: "slider",
				"aria-label": "Position (arrows: 5 seconds, page up/down: 1 minute, [ and ]: note timestamps)",
				"aria-valuemin": "0",
			},
		});
		this.trackEl.createDiv({ cls: "perplexity-saver-video-progress" });
		this.marksEl = this.trackEl.createDiv({ cls: "perplexity-saver-video-marks" });
		this.trackEl.createDiv({ cls: "perplexity-saver-video-playhead" });
		this.bindTimeline();

		const bar = el.createDiv({ cls: "perplexity-saver-video-controls" });
		this.button(bar, "rotate-ccw", `Back ${SKIP_SECONDS} seconds (J)`, () => this.skip(-SKIP_SECONDS), "J");
		this.playBtn = this.button(bar, "play", "Play (space)", () => this.togglePlay(), "K");
		this.button(bar, "rotate-cw", `Forward ${SKIP_SECONDS} seconds (L)`, () => this.skip(SKIP_SECONDS), "L");
		this.timeEl = bar.createSpan({ cls: "perplexity-saver-video-time", text: "0:00" });

		this.rateBtn = this.button(bar, "gauge", "Playback speed", (evt) => this.showRateMenu(evt));
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

		bar.createDiv({ cls: "perplexity-saver-video-spacer" });
		this.button(bar, "zoom-out", "Zoom out (-)", () => this.zoomBy(1 / ZOOM_STEP), "Minus");
		this.zoomLabel = bar.createEl("button", {
			cls: "perplexity-saver-video-zoom-label",
			text: "100%",
			attr: { "aria-label": "Reset zoom (0)" },
		});
		this.zoomLabel.addEventListener("click", () => this.resetZoom());
		this.button(bar, "zoom-in", "Zoom in (+)", () => this.zoomBy(ZOOM_STEP), "Plus");
		this.button(bar, "link", "Copy timestamp link", () => void this.copyTimestampLink());
		this.button(bar, "external-link", "Open in browser at this time", () => this.openInBrowser());
		if (Platform.isDesktopApp) {
			this.button(bar, "camera", "Screenshot: drag an area, or click for the whole picture (shift-click: whole picture now)", (evt) =>
				void this.screenshot(evt.shiftKey)
			);
		}
		this.transcriptBtn = this.button(bar, "captions", "Show transcript (C)", () => void this.toggleTranscript(), "C");
		this.updateTranscriptButton();

		el.addEventListener("keydown", (evt) => this.onKey(evt));
		this.updateEmpty();
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
		this.player?.toggle();
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
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
		return btn;
	}

	private showRate(rate: number): void {
		this.rate = rate;
		this.rateLabel.setText(rate === 1 ? "" : `${rate}×`);
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
		this.setZoom({ zoom: 1, x: 0, y: 0 });
		if (this.videoId) {
			this.player = new YouTubeEmbed(this.frameEl, this.videoId, this.startTime, (info) => this.update(info), {
				autoplay,
				playbackRate: this.rate,
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
		setIcon(this.playBtn, playing ? "pause" : "play");
		this.playBtn.setAttr("aria-label", playing ? "Pause (space)" : "Play (space)");
		if (info.playbackRate !== this.rate && PLAYBACK_RATES.includes(info.playbackRate)) {
			this.showRate(info.playbackRate);
		}
		this.renderMarks();
		if (this.videoId) this.host.onPlayback(this.videoId, this.filePath, info.currentTime);
	}

	/** Jump `delta` seconds forward (negative: back). */
	skip(delta: number): void {
		if (this.player) this.player.seekTo(this.player.info.currentTime + delta);
	}

	/** Jump to the next (1) or previous (-1) timestamp the note links to. */
	jumpToMark(direction: 1 | -1): void {
		if (!this.player) return;
		const now = this.player.info.currentTime;
		const sorted = [...this.marks].sort((a, b) => a - b);
		const target = direction > 0 ? sorted.find((t) => t > now + 0.5) : sorted.reverse().find((t) => t < now - 1.5);
		if (target === undefined) new Notice(direction > 0 ? "No later timestamp in the note." : "No earlier timestamp in the note.");
		else this.player.seekTo(target);
	}

	/** Re-read the user's own timestamp links (outside the transcript) for the timeline. */
	private async refreshMarks(): Promise<void> {
		const token = ++this.marksToken;
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		let marks: number[] = [];
		if (file && this.videoId) {
			const content = await this.app.vault.cachedRead(file);
			const headings = this.app.metadataCache.getFileCache(file)?.headings;
			const transcript = findTranscriptRange(content, headings, this.host.getTranscriptHeading());
			marks = collectNoteTimestamps(content, this.videoId, transcript);
		}
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
			this.player.seekTo(snapToMark(t));
		});
		track.addEventListener("pointermove", (evt) => {
			const t = timeAt(evt);
			if (!Number.isNaN(t)) track.setAttr("aria-label", formatClock(snapToMark(t)));
			if (dragging && !Number.isNaN(t)) this.player?.seekTo(t);
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
			if (clicked) this.player?.toggle();
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
		this.zoomLabel?.setText(`${Math.round(state.zoom * 100)}%`);
	}

	private onKey(evt: KeyboardEvent): void {
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
			Home: () => player.seekTo(0),
			End: () => player.seekTo(Math.max(0, player.info.duration - 1)),
			"[": () => this.jumpToMark(-1),
			"]": () => this.jumpToMark(1),
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
		const text = timestampClipboardText(this.videoId, this.player.info.currentTime, this.host.getTimestampCopyFormat());
		if (win && (await writeClipboardIn(win, text).catch(() => false))) {
			new Notice(`Copied ${formatClock(this.player.info.currentTime)} link.`);
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
		const layer = this.stageEl.createDiv({ cls: "perplexity-saver-video-snip" });
		const box = layer.createDiv({ cls: "perplexity-saver-video-snip-box" });
		layer.createDiv({
			cls: "perplexity-saver-video-snip-hint",
			text: "Drag to select an area. Click or press Enter for the whole picture. Esc cancels.",
		});
		this.snip = { layer, resume };
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
			done();
			return;
		}
		void this.captureAndSave(region).finally(done);
	}

	/**
	 * Capture the visible (zoomed) picture, or `region` of it, save it as an
	 * attachment of the linked note, and copy its embed plus a timestamp link.
	 */
	private async captureAndSave(region: SnipRect | undefined): Promise<void> {
		if (!this.player || !this.videoId) return;
		const win = this.ownerWin;
		// Let the removed selection layer leave the screen before capturing composited pixels.
		if (win) await nextPaint(win);
		const seconds = this.player.info.currentTime;
		const png = await captureElementImage(this.stageEl, region);
		if (!png) {
			new Notice("Could not capture the video picture.");
			return;
		}
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		const sourcePath = file?.path ?? "";
		const name = screenshotFileName(file?.basename ?? this.videoId, seconds, new Date());
		const path = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
		const data = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
		const image = await this.app.vault.createBinary(path, data);
		const embed = "!" + this.app.fileManager.generateMarkdownLink(image, sourcePath);
		const text = screenshotClipboardText(embed, this.videoId, seconds);
		const copied = win ? await writeClipboardIn(win, text).catch(() => false) : false;
		new Notice(copied ? `Screenshot saved to ${image.path}; paste it into your note.` : `Screenshot saved to ${image.path}.`);
	}
}

interface SnipSession {
	layer: HTMLElement;
	/** Resume playback when the snip ends (the video was playing when it started). */
	resume: boolean;
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
	request: { videoId: string; seconds: number; sourcePath: string | null; autoplay?: boolean },
	location: VideoViewerLocation
): Promise<WorkspaceLeaf> {
	const autoplay = request.autoplay ?? false;
	const noteLeaf = request.sourcePath ? findLeafForFile(app, request.sourcePath) : null;
	const existing = getVideoLeaf(app, noteLeaf ? getWindowForLeaf(noteLeaf) : null);
	if (existing) {
		await loadLeafIfDeferred(existing);
		await app.workspace.revealLeaf(existing);
		if (existing.view instanceof VideoView) {
			// setViewState refreshes the tab title; setState seeks without reloading the same video.
			await existing.setViewState({
				type: VIDEO_VIEW_TYPE,
				active: false,
				state: { videoId: request.videoId, time: request.seconds, file: request.sourcePath, autoplay },
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
	await leaf.setViewState({
		type: VIDEO_VIEW_TYPE,
		active: false,
		state: { videoId: request.videoId, time: request.seconds, file: request.sourcePath, autoplay },
	});
	return leaf;
}
