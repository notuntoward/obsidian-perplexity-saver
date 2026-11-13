import { DropdownComponent, ItemView, Menu, Notice, Scope, SearchComponent, TFile, setIcon } from "obsidian";
import type { App, Command, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { getCommandHotkeyLabel, renderHighlightedText, renderKeyHints, type KeyHint } from "commons/modal";
import { writeClipboardIn } from "commons/windows";
import {
	findLiteralRanges,
	dispatchSearchNavigation,
	matchAllWords,
	onSearchNavigation,
	searchExitAction,
	searchRepeatAction,
	shouldShowAllMatches,
	type AllMatchesDisplayMode,
	type SearchExitBehavior,
} from "commons/search";
import {
	getWindowForLeaf,
	isInCollapsedSidebar,
	isSidebarCollapsed,
	isSidebarLeaf,
	loadLeafIfDeferred,
	setSidebarCollapsed,
} from "commons/workspace";
import {
	findTranscriptSection,
	normalizeTranscriptHeading,
	parseStoredTranscript,
	storedLinesToCues,
	type StoredTranscriptLine,
} from "./transcriptSection";
import { buildTranscriptParagraphs } from "./transcriptParagraphs";
import { prepareTranscript, sentenceRows } from "./transcriptSentences";
import { formatShortTimestamp } from "./youtubeTranscript";
import { alignedSentenceRows, ALIGNMENT_CACHE_KEY, readAlignmentCache, type AlignmentCache } from "./transcriptAlignment";
import { formatClock, parseYouTubeUrl, timestampLink } from "../video/youtubeLinks";
import type { BackgroundPlayback } from "../video/backgroundPlayback";

export const TRANSCRIPT_VIEW_TYPE = "perplexity-saver-transcript";

/** Native shortcuts belong to Saver; other search plugins are optional. */
export function transcriptSearchCommands(app: App): Command[] {
	return (["forward", "backward"] as const).map((direction) => ({
		id: `transcript-search-${direction}`,
		name: `Transcript search: ${direction === "forward" ? "Forward" : "Reverse"} Emacs`,
		checkCallback: (checking: boolean): boolean => {
			for (const leaf of app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
				if (!(leaf.view instanceof TranscriptView)) continue;
				const target = leaf.view.contentEl.ownerDocument.activeElement;
				if (target && leaf.view.contentEl.contains(target)) {
					return dispatchSearchNavigation(target, direction, checking);
				}
			}
			return false;
		},
	}));
}

export type TranscriptViewMode = "lines" | "paragraphs" | "sentences" | "aligned-sentences";

const COMPARISON_MODES: Record<TranscriptViewMode, string> = {
	lines: "Original captions / lines",
	sentences: "Punctuation sentences",
	paragraphs: "Original paragraphs",
	"aligned-sentences": "Word-timed sentences",
};

function isTranscriptMode(value: unknown): value is TranscriptViewMode {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMPARISON_MODES, value);
}

export interface TranscriptSearchSettings {
	keyboard: SearchExitBehavior;
	matching: "all-words" | "phrase";
	highlights: AllMatchesDisplayMode;
}

interface TranscriptViewState {
	file?: string | null;
	mode?: TranscriptViewMode;
	filter?: boolean;
	pinned?: boolean;
}

interface TranscriptRow {
	startSec: number;
	url: string;
	text: string;
	sourceStart?: number;
	endSec?: number;
	timingUncertain?: boolean;
}

/**
 * Read the stored transcript of a note. Returns null when the note has no
 * transcript heading, or an empty array when the section has no timestamped lines.
 */
export async function loadTranscriptLines(
	app: App,
	file: TFile,
	headingName: string
): Promise<StoredTranscriptLine[] | null> {
	const headings = app.metadataCache.getFileCache(file)?.headings;
	if (!headings?.length) return null;
	const content = await app.vault.cachedRead(file);
	const section = findTranscriptSection(content, headings, headingName);
	return section === null ? null : parseStoredTranscript(section);
}

/** Rows for the given display mode. */
export function transcriptRows(
	lines: StoredTranscriptLine[],
	mode: TranscriptViewMode,
	alignment?: AlignmentCache | null
): TranscriptRow[] {
	const prepared = alignment || mode === "aligned-sentences" || mode === "sentences" ? prepareTranscript(lines) : null;
	const offsets = prepared ? new Map(prepared.lines.map((line, i) => [line, prepared.cueStarts[i]])) : null;
	if (mode === "lines") return lines.map((line) => ({
		startSec: line.startSec, url: line.url, text: line.text,
		...(offsets ? { sourceStart: offsets.get(line) } : {}),
	}));
	if (mode === "sentences" && prepared) return sentenceRows(prepared);
	if (mode === "aligned-sentences" && prepared) {
		if (!alignment) throw new Error("WhisperX timings are unavailable for this transcript.");
		return alignedSentenceRows(prepared, alignment);
	}
	const cues = storedLinesToCues(lines).map((cue, i) => ({ ...cue, sourceStart: prepared?.cueStarts[i] }));
	return buildTranscriptParagraphs(cues).map((p) => ({
		startSec: p.startSec,
		url: p.cues[0].url,
		text: p.text,
		...(prepared ? { sourceStart: p.cues[0].sourceStart } : {}),
	}));
}

/** What the transcript panel needs from the plugin. */
export interface TranscriptViewHost {
	getHeadingName(): string;
	getSearchSettings(): TranscriptSearchSettings;
	getAlignmentEnabled?(): boolean;
	alignTranscript?(filePath: string): Promise<void>;
	cancelAlignment?(): void;
	/**
	 * Show the video at `seconds` in the video viewer; `url` is the row's timestamp
	 * link (may be empty). With `play`, start playing; otherwise keep playing or paused.
	 */
	playAt(filePath: string, url: string, seconds: number, play: boolean): void;
	/** True when a player for this note is loaded in any window, so the panel stays with that player. */
	hasPlayerFor?(filePath: string): boolean;
	isVideoVisible?(filePath: string, leaf: WorkspaceLeaf): boolean;
	isPlaybackPlaying?(filePath: string): boolean;
	onPlaybackSessionChanged?(filePath: string, videoId: string): void;
	runPlaybackControl?(filePath: string, action: "play" | "previous" | "next" | "insert"): void;
	movePanel?(filePath: string, location: TranscriptPanelLocation): Promise<void>;
	toggleOrientation?(filePath: string): Promise<void>;
	closePanel?(leaf: WorkspaceLeaf): Promise<void>;
}

/** Index of the row playing at `seconds`: the last row starting at or before it, or -1. `starts` is sorted. */
export function currentRowIndex(starts: number[], seconds: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid] <= seconds) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/** The nearest ancestor of `el` that scrolls vertically. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
	const win = el.ownerDocument.defaultView;
	for (let p = el.parentElement; p; p = p.parentElement) {
		const overflow = win?.getComputedStyle(p).overflowY ?? "";
		if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) return p;
	}
	return null;
}

/**
 * Row to focus when moving `delta` (1 down, -1 up) from row `current`.
 * `visible` lists the rows not hidden by the filter, `onScreen` those scrolled into
 * view (both ascending). When `current` is not on screen (the user paged away, or the
 * filter hid it), start from the rows on screen. Returns -1 when there are no rows.
 */
