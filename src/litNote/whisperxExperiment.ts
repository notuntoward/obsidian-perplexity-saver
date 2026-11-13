import { getFrontMatterInfo, Notice, parseYaml, type App, type TFile } from "obsidian";
import { askNoteDecision } from "./decisionModal";
import { loadTranscriptLines } from "./transcriptView";
import { prepareTranscript } from "./transcriptSentences";
import { ALIGNMENT_CACHE_KEY, readAlignmentCache, transcriptVideoId, type AlignmentCache } from "./transcriptAlignment";
import { runWhisperx, type WhisperxProcessOptions } from "./whisperxProcess";

const running = new WeakMap<App, Set<TFile>>();

export async function runWhisperxExperiment(
	app: App, file: TFile, heading: string, options: WhisperxProcessOptions
): Promise<AlignmentCache | null> {
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
		const lines = await loadTranscriptLines(app, file, heading);
		if (!lines?.length) throw new Error("This note has no timestamped transcript.");
		const transcript = prepareTranscript(lines);
		const videoId = transcriptVideoId(transcript);
		const cached = readAlignmentCache(raw, transcript);
		if (cached) {
			new Notice("WhisperX timings already saved. Comparison works offline; no download or alignment was run.");
			return cached;
		}
		const consent = await askNoteDecision(app, "Use caption word timing?",
			`Check YouTube captions for ${videoId} and time these ${transcript.words.length} words?\n\nUse native word offsets first, without audio downloads or inference. Only missing internal timings need local WhisperX and short audio clips. The first word of each original caption stays fixed; no word may cross the next caption's start. Caption text must match the note before any results are applied.\n\nContinue only if you have permission to download/process the needed audio. Your note and transcript are not uploaded; no API charge. Save versioned timings/provenance for offline comparison. Original text and punctuation remain unchanged.`,
			[{ label: "Check captions and save timings", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
		if (consent !== "create") return null;
		assertActive();
		const notice = new Notice("Starting local WhisperX alignment...", 0);
		try {
			const result = await runWhisperx({
				version: 2, sourceHash: transcript.hash, videoId,
				words: transcript.words.map((word) => {
					const line = transcript.lines[word.cue];
					return { text: word.text, start: line.startSec, ...(line.endSec === undefined ? {} : { end: line.endSec }) };
				}),
			}, { ...options, onProgress: (message) => { notice.setMessage(message); options.onProgress?.(message); } });
			assertActive();
			const cache = readAlignmentCache(result, transcript);
			if (!cache) throw new Error("WhisperX returned results for a different transcript or helper version.");
			if (!cache.words.some((word) => word !== null)) throw new Error("WhisperX could not align any words; no results were saved.");
			const current = await app.vault.cachedRead(file);
			if (current.slice(getFrontMatterInfo(current).contentStart) !== body) {
				throw new Error("The note body changed during alignment. Results were not applied to edited text.");
			}
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm[ALIGNMENT_CACHE_KEY] = cache;
			});
			const unmatched = cache.words.filter((word) => word === null).length;
			new Notice(`Caption timings saved (${cache.engine}). ${unmatched}/${cache.words.length} words uncertain. Select Word-timed sentences and Compare.`);
			return cache;
		} finally {
			notice.hide();
		}
	} finally {
		files.delete(file);
	}
}
