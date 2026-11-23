import { Modal, Notice, type App, type TFile } from "obsidian";
import { applyModalAppearance } from "commons/modal";
import {
	findTranscriptRange,
	headingsFromText,
	normalizeTranscriptHeading,
	fetchYouTubeCaptions,
	formatNativeTranscript,
	findYouTubeLinks,
	parseYouTubeUrl,
	watchUrl,
} from "commons/youtube";

export interface TranscriptVideoSource {
	videoId: string;
	url: string;
	label: string;
	alias: string;
	origin: "note" | "entered";
}

export interface TranscriptCreationResult {
	action: "created" | "updated";
	videoId: string;
	cueCount: number;
}

export interface CreateOrUpdateTranscriptOptions {
	preferredVideoId?: string | null;
	chooseVideo?: (
		app: App,
		sources: TranscriptVideoSource[],
		preferredVideoId: string | null,
		context: TranscriptVideoPromptContext
	) => Promise<TranscriptVideoSource | null>;
	/** Authoritative editor text when the note is open, including not-yet-saved edits. */
	noteText?: string;
}

const GENERATED_CUE = /^\s*\[[^\]]+\]\([^)]+\s+"[^"]*[–-][^"]*"\)\s/;
const PRECISE_CUE = /^\s*\[[^\]]*(?:→|->|-->)[^\]]*\]\([^)]+\)/;

/** Ignore URLs that remain from a stored transcript after its heading was manually removed. */
function staleTranscriptOffsets(text: string): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	const heading = /^ {0,3}#{1,6}[ \t]+/m;
	const lines = text.split("\n");
	let offset = 0;
	let orphanStart: number | null = null;
	for (const raw of lines) {
		const line = raw.replace(/\r$/, "");
		const start = offset;
		const end = start + raw.length;
		offset = end + 1;
		if (line.includes("<!-- saver-word-timing:") || line.includes("<!-- saver-transcript-language:")) {
			orphanStart ??= start;
		} else if (orphanStart !== null && heading.test(line)) {
			ranges.push({ start: orphanStart, end: start });
			orphanStart = null;
		}
	}
	if (orphanStart !== null) ranges.push({ start: orphanStart, end: text.length });
	return ranges;
}

export function transcriptVideoSources(text: string): TranscriptVideoSource[] {
	const unique = new Map<string, TranscriptVideoSource>();
	const ignored = staleTranscriptOffsets(text);
	for (const link of findYouTubeLinks(text)) {
		const lineStart = text.lastIndexOf("\n", link.start - 1) + 1;
		const lineEnd = text.indexOf("\n", link.end);
		const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
		if (GENERATED_CUE.test(line) || PRECISE_CUE.test(line) ||
			ignored.some((range) => link.start >= range.start && link.start < range.end)) continue;
		if (unique.has(link.videoId)) continue;
		const url = watchUrl(link.videoId);
		unique.set(link.videoId, {
			videoId: link.videoId,
			url,
			label: `YouTube video ${unique.size + 1}`,
			alias: `${unique.size === 0 ? "First link in note · " : ""}${link.url}`,
			origin: "note",
		});
	}
	return [...unique.values()];
}

export function transcriptVideoFromUrl(value: string): TranscriptVideoSource | null {
	const parsed = parseYouTubeUrl(value.trim());
	return parsed ? {
		videoId: parsed.videoId,
		url: watchUrl(parsed.videoId),
		label: "Entered YouTube URL",
		alias: value.trim(),
		origin: "entered",
	} : null;
}

export interface TranscriptVideoPromptContext {
	action: "create" | "update";
	fileName: string;
	headingName: string;
}

export class TranscriptVideoModal extends Modal {
	private settled = false;
	private cleanupKeys?: () => void;

	constructor(
		app: App,
		private readonly sources: TranscriptVideoSource[],
		private readonly preferredVideoId: string | null,
		private readonly context: TranscriptVideoPromptContext,
		private readonly resolve: (source: TranscriptVideoSource | null) => void
	) {
		super(app);
	}

	private settle(source: TranscriptVideoSource | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(source);
	}

