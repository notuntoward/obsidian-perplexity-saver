import { sentenceRows, type BoundaryRow, type PreparedTranscript } from "./transcriptSentences";
import { parseYouTubeUrl, watchUrl } from "../video/youtubeLinks";

export const ALIGNMENT_CACHE_KEY = "whisperx_transcript";
export const ALIGNMENT_ENGINE = "whisperx-3.8.6";
export const ALIGNMENT_MODEL = "WAV2VEC2_ASR_BASE_960H";

export interface AlignmentCache {
	version: 2;
	sourceHash: string;
	videoId: string;
	engine: typeof ALIGNMENT_ENGINE | "youtube-json3";
	model: typeof ALIGNMENT_MODEL | null;
	paddingSeconds: 0;
	createdAt: string;
	audioSha256: string | null;
	captionSha256: string;
	audioDuration: number;
	captions: { first: number; last: number; start: number; end: number }[];
	wordSources: ("caption" | "youtube" | "acoustic" | "unmatched")[];
	words: ([number, number | null, number | null] | null)[];
}

export interface AlignedRow extends BoundaryRow {
	endSec?: number;
	timingUncertain: boolean;
}

export function transcriptVideoId(transcript: PreparedTranscript): string {
	const ids = transcript.lines.map((line) => parseYouTubeUrl(line.url)?.videoId);
	const id = ids[0];
	if (!id || !/^[\w-]{11}$/.test(id) || ids.some((value) => value !== id)) {
		throw new Error("Alignment requires transcript links to one YouTube video.");
	}
	return id;
}

export function readAlignmentCache(value: unknown, transcript: PreparedTranscript): AlignmentCache | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid WhisperX transcript cache.");
	const raw = value as Record<string, unknown>;
	if (raw.version !== 2 || raw.paddingSeconds !== 0 || raw.sourceHash !== transcript.hash) return null;
	if ((raw.engine !== ALIGNMENT_ENGINE || raw.model !== ALIGNMENT_MODEL) &&
		(raw.engine !== "youtube-json3" || raw.model !== null)) throw new Error("Invalid word timing engine.");
	if (raw.videoId !== transcriptVideoId(transcript)) throw new Error("WhisperX cache video does not match the transcript.");
	if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) ||
		(raw.audioSha256 !== null && (typeof raw.audioSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.audioSha256))) ||
		typeof raw.captionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.captionSha256) ||
		typeof raw.audioDuration !== "number" || !Number.isFinite(raw.audioDuration) || raw.audioDuration <= 0 ||
		!Array.isArray(raw.words) || raw.words.length !== transcript.words.length ||
		!Array.isArray(raw.wordSources) || raw.wordSources.length !== raw.words.length ||
		!Array.isArray(raw.captions) || !raw.captions.length) {
		throw new Error("Invalid WhisperX cache metadata or word count. Remove whisperx_transcript to realign.");
	}
	const duration = raw.audioDuration;
	if ((raw.engine === "youtube-json3") !== (raw.audioSha256 === null)) throw new Error("Invalid word timing audio provenance.");
	const wordSources = raw.wordSources.map((source: unknown): AlignmentCache["wordSources"][number] => {
		if (source !== "caption" && source !== "youtube" && source !== "acoustic" && source !== "unmatched") {
			throw new Error("Invalid word timing provenance.");
		}
		return source;
	});
	const words = raw.words.map((word: unknown, index: number): AlignmentCache["words"][number] => {
		if (raw.engine === "youtube-json3" && wordSources[index] === "acoustic") throw new Error("Invalid native word timing provenance.");
		if (word === null && wordSources[index] === "unmatched") return null;
		if (!Array.isArray(word) || word.length !== 3 || typeof word[0] !== "number" || !Number.isFinite(word[0])) {
			throw new Error("Invalid WhisperX word timing.");
		}
		const [start, end, score] = word as [number, unknown, unknown];
		if (wordSources[index] !== "acoustic") {
			if (wordSources[index] === "unmatched" || end !== null || score !== null) throw new Error("Invalid native word timing.");
			return [start, null, null];
		}
		if (typeof end !== "number" || !Number.isFinite(end) || typeof score !== "number" || !Number.isFinite(score) ||
			end <= start || score < 0.3 || score > 1) {
			throw new Error("Invalid or non-monotonic WhisperX word timing.");
		}
		return [start, end, score];
	});
	let position = 0;
	let previousEnd = 0;
	const captions = raw.captions.map((value: unknown): AlignmentCache["captions"][number] => {
		if (typeof value !== "object" || value === null) throw new Error("Invalid caption anchors.");
		const { first, last, start, end } = value as Record<string, unknown>;
		if (first !== position || typeof last !== "number" || !Number.isInteger(last) || last <= position || last > words.length ||
			typeof start !== "number" || !Number.isFinite(start) || typeof end !== "number" || !Number.isFinite(end) ||
			start < previousEnd || end <= start || end > duration) throw new Error("Invalid caption anchors.");
		if (words[position]?.[0] !== start || wordSources[position] !== "caption") throw new Error("Caption first word lost its anchor.");
		let boundary = start;
		for (let i = position; i < last; i++) {
			const word = words[i];
			if (word) {
				if (word[0] < boundary || word[0] >= end || (word[1] !== null && word[1] > end)) throw new Error("Word timing crosses a caption anchor.");
				boundary = word[1] ?? word[0];
			}
		}
		const caption = { first: position, last, start, end };
		position = last;
		previousEnd = end;
		return caption;
	});
	if (position !== words.length) throw new Error("Caption anchors do not cover the transcript words.");
	return {
		version: 2, sourceHash: transcript.hash, videoId: raw.videoId, engine: raw.engine as AlignmentCache["engine"],
		model: raw.model as AlignmentCache["model"], paddingSeconds: 0, createdAt: raw.createdAt,
		audioSha256: raw.audioSha256, captionSha256: raw.captionSha256, audioDuration: duration, words, captions, wordSources,
	};
}

export function alignedSentenceRows(transcript: PreparedTranscript, value: AlignmentCache): AlignedRow[] {
	const cache = readAlignmentCache(value, transcript);
	if (!cache) throw new Error("WhisperX results are unavailable for this transcript.");
	const sentences = sentenceRows(transcript);
	let first = 0;
	let previousEnd = 0;
	return sentences.map((sentence, index) => {
		const nextStart = sentences[index + 1]?.sourceStart ?? transcript.text.length;
		let last = first;
		while (last + 1 < transcript.words.length && transcript.words[last + 1].start < nextStart) last++;
		const timings = cache.words.slice(first, last + 1);
		const known = timings.filter((word) => word !== null);
		const startSec = known[0]?.[0] ?? previousEnd;
		const endSec = known.at(-1)?.[1] ?? undefined;
		const timingUncertain = timings.some((word) => word === null);
		first = last + 1;
		previousEnd = endSec ?? known.at(-1)?.[0] ?? startSec;
		return { ...sentence, startSec, endSec, timingUncertain, url: watchUrl(cache.videoId, startSec) };
	});
}
