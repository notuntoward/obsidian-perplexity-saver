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
	getActiveLeafInFocusedWindow,
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
import { buildTranscriptParagraphs, groupSentencesIntoParagraphs, needsSpaceBetween, SENTENCE_END } from "./transcriptParagraphs";
import { isEnglishTranscript, resolveTranscriptLanguage } from "./transcriptLanguage";
import { prepareTranscript, sentenceRows } from "./transcriptSentences";
import { formatShortTimestamp } from "./youtubeTranscript";
import { alignedSentenceRows, ALIGNMENT_CACHE_KEY, readAlignmentCache, type WordTimings } from "./transcriptAlignment";
import { readInlineTimings } from "./transcriptTimingStorage";
import { formatClock, parseYouTubeUrl, timestampLink } from "../video/youtubeLinks";
import type { BackgroundPlayback } from "../video/backgroundPlayback";

export const TRANSCRIPT_VIEW_TYPE = "perplexity-saver-transcript";

/** Native shortcuts belong to Saver; other search plugins are optional. */
export function transcriptSearchCommands(app: App): Command[] {
	return (["forward", "backward"] as const).map((direction) => ({
		id: `transcript-search-${direction}`,
		name: `Transcript search: ${direction === "forward" ? "Forward" : "Reverse"} Emacs`,
		checkCallback: (checking: boolean): boolean => {
			const leaves = app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE);
			for (const leaf of leaves) {
				if (!(leaf.view instanceof TranscriptView)) continue;
				const target = leaf.view.contentEl.ownerDocument.activeElement;
				if (target && (leaf.view.containerEl ?? leaf.view.contentEl).contains(target)) {
					return dispatchSearchNavigation(target, direction, checking);
				}
			}
			if (!leaves.some((leaf) => {
				if (!(leaf.view instanceof TranscriptView)) return false;
				const doc = leaf.view.contentEl.ownerDocument;
				return !doc.activeElement || doc.activeElement === doc.body;
			})) return false;
			const view = getActiveLeafInFocusedWindow(app, { includeSidebars: true })?.view;
			const doc = view?.containerEl?.ownerDocument;
			if (view instanceof TranscriptView && (!doc?.activeElement || doc.activeElement === doc.body)) {
				return dispatchSearchNavigation(view.contentEl, direction, checking);
			}
			return false;
		},
	}));
}

export type TranscriptViewMode = "lines" | "paragraphs" | "sentences" | "aligned-sentences" | "readable-paragraphs";

const TRANSCRIPT_MODES = {
	"readable-paragraphs": "Paragraphs",
	sentences: "Sentences",
	lines: "Captions",
};

function isTranscriptMode(value: unknown): value is TranscriptViewMode {
	return typeof value === "string" && (Object.prototype.hasOwnProperty.call(TRANSCRIPT_MODES, value) ||
		value === "paragraphs" || value === "aligned-sentences");
}

function readingMode(mode: TranscriptViewMode): keyof typeof TRANSCRIPT_MODES {
	return mode === "paragraphs" ? "readable-paragraphs" : mode === "aligned-sentences" ? "sentences" : mode;
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
	paragraphStart?: boolean;
	captionFallback?: boolean;
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
	alignment?: WordTimings | null
): TranscriptRow[] {
	const prepared = prepareTranscript(lines);
	const offsets = new Map(prepared.lines.map((line, i) => [line, prepared.cueStarts[i]]));
	if (mode === "lines") return lines.map((line) => ({
		startSec: line.startSec, url: line.url, text: line.text,
		sourceStart: offsets.get(line),
	}));
	if (mode === "sentences") return alignment ? alignedSentenceRows(prepared, alignment)
		: sentenceRows(prepared).map((row) => ({ ...row, timingUncertain: !prepared.cueStarts.includes(row.sourceStart) }));
	if (mode === "aligned-sentences") {
		if (!alignment) throw new Error("Word timings are unavailable for this transcript.");
		return alignedSentenceRows(prepared, alignment);
	}
	if (mode === "readable-paragraphs") {
		const cueStarts = new Set(prepared.cueStarts);
		const sentences = sentenceRows(prepared);
		const captionFallback = sentences.length === 1 && prepared.lines.length > 1 && !SENTENCE_END.test(prepared.text);
		const units = captionFallback
			? prepared.lines.map((line, i) => ({ startSec: line.startSec, url: line.url, text: line.text, sourceStart: prepared.cueStarts[i] }))
			: alignment ? alignedSentenceRows(prepared, alignment)
				: sentences.map((row) => ({ ...row, timingUncertain: !cueStarts.has(row.sourceStart) }));
		return groupSentencesIntoParagraphs(units, captionFallback && isEnglishTranscript(prepared.language) ? undefined : prepared.language)
			.flatMap((group) => group.map((row, i) => ({ ...row, paragraphStart: i === 0, captionFallback })));
	}
	const cues = storedLinesToCues(lines).map((cue, i) => ({ ...cue, sourceStart: prepared.cueStarts[i] }));
	return buildTranscriptParagraphs(cues).map((p) => ({
		startSec: p.startSec,
		url: p.cues[0].url,
		text: p.text,
		sourceStart: p.cues[0].sourceStart,
	}));
}