	onOpen(): void {
		const actionLabel = this.context.action === "create" ? "Create" : "Update";
		this.titleEl.setText(`${actionLabel} transcript from YouTube`);
		applyModalAppearance(this, { size: "standard" });
		const form = this.contentEl.createEl("form");
		const intro = this.contentEl.createDiv({ cls: "commons-modal-intro" });
		intro.createEl("p", {
			text: this.context.action === "create"
				? `Download captions and add a "${this.context.headingName}" section to "${this.context.fileName}".`
				: `Replace the "${this.context.headingName}" section in "${this.context.fileName}" with fresh YouTube captions. The rest of the note stays unchanged.`,
		});
		form.appendChild(intro);
		const preferred = this.sources.find((source) => source.videoId === this.preferredVideoId) ?? this.sources[0];
		let linkedVideo: TranscriptVideoSource | null = preferred ?? null;
		let input: HTMLInputElement;
		const warning = form.createDiv({
			cls: "commons-modal-description perplexity-saver-transcript-source-warning",
			attr: { role: "status" },
		});
		if (this.sources.length === 1) {
			const sourceField = form.createDiv({ cls: "commons-modal-field" });
			sourceField.createSpan({ text: "Video linked in the note" });
			const sourceControl = sourceField.createDiv({ cls: "commons-modal-control" });
			sourceControl.createDiv({ cls: "commons-modal-description", text: this.sources[0].url });
		} else if (this.sources.length > 1) {
			const sourceField = form.createDiv({ cls: "commons-modal-field" });
			sourceField.createSpan({ text: "Choose a linked video" });
			const sourceControl = sourceField.createDiv({ cls: "commons-modal-control" });
			for (const [index, source] of this.sources.entries()) {
				const option = sourceControl.createEl("label");
				const radio = option.createEl("input", {
					attr: {
						type: "radio",
						name: "transcript-video",
						value: source.videoId,
						"aria-label": `${source.label}: ${source.url}`,
					},
				});
				radio.checked = index === this.sources.indexOf(preferred ?? this.sources[0]);
				option.createSpan({ text: source.alias.replace("First link in note · ", "") });
				radio.addEventListener("change", () => {
					if (!radio.checked) return;
					linkedVideo = source;
					input.value = "";
					refreshWarning();
				});
			}
		}
		const field = form.createEl("label", { cls: "commons-modal-field" });
		field.createSpan({ text: this.sources.length ? "Use a different YouTube URL (optional)" : "YouTube video URL" });
		const control = field.createSpan({ cls: "commons-modal-control" });
		input = control.createEl("input", {
			cls: "commons-modal-input",
			attr: {
				type: "url",
				"aria-label": this.sources.length ? "Different YouTube video URL" : "YouTube video URL",
				autocomplete: "off",
			},
		});
		control.createSpan({
			cls: "commons-modal-description",
			text: this.sources.length
				? "Leave this blank to use the selected linked video."
				: "Paste a YouTube watch, short, embed, live, or youtu.be link.",
		});
		form.insertBefore(warning, field);
		const error = form.createDiv({ cls: "commons-modal-error", attr: { role: "alert" } });
		const buttons = form.createDiv({ cls: "modal-button-container commons-modal-actions" });
		const cancel = buttons.createEl("button", { text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		const submitButton = buttons.createEl("button", {
			text: `${actionLabel} transcript`,
			cls: "mod-cta",
			attr: { type: "submit" },
		});
		const resolveSource = (): TranscriptVideoSource | null => {
			const entered = input.value.trim() ? transcriptVideoFromUrl(input.value) : null;
			if (input.value.trim() && !entered) {
				error.setText("Enter a valid YouTube watch, short, embed, live, or youtu.be URL.");
				return null;
			}
			const source = entered ?? linkedVideo;
			if (!source) {
				error.setText("Enter a YouTube video URL.");
				return null;
			}
			return source;
		};
		const submit = (): void => {
			const source = resolveSource();
			if (!source) return;
			this.settle(source);
			this.close();
		};
		const refreshWarning = (): void => {
			const entered = input.value.trim() ? transcriptVideoFromUrl(input.value) : null;
			const different = !!entered && this.sources.length > 0 &&
				!this.sources.some((source) => source.videoId === entered.videoId);
			warning.setText(different
				? "This URL is different from every video linked in the note. The transcript will use the entered URL; existing note links stay unchanged."
				: "");
			warning.hidden = !different;
		};
		input.addEventListener("input", () => {
			error.setText("");
			refreshWarning();
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			submit();
		});
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.isComposing || !this.modalEl.contains(event.target as Node)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				this.close();
				return;
			}
			if (event.key !== "Enter") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.target === cancel) this.close();
			else submit();
		};
		const doc = this.modalEl.ownerDocument;
		doc.addEventListener("keydown", onKeyDown, true);
		this.cleanupKeys = () => doc.removeEventListener("keydown", onKeyDown, true);
		warning.hidden = true;
		refreshWarning();
		(this.sources.length ? submitButton : input).focus();
	}

	onClose(): void {
		this.cleanupKeys?.();
		this.cleanupKeys = undefined;
		this.settle(null);
		this.contentEl.empty();
	}
}

