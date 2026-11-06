import { ItemView, Notice, TFile } from "obsidian";
import type { App, ViewStateResult, WorkspaceLeaf } from "obsidian";
import {
	findTranscriptSection,
	normalizeTranscriptHeading,
	parseStoredTranscript,
	storedLinesToCues,
	type StoredTranscriptLine,
} from "./transcriptSection";
import { buildTranscriptParagraphs } from "./transcriptParagraphs";
import { formatTimestamp } from "./youtubeTranscript";

export const TRANSCRIPT_VIEW_TYPE = "perplexity-saver-transcript";

export type TranscriptViewMode = "lines" | "paragraphs";

interface TranscriptViewState {
	file?: string | null;
	mode?: TranscriptViewMode;
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

/** Side panel listing a literature note's stored YouTube transcript. */
export class TranscriptView extends ItemView {
	private filePath: string | null = null;
	private mode: TranscriptViewMode = "lines";
	private lines: StoredTranscriptLine[] | null = null;
	private loadToken = 0;

	constructor(leaf: WorkspaceLeaf, private readonly getHeadingName: () => string) {
		super(leaf);
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
		await this.reload();
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as TranscriptViewState;
		if (typeof s.file === "string") this.filePath = s.file;
		if (s.mode === "lines" || s.mode === "paragraphs") this.mode = s.mode;
		await super.setState(state, result);
		await this.reload();
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), file: this.filePath, mode: this.mode };
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
		const lines = file ? await loadTranscriptLines(this.app, file, this.getHeadingName()) : null;
		if (token !== this.loadToken) return;
		this.lines = lines;
		this.render();
	}

	private async followFile(file: TFile): Promise<void> {
		if (file.extension !== "md") return;
		const token = ++this.loadToken;
		const lines = await loadTranscriptLines(this.app, file, this.getHeadingName());
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
		el.empty();
		el.addClass("perplexity-saver-transcript-view");

		const heading = normalizeTranscriptHeading(this.getHeadingName());
		const file = this.filePath ? this.app.vault.getFileByPath(this.filePath) : null;
		if (!file) {
			el.createDiv({
				cls: "perplexity-saver-transcript-empty",
				text: "Open a literature note and run \"Show YouTube transcript in side panel\".",
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

		const list = el.createDiv({
			cls: `perplexity-saver-transcript-list is-${this.mode}`,
		});
		for (const row of rows) {
			const rowEl = list.createDiv({ cls: "perplexity-saver-transcript-row" });
			const stamp = formatTimestamp(row.startSec * 1000);
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
			rowEl.createDiv({ cls: "perplexity-saver-transcript-text", text: row.text });
		}
	}
}

/**
 * Open (or reuse) the transcript panel in the right sidebar for `file`,
 * without taking focus away from the editor.
 */
export async function showTranscriptPanel(
	app: App,
	file: TFile,
	headingName: string
): Promise<void> {
	const lines = await loadTranscriptLines(app, file, headingName);
	if (!lines?.length) {
		const heading = normalizeTranscriptHeading(headingName);
		new Notice(`No timestamped transcript under a "${heading}" heading in ${file.basename}.`);
		return;
	}
	const leaf = await app.workspace.ensureSideLeaf(TRANSCRIPT_VIEW_TYPE, "right", {
		active: false,
		reveal: true,
		state: { file: file.path },
	});
	if (leaf.view instanceof TranscriptView) await leaf.view.showFile(file.path);
}
