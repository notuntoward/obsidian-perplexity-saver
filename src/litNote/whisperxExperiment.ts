import { getFrontMatterInfo, Notice, parseYaml, type App, type TFile } from "obsidian";
import { askNoteDecision } from "./decisionModal";
import { prepareTranscript, sentenceRows, type PreparedTranscript } from "./transcriptSentences";
import { findTranscriptRange, parseStoredTranscript } from "./transcriptSection";
import { readInlineTimings, writeInlineTimings } from "./transcriptTimingStorage";
import { alignedSentenceRows, ALIGNMENT_CACHE_KEY, readAlignmentCache, readCaptionReplacement, transcriptVideoId, type WordTimings } from "./transcriptAlignment";
import { runWhisperx, type WhisperxProcessOptions } from "./whisperxProcess";
import { formatTranscriptCues } from "./youtubeTranscript";
import { parseYouTubeUrl, watchUrl } from "../video/youtubeLinks";

const running = new WeakMap<App, Set<TFile>>();

export async function runWhisperxExperiment(
	app: App, file: TFile, heading: string, options: WhisperxProcessOptions
): Promise<WordTimings | null> {
	const files = running.get(app) ?? new Set<TFile>();
	if (files.size) throw new Error("WhisperX alignment is already running. Wait or cancel it before starting another note.");
	running.set(app, files);
	files.add(file);
	const assertActive = (): void => {
		if (options.signal?.aborted) throw new Error("WhisperX alignment cancelled; the note was not changed.");
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
					throw new Error("The note body changed during alignment. Results were not applied to edited text.");
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
		const cached = lines.length ? readInlineTimings(transcript) ?? readAlignmentCache(raw, transcript) : null;
		if (cached) {
			if (raw !== undefined) {
				await save(cached);
				new Notice("Saved word timings moved into transcript links. No download or inference was run.");
			} else new Notice("Word timings already saved in transcript links. Comparison works offline; no download or alignment was run.");
			return cached;
		}
		const consent = await askNoteDecision(app, "Use caption word timing?",
			`Check YouTube captions for ${videoId}${transcript.words.length ? ` and time these ${sentenceRows(transcript).length} sentence starts` : " and recover the unrecognized transcript format"}?\n\nUse native YouTube word offsets at punctuation-derived sentence starts first, without audio downloads or inference. Missing internal word timings do not require alignment. Only if a sentence's first word lacks a timestamp, download the video's full audio once, then decode and align its short caption interval locally with WhisperX. The first word of each original caption stays fixed; no word may cross the next caption's start. If the stored transcript differs or its format is unrecognized, you can cancel or explicitly replace only the transcript section.\n\nContinue only if you have permission to download/process the audio. Your note and transcript are not uploaded; no API charge. Save compact word offsets in existing transcript links for offline comparison, not in Properties. Text and punctuation remain unchanged unless you separately confirm replacement.`,
			[{ label: "Check captions and save timings", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
		if (consent !== "create") return null;
		assertActive();
		const notice = new Notice("Checking YouTube sentence-start timestamps...", 0);
		try {
			const align = (prepared: PreparedTranscript) => {
				const starts = new Set(sentenceRows(prepared).map((row) => row.sourceStart));
				return runWhisperx({
					version: 2, sourceHash: prepared.hash, videoId,
					sentenceStarts: prepared.words.flatMap((word, index) => starts.has(word.start) ? [index] : []),
					words: prepared.words.map((word) => {
						const line = prepared.lines[word.cue];
						return { text: word.text, start: line.startSec, ...(line.endSec === undefined ? {} : { end: line.endSec }) };
					}),
				}, { ...options, onProgress: (message) => { notice.setMessage(message); options.onProgress?.(message); } });
			};
			let prepared = transcript;
			let sourceSection = section;
			let result = await align(prepared);
			assertActive();
			const replacement = readCaptionReplacement(result, prepared, videoId);
			if (replacement) {
				const choice = await askNoteDecision(app, "Transcript differs from YouTube captions",
					`${replacement.reason === "format" ? "The stored transcript format is unrecognized." : "The stored transcript wording does not match the current YouTube captions."}\n\n${replacement.reason === "format" ? "Stored word count unavailable" : `${replacement.expectedWords} stored words`}; ${replacement.actualWords} current words. Even equal word counts can contain different wording.\n\nCancel leaves the existing transcript and saved timings unchanged. Replace transcript uses the current captions and their punctuation, then saves new word timings. Only content under the transcript heading is replaced; your other written content and note properties are preserved. Nothing is replaced unless timing succeeds.`,
					[{ label: "Cancel", value: "cancel" }, { label: "Replace transcript", value: "overwrite", warning: true }]);
				if (choice !== "overwrite") return null;
				assertActive();
				const newline = section.includes("\r\n") ? "\r\n" : "\n";
				sourceSection = newline + newline + formatTranscriptCues(replacement.captions.map((caption) => ({
					text: caption.text, offset: caption.startSec * 1000, duration: (caption.endSec - caption.startSec) * 1000,
				})), watchUrl(videoId)).replace(/\n/g, newline) + newline + newline;
				prepared = prepareTranscript(parseStoredTranscript(sourceSection));
				result = await align(prepared);
				assertActive();
				if (readCaptionReplacement(result, prepared, videoId)) {
					throw new Error("YouTube captions changed again while refreshing. The old transcript was not changed; please retry.");
				}
			}
			const cache = readAlignmentCache(result, prepared);
			if (!cache) throw new Error("WhisperX returned results for a different transcript or helper version.");
			if (!cache.words.some((word) => word !== null)) throw new Error("WhisperX could not align any words; no results were saved.");
			await save(cache, sourceSection);
			const sentences = alignedSentenceRows(prepared, cache);
			const approximate = sentences.filter((sentence) => sentence.timingUncertain).length;
			const method = cache.engine === "youtube-json3"
				? "YouTube timestamps only; no audio download or WhisperX inference."
				: "WhisperX acoustic fallback ran for missing sentence starts.";
			new Notice(`Sentence timings saved in transcript links. ${method} ${sentences.length - approximate}/${sentences.length} sentence starts timed; ${approximate} approximate. Use Compare to compare with caption timing.`);
			return cache;
		} finally {
			notice.hide();
		}
	} finally {
		files.delete(file);
	}
}
