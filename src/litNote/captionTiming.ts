import { getFrontMatterInfo, Notice, parseYaml, type App, type Plugin, type TFile } from "obsidian";
import { askNoteDecision } from "./decisionModal";
import { prepareTranscript, type PreparedTranscript } from "./transcriptSentences";
import { findTranscriptRange, parseStoredTranscript, type StoredTranscriptLine } from "./transcriptSection";
import { readInlineTimings, writeInlineTimings } from "./transcriptTimingStorage";
import { alignedSentenceRows, ALIGNMENT_CACHE_KEY, readAlignmentCache, transcriptVideoId, type WordTimings } from "./transcriptAlignment";
import { fetchYouTubeCaptions, formatNativeTranscript } from "./youtubeTranscript";
import { parseYouTubeUrl, watchUrl } from "../video/youtubeLinks";

const running = new WeakMap<App, Set<TFile>>();

function savedTimings(transcript: PreparedTranscript, raw: unknown): WordTimings | null {
	try {
		return readInlineTimings(transcript) ?? readAlignmentCache(raw, transcript);
	} catch (error: unknown) {
		console.warn("Perplexity Saver: saved transcript timings are invalid; offering a confirmed refresh", error);
		return null;
	}
}

export function needsCaptionTimingRepair(lines: StoredTranscriptLine[], timings: WordTimings | null): boolean {
	if (timings || !lines.length) return false;
	const videoId = parseYouTubeUrl(lines[0].url)?.videoId;
	return !!videoId && lines.every((line) => parseYouTubeUrl(line.url)?.videoId === videoId);
}

/** Offer once per transcript source per session; downloading still requires the timing flow's consent. */
export function registerCaptionTimingRepair(
	plugin: Plugin, heading: () => string, repair: (file: TFile) => Promise<void>
): void {
	const { app } = plugin;
	const offered = new WeakMap<TFile, string>();
	let generation = 0;
	let disposed = false;
	let repairing = false;
	const check = async (file: TFile | null): Promise<void> => {
		const token = ++generation;
		if (disposed || repairing || !file || file.extension !== "md") return;
		const content = await app.vault.cachedRead(file);
		if (disposed || token !== generation || app.workspace.getActiveFile() !== file) return;
		const metadata = app.metadataCache.getFileCache(file);
		const range = findTranscriptRange(content, metadata?.headings, heading());
		if (!range) return;
		const transcript = prepareTranscript(parseStoredTranscript(content.slice(range.start, range.end)));
		if (!needsCaptionTimingRepair(transcript.lines, null) || offered.get(file) === transcript.hash) return;
		const cached = savedTimings(transcript, metadata?.frontmatter?.[ALIGNMENT_CACHE_KEY]);
		if (cached) return;
		offered.set(file, transcript.hash);
		repairing = true;
		try {
			await repair(file);
		} finally {
			repairing = false;
		}
	};
	const open = (file: TFile | null): void => {
		void check(file).catch((error: unknown) => {
			console.error("Perplexity Saver: could not offer transcript timing repair", error);
			new Notice(error instanceof Error ? error.message : "Could not check transcript timing.");
		});
	};
	plugin.registerEvent(app.workspace.on("file-open", open));
	plugin.registerEvent(app.workspace.on("active-leaf-change", () => open(app.workspace.getActiveFile())));
	plugin.registerEvent(app.metadataCache.on("changed", (file) => {
		if (app.workspace.getActiveFile() === file) open(file);
	}));
	app.workspace.onLayoutReady(() => open(app.workspace.getActiveFile()));
	plugin.register(() => { disposed = true; generation++; });
}