export function stepRow(visible: number[], current: number, delta: 1 | -1, onScreen: number[]): number {
	if (!visible.length) return -1;
	if (!onScreen.includes(current)) {
		const from = onScreen.length ? onScreen : visible;
		return delta > 0 ? from[0] : from[from.length - 1];
	}
	const pos = visible.indexOf(current);
	return visible[Math.min(visible.length - 1, Math.max(0, pos + delta))];
}

function searchHints(behavior: SearchExitBehavior, app: App): KeyHint[][] {
	const navigation = (["forward", "backward"] as const).map((direction): KeyHint => {
		const key = getCommandHotkeyLabel(app, `perplexity-saver:transcript-search-${direction}`)
			|| getCommandHotkeyLabel(app, `incremental-search:${direction}`);
		return {
			key: key || "Unassigned",
			action: direction === "forward" ? "next match" : "previous",
			disabled: !key,
		};
	});
	return [
		behavior === "emacs"
			? [...navigation, { key: "Enter", action: "accept match" }, { key: "Esc", action: "cancel" }]
			: [{ key: "Enter", action: "next match" }, { key: "Shift+Enter", action: "previous" }, { key: "Esc", action: "accept match" }],
		[
			{ key: "Tab", action: "accept & browse" },
			{ key: "Ctrl+Enter", action: "play match" },
			{ key: "Ctrl+G", action: "cancel" },
		],
	];
}

const ROW_HINTS: KeyHint[][] = [
	[
		{ key: "↑↓ / Ctrl+N/P", action: "move" },
		{ key: "Home/End", action: "first/last timestamp" },
		{ key: "Enter", action: "play from here" },
		{ key: "Shift+Enter", action: "go here" },
	],
	[
		{ key: "Ctrl+C", action: "copy timestamp link" },
		{ key: "Esc", action: "search" },
	],
];

/** After the user scrolls or clicks in the panel, following playback waits this long (ms) before scrolling again. */
const FOLLOW_PAUSE_MS = 4000;

interface RenderedRow {
	row: TranscriptRow;
	el: HTMLElement;
	textEl: HTMLElement;
	highlighted: boolean;
	ranges: [number, number][];
}

/** Side panel listing a literature note's stored YouTube transcript, with search and playback following. */
export class TranscriptView extends ItemView {
	private backgroundPlayback: BackgroundPlayback | null = null;

	getBackgroundPlayback(): BackgroundPlayback | null { return this.backgroundPlayback; }

	setBackgroundPlayback(playback: BackgroundPlayback): void {
		this.stopBackgroundPlayback();
		this.backgroundPlayback = playback;
		this.refreshPlaybackControls();
		this.host.onPlaybackSessionChanged?.(playback.getFilePath(), playback.getVideoId());
	}

	stopBackgroundPlayback(remember = true): void {
		const playback = this.backgroundPlayback;
		if (!playback) return;
		playback.destroy(remember);
		this.backgroundPlayback = null;
		this.refreshPlaybackControls();
		this.host.onPlaybackSessionChanged?.(playback.getFilePath(), playback.getVideoId());
	}

	private filePath: string | null = null;
	private pinned = false;
	private mode: TranscriptViewMode = "lines";
	private lines: StoredTranscriptLine[] | null = null;
	private alignmentCache: AlignmentCache | null = null;
	private alignmentStatus = "Caption timing: not computed.";
	private aligning = false;
	private comparisonSourceStart: number | null = null;
	private loadToken = 0;
	private rendered: RenderedRow[] = [];
	private rowStarts: number[] = [];
	private query = "";
	private previousQuery = "";
	/** Indexes into `rendered` of the rows matching `query`. */
	private matches: number[] = [];
	private matchIndex = -1;
	private search: SearchComponent | null = null;
	private searchBar: HTMLElement | null = null;
	private searchOpen = false;
	private searchVisibilityCleanup: (() => void) | null = null;
	private matchCountEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private filterBtn: HTMLElement | null = null;
	private highlightBtn: HTMLElement | null = null;
	private demandHighlights = false;
	private searchOrigin: { row: number; scrollTop: number } | null = null;
	private searchNavigationCleanup: (() => void) | null = null;
	private searchHintsEl: HTMLElement | null = null;
	private previousMatchBtn: HTMLElement | null = null;
	private nextMatchBtn: HTMLElement | null = null;
	/** Show only the rows matching the search. */
	private filter = false;
	/** The keydown already handled by the search box or list, so the view scope does not handle it twice. */
	private handledKey: KeyboardEvent | null = null;
	/** The row in the Tab order (roving tabindex); arrow keys move it. */
	private focusRow = -1;
	private playbackSec: number | null = null;
	private follow = true;
	private currentRow = -1;
	/** Timestamp whose row must be centered as soon as the panel can scroll. */
	private revealSeconds: number | null = null;
	private revealObserver: ResizeObserver | null = null;
	private observedRevealEl: HTMLElement | null = null;
	private userScrollAt = 0;
	private lastPlaying = false;