export function chooseTranscriptVideo(
	app: App,
	sources: TranscriptVideoSource[],
	preferredVideoId: string | null,
	context: TranscriptVideoPromptContext
): Promise<TranscriptVideoSource | null> {
	return new Promise((resolve) => {
		const modal = new TranscriptVideoModal(app, sources, preferredVideoId, context, resolve);
		modal.open();
	});
}

function replaceOrAppendTranscript(
	content: string,
	headingName: string,
	transcript: string
): { content: string; action: "created" | "updated" } {
	const range = findTranscriptRange(content, headingsFromText(content), headingName);
	const section = `\n\n${transcript.trim()}\n\n`;
	if (range) {
		return {
			content: content.slice(0, range.start) + section + content.slice(range.end),
			action: "updated",
		};
	}
	const heading = normalizeTranscriptHeading(headingName);
	return {
		content: `${content.trimEnd()}\n\n# ${heading}\n\n${transcript.trim()}\n`,
		action: "created",
	};
}

/**
 * Fetch captions from one selected YouTube video, then atomically create or replace
 * the note's transcript section. Nothing is written until captions are available.
 */
export async function createOrUpdateTranscript(
	app: App,
	file: TFile,
	headingName: string,
	options: CreateOrUpdateTranscriptOptions = {}
): Promise<TranscriptCreationResult | null> {
	const original = options.noteText ?? await app.vault.cachedRead(file);
	const persisted = options.noteText === undefined ? original : await app.vault.cachedRead(file);
	const sources = transcriptVideoSources(original);
	const existingRange = findTranscriptRange(original, headingsFromText(original), headingName);
	const existingVideoId = existingRange
		? findYouTubeLinks(original.slice(existingRange.start, existingRange.end))[0]?.videoId ?? null
		: null;
	const preferredVideoId = options.preferredVideoId &&
		sources.some((source) => source.videoId === options.preferredVideoId)
		? options.preferredVideoId
		: existingVideoId ?? sources[0]?.videoId ?? null;
	const source = options.chooseVideo
		? sources.length ? await options.chooseVideo(app, sources, preferredVideoId, {
			action: existingRange ? "update" : "create",
			fileName: file.basename,
			headingName: normalizeTranscriptHeading(headingName),
		}) : null
		: await chooseTranscriptVideo(app, sources, preferredVideoId, {
			action: existingRange ? "update" : "create",
			fileName: file.basename,
			headingName: normalizeTranscriptHeading(headingName),
		});
	if (!source) return null;

	const progress = new Notice(`Fetching captions for ${source.videoId}...`, 0);
	let captions;
	try {
		captions = await fetchYouTubeCaptions(source.url);
	} catch (error: unknown) {
		console.error(`Perplexity Saver: could not fetch transcript for ${source.videoId}`, error);
		new Notice("Could not download YouTube captions. The note was not changed.");
		return null;
	} finally {
		progress.hide();
	}
	if (!captions) {
		new Notice("This video has no usable YouTube captions. The note was not changed.");
		return null;
	}
	const transcript = formatNativeTranscript(captions.lines, source.url, captions.language);
	const change = replaceOrAppendTranscript(original, headingName, transcript);
	try {
		await app.vault.process(file, (current) => {
			if (current !== original && current !== persisted) {
				throw new Error("The note changed while captions were downloading. Nothing was saved.");
			}
			return change.content;
		});
	} catch (error: unknown) {
		console.error(`Perplexity Saver: could not save transcript for ${source.videoId}`, error);
		new Notice(error instanceof Error ? error.message : "Could not save the transcript. The note was not changed.");
		return null;
	}
	new Notice(
		`${change.action === "created" ? "Created" : "Updated"} the "${normalizeTranscriptHeading(headingName)}" section with ` +
		`${captions.lines.length} caption cue${captions.lines.length === 1 ? "" : "s"} from YouTube. ` +
		"Folding follows the Collapse transcript on open setting."
	);
	return { action: change.action, videoId: source.videoId, cueCount: captions.lines.length };
}