export async function runCaptionTiming(
	app: App, file: TFile, heading: string, options: { signal?: AbortSignal } = {}
): Promise<WordTimings | null> {
	const files = running.get(app) ?? new Set<TFile>();
	if (files.size) throw new Error("Caption timing is already running. Wait or cancel it before starting another note.");
	running.set(app, files);
	files.add(file);
	const assertActive = (): void => {
		if (options.signal?.aborted) throw new Error("Caption timing cancelled; the note was not changed.");
	};
	try {
		assertActive();
		const content = await app.vault.cachedRead(file);
		const info = getFrontMatterInfo(content);
		const body = content.slice(info.contentStart);
		const frontmatter: unknown = info.exists ? parseYaml(info.frontmatter) : {};
		const raw = typeof frontmatter === "object" && frontmatter !== null
			? (frontmatter as Record<string, unknown>)[ALIGNMENT_CACHE_KEY] : undefined;
		const range = findTranscriptRange(content, app.metadataCache.getFileCache(file)?.headings, heading);
		const section = range ? content.slice(range.start, range.end) : "";
		const lines = parseStoredTranscript(section);
		if (!range) throw new Error("This note has no transcript heading to replace safely.");
		const transcript = prepareTranscript(lines);
		const noteUrl = typeof frontmatter === "object" && frontmatter !== null
			? (frontmatter as Record<string, unknown>).url : undefined;
		const videoId = lines.length ? transcriptVideoId(transcript) : typeof noteUrl === "string" ? parseYouTubeUrl(noteUrl)?.videoId : undefined;
		if (!videoId) throw new Error("This note needs a YouTube URL to replace an unrecognized transcript format.");
		const save = async (timings: WordTimings, sourceSection = section): Promise<void> => {
			if (!range) throw new Error("The transcript section is unavailable.");
			const start = range.start - info.contentStart;
			const end = range.end - info.contentStart;
			const compact = writeInlineTimings(sourceSection, timings);
			const expectedBody = body.slice(0, start) + compact + body.slice(end);
			assertActive();
			await app.vault.process(file, (current) => {
				assertActive();
				const currentBodyStart = getFrontMatterInfo(current).contentStart;
				if (current.slice(currentBodyStart) !== body) {
					throw new Error("The note body changed during caption timing. Results were not applied to edited text.");
				}
				return current.slice(0, currentBodyStart) + expectedBody;
			});
			const saved = await app.vault.cachedRead(file);
			const savedBody = saved.slice(getFrontMatterInfo(saved).contentStart);
			if (savedBody !== expectedBody ||
				!readInlineTimings(prepareTranscript(parseStoredTranscript(savedBody.slice(start, start + compact.length))))) {
				throw new Error("Compact timing verification failed after saving. The old timing property was not removed.");
			}
			if (raw !== undefined) {
				await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					if (JSON.stringify(fm[ALIGNMENT_CACHE_KEY]) !== JSON.stringify(raw)) {
						throw new Error("The old timing property changed while saving. Both copies were retained.");
					}
					delete fm[ALIGNMENT_CACHE_KEY];
				});
			}
		};
		const cached = lines.length ? savedTimings(transcript, raw) : null;
		if (cached) {
			if (raw !== undefined) {
				await save(cached);
				new Notice("Saved word timings moved into transcript links. No download or inference was run.");
			} else new Notice("Word timings already saved in transcript links. Comparison works offline; no download or alignment was run.");
			return cached;
		}
		const consent = await askNoteDecision(app, "Transcript timing needs repair",
			`The transcript in "${file.basename}" has missing or invalid word timings. Sentence timestamps may repeat or be inaccurate.\n\nRedownload the transcript from YouTube (${videoId}) using native JSON3 caption and word timestamps?\n\nOnly the transcript section will be updated. Your other note content and properties are preserved. If the wording or usable caption bounds differ, replacement requires a further confirmation. Cancel leaves the note unchanged.\n\nNo audio, Python, model downloads or inference. Your note is not uploaded; no API charge. Missing native timestamps remain explicitly approximate.`,
			[{ label: "Redownload transcript", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
		if (consent !== "create") return null;
		assertActive();
		const notice = new Notice("Checking YouTube sentence-start timestamps...", 0);
		try {
			const captions = await fetchYouTubeCaptions(watchUrl(videoId), { lang: transcript.language, signal: options.signal });
			assertActive();
			if (!captions) throw new Error("No usable YouTube JSON3 captions are available. Nothing was saved.");
			const freshSection = formatNativeTranscript(captions.lines, watchUrl(videoId), captions.language);
			const fresh = prepareTranscript(parseStoredTranscript(freshSection));
			const native = readInlineTimings(fresh);
			if (!native) throw new Error("YouTube captions did not produce valid native timings. Nothing was saved.");
			const canonical = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
			const sameWords = fresh.words.length === transcript.words.length &&
				fresh.words.every((word, i) => canonical(word.text) === canonical(transcript.words[i].text));
			const sameBounds = sameWords && native.words.every((word, i) => {
				const line = transcript.lines[transcript.words[i].cue];
				return word === null || (word[0] >= line.startSec && word[0] <= (line.endSec ?? Infinity));
			});
			if (!sameWords || !sameBounds) {
				const choice = await askNoteDecision(app, "Transcript differs from YouTube captions",
					`${!transcript.words.length ? "The stored transcript format is unrecognized. Stored word count unavailable." : `The stored wording or caption bounds differ: ${transcript.words.length} stored words.`} ${fresh.words.length} current words. Even equal word counts can contain different wording.\n\nCancel leaves the note unchanged. Replace transcript uses the fetched JSON3 captions and their punctuation and native timings. Only the transcript section is replaced; your other content and properties are preserved. Missing timestamps remain approximate.`,
					[{ label: "Cancel", value: "cancel" }, { label: "Replace transcript", value: "overwrite", warning: true }]);
				if (choice !== "overwrite") return null;
				assertActive();
			}
			const newline = section.includes("\r\n") ? "\r\n" : "\n";
			const sourceSection = newline + newline + freshSection.replace(/\n/g, newline) + newline + newline;
			await save(native, sourceSection);
			const sentences = alignedSentenceRows(fresh, native);
			const approximate = sentences.filter((sentence) => sentence.timingUncertain).length;
			new Notice(`Native YouTube sentence timings saved. No audio or model downloads. ${sentences.length - approximate}/${sentences.length} sentence starts timed; ${approximate} approximate. Sentence and paragraph views use saved timings automatically.`);
			return native;
		} finally {
			notice.hide();
		}
	} finally {
		files.delete(file);
	}
}