	constructor(leaf: WorkspaceLeaf, private readonly host: TranscriptViewHost) {
		super(leaf);
		// Registered on the view scope so these keys win over global hotkeys (Mod+Enter is often bound).
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", (evt) => {
			if (evt === this.handledKey) return false;
			this.handledKey = evt;
			const row = this.focusedRowIndex();
			if (row >= 0) this.playRow(row, true);
			else this.playMatch();
			return false;
		});
		this.scope.register(["Mod"], "G", (evt) => {
			if (evt === this.handledKey) return false;
			const input = this.search?.inputEl;
			if (!input || input.ownerDocument.activeElement !== input) return true;
			this.handledKey = evt;
			this.finishSearch(false);
			return false;
		});
		this.scope.register(["Mod"], "F", () => {
			this.focusSearch();
			return false;
		});
		this.scope.register(["Ctrl"], "N", (evt) => this.moveFocusedRow(1, evt));
		this.scope.register(["Ctrl"], "P", (evt) => this.moveFocusedRow(-1, evt));
	}

	getViewType(): string {
		return TRANSCRIPT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Transcript";
	}

	getIcon(): string {
		return "captions";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			this.refreshPlaybackControls();
			this.retryReveal();
		}));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshPlaybackControls()));
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path === this.filePath) void this.reload();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (oldPath === this.filePath) {
					const playback = this.backgroundPlayback;
					playback?.renameFile(file.path);
					this.filePath = file.path;
					this.render();
					if (playback) this.host.onPlaybackSessionChanged?.(file.path, playback.getVideoId());
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file.path === this.filePath) {
					this.stopBackgroundPlayback(false);
					this.filePath = null;
					this.lines = null;
					this.lastPlaying = false;
					this.render();
				}
			})
		);
		// Follow the user to another note, but only if it has a transcript.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && file.path !== this.filePath) void this.followFile(file);
			})
		);
		// Scrolling or clicking in the panel pauses following playback for a moment.
		const touched = (): void => {
			this.userScrollAt = Date.now();
		};
		this.registerDomEvent(this.contentEl, "wheel", touched, { passive: true });
		this.registerDomEvent(this.contentEl, "pointerdown", touched);
		this.registerDomEvent(this.contentEl, "touchmove", touched, { passive: true });
		await this.reload();
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as TranscriptViewState;
		if (typeof s.file === "string") {
			if (s.file !== this.filePath) {
				this.comparisonSourceStart = null;
				this.stopBackgroundPlayback();
				this.revealSeconds = null;
				this.lastPlaying = false;
			}
			this.filePath = s.file;
		}
		if (isTranscriptMode(s.mode)) this.mode = s.mode;
		if (typeof s.filter === "boolean") this.filter = s.filter;
		if (typeof s.pinned === "boolean") this.pinned = s.pinned;
		await super.setState(state, result);
		await this.reload();
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), file: this.filePath, mode: this.mode, filter: this.filter, pinned: this.pinned };
	}

	/** Workspace panels belong to one note rather than following unrelated file opens. */
	pinToNote(): void {
		this.pinned = true;
		this.loadToken++;
	}

	/** Path of the note whose transcript is shown. */
	getFilePath(): string | null {
		return this.filePath;
	}

	/** Whether this panel shows the transcript of the note `filePath` or of video `videoId`. */
	showsVideo(filePath: string | null, videoId: string): boolean {
		if (filePath && filePath === this.filePath) return true;
		const url = this.lines?.find((l) => l.url)?.url;
		return !!url && parseYouTubeUrl(url)?.videoId === videoId;
	}

	/** Show the transcript of the note at `path`. */
	async showFile(path: string): Promise<void> {
		if (path !== this.filePath) {
			this.comparisonSourceStart = null;
			this.stopBackgroundPlayback();
			this.setSearchOpen(false);
			this.playbackSec = null;
			this.revealSeconds = null;
			this.focusRow = -1;
			this.query = "";
			this.searchOrigin = null;
			this.lastPlaying = false;
		}
		this.filePath = path;
		await this.reload();
	}

	/** Re-read the note (for example after the heading setting changed). */
	async reload(): Promise<void> {
		const token = ++this.loadToken;
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		const lines = file ? await loadTranscriptLines(this.app, file, this.host.getHeadingName()) : null;
		if (token !== this.loadToken) return;
		this.lines = lines;
		this.loadAlignmentCache(file, lines);
		this.render();
	}

	private loadAlignmentCache(file: TFile | null, lines: StoredTranscriptLine[] | null): void {
		this.alignmentCache = null;
		this.alignmentStatus = "Caption timing: not computed.";
		if (!file || !lines?.length || !this.host.getAlignmentEnabled?.()) return;
		const raw: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[ALIGNMENT_CACHE_KEY];
		try {
			this.alignmentCache = readAlignmentCache(raw, prepareTranscript(lines));
			if (this.alignmentCache) {
				const missing = this.alignmentCache.words.filter((word) => word === null).length;
				const native = this.alignmentCache.wordSources.filter((source) => source === "caption" || source === "youtube").length;
				this.alignmentStatus = `Caption timing: ${native}/${this.alignmentCache.words.length} original timestamps; ${missing} uncertain. Saved offline. ≈ marks estimates.`;
			} else if (raw !== undefined) this.alignmentStatus = "Caption timing: saved timings are stale. Click Time words to recompute with caption anchors.";
		} catch (error: unknown) {
			console.error("Perplexity Saver: invalid WhisperX cache", error);
			this.alignmentStatus = error instanceof Error ? error.message : "Invalid WhisperX transcript cache.";
		}
	}

	/** The displayed segmentation also drives existing next/previous timestamp commands. */
	getRows(lines = this.lines ?? []): TranscriptRow[] {
		return transcriptRows(lines, this.mode, this.host.getAlignmentEnabled?.() ? this.alignmentCache : undefined);
	}

	/** Put the cursor in the search box. */
	focusSearch(): void {
		const input = this.search?.inputEl;
		if (!input) return;
		this.setSearchOpen(true);
		this.rememberSearchOrigin();
		input.focus();
		input.select();
	}

	/**
	 * Mark the row playing at `seconds` (null clears the mark). With `follow`,
	 * unless the user is scrolling or searching, scroll it into the middle of the panel.
	 * `reveal` marks and centers the row even when following is paused or disabled.
	 */
	showPlayback(seconds: number | null, follow = true, stateChanged = true, reveal = false): void {
		this.playbackSec = seconds;
		this.follow = follow;
		let resumed = false;
		if (stateChanged) {
			const playing = this.playbackIsPlaying();
			resumed = playing && !this.lastPlaying;
			this.lastPlaying = playing;
			this.refreshPlaybackControls(playing);
		}
		const idx = seconds === null ? -1 : currentRowIndex(this.rowStarts, seconds);
		const changed = idx !== this.currentRow;
		if (changed) {
			this.rendered[this.currentRow]?.el.removeClass("is-playing");
			this.currentRow = idx;
			this.rendered[idx]?.el.addClass("is-playing");
		}
		const current = this.rendered[idx];
		if (!current) {
			// The transcript can still be loading, hidden in a collapsed sidebar, or
			// in a deferred view. Keep the request until layout makes the row usable.
			if (reveal || resumed) this.revealSeconds = seconds;
			return;
		}
		if (reveal || resumed) {
			this.revealSeconds = seconds;
			this.retryReveal();
		} else if (changed && follow && !this.query.trim() && this.focusedRowIndex() < 0 && Date.now() - this.userScrollAt > FOLLOW_PAUSE_MS) {
			this.scrollToRow(current.el, true);
		}
		this.retryReveal();
	}

	/** Center the pending timestamp row once the panel has a scrollable layout. */
	private retryReveal(): void {
		if (this.revealSeconds === null) return;
		const idx = currentRowIndex(this.rowStarts, this.revealSeconds);
		const row = this.rendered[idx];
		if (!row) return;
		if (this.scrollToRow(row.el, false)) this.revealSeconds = null;
	}

	/** Retry a pending reveal when the list changes size, for example when a sidebar expands. */
	private observeRevealTarget(el: HTMLElement): void {
		if (typeof ResizeObserver === "undefined" || this.observedRevealEl === el) return;
		this.revealObserver?.disconnect();
		this.observedRevealEl = el;
		this.revealObserver = new ResizeObserver(() => this.retryReveal());
		this.revealObserver.observe(el);
	}

	/** Explicit navigation goes to the current chunk even while paused or with following disabled. */
	focusPlayback(seconds: number | null, follow = true): void {
		if (this.query) this.previousQuery = this.query;
		this.setSearchOpen(false);
		this.query = "";
		this.search?.setValue("");
		this.searchOrigin = null;
		this.demandHighlights = false;
		this.applySearch(false);
		this.showPlayback(seconds, follow);
		this.focusLines();
		this.userScrollAt = Date.now();
	}

	private async followFile(file: TFile): Promise<void> {
		// A transcript whose note has a player follows that player, not unrelated note opens.
		if (this.pinned || file.extension !== "md" || (this.filePath && this.host.hasPlayerFor?.(this.filePath))) return;
		const token = ++this.loadToken;
		const lines = await loadTranscriptLines(this.app, file, this.host.getHeadingName());
		if (token !== this.loadToken || !lines?.length) return;
		this.stopBackgroundPlayback();
		this.playbackSec = null;
		this.revealSeconds = null;
		this.focusRow = -1;
		this.query = "";
		this.searchOrigin = null;
		this.lastPlaying = false;
		this.filePath = file.path;
		this.comparisonSourceStart = null;
		this.setSearchOpen(false);
		this.lines = lines;
		this.loadAlignmentCache(file, lines);
		this.render();
	}

	private setMode(mode: TranscriptViewMode): void {
		if (mode === "aligned-sentences" && !this.alignmentCache) {
			new Notice(this.alignmentStatus);
			return;
		}
		if (!this.host.getAlignmentEnabled?.()) {
			this.mode = mode;
			this.userScrollAt = 0;
			this.render();
			return;
		}
		const { visible, onScreen } = this.visibleRows();
		const focused = this.focusedRowIndex();
		const row = this.rendered[onScreen.includes(focused) ? focused : onScreen[0] ?? visible[0] ?? -1];
		const anchor = row?.row.startSec ?? this.playbackSec;
		const source = row?.row.sourceStart;
		const previous = this.comparisonSourceStart;
		this.comparisonSourceStart = source === undefined ? null
			: previous !== null && previous >= source && previous < source + row.row.text.length ? previous : source;
		const hadFocus = this.focusedRowIndex() >= 0;
		this.mode = mode;
		// Rebuilding the list resets its scroll position; re-center on the playing
		// row at once instead of waiting out the pause a click in the panel starts.
		this.userScrollAt = 0;
		this.render();
		if (anchor !== null && anchor !== undefined) {
			const index = this.comparisonSourceStart === null ? currentRowIndex(this.rowStarts, anchor)
				: currentRowIndex(this.rendered.map((entry) => entry.row.sourceStart ?? 0), this.comparisonSourceStart);
			if (index >= 0) {
				this.setFocusRow(index);
				this.rendered[index]?.el.scrollIntoView({ block: "center" });
				if (hadFocus) this.rendered[index]?.el.focus({ preventScroll: true });
			}
		}
	}

	/** Apply changed preferences without reloading the note or discarding the query. */
	refreshSearchSettings(): void {
		this.render();
	}

	private render(): void {
		const alignmentEnabled = this.host.getAlignmentEnabled?.() ?? false;
		const comparison = alignmentEnabled;
		if ((!comparison && this.mode !== "lines" && this.mode !== "paragraphs") ||
			(this.mode === "aligned-sentences" && (!alignmentEnabled || !this.alignmentCache))) this.mode = "lines";
		const el = this.contentEl;
		const input = this.search?.inputEl;
		const searchFocused = !!input && input.ownerDocument.activeElement === input;
		const rowHadFocus = this.focusedRowIndex() >= 0;
		this.searchNavigationCleanup?.();
		this.searchVisibilityCleanup?.();
		this.searchNavigationCleanup = null;
		this.searchHintsEl = null;
		this.previousMatchBtn = null;
		this.nextMatchBtn = null;
		el.empty();
		el.addClass("perplexity-saver-transcript-view");
		this.rendered = [];
		this.rowStarts = [];
		this.matches = [];
		this.search = null;
		this.matchCountEl = null;
		this.listEl = null;
		this.filterBtn = null;
		this.highlightBtn = null;
		this.currentRow = -1;

		const heading = normalizeTranscriptHeading(this.host.getHeadingName());
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		if (!file) {
			el.createDiv({
				cls: "perplexity-saver-transcript-empty",
				text: "Open a literature note and run \"Video: show or hide transcript\".",
			});
			return;
		}

		const header = el.createDiv({ cls: "perplexity-saver-transcript-header" });
		const controls = header.createDiv({ cls: "perplexity-saver-transcript-controls" });
		const title = controls.createEl("a", {
			cls: "perplexity-saver-transcript-title",
			text: file.basename,
			attr: { title: file.path },
		});
		title.addEventListener("click", (evt) => {
			evt.preventDefault();
			void this.app.workspace.openLinkText(file.path, "", false);
		});

		const lines = this.lines;
		if (!lines?.length) {
			el.createDiv({
				cls: "perplexity-saver-transcript-empty",
				text: `No timestamped lines under a "${heading}" heading in this note.`,
			});
			return;
		}

		const rows = this.getRows(lines);
		const lineNoun = lines.some((l) => l.endSec !== undefined) ? "captions" : "lines";
		controls.createSpan({
			cls: "perplexity-saver-transcript-count",
			text: this.mode === "lines" ? `${rows.length} ${lineNoun}`
				: !comparison && this.mode === "paragraphs" ? `${rows.length} paragraphs`
				: `${rows.length} ${COMPARISON_MODES[this.mode]}`,
		});
		if (comparison) {
			const format = new DropdownComponent(controls).addOptions(COMPARISON_MODES).setValue(this.mode)
				.onChange((mode) => {
					if (isTranscriptMode(mode)) this.setMode(mode);
					format.setValue(this.mode);
				});
			format.selectEl.setAttribute("aria-label", "Transcript segmentation");
			format.selectEl.addClass("perplexity-saver-transcript-segmentation");
			const compare = controls.createEl("button", { text: "Compare", attr: { "aria-label": "Compare segmentations" } });
			compare.disabled = !this.alignmentCache || (this.mode !== "sentences" && this.mode !== "aligned-sentences");
			compare.addEventListener("click", () => {
				const counterpart: Partial<Record<TranscriptViewMode, TranscriptViewMode>> = {
					sentences: "aligned-sentences", "aligned-sentences": "sentences",
				};
				const next = counterpart[this.mode];
				if (next) this.setMode(next);
			});
			if (alignmentEnabled && this.host.alignTranscript && !this.alignmentCache) {
				const align = controls.createEl("button", { text: this.aligning ? "Timing words..." : "Time words" });
				align.disabled = this.aligning;
				align.addEventListener("click", () => {
					if (!this.filePath || this.aligning) return;
					this.aligning = true;
					this.render();
					void this.host.alignTranscript?.(this.filePath).catch((error: unknown) => {
						console.error("Perplexity Saver: audio alignment failed", error);
						new Notice(error instanceof Error ? error.message : "Audio alignment failed.");
					}).finally(() => {
						this.aligning = false;
						void this.reload().catch((error: unknown) => {
							console.error("Perplexity Saver: could not reload alignment", error);
							new Notice("Could not reload saved alignment.");
						});
					});
				});
			}
			if (this.aligning && this.host.cancelAlignment) {
				const cancel = controls.createEl("button", { text: "Cancel alignment" });
				cancel.addEventListener("click", () => this.host.cancelAlignment?.());
			}
		} else {
			const toggle = controls.createEl("button", {
				cls: "perplexity-saver-transcript-format",
				text: this.mode === "lines" ? "Paragraphs" : lineNoun === "captions" ? "Captions" : "Lines",
				attr: { "aria-label": this.mode === "lines" ? "Format as paragraphs" : `Show original ${lineNoun}` },
			});
			toggle.addEventListener("click", () => this.setMode(this.mode === "lines" ? "paragraphs" : "lines"));
		}
		if (alignmentEnabled) header.createDiv({ cls: "perplexity-saver-transcript-experiment-status", text: this.alignmentStatus });
		this.iconButton(controls, "search", "Search transcript (Ctrl/Cmd+F)", () => this.focusSearch());
		if (this.host.toggleOrientation) {
			const placement = controls.createEl("button", {
				text: "Layout",
				attr: { "aria-label": "Transcript layout", "aria-haspopup": "menu" },
			});
			placement.addEventListener("click", () => {
				const menu = new Menu();
				menu.addItem((item) => item.setTitle("Show pane tabs and navigation")
					.setChecked(el.hasClass("show-pane-chrome"))
					.onClick(() => el.toggleClass("show-pane-chrome", !el.hasClass("show-pane-chrome"))));
				menu.addItem((item) => item.setTitle("Toggle transcript below / beside video").onClick(() => {
					if (this.filePath) void this.host.toggleOrientation?.(this.filePath).catch((error: unknown) => {
						console.error("Perplexity Saver: could not change transcript orientation", error);
						new Notice("Could not change transcript orientation.");
					});
				}));
				const rect = placement.getBoundingClientRect();
				menu.showAtPosition({ x: rect.left, y: rect.bottom }, placement.ownerDocument);
			});
		}
		if (this.host.runPlaybackControl) {
			const playback = controls.createDiv({ cls: "perplexity-saver-transcript-playback" });
			for (const [icon, label, action] of [
				["play", "Play", "play"],
				["skip-back", "Previous transcript row", "previous"],
				["skip-forward", "Next transcript row", "next"],
				["list-plus", "Insert current timestamp", "insert"],
			] as const) {
				const button = this.iconButton(playback, icon, label, () => {
					if (this.filePath && !playback.hidden) this.host.runPlaybackControl?.(this.filePath, action);
				});
				if (action === "play") button.addClass("perplexity-saver-transcript-play-toggle");
			}
			this.refreshPlaybackControls();
		}
		const help = this.iconButton(controls, "circle-help", "Transcript keyboard help", () => {
			const shown = !el.hasClass("show-help");
			el.toggleClass("show-help", shown);
			help.setAttribute("aria-expanded", String(shown));
		});
		help.setAttribute("aria-expanded", String(el.hasClass("show-help")));
		this.iconButton(controls, "x", "Close transcript pane", () => {
			if (this.host.closePanel) void this.host.closePanel(this.leaf).catch((error: unknown) => {
				console.error("Perplexity Saver: could not close transcript", error);
				new Notice("Could not close transcript pane.");
			});
			else this.leaf.detach();
		});
		this.buildSearch(header);
		const hints = header.createDiv({ cls: "perplexity-saver-transcript-hints" });
		this.searchHintsEl = hints.createDiv({ cls: "is-search" });
		this.updateSearchHints();
		renderKeyHints(hints.createDiv({ cls: "is-rows" }), ROW_HINTS, "perplexity-saver");

		const list = el.createDiv({
			cls: `perplexity-saver-transcript-list is-${this.mode}`,
		});
		this.listEl = list;
		this.observeRevealTarget(list);
		list.setAttribute("role", "listbox");
		list.addEventListener("keydown", (evt) => this.onListKey(evt));
		list.addEventListener("focusin", (evt) => {
			const idx = this.rendered.findIndex((r) => r.el === evt.target);
			if (idx >= 0) this.setFocusRow(idx);
		});
		for (const row of rows) {
			const rowEl = list.createDiv({
				cls: "perplexity-saver-transcript-row",
				// No aria-label: Obsidian shows aria-labels as hover tooltips; the row's own text is its accessible name.
				attr: { tabindex: "-1", role: "option" },
			});
			const stamp = `${row.timingUncertain ? "≈ " : ""}${formatShortTimestamp(row.startSec * 1000)}`;
			if (row.timingUncertain) rowEl.setAttribute("title", "Approximate timing: some words were not acoustically aligned.");
			if (row.url) {
				rowEl.createEl("a", {
					cls: "perplexity-saver-transcript-time external-link",
					text: stamp,
					href: row.url,
					attr: { target: "_blank", rel: "noopener" },
				});
			} else {
				rowEl.createSpan({ cls: "perplexity-saver-transcript-time", text: stamp });
			}
			const textEl = rowEl.createDiv({ cls: "perplexity-saver-transcript-text", text: row.text });
			this.rendered.push({ row, el: rowEl, textEl, highlighted: false, ranges: [] });
			this.rowStarts.push(row.startSec);
		}

		this.focusRow = Math.min(this.focusRow, this.rendered.length - 1);
		this.setFocusRow(this.focusRow >= 0 ? this.focusRow : 0);
		if (rowHadFocus) this.rendered[this.focusRow]?.el.focus({ preventScroll: true });
		const keep = this.matchIndex;
		this.applySearch(false);
		if (this.matches.length && keep >= 0) this.selectMatch(Math.min(keep, this.matches.length - 1), false);
		if (searchFocused) this.focusSearch();
		if (this.playbackSec !== null) this.showPlayback(this.playbackSec, this.follow);
		this.retryReveal();
	}

	refreshPlaybackControls(playing = this.playbackIsPlaying()): void {
		const controls = this.contentEl.querySelector<HTMLElement>(".perplexity-saver-transcript-playback");
		if (!controls) return;
		controls.hidden = !this.filePath || !!this.host.isVideoVisible?.(this.filePath, this.leaf);
		const button = controls.querySelector<HTMLElement>(".perplexity-saver-transcript-play-toggle");
		if (!button) return;
		const label = playing ? "Pause" : "Play";
		if (button.getAttribute("aria-label") !== label) {
			setIcon(button, playing ? "pause" : "play");
			button.setAttribute("aria-label", label);
		}
	}

	private playbackIsPlaying(): boolean {
		return !!this.filePath && !!this.host.isPlaybackPlaying?.(this.filePath);
	}

	private buildSearch(header: HTMLElement): void {
		const bar = header.createDiv({ cls: "perplexity-saver-transcript-search" });
		this.searchBar = bar;
		bar.hidden = !this.searchOpen;
		const search = new SearchComponent(bar);
		const behavior = this.host.getSearchSettings().keyboard;
		search.setPlaceholder("Search transcript");
		search.setValue(this.query);
		search.inputEl.setAttribute(
			"aria-label",
			behavior === "emacs"
				? "Search the transcript. Enter or Tab: accept and browse, Escape or Ctrl+G: cancel, Ctrl+Enter: play."
				: "Search the transcript. Enter: next match, Shift+Enter: previous, Escape or Tab: accept and browse, Ctrl+G: cancel, Ctrl+Enter: play."
		);
		search.inputEl.setAttribute("aria-keyshortcuts", "Enter Shift+Enter Control+Enter Meta+Enter Tab Escape Control+g Meta+g F3 Shift+F3");
		search.inputEl.addEventListener("focus", () => {
			this.setSearchOpen(true);
			this.rememberSearchOrigin();
			this.updateSearchHints();
		});
		const leave = (): void => {
			queueMicrotask(() => {
				if (this.search === search && this.searchOpen && !this.contentEl.contains(this.contentEl.ownerDocument.activeElement)) {
					this.finishSearch(false, false);
				}
			});
		};
		this.contentEl.addEventListener("focusout", leave);
		const win = this.contentEl.ownerDocument.defaultView;
		const blur = (): void => {
			if (this.searchOpen && !this.contentEl.ownerDocument.hasFocus()) this.finishSearch(false, false);
		};
		win?.addEventListener("blur", blur);
		this.searchVisibilityCleanup = () => {
			this.contentEl.removeEventListener("focusout", leave);
			win?.removeEventListener("blur", blur);
		};
		this.searchNavigationCleanup = onSearchNavigation(this.contentEl, (direction, checking) => {
			if (!checking) {
				const settings = this.host.getSearchSettings();
				const action = searchRepeatAction(
					search.inputEl.ownerDocument.activeElement === search.inputEl,
					this.query,
					settings.keyboard === "emacs" ? this.previousQuery : ""
				);
				if (action === "start") this.focusSearch();
				else if (action === "recall") {
					const origin = this.searchOrigin?.row ?? this.focusRow;
					this.query = this.previousQuery;
					search.setValue(this.query);
					this.applySearch(false);
					const next = direction === "forward"
						? this.matches.findIndex((row) => row > origin)
						: this.matches.filter((row) => row < origin).length - 1;
					if (this.matches.length) {
						this.selectMatch(next >= 0 ? next : direction === "forward" ? 0 : this.matches.length - 1, true);
					}
					search.inputEl.focus();
					search.inputEl.setSelectionRange(this.query.length, this.query.length);
				} else this.stepMatch(direction === "forward" ? 1 : -1);
				this.updateSearchHints();
			}
			return true;
		});
		search.onChange((value) => {
			this.query = value;
			this.applySearch(true);
		});
		search.inputEl.addEventListener("keydown", (evt) => {
			if (evt === this.handledKey) return;
			const mod = evt.ctrlKey || evt.metaKey;
			const action = searchExitAction(evt.key, evt.shiftKey, this.host.getSearchSettings().keyboard);
			if (mod && evt.key.toLowerCase() === "g") this.finishSearch(false);
			else if (mod && evt.key === "Enter") this.playMatch();
			else if (evt.key === "Tab" && !evt.shiftKey && !mod && !evt.altKey) this.finishSearch(true);
			else if (evt.key === "F3") this.stepMatch(evt.shiftKey ? -1 : 1);
			else if (action === "accept") this.finishSearch(true);
			else if (action === "cancel") this.finishSearch(false);
			else if (action === "next" || action === "previous") this.stepMatch(action === "previous" ? -1 : 1);
			else return;
			evt.preventDefault();
			evt.stopPropagation();
			this.handledKey = evt;
		});
		this.search = search;
		this.matchCountEl = bar.createSpan({ cls: "perplexity-saver-transcript-matches" });
		this.previousMatchBtn = this.iconButton(bar, "chevron-up", "Previous match", () => this.stepMatch(-1));
		this.nextMatchBtn = this.iconButton(bar, "chevron-down", "Next match", () => this.stepMatch(1));
		this.updateSearchHints();
		this.iconButton(bar, "check", "Accept match and browse transcript (Tab)", () => this.finishSearch(true));
		this.iconButton(bar, "x", "Cancel transcript search", () => this.finishSearch(false));
		this.iconButton(bar, "play", "Play the video from this match (Ctrl+Enter)", () => this.playMatch());
		if (this.host.getSearchSettings().highlights === "on-demand") {
			this.highlightBtn = this.iconButton(bar, "highlighter", "Toggle other match highlights", () => {
				this.demandHighlights = !this.demandHighlights;
				this.updateHighlights();
			});
		}
		this.filterBtn = this.iconButton(bar, "filter", "Show only matching lines", () => {
			this.filter = !this.filter;
			this.applyFilter();
			this.app.workspace.requestSaveLayout();
		});
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const btn = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
		return btn;
	}

	private updateSearchHints(): void {
		const behavior = this.host.getSearchSettings().keyboard;
		const hints = searchHints(behavior, this.app);
		if (this.searchHintsEl) {
			renderKeyHints(this.searchHintsEl, hints, "perplexity-saver");
		}
		const next = behavior === "obsidian" ? "Enter" : hints[0][0].key;
		const previous = behavior === "obsidian" ? "Shift+Enter" : hints[0][1].key;
		this.nextMatchBtn?.setAttribute("aria-label", `Next match (${next})`);
		this.previousMatchBtn?.setAttribute("aria-label", `Previous match (${previous})`);
	}

	async onClose(): Promise<void> {
		this.stopBackgroundPlayback();
		this.revealObserver?.disconnect();
		this.revealObserver = null;
		this.observedRevealEl = null;
		this.searchNavigationCleanup?.();
		this.searchVisibilityCleanup?.();
		this.searchVisibilityCleanup = null;
		this.searchNavigationCleanup = null;
	}

	/** Hide the rows that do not match while the filter is on and there is a query. */
	private applyFilter(): void {
		const active = this.filter && !!this.query.trim();
		this.listEl?.toggleClass("is-filtered", active);
		this.filterBtn?.toggleClass("is-active", this.filter);
		this.filterBtn?.setAttribute("aria-pressed", String(this.filter));
		const current = this.rendered[this.matches[this.matchIndex]];
		if (active && current) this.scrollToRow(current.el, false);
	}

	/** Highlight the rows matching the query and, with `jump`, scroll to the first match. */
	private applySearch(jump: boolean): void {
		const query = this.query.trim();
		const matching = this.host.getSearchSettings().matching;
		this.matches = [];
		this.rendered.forEach((r, i) => {
			r.ranges = !query ? [] : matching === "phrase"
				? findLiteralRanges(r.row.text, query)
				: matchAllWords(r.row.text, query) ?? [];
			r.el.toggleClass("is-match", r.ranges.length > 0);
			r.el.removeClass("is-search-current");
			if (r.ranges.length) this.matches.push(i);
		});
		this.matchIndex = -1;
		this.applyFilter();
		if (this.matches.length) this.selectMatch(0, jump);
		else this.updateHighlights();
		this.updateMatchCount();
	}

	private updateHighlights(): void {
		const all = shouldShowAllMatches(this.host.getSearchSettings().highlights, this.demandHighlights);
		this.highlightBtn?.toggleClass("is-active", this.demandHighlights);
		this.highlightBtn?.setAttribute("aria-pressed", String(this.demandHighlights));
		this.rendered.forEach((r, i) => {
			const highlight = r.ranges.length > 0 && (all || i === this.matches[this.matchIndex]);
			if (highlight || r.highlighted) {
				r.textEl.empty();
				renderHighlightedText(r.textEl, r.row.text, highlight ? r.ranges : []);
			}
			r.highlighted = highlight;
		});
	}

	private selectMatch(index: number, scroll: boolean): void {
		this.rendered[this.matches[this.matchIndex]]?.el.removeClass("is-search-current");
		this.matchIndex = index;
		const r = this.rendered[this.matches[index]];
		if (r) {
			r.el.addClass("is-search-current");
			this.setFocusRow(this.matches[index]);
			if (scroll) this.scrollToRow(r.el, false, false);
		}
		this.updateHighlights();
		this.updateMatchCount();
	}

	private rememberSearchOrigin(): void {
		this.searchOrigin ??= { row: this.focusRow, scrollTop: this.listEl ? scrollParent(this.listEl)?.scrollTop ?? 0 : 0 };
	}

	private setSearchOpen(open: boolean): void {
		this.searchOpen = open;
		if (this.searchBar) this.searchBar.hidden = !open;
	}

	/** Preserve display preferences and search recall when native placement requires a new leaf. */
	copySessionFrom(source: TranscriptView): void {
		this.pinned = source.pinned;
		this.mode = source.mode;
		this.filter = source.filter;
		this.previousQuery = source.query || source.previousQuery;
		this.render();
		const playback = source.backgroundPlayback;
		if (playback) {
			source.backgroundPlayback = null;
			this.setBackgroundPlayback(playback.transferTo(this.containerEl));
		}
	}

	private finishSearch(accept: boolean, refocus = true): void {
		const origin = this.searchOrigin;
		const target = accept ? this.matches[this.matchIndex] ?? this.focusRow : origin?.row ?? this.focusRow;
		if (this.query) this.previousQuery = this.query;
		this.query = "";
		this.setSearchOpen(false);
		this.search?.setValue("");
		this.demandHighlights = false;
		this.applySearch(false);
		this.searchOrigin = null;
		if (refocus) this.moveFocus(target);
		if (!accept && origin && this.listEl) {
			const box = scrollParent(this.listEl);
			if (box) box.scrollTop = origin.scrollTop;
		}
		this.userScrollAt = Date.now();
	}

	private stepMatch(delta: number): void {
		const n = this.matches.length;
		if (!n) return;
		this.selectMatch((((this.matchIndex + delta) % n) + n) % n, true);
	}

	private playMatch(): void {
		const idx = this.matches[this.matchIndex];
		if (idx !== undefined) this.playRow(idx, true);
	}

	private playRow(index: number, play: boolean): void {
		const r = this.rendered[index];
		if (r && this.filePath) this.host.playAt(this.filePath, r.row.url, r.row.startSec, play);
	}

	/** Move keyboard focus to the lines: the selected match, else the playing line, else the first line on screen (the search box when there are none). */
	focusLines(): void {
		const { visible, onScreen } = this.visibleRows();
		const match = this.matches[this.matchIndex];
		const target =
			match !== undefined ? match
			: visible.includes(this.currentRow) ? this.currentRow
			: onScreen[0] ?? visible[0] ?? -1;
		if (target < 0) this.focusSearch();
		else this.moveFocus(target);
	}

	/** Index of the row that has keyboard focus, or -1. */
	private focusedRowIndex(): number {
		const active = this.listEl?.ownerDocument.activeElement;
		return active ? this.rendered.findIndex((r) => r.el === active) : -1;
	}

	/** Put row `index` in the Tab order (only one row is, so Tab moves past the list). */
	private setFocusRow(index: number): void {
		if (index === this.focusRow && this.rendered[index]?.el.tabIndex === 0) return;
		const old = this.rendered[this.focusRow];
		if (old) old.el.tabIndex = -1;
		this.focusRow = index;
		const r = this.rendered[index];
		if (r) r.el.tabIndex = 0;
	}

	private moveFocus(index: number): void {
		const r = this.rendered[index];
		if (!r) return;
		this.setFocusRow(index);
		r.el.focus({ preventScroll: true });
		this.scrollToRow(r.el, true, false);
	}

	private moveFocusedRow(delta: 1 | -1, evt: KeyboardEvent): boolean {
		if (evt === this.handledKey) return false;
		if (!evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) return true;
		const index = this.focusedRowIndex();
		if (index < 0) return true;
		const { visible, onScreen } = this.visibleRows();
		this.moveFocus(stepRow(visible, index, delta, onScreen));
		this.handledKey = evt;
		this.userScrollAt = Date.now();
		return false;
	}

	/** Rows not hidden by the filter, and the subset scrolled into view. */
	private visibleRows(): { visible: number[]; onScreen: number[] } {
		const visible: number[] = [];
		const onScreen: number[] = [];
		const box = this.listEl ? scrollParent(this.listEl) : null;
		const header = this.contentEl.querySelector(".perplexity-saver-transcript-header");
		const b = box?.getBoundingClientRect();
		const top = Math.max(b?.top ?? 0, header ? header.getBoundingClientRect().bottom : 0);
		this.rendered.forEach((r, i) => {
			if (!r.el.isShown()) return;
			visible.push(i);
			const rect = r.el.getBoundingClientRect();
			if (!b || (rect.bottom > top && rect.top < b.bottom)) onScreen.push(i);
		});
		return { visible, onScreen };
	}

	private onListKey(evt: KeyboardEvent): void {
		if (evt === this.handledKey || evt.isComposing) return;
		const index = this.focusedRowIndex();
		if (index < 0) return;
		const mod = evt.ctrlKey || evt.metaKey;
		const step = (delta: 1 | -1): void => {
			const { visible, onScreen } = this.visibleRows();
			this.moveFocus(stepRow(visible, index, delta, onScreen));
		};
		const emacs = evt.ctrlKey && !evt.metaKey && !evt.altKey && !evt.shiftKey;
		const edge = (last: boolean): boolean => {
			const { visible } = this.visibleRows();
			const target = visible[last ? visible.length - 1 : 0];
			if (target === undefined) return false;
			this.moveFocus(target);
			return true;
		};
		let handled = true;
		if (evt.key === "ArrowDown" && !mod) step(1);
		else if (evt.key === "ArrowUp" && !mod) step(-1);
		else if (emacs && evt.key.toLowerCase() === "n") step(1);
		else if (emacs && evt.key.toLowerCase() === "p") step(-1);
		else if (evt.key === "Home" && !mod && !evt.shiftKey && !evt.altKey) handled = edge(false);
		else if (evt.key === "End" && !mod && !evt.shiftKey && !evt.altKey) handled = edge(true);
		else if (evt.key === "Enter") this.playRow(index, mod || !evt.shiftKey);
		else if (evt.key === "Escape") this.focusSearch();
		else if (mod && evt.key.toLowerCase() === "c" && !this.hasTextSelection()) void this.copyRowLink(index);
		else handled = false;
		if (!handled) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.handledKey = evt;
		this.userScrollAt = Date.now();
	}

	private hasTextSelection(): boolean {
		const sel = this.listEl?.ownerDocument.getSelection();
		return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
	}

	/** Copy a markdown timestamp link to row `index`, for pasting into a note. */
	private async copyRowLink(index: number): Promise<void> {
		const r = this.rendered[index];
		const url = r?.row.url || this.lines?.find((l) => l.url)?.url || "";
		const videoId = url ? parseYouTubeUrl(url)?.videoId : null;
		const win = this.listEl?.ownerDocument.defaultView;
		if (!r || !videoId || !win) {
			new Notice("No YouTube link for this transcript.");
			return;
		}
		const ok = await writeClipboardIn(win, timestampLink(videoId, r.row.startSec)).catch(() => false);
		new Notice(ok ? `Copied ${formatClock(r.row.startSec)} link.` : "Could not write to the clipboard.");
	}

	private updateMatchCount(): void {
		if (!this.matchCountEl) return;
		const n = this.matches.length;
		this.matchCountEl.setText(!this.query.trim() ? "" : n ? `${this.matchIndex + 1}/${n}` : "No matches");
	}

	/**
	 * Scroll `rowEl` to the middle of the list's visible area (below the sticky
	 * header); with `onlyIfNeeded`, only when it is near an edge or hidden.
	 */
	private scrollToRow(rowEl: HTMLElement, onlyIfNeeded: boolean, smooth = true): boolean {
		const box = scrollParent(rowEl);
		if (!box) {
			if (typeof rowEl.isShown === "function" && !rowEl.isShown()) return false;
			rowEl.scrollIntoView({ block: "center" });
			return true;
		}
		const b = box.getBoundingClientRect();
		const header = this.contentEl.querySelector(".perplexity-saver-transcript-header");
		const top = Math.max(b.top, header ? header.getBoundingClientRect().bottom : b.top);
		const height = b.bottom - top;
		const r = rowEl.getBoundingClientRect();
		if (height <= 0) return false;
		if (onlyIfNeeded && r.top >= top + height * 0.25 && r.bottom <= b.bottom - height * 0.25) return true;
		const delta = r.top - top - Math.max(0, (height - r.height) / 2);
		box.scrollTo({ top: box.scrollTop + delta, behavior: smooth ? "smooth" : "auto" });
		return true;
	}
}

