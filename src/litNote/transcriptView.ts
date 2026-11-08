import { ItemView, Notice, Scope, SearchComponent, TFile, setIcon } from "obsidian";
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
import { formatShortTimestamp } from "./youtubeTranscript";
import { formatClock, parseYouTubeUrl, timestampLink } from "../video/youtubeLinks";

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

export type TranscriptViewMode = "lines" | "paragraphs";

export interface TranscriptSearchSettings {
	keyboard: SearchExitBehavior;
	matching: "all-words" | "phrase";
	highlights: AllMatchesDisplayMode;
}

interface TranscriptViewState {
	file?: string | null;
	mode?: TranscriptViewMode;
	filter?: boolean;
}

interface TranscriptRow {
	startSec: number;
	url: string;
	text: string;
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
	mode: TranscriptViewMode
): TranscriptRow[] {
	if (mode === "lines") return lines.map(({ startSec, url, text }) => ({ startSec, url, text }));
	return buildTranscriptParagraphs(storedLinesToCues(lines)).map((p) => ({
		startSec: p.startSec,
		url: p.cues[0].url,
		text: p.text,
	}));
}

/** What the transcript panel needs from the plugin. */
export interface TranscriptViewHost {
	getHeadingName(): string;
	getSearchSettings(): TranscriptSearchSettings;
	/**
	 * Show the video at `seconds` in the video viewer; `url` is the row's timestamp
	 * link (may be empty). With `play`, start playing; otherwise keep playing or paused.
	 */
	playAt(filePath: string, url: string, seconds: number, play: boolean): void;
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
		{ key: "Ctrl+Home/End", action: "first/last timestamp" },
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
	private filePath: string | null = null;
	private mode: TranscriptViewMode = "lines";
	private lines: StoredTranscriptLine[] | null = null;
	private loadToken = 0;
	private rendered: RenderedRow[] = [];
	private rowStarts: number[] = [];
	private query = "";
	private previousQuery = "";
	/** Indexes into `rendered` of the rows matching `query`. */
	private matches: number[] = [];
	private matchIndex = -1;
	private search: SearchComponent | null = null;
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
	private userScrollAt = 0;

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
		this.scope.register(["Ctrl"], "Home", (evt) => this.handleEdgeKey(evt));
		this.scope.register(["Ctrl"], "End", (evt) => this.handleEdgeKey(evt));
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
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path === this.filePath) void this.reload();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (oldPath === this.filePath) {
					this.filePath = file.path;
					this.render();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file.path === this.filePath) {
					this.filePath = null;
					this.lines = null;
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
		if (typeof s.file === "string") this.filePath = s.file;
		if (s.mode === "lines" || s.mode === "paragraphs") this.mode = s.mode;
		if (typeof s.filter === "boolean") this.filter = s.filter;
		await super.setState(state, result);
		await this.reload();
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), file: this.filePath, mode: this.mode, filter: this.filter };
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
			this.playbackSec = null;
			this.focusRow = -1;
			this.query = "";
			this.searchOrigin = null;
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
		this.render();
	}

	/** Put the cursor in the search box. */
	focusSearch(): void {
		const input = this.search?.inputEl;
		if (!input) return;
		this.rememberSearchOrigin();
		input.focus();
		input.select();
	}

	/**
	 * Mark the row playing at `seconds` (null clears the mark). With `follow`,
	 * unless the user is scrolling or searching, scroll it into the middle of the panel.
	 */
	showPlayback(seconds: number | null, follow = true): void {
		this.playbackSec = seconds;
		this.follow = follow;
		const idx = seconds === null ? -1 : currentRowIndex(this.rowStarts, seconds);
		if (idx === this.currentRow) return;
		this.rendered[this.currentRow]?.el.removeClass("is-playing");
		this.currentRow = idx;
		const current = this.rendered[idx];
		if (!current) return;
		current.el.addClass("is-playing");
		if (follow && !this.query.trim() && this.focusedRowIndex() < 0 && Date.now() - this.userScrollAt > FOLLOW_PAUSE_MS) {
			this.scrollToRow(current.el, true);
		}
	}

	/** Explicit navigation goes to the current chunk even while paused or with following disabled. */
	focusPlayback(seconds: number | null, follow = true): void {
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
		if (file.extension !== "md") return;
		const token = ++this.loadToken;
		const lines = await loadTranscriptLines(this.app, file, this.host.getHeadingName());
		if (token !== this.loadToken || !lines?.length) return;
		this.playbackSec = null;
		this.focusRow = -1;
		this.query = "";
		this.searchOrigin = null;
		this.filePath = file.path;
		this.lines = lines;
		this.render();
	}

	private setMode(mode: TranscriptViewMode): void {
		this.mode = mode;
		this.render();
	}

	/** Apply changed preferences without reloading the note or discarding the query. */
	refreshSearchSettings(): void {
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		const input = this.search?.inputEl;
		const searchFocused = !!input && input.ownerDocument.activeElement === input;
		const rowHadFocus = this.focusedRowIndex() >= 0;
		this.searchNavigationCleanup?.();
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
				text: "Open a literature note and run \"Show YouTube transcript panel\".",
			});
			return;
		}

		const header = el.createDiv({ cls: "perplexity-saver-transcript-header" });
		const title = header.createEl("a", {
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

		const rows = transcriptRows(lines, this.mode);
		const lineNoun = lines.some((l) => l.endSec !== undefined) ? "captions" : "lines";
		const controls = header.createDiv({ cls: "perplexity-saver-transcript-controls" });
		controls.createSpan({
			cls: "perplexity-saver-transcript-count",
			text: this.mode === "lines" ? `${rows.length} ${lineNoun}` : `${rows.length} paragraphs`,
		});
		const toggle = controls.createEl("button", {
			text: this.mode === "lines" ? "Format as paragraphs" : `Show original ${lineNoun}`,
		});
		toggle.addEventListener("click", () => {
			this.setMode(this.mode === "lines" ? "paragraphs" : "lines");
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
			const stamp = formatShortTimestamp(row.startSec * 1000);
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
	}

	private buildSearch(header: HTMLElement): void {
		header.addEventListener("keydown", (evt) => { this.handleEdgeKey(evt); });
		const bar = header.createDiv({ cls: "perplexity-saver-transcript-search" });
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
			this.rememberSearchOrigin();
			this.updateSearchHints();
		});
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
		this.searchNavigationCleanup?.();
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

	private finishSearch(accept: boolean): void {
		const origin = this.searchOrigin;
		const target = accept ? this.matches[this.matchIndex] ?? this.focusRow : origin?.row ?? this.focusRow;
		if (this.query) this.previousQuery = this.query;
		this.query = "";
		this.search?.setValue("");
		this.demandHighlights = false;
		this.applySearch(false);
		this.searchOrigin = null;
		this.moveFocus(target);
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
		if (evt === this.handledKey) return;
		if (!this.handleEdgeKey(evt)) return;
		const index = this.focusedRowIndex();
		if (index < 0) return;
		const mod = evt.ctrlKey || evt.metaKey;
		const step = (delta: 1 | -1): void => {
			const { visible, onScreen } = this.visibleRows();
			this.moveFocus(stepRow(visible, index, delta, onScreen));
		};
		const emacs = evt.ctrlKey && !evt.metaKey && !evt.altKey && !evt.shiftKey;
		const edge = (last: boolean): void => {
			const { visible } = this.visibleRows();
			this.moveFocus(visible[last ? visible.length - 1 : 0] ?? -1);
		};
		let handled = true;
		if (evt.key === "ArrowDown" && !mod) step(1);
		else if (evt.key === "ArrowUp" && !mod) step(-1);
		else if (emacs && evt.key.toLowerCase() === "n") step(1);
		else if (emacs && evt.key.toLowerCase() === "p") step(-1);
		else if (evt.key === "Home" && !mod) edge(false);
		else if (evt.key === "End" && !mod) edge(true);
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

	private handleEdgeKey(evt: KeyboardEvent): boolean {
		if (evt === this.handledKey) return false;
		if (!evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey || (evt.key !== "Home" && evt.key !== "End")) return true;
		const active = this.contentEl.ownerDocument.activeElement;
		if (!active || !this.contentEl.contains(active)) return true;
		const { visible } = this.visibleRows();
		this.moveFocus(visible[evt.key === "Home" ? 0 : visible.length - 1] ?? -1);
		evt.preventDefault();
		evt.stopPropagation();
		this.handledKey = evt;
		this.userScrollAt = Date.now();
		return false;
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
	private scrollToRow(rowEl: HTMLElement, onlyIfNeeded: boolean, smooth = true): void {
		const box = scrollParent(rowEl);
		if (!box) {
			rowEl.scrollIntoView({ block: "center" });
			return;
		}
		const b = box.getBoundingClientRect();
		const header = this.contentEl.querySelector(".perplexity-saver-transcript-header");
		const top = Math.max(b.top, header ? header.getBoundingClientRect().bottom : b.top);
		const height = b.bottom - top;
		const r = rowEl.getBoundingClientRect();
		if (height <= 0) return;
		if (onlyIfNeeded && r.top >= top + height * 0.25 && r.bottom <= b.bottom - height * 0.25) return;
		const delta = r.top - top - Math.max(0, (height - r.height) / 2);
		box.scrollTo({ top: box.scrollTop + delta, behavior: smooth ? "smooth" : "auto" });
	}
}

export type TranscriptPanelLocation = "sidebar" | "viewer";

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
 * Open (or reuse) the transcript panel for `file`, returning its leaf for activation.
 */
export async function showTranscriptPanel(
	app: App,
	file: TFile,
	headingName: string,
	placement?: TranscriptPlacement | null
): Promise<WorkspaceLeaf | null> {
	const lines = await loadTranscriptLines(app, file, headingName);
	if (!lines?.length) {
		const heading = normalizeTranscriptHeading(headingName);
		new Notice(`No timestamped transcript under a "${heading}" heading in ${file.basename}.`);
		return null;
	}
	let leaf: WorkspaceLeaf;
	if (placement) {
		const win = getWindowForLeaf(placement.nextTo);
		const existing = app.workspace
			.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)
			.find((l) => !isSidebarLeaf(app, l) && getWindowForLeaf(l) === win);
		leaf = existing ?? app.workspace.createLeafBySplit(placement.nextTo, placement.direction);
		if (!existing) {
			await leaf.setViewState({ type: TRANSCRIPT_VIEW_TYPE, active: false, state: { file: file.path } });
		}
		await app.workspace.revealLeaf(leaf);
	} else {
		const collapsed = isSidebarCollapsed(app, "right");
		if (collapsed === true) {
			expandedRightSidebar = true;
		} else if (!visibleTranscriptLeaves(app).some((l) => isSidebarLeaf(app, l))) {
			expandedRightSidebar = false;
		}
		leaf = await app.workspace.ensureSideLeaf(TRANSCRIPT_VIEW_TYPE, "right", {
			active: false,
			reveal: true,
			state: { file: file.path },
		});
	}
	await loadLeafIfDeferred(leaf);
	if (leaf.view instanceof TranscriptView) await leaf.view.showFile(file.path);
	return leaf;
}