/** What the video's next/previous controls step through with no transcript panel open: sentences, or captions when the transcript has no sentence boundaries. */
export function hiddenTranscriptNavigationRows(app: App, file: TFile, lines: StoredTranscriptLine[]): TranscriptRow[] {
	if (!lines.length) return [];
	const transcript = prepareTranscript(lines);
	let timings: WordTimings | null = null;
	try {
		timings = readInlineTimings(transcript) ?? readAlignmentCache(app.metadataCache.getFileCache(file)?.frontmatter?.[ALIGNMENT_CACHE_KEY], transcript);
	} catch {
		// Stale or invalid saved timings: use caption-based sentence starts.
	}
	return transcriptRows(lines, "readable-paragraphs", timings);
}

/** What the transcript panel needs from the plugin. */
export interface TranscriptViewHost {
	getHeadingName(): string;
	getSearchSettings(): TranscriptSearchSettings;
	getAlignmentEnabled?(): boolean;
	paragraphWarnings?: Set<string>;
	insertTimestampAt?(filePath: string, url: string, seconds: number): Promise<void>;
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
	getOrientation?(filePath: string): "below" | "beside";
	onFormatChanged?(filePath: string): void;
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
	private mode: keyof typeof TRANSCRIPT_MODES = "readable-paragraphs";
	private lines: StoredTranscriptLine[] | null = null;
	private alignmentCache: WordTimings | null = null;
	private needsTimingMigration = false;
	private alignmentStatus = "Sentence timing: not computed.";
	private aligning = false;
	private timingProblem: string | null = null;
	private readonly paragraphWarnings = this.host.paragraphWarnings ?? new Set<string>();
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
	private followOverride: boolean | null = null;
	private currentRow = -1;
	/** Timestamp whose row must be centered as soon as the panel can scroll. */
	private revealSeconds: number | null = null;
	private revealObserver: ResizeObserver | null = null;
	private observedRevealEl: HTMLElement | null = null;
	private followingPaused = false;
	private playingPassageBtn: HTMLElement | null = null;
	private followBtn: HTMLElement | null = null;
	private selectionBar: HTMLElement | null = null;
	private selectedSourceStart: number | null = null;
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
		return "file-text";
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
		const touched = (): void => this.pauseFollowing();
		this.registerDomEvent(this.contentEl, "wheel", touched, { passive: true });
		this.registerDomEvent(this.contentEl, "pointerdown", (evt) => {
			const target = evt.target as HTMLElement | null;
			if (target === this.contentEl || (target && this.listEl?.contains(target))) touched();
		});
		this.registerDomEvent(this.contentEl, "touchmove", touched, { passive: true });
		this.registerDomEvent(this.contentEl, "keydown", (evt) => {
			if (evt.ctrlKey || evt.metaKey || evt.altKey || (evt.key !== "PageDown" && evt.key !== "PageUp")) return;
			const target = evt.target as HTMLElement | null;
			if (!target?.closest("input, textarea, select, [contenteditable=true]")) touched();
		});
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
				this.followingPaused = false;
				this.followOverride = null;
				this.selectedSourceStart = null;
			}
			this.filePath = s.file;
		}
		if (isTranscriptMode(s.mode)) this.mode = readingMode(s.mode);
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
			this.followingPaused = false;
			this.followOverride = null;
			this.selectedSourceStart = null;
		}
		this.filePath = path;
		await this.reload();
	}

	/** Re-read the note (for example after the heading setting changed). */
	async reload(options?: { showWordTimedSentences?: boolean }): Promise<void> {
		const token = ++this.loadToken;
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		const lines = file ? await loadTranscriptLines(this.app, file, this.host.getHeadingName()) : null;
		if (token !== this.loadToken) return;
		if (this.lines?.length !== lines?.length || this.lines?.some((line, i) => line.text !== lines?.[i]?.text)) {
			this.selectedSourceStart = null;
		}
		this.lines = lines;
		this.loadAlignmentCache(file, lines);
		if (options?.showWordTimedSentences && this.alignmentCache) this.setMode("sentences");
		else this.render();
	}

	private loadAlignmentCache(file: TFile | null, lines: StoredTranscriptLine[] | null): void {
		this.alignmentCache = null;
		this.needsTimingMigration = false;
		this.timingProblem = null;
		this.alignmentStatus = "Sentence timing: not computed.";
		if (!file || !lines?.length) return;
		const raw: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[ALIGNMENT_CACHE_KEY];
		try {
			const transcript = prepareTranscript(lines);
			this.alignmentCache = readInlineTimings(transcript) ?? readAlignmentCache(raw, transcript);
			this.needsTimingMigration = raw !== undefined && this.alignmentCache !== null;
			if (this.alignmentCache) {
				const sentences = alignedSentenceRows(transcript, this.alignmentCache);
				const missing = sentences.filter((sentence) => sentence.timingUncertain).length;
				this.alignmentStatus = `Sentence timing: ${sentences.length - missing}/${sentences.length} sentence starts timed; ${missing} approximate. Saved offline. ≈ marks estimated starts.` +
					(this.needsTimingMigration ? " Compact saved timings moves the old Properties cache into transcript links, offline." : "");
			} else if (raw !== undefined || lines.some((line) => line.timingMarker !== undefined || line.wordTimings !== undefined)) {
				this.alignmentStatus = "Sentence timing: saved timings are stale. Choose Get timings in More to refresh sentence starts.";
				this.timingProblem = "Saved timings no longer match this transcript. Get timings to refresh them.";
			}
		} catch (error: unknown) {
			console.error("Perplexity Saver: invalid saved timing cache", error);
			this.alignmentStatus = error instanceof Error ? error.message : "Invalid saved transcript timing cache.";
			this.timingProblem = this.alignmentStatus;
		}
	}

	/** The displayed segmentation also drives existing next/previous timestamp commands. */
	getRows(lines = this.lines ?? []): TranscriptRow[] {
		return transcriptRows(lines, readingMode(this.mode), this.alignmentCache);
	}

	getNavigationUnit(): "sentence" | "caption" {
		return this.mode === "lines" || this.rendered[0]?.row.captionFallback ? "caption" : "sentence";
	}

	/** Put the cursor in the search box. */
	focusSearch(): void {
		const input = this.search?.inputEl;
		if (!input) return;
		this.setSearchOpen(true);
		this.pauseFollowing();
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
		this.follow = this.followOverride ?? follow;
		follow = this.follow;
		this.updateFollowButton();
		let resumed = false;
		if (stateChanged) {
			const playing = this.playbackIsPlaying();
			resumed = playing && !this.lastPlaying;
			this.lastPlaying = playing;
			this.refreshPlaybackControls(playing);
			if (resumed) this.dropSelection();
		}
		const idx = seconds === null ? -1 : currentRowIndex(this.rowStarts, seconds);
		const changed = idx !== this.currentRow;
		if (changed) {
			this.rendered[this.currentRow]?.el.removeClass("is-playing");
			this.currentRow = idx;
			this.rendered[idx]?.el.addClass("is-playing");
			// While following, the keyboard cursor rides with playback so its focus ring is not left behind as a second mark.
			if (this.isFollowing() && this.rendered[idx]) {
				const hadFocus = this.focusedRowIndex() >= 0;
				this.setFocusRow(idx);
				if (hadFocus) this.rendered[idx].el.focus({ preventScroll: true });
			}
		}
		const current = this.rendered[idx];
		if (!current) {
			// The transcript can still be loading, hidden in a collapsed sidebar, or
			// in a deferred view. Keep the request until layout makes the row usable.
			if (reveal || (resumed && follow && !this.followingPaused)) this.revealSeconds = seconds;
			return;
		}
		if (reveal || (resumed && follow && !this.followingPaused)) {
			this.revealSeconds = seconds;
			this.retryReveal();
		} else if (changed && follow && !this.followingPaused && !this.query.trim()) {
			this.scrollToRow(current.el, true);
		}
		this.retryReveal();
	}

	private isFollowing(): boolean {
		return this.follow && !this.followingPaused && !this.query.trim();
	}

	/**
	 * A selection marks the row the user is browsing, so it exists only while following
	 * is paused or off. Anything that hands the transcript back to playback (playing
	 * from a row, resuming playback, turning Follow back on) calls this; otherwise the
	 * panel shows the selected row and the playing row as two marks.
	 */
	private dropSelection(): void {
		if (this.selectedSourceStart === null) return;
		this.selectedSourceStart = null;
		this.updateSelection();
	}

	private pauseFollowing(): void {
		this.followingPaused = true;
		this.revealSeconds = null;
		this.updateFollowButton();
	}

	private updateFollowButton(): void {
		const enabled = this.follow && !this.followingPaused;
		this.followBtn?.setAttribute("aria-pressed", String(enabled));
		this.followBtn?.toggleClass("is-active", enabled);
		if (this.playingPassageBtn) this.playingPassageBtn.hidden = enabled || this.playbackSec === null;
	}

	private revealPlayingPassage(): void {
		this.finishSearch(true, false);
		this.showPlayback(this.playbackSec, this.follow, false, true);
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
		this.focusLines(false);
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
		this.followingPaused = false;
		this.followOverride = null;
		this.selectedSourceStart = null;
		this.filePath = file.path;
		this.comparisonSourceStart = null;
		this.setSearchOpen(false);
		this.lines = lines;
		this.loadAlignmentCache(file, lines);
		this.render();
	}

	private setMode(mode: TranscriptViewMode): void {
		// While following, the playing row is the reading position; otherwise keep the row the user is reading.
		const following = this.isFollowing() && this.rendered[this.currentRow] !== undefined;
		const { visible, onScreen } = this.visibleRows();
		const focused = this.focusedRowIndex();
		const row = following ? this.rendered[this.currentRow]
			: this.rendered[onScreen.includes(focused) ? focused : onScreen[0] ?? visible[0] ?? -1];
		const anchor = row?.row.startSec ?? this.playbackSec;
		const source = row?.row.sourceStart;
		const previous = this.comparisonSourceStart;
		this.comparisonSourceStart = source === undefined ? null
			: previous !== null && previous >= source && previous < source + row.row.text.length ? previous : source;
		const hadFocus = this.focusedRowIndex() >= 0;
		this.mode = readingMode(mode);
		this.render();
		const playing = this.rendered[this.currentRow];
		if (following && playing) {
			this.setFocusRow(this.currentRow);
			this.scrollToRow(playing.el, false, false);
			if (hadFocus) playing.el.focus({ preventScroll: true });
		} else if (anchor !== null && anchor !== undefined) {
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
		this.mode = readingMode(this.mode);
		const el = this.contentEl;
		const input = this.search?.inputEl;
		const searchFocused = !!input && input.ownerDocument.activeElement === input;
		const rowHadFocus = this.focusedRowIndex() >= 0;
		this.searchNavigationCleanup?.();
		this.searchVisibilityCleanup?.();
		this.searchNavigationCleanup = null;
		this.searchHintsEl = null;
		this.playingPassageBtn = null;
		this.followBtn = null;
		this.selectionBar = null;
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
		const summary = controls.createDiv({ cls: "perplexity-saver-transcript-summary" });
		const title = summary.createEl("a", {
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
		if (this.mode === "readable-paragraphs") {
			const language = resolveTranscriptLanguage(lines.map((line) => line.language));
			const captionFallback = rows[0]?.captionFallback;
			const warningKey = `${file.path}:${language ?? "unknown"}:${captionFallback ? "captions" : "sentences"}`;
			if ((!isEnglishTranscript(language) || captionFallback) && !this.paragraphWarnings.has(warningKey)) {
				const message = isEnglishTranscript(language) ? "Using length-based paragraphs."
					: language ? "Using length-based paragraphs for this language; topic-aware grouping is English-only."
						: "Using length-based paragraphs because the caption language is unknown; topic-aware grouping is English-only.";
				new Notice(message + (captionFallback ? " No sentence boundaries found; grouping whole captions instead." : ""));
				this.paragraphWarnings.add(warningKey);
			}
		}
		const lineNoun = lines.some((l) => l.endSec !== undefined) ? "captions" : "lines";
		const details = this.mode === "readable-paragraphs" ? `${rows.filter((row) => row.paragraphStart).length} paragraphs · ${rows.length} ${rows[0]?.captionFallback ? "captions" : "sentences"}`
				: this.mode === "lines" ? `${rows.length} ${lineNoun}`
				: `${rows.length} sentences`;
		const presentation = controls.createDiv({ cls: "perplexity-saver-transcript-control-group" });
		const format = new DropdownComponent(presentation).addOptions(TRANSCRIPT_MODES).setValue(this.mode)
			.onChange((mode) => {
				if (isTranscriptMode(mode)) this.setMode(mode);
				format.setValue(this.mode);
			});
		format.selectEl.setAttribute("aria-label", "Transcript segmentation");
		format.selectEl.addClass("perplexity-saver-transcript-segmentation");
		this.iconButton(presentation, "search", "Search transcript (Ctrl/Cmd+F)", () => this.focusSearch());
		this.followBtn = this.iconButton(controls, "arrow-down", "Follow video", () => {
			this.followOverride = !this.follow || this.followingPaused;
			this.follow = this.followOverride;
			this.followingPaused = !this.follow;
			if (this.follow) this.dropSelection();
			this.revealSeconds = null;
			this.updateFollowButton();
			if (this.follow) this.revealPlayingPassage();
		});
		this.followBtn.appendText("Follow video");
		this.followBtn.addClass("perplexity-saver-transcript-follow");
		this.followBtn.setAttribute("title", "Automatically scroll the transcript with playback");
		const layout = controls.createDiv({ cls: "perplexity-saver-transcript-control-group" });
		const chrome = this.iconButton(layout, "panel-top", "Show pane tabs and navigation", () => {
			el.toggleClass("show-pane-chrome", !el.hasClass("show-pane-chrome"));
			this.render();
		});
		chrome.setAttribute("aria-pressed", String(el.hasClass("show-pane-chrome")));
		chrome.toggleClass("is-active", el.hasClass("show-pane-chrome"));
		if (this.host.toggleOrientation) {
			const below = this.host.getOrientation?.(file.path) === "below";
			const placement = this.iconButton(layout, below ? "arrow-right-to-line" : "arrow-down-to-line",
				below ? "Move transcript beside video" : "Move transcript below video", () => {
					void this.host.toggleOrientation?.(file.path).then(() => this.render()).catch((error: unknown) => {
						console.error("Perplexity Saver: could not change transcript orientation", error);
						new Notice("Could not change transcript orientation.");
					});
			});
			placement.appendText(below ? "Beside video" : "Below video");
		}
		if (this.host.runPlaybackControl) {
			const playback = controls.createDiv({ cls: "perplexity-saver-transcript-playback" });
			const transport = playback.createDiv({ cls: "perplexity-saver-transcript-control-group" });
			const unit = this.mode === "lines" || rows[0]?.captionFallback ? "caption" : "sentence";
			for (const [icon, label, action] of [
				["chevron-up", `Previous ${unit}`, "previous"],
				["play", "Play", "play"],
				["chevron-down", `Next ${unit}`, "next"],
			] as const) {
				const button = this.iconButton(transport, icon, label, () => {
					if (this.filePath && !playback.hidden) this.host.runPlaybackControl?.(this.filePath, action);
				});
				if (action === "play") button.addClass("perplexity-saver-transcript-play-toggle");
			}
			const capture = playback.createDiv({ cls: "perplexity-saver-transcript-control-group" });
			this.iconButton(capture, "list-plus", "Insert current timestamp", () => {
				if (this.filePath && !playback.hidden) this.host.runPlaybackControl?.(this.filePath, "insert");
			});
			this.refreshPlaybackControls();
		}
		const actions = controls.createDiv({ cls: "perplexity-saver-transcript-control-group" });
		const more = this.iconButton(actions, "ellipsis", "More transcript options", () => {
			const menu = new Menu();
			menu.addItem((item) => item.setTitle("Transcript details").onClick(() => { new Notice(`${details}. ${this.alignmentStatus}`, 12000); }));
			if (this.aligning) {
				menu.addItem((item) => item.setTitle("Cancel caption timing").onClick(() => this.host.cancelAlignment?.()));
			} else if (this.host.alignTranscript && (this.needsTimingMigration || (alignmentEnabled && !this.alignmentCache))) {
				menu.addItem((item) => item.setTitle(this.needsTimingMigration ? "Compact saved timings" : "Get timings")
					.onClick(() => this.saveCaptionTimings()));
			}
			menu.addItem((item) => item.setTitle("Keyboard help").setChecked(el.hasClass("show-help"))
				.onClick(() => el.toggleClass("show-help", !el.hasClass("show-help"))));
			const rect = more.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom }, more.ownerDocument);
		});
		more.setAttribute("aria-haspopup", "menu");
		this.iconButton(actions, "x", "Close transcript pane", () => {
			if (this.host.closePanel) void this.host.closePanel(this.leaf).catch((error: unknown) => {
				console.error("Perplexity Saver: could not close transcript", error);
				new Notice("Could not close transcript pane.");
			});
			else this.leaf.detach();
		}).addClass("perplexity-saver-transcript-close");
		this.playingPassageBtn = this.iconButton(header, "locate", "Show playing passage", () => this.revealPlayingPassage());
		this.playingPassageBtn.appendText("Show playing passage");
		this.playingPassageBtn.addClass("perplexity-saver-transcript-reveal");
		this.updateFollowButton();
		if (this.timingProblem || this.aligning) {
			header.createDiv({ cls: "perplexity-saver-transcript-timing-status",
				text: this.aligning ? "Saving caption timings..." : this.timingProblem ?? "",
				attr: { role: "status" } });
		}
		this.buildSearch(header);
		const hints = header.createDiv({ cls: "perplexity-saver-transcript-hints" });
		this.searchHintsEl = hints.createDiv({ cls: "is-search" });
		this.updateSearchHints();
		renderKeyHints(hints.createDiv({ cls: "is-rows" }), ROW_HINTS, "perplexity-saver");
		this.selectionBar = header.createDiv({ cls: "perplexity-saver-transcript-selection" });

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
		list.addEventListener("click", (evt) => {
			if (this.hasTextSelection()) return;
			const target = evt.target as HTMLElement | null;
			if (target?.closest("a")) return;
			const row = target?.closest(".perplexity-saver-transcript-row");
			const index = this.rendered.findIndex((entry) => entry.el === row);
			if (index >= 0) {
				this.pauseFollowing();
				this.setFocusRow(index);
				this.selectRow(index);
			}
		});
		let parent = list;
		let previousText = "";
		for (const row of rows) {
			if (row.paragraphStart) parent = list.createDiv({ cls: "perplexity-saver-transcript-paragraph", attr: { role: "group" } });
			else if (this.mode === "readable-paragraphs" && needsSpaceBetween(previousText, row.text)) parent.appendText(" ");
			const rowEl = parent.createEl(this.mode === "readable-paragraphs" ? "span" : "div", {
				cls: "perplexity-saver-transcript-row",
				// No aria-label: Obsidian shows aria-labels as hover tooltips; the row's own text is its accessible name.
				attr: { tabindex: "-1", role: "option" },
			});
			const stamp = `${row.timingUncertain ? "≈ " : ""}${formatShortTimestamp(row.startSec * 1000)}`;
			if (row.timingUncertain) rowEl.setAttribute("title", "Approximate sentence start: the first word has no accepted timing.");
			if (this.mode !== "readable-paragraphs") {
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
			}
			const textEl = rowEl.createEl(this.mode === "readable-paragraphs" ? "span" : "div", { cls: "perplexity-saver-transcript-text", text: row.text });
			this.rendered.push({ row, el: rowEl, textEl, highlighted: false, ranges: [] });
			this.rowStarts.push(row.startSec);
			previousText = row.text;
		}

		this.focusRow = Math.min(this.focusRow, this.rendered.length - 1);
		this.setFocusRow(this.focusRow >= 0 ? this.focusRow : 0);
		this.updateSelection();
		if (rowHadFocus) this.rendered[this.focusRow]?.el.focus({ preventScroll: true });
		const keep = this.matchIndex;
		this.applySearch(false);
		if (this.matches.length && keep >= 0) this.selectMatch(Math.min(keep, this.matches.length - 1), false);
		if (searchFocused) this.focusSearch();
		if (this.playbackSec !== null) this.showPlayback(this.playbackSec, this.follow, false);
		this.retryReveal();
		this.host.onFormatChanged?.(file.path);
	}

	private saveCaptionTimings(): void {
		if (!this.filePath || this.aligning || !this.host.alignTranscript) return;
		this.aligning = true;
		this.render();
		void this.host.alignTranscript(this.filePath).catch((error: unknown) => {
			console.error("Perplexity Saver: caption timing failed", error);
			new Notice(error instanceof Error ? error.message : "Caption timing failed.");
		}).finally(() => {
			this.aligning = false;
			void this.reload().catch((error: unknown) => {
				console.error("Perplexity Saver: could not reload timings", error);
				new Notice("Could not reload saved timings.");
			});
		});
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
		const navigate = (direction: "forward" | "backward", checking: boolean): boolean => {
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
		};
		const root = this.containerEl ?? this.contentEl;
		const cleanupRoot = onSearchNavigation(root, navigate);
		const cleanupBackground = onSearchNavigation(root.ownerDocument.body, (direction, checking) => {
			if (!root.isConnected) return false;
			const active = root.ownerDocument.activeElement;
			if (active && active !== root.ownerDocument.body) return false;
			return getActiveLeafInFocusedWindow(this.app, { includeSidebars: true })?.view === this && navigate(direction, checking);
		});
		this.searchNavigationCleanup = () => { cleanupRoot(); cleanupBackground(); };
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
		this.selectedSourceStart = source.selectedSourceStart;
		this.followOverride = source.followOverride;
		this.follow = source.follow;
		this.followingPaused = source.followingPaused;
		this.lastPlaying = source.lastPlaying;
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
		if (!r || !this.filePath) return;
		// Playback takes over from the chosen row: its playing marker replaces the selection, and following resumes there.
		this.dropSelection();
		this.followingPaused = false;
		this.updateFollowButton();
		this.host.playAt(this.filePath, r.row.url, r.row.startSec, play);
	}

	/** Move keyboard focus to the lines: the selected match, else the playing line, else the first line on screen (the search box when there are none). */
	focusLines(select = true): void {
		const { visible, onScreen } = this.visibleRows();
		const match = this.matches[this.matchIndex];
		const target =
			match !== undefined ? match
			: visible.includes(this.currentRow) ? this.currentRow
			: onScreen[0] ?? visible[0] ?? -1;
		if (target < 0) this.focusSearch();
		else this.moveFocus(target, select);
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

	private moveFocus(index: number, select = true): void {
		const r = this.rendered[index];
		if (!r) return;
		if (select) {
			this.pauseFollowing();
			this.selectRow(index);
		}
		this.setFocusRow(index);
		r.el.focus({ preventScroll: true });
		this.scrollToRow(r.el, true, false);
	}

	private selectRow(index: number): void {
		this.selectedSourceStart = this.rendered[index]?.row.sourceStart ?? null;
		this.updateSelection();
	}

	private updateSelection(): void {
		const bar = this.selectionBar;
		if (!bar) return;
		const index = this.selectedSourceStart === null ? -1
			: currentRowIndex(this.rendered.map((entry) => entry.row.sourceStart ?? 0), this.selectedSourceStart);
		this.rendered.forEach((entry, i) => {
			entry.el.toggleClass("is-selected", i === index);
			entry.el.setAttribute("aria-selected", String(i === index));
		});
		bar.empty();
		bar.hidden = index < 0;
		const row = this.rendered[index]?.row;
		if (!row) return;
		const stamp = `${row.timingUncertain ? "≈ " : ""}${formatClock(row.startSec)}`;
		bar.createSpan({ text: `Selected ${this.getNavigationUnit()} · ${stamp}` });
		if (this.host.insertTimestampAt) {
			this.iconButton(bar, "file-plus-2", "Insert selected timestamp into note", () => {
				if (!this.filePath) return;
				void this.host.insertTimestampAt?.(this.filePath, row.url, row.startSec).catch((error: unknown) => {
					console.error("Perplexity Saver: could not insert selected timestamp", error);
					new Notice("Could not insert selected timestamp into the note.");
				});
			}).appendText(`Insert ${stamp}`);
		}
		this.iconButton(bar, "copy", "Copy selected timestamp link", () => void this.copyRowLink(index));
	}

	private moveFocusedRow(delta: 1 | -1, evt: KeyboardEvent): boolean {
		if (evt === this.handledKey) return false;
		if (!evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) return true;
		const index = this.focusedRowIndex();
		if (index < 0) return true;
		const { visible, onScreen } = this.visibleRows();
		this.moveFocus(stepRow(visible, index, delta, onScreen));
		this.handledKey = evt;
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