export type TranscriptPanelLocation = "sidebar" | "viewer" | "beside";

export const TRANSCRIPT_LOCATIONS: Record<TranscriptPanelLocation, string> = {
	sidebar: "Right sidebar",
	viewer: "Below the video viewer",
	beside: "Beside the video viewer",
};

/** Where a non-sidebar transcript panel goes: split off `nextTo` (the video viewer's leaf). */
export interface TranscriptPlacement {
	nextTo: WorkspaceLeaf;
	/** "horizontal" puts the panel below, "vertical" to the right. */
	direction: "horizontal" | "vertical";
}

// True while the right sidebar is open only because showTranscriptPanel expanded it.
let expandedRightSidebar = false;

/**
 * Transcript panels currently on screen: not a background tab (its content
 * element is hidden) and not inside a collapsed sidebar. With `scope`, only
 * panels in the same window as that leaf.
 */
export function visibleTranscriptLeaves(app: App, scope?: WorkspaceLeaf | null, filePath?: string | null): WorkspaceLeaf[] {
	const scopeWin = scope ? getWindowForLeaf(scope) : undefined;
	return app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).filter((leaf) => {
		if (isInCollapsedSidebar(app, leaf)) return false;
		if (scope && getWindowForLeaf(leaf) !== scopeWin) return false;
		if (filePath && (!(leaf.view instanceof TranscriptView) || leaf.view.getFilePath() !== filePath)) return false;
		const el = leaf.view?.containerEl;
		return !el || typeof el.isShown !== "function" || el.isShown();
	});
}

