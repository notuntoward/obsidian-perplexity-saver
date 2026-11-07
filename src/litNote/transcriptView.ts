import { ItemView, Notice, Scope, SearchComponent, TFile, setIcon } from "obsidian";
import type { App, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { renderHighlightedText, renderKeyHints, type KeyHint } from "commons/modal";
import { writeClipboardIn } from "commons/windows";
import { matchAllWords } from "commons/search";
import {
	getWindowForLeaf,
	isInCollapsedSidebar,
	isSidebarCollapsed,
	isSidebarLeaf,
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

export type TranscriptViewMode = "lines" | "paragraphs";

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

const SEARCH_HINTS: KeyHint[][] = [
	[
		{ key: "Enter", action: "next match" },
		{ key: "Shift+Enter", action: "previous" },
		{ key: "Ctrl+Enter", action: "play match" },
	],
	[
		{ key: "Tab", action: "go to lines" },
		{ key: "Esc", action: "clear" },
	],
];

const ROW_HINTS: KeyHint[][] = [
	[
		{ key: "↑↓", action: "move" },
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
	/** Indexes into `rendered` of the rows matching `query`. */
	private matches: number[] = [];
	private matchIndex = -1;
	private search: SearchComponent | null = null;
	private matchCountEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private filterBtn: HTMLElement | null = null;
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
			const row = this.focusedRowIndex();
			if (row >= 0) this.playRow(row, true);
			else this.playMatch();
			return false;
		});
		this.scope.register(["Mod"], "F", () => {
			this.focusSearch();
			return false;
		});
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

	private async followFile(file: TFile): Promise<void> {
		if (file.extension !== "md") return;
		const token = ++this.loadToken;
		const lines = await loadTranscriptLines(this.app, file, this.host.getHeadingName());
		if (token !== this.loadToken || !lines?.length) return;
		this.filePath = file.path;
		this.lines = lines;
		this.render();
	}

	private setMode(mode: TranscriptViewMode): void {
		this.mode = mode;
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		const input = this.search?.inputEl;
		const searchFocused = !!input && input.ownerDocument.activeElement === input;
		el.empty();
		el.addClass("perplexity-saver-transcript-view");
		this.rendered = [];
		this.rowStarts = [];
		this.matches = [];
		this.search = null;
		this.matchCountEl = null;
		const rowHadFocus = this.focusedRowIndex() >= 0;
		this.listEl = null;
		this.filterBtn = null;
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
		renderKeyHints(hints.createDiv({ cls: "is-search" }), SEARCH_HINTS, "perplexity-saver");
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
			this.rendered.push({ row, el: rowEl, textEl, highlighted: false });
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
		const bar = header.createDiv({ cls: "perplexity-saver-transcript-search" });
		const search = new SearchComponent(bar);
		search.setPlaceholder("Search transcript");
		search.setValue(this.query);
		search.inputEl.setAttribute(
			"aria-label",
			"Search the transcript. Enter: next match, Shift+Enter: previous, Ctrl+Enter: play from the match, Escape: clear."
		);
		search.inputEl.setAttribute("aria-keyshortcuts", "Enter Shift+Enter Control+Enter Escape");
		search.onChange((value) => {
			this.query = value;
			this.applySearch(true);
		});
		search.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.handledKey = evt;
				if (evt.ctrlKey || evt.metaKey) {
					evt.stopPropagation();
					this.playMatch();
				} else {
					this.stepMatch(evt.shiftKey ? -1 : 1);
				}
			} else if (evt.key === "Tab" && !evt.shiftKey && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
				evt.preventDefault();
				this.focusLines();
			} else if (evt.key === "Escape" && search.getValue()) {
				evt.preventDefault();
				evt.stopPropagation();
				search.setValue("");
				this.query = "";
				this.applySearch(false);
			}
		});
		this.search = search;
		this.matchCountEl = bar.createSpan({ cls: "perplexity-saver-transcript-matches" });
		this.iconButton(bar, "chevron-up", "Previous match (Shift+Enter)", () => this.stepMatch(-1));
		this.iconButton(bar, "chevron-down", "Next match (Enter)", () => this.stepMatch(1));
		this.iconButton(bar, "play", "Play the video from this match (Ctrl+Enter)", () => this.playMatch());
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
		this.matches = [];
		this.rendered.forEach((r, i) => {
			const ranges = query ? matchAllWords(r.row.text, query) : null;
			if (ranges || r.highlighted) {
				r.textEl.empty();
				renderHighlightedText(r.textEl, r.row.text, ranges ?? []);
				r.highlighted = !!ranges;
			}
			r.el.toggleClass("is-match", !!ranges);
			r.el.removeClass("is-search-current");
			if (ranges) this.matches.push(i);
		});
		this.matchIndex = -1;
		this.applyFilter();
		if (this.matches.length) this.selectMatch(0, jump);
		this.updateMatchCount();
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
		this.updateMatchCount();
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
		const index = this.focusedRowIndex();
		if (index < 0) return;
		const mod = evt.ctrlKey || evt.metaKey;
		const step = (delta: 1 | -1): void => {
			const { visible, onScreen } = this.visibleRows();
			this.moveFocus(stepRow(visible, index, delta, onScreen));
		};
		const edge = (last: boolean): void => {
			const { visible } = this.visibleRows();
			this.moveFocus(visible[last ? visible.length - 1 : 0] ?? -1);
		};
		let handled = true;
		if (evt.key === "ArrowDown" && !mod) step(1);
		else if (evt.key === "ArrowUp" && !mod) step(-1);
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
export function visibleTranscriptLeaves(app: App, scope?: WorkspaceLeaf | null): WorkspaceLeaf[] {
	const scopeWin = scope ? getWindowForLeaf(scope) : undefined;
	return app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).filter((leaf) => {
		if (isInCollapsedSidebar(app, leaf)) return false;
		if (scope && getWindowForLeaf(leaf) !== scopeWin) return false;
		const el = leaf.view?.containerEl;
		return !el || typeof el.isShown !== "function" || el.isShown();
	});
}

/**
 * Close every visible transcript panel (in `scope`'s window, when given), and
 * collapse the right sidebar again if showing the transcript expanded it.
 * Returns true when a panel was closed.
 */
export function hideTranscriptPanels(app: App, scope?: WorkspaceLeaf | null): boolean {
	const leaves = visibleTranscriptLeaves(app, scope);
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
 * Open (or reuse) the transcript panel for `file` without taking focus away
 * from the editor: in the right sidebar, or split off the video viewer when
 * `placement` is given.
 */
export async function showTranscriptPanel(
	app: App,
	file: TFile,
	headingName: string,
	placement?: TranscriptPlacement | null
): Promise<void> {
	const lines = await loadTranscriptLines(app, file, headingName);
	if (!lines?.length) {
		const heading = normalizeTranscriptHeading(headingName);
		new Notice(`No timestamped transcript under a "${heading}" heading in ${file.basename}.`);
		return;
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
	if (leaf.view instanceof TranscriptView) await leaf.view.showFile(file.path);
}