/**
 * Close every visible transcript panel (in `scope`'s window, when given), and
 * collapse the right sidebar again if showing the transcript expanded it.
 * Returns true when a panel was closed.
 */
export function hideTranscriptPanels(app: App, scope?: WorkspaceLeaf | null, filePath?: string | null): boolean {
	const leaves = visibleTranscriptLeaves(app, scope, filePath);
	const inSidebar = leaves.some((leaf) => isSidebarLeaf(app, leaf));
	for (const leaf of leaves) leaf.detach();
	if (inSidebar) {
		if (expandedRightSidebar && isSidebarCollapsed(app, "right") === false) {
			setSidebarCollapsed(app, "right", true);
		}
		expandedRightSidebar = false;
	}
	return leaves.length > 0;
}

/**
 * Open (or reuse) the transcript panel for `file`. With `replaceLeaf`, initialize
 * the new placement before closing the old pane, retaining display/search recall.
 */
export async function showTranscriptPanel(
	app: App,
	file: TFile,
	headingName: string,
	placement?: TranscriptPlacement | null,
	replaceLeaf?: WorkspaceLeaf | null,
	associatedOnly = false
): Promise<WorkspaceLeaf | null> {
	const lines = await loadTranscriptLines(app, file, headingName);
	if (!lines?.length) {
		const heading = normalizeTranscriptHeading(headingName);
		new Notice(`No timestamped transcript under a "${heading}" heading in ${file.basename}.`);
		return null;
	}
	let leaf: WorkspaceLeaf;
	let createdLeaf: WorkspaceLeaf | null = null;
	try {
		if (placement) {
			const win = getWindowForLeaf(placement.nextTo);
			const existing = replaceLeaf ? undefined : app.workspace
				.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)
				.find((l) => !isSidebarLeaf(app, l) && getWindowForLeaf(l) === win &&
					(!associatedOnly || (l.view instanceof TranscriptView && l.view.getFilePath() === file.path)));
			leaf = existing ?? app.workspace.createLeafBySplit(placement.nextTo, placement.direction);
			if (!existing) {
				createdLeaf = leaf;
				await leaf.setViewState({ type: TRANSCRIPT_VIEW_TYPE, active: false, state: { file: file.path } });
			}
		} else {
			const existing = app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)
				.find((l) => isSidebarLeaf(app, l, "right") &&
					(!associatedOnly || (l.view instanceof TranscriptView && l.view.getFilePath() === file.path)));
			const sideLeaf = existing ?? app.workspace.getRightLeaf(associatedOnly);
			if (!sideLeaf) throw new Error("Right sidebar is unavailable.");
			leaf = sideLeaf;
			if (!existing) {
				createdLeaf = leaf;
				await leaf.setViewState({ type: TRANSCRIPT_VIEW_TYPE, active: false, state: { file: file.path } });
			}
		}
		await loadLeafIfDeferred(leaf);
		if (leaf.view instanceof TranscriptView) await leaf.view.showFile(file.path);
		const collapsed = !placement && isSidebarCollapsed(app, "right") === true;
		await app.workspace.revealLeaf(leaf);
		if (!placement) {
			if (collapsed) expandedRightSidebar = true;
			else if (createdLeaf) expandedRightSidebar = false;
		}
		if (replaceLeaf && replaceLeaf !== leaf && leaf.view instanceof TranscriptView && replaceLeaf.view instanceof TranscriptView) {
			leaf.view.copySessionFrom(replaceLeaf.view);
		}
	} catch (error) {
		createdLeaf?.detach();
		throw error;
	}
	if (replaceLeaf && replaceLeaf !== leaf) {
		const wasSidebar = isSidebarLeaf(app, replaceLeaf);
		replaceLeaf.detach();
		if (wasSidebar && expandedRightSidebar && !app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).some((l) => l !== replaceLeaf && isSidebarLeaf(app, l))) {
			setSidebarCollapsed(app, "right", true);
			expandedRightSidebar = false;
		}
	}
	return leaf;
}
