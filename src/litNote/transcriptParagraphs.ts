/// <reference lib="es2022.intl" />
import { eng, removeStopwords } from "stopword";
import { isEnglishTranscript, normalizeTranscriptLanguage } from "./transcriptLanguage";

/**
 * Group timestamped transcript cues into paragraphs.
 *
 * This mirrors the "Transcript (paragraphs)" view of the Media Extended plugin
 * (v4): a paragraph ends at a pause in speech, or once it grows past about a
 * minute, preferring to break after a cue that ends a sentence. Cue texts are
 * joined with a space unless the language or a trailing dash says otherwise.
 */

export interface TranscriptCue {
	startSec: number;
	endSec: number;
	text: string;
}

export interface TranscriptParagraph<C extends TranscriptCue = TranscriptCue> {
	startSec: number;
	cues: C[];
	text: string;
}

/** A silence longer than this (seconds) between cues starts a new paragraph. */
const PAUSE_SEC = 3;
/** Paragraphs are capped near this length (seconds). */
const MAX_PARAGRAPH_SEC = 60;
/** How far (seconds) from the cap a sentence end may be to break there. */
const SENTENCE_SEARCH_SEC = 15;
/** At a pause, split at the last sentence end only if it leaves this much (seconds). */
const MIN_SPLIT_SEC = 10;

export const SENTENCE_END = /[.!?。！？][\p{Pe}\p{Pf}"'\u200e\u200f\s]*$/u;
const NO_SPACE_SCRIPT =
	/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;
const TRAILING_DASH = /[-–—]$/;

/** Group cues (sorted by start time) into paragraphs of cues. */
export function groupCuesIntoParagraphs<C extends TranscriptCue>(cues: C[]): C[][] {
	if (cues.length === 0) return [];
	const endsSentence = cues.map((c) => SENTENCE_END.test(c.text));
	const paragraphs: C[][] = [];
	let current: C[] = [];
	// Index in `cues` of current[0].
	let currentStart = 0;

	for (let i = 0; i < cues.length; i++) {
		const cue = cues[i];

		if (current.length > 0) {
			const last = current[current.length - 1];
			if (cue.startSec - last.endSec > PAUSE_SEC) {
				let lastSentence = -1;
				for (let n = current.length - 1; n >= 0; n--) {
					if (endsSentence[currentStart + n]) {
						lastSentence = n;
						break;
					}
				}
				const sentenceSpan =
					lastSentence === -1 ? 0 : current[lastSentence].endSec - current[0].startSec;
				if (lastSentence !== -1 && sentenceSpan >= MIN_SPLIT_SEC) {
					paragraphs.push(current.slice(0, lastSentence + 1));
					current = current.slice(lastSentence + 1);
					currentStart += lastSentence + 1;
				} else {
					paragraphs.push(current);
					current = [];
				}
			}
		}

		if (current.length === 0) currentStart = i;
		current.push(cue);

		if (cue.endSec - current[0].startSec <= MAX_PARAGRAPH_SEC) continue;

		const target = current[0].startSec + MAX_PARAGRAPH_SEC;

		// Closest sentence end already in the paragraph.
		let back = -1;
		let backDist = Infinity;
		for (let n = current.length - 1; n >= 0; n--) {
			if (!endsSentence[currentStart + n]) continue;
			const dist = Math.abs(current[n].endSec - target);
			if (dist <= SENTENCE_SEARCH_SEC && dist < backDist) {
				back = n;
				backDist = dist;
			}
		}

		// Closest sentence end a little further on, without crossing a pause.
		let ahead = -1;
		let aheadDist = Infinity;
		for (let n = i + 1; n < cues.length; n++) {
			if (cues[n].startSec - cues[n - 1].endSec > PAUSE_SEC) break;
			if (cues[n].startSec - target > SENTENCE_SEARCH_SEC) break;
			if (!endsSentence[n]) continue;
			const dist = Math.abs(cues[n].endSec - target);
			if (dist <= SENTENCE_SEARCH_SEC && dist < aheadDist) {
				ahead = n;
				aheadDist = dist;
			}
		}

		if (back !== -1 && (ahead === -1 || backDist <= aheadDist)) {
			paragraphs.push(current.slice(0, back + 1));
			current = current.slice(back + 1);
			currentStart += back + 1;
		} else if (ahead !== -1) {
			for (let n = i + 1; n <= ahead; n++) current.push(cues[n]);
			paragraphs.push(current);
			current = [];
			i = ahead;
		} else if (current.length === 1) {
			paragraphs.push(current);
			current = [];
		} else {
			const overflow = current.pop() as C;
			paragraphs.push(current);
			current = [overflow];
			currentStart = i;
		}
	}

	if (current.length > 0) paragraphs.push(current);
	return paragraphs;
}

/** Whether a space is needed between two adjacent cue texts. */
export function needsSpaceBetween(left: string, right: string): boolean {
	if (left.length === 0 || right.length === 0) return false;
	const last = left[left.length - 1];
	const first = right[0];
	return !(
		/\s/.test(last) ||
		/\s/.test(first) ||
		TRAILING_DASH.test(left) ||
		NO_SPACE_SCRIPT.test(last) ||
		NO_SPACE_SCRIPT.test(first)
	);
}

/** Join cue texts the way Media Extended renders a paragraph. */
export function joinCueTexts(texts: string[]): string {
	let joined = "";
	texts.forEach((text, i) => {
		joined += text;
		if (i < texts.length - 1 && needsSpaceBetween(text, texts[i + 1])) joined += " ";
	});
	return joined;
}

export function buildTranscriptParagraphs<C extends TranscriptCue>(
	cues: C[]
): TranscriptParagraph<C>[] {
	return groupCuesIntoParagraphs(cues).map((group) => ({
		startSec: group[0].startSec,
		cues: group,
		text: joinCueTexts(group.map((c) => c.text)),
	}));
}

/** Group complete sentences locally; timestamps are not measurements of silence. */
export function groupSentencesIntoParagraphs<T extends { text: string }>(sentences: readonly T[], language?: string): T[][] {
	if (!sentences.length) return [];
	const locale = normalizeTranscriptLanguage(language);
	const english = isEnglishTranscript(locale);
	const characters = !english && (/^(?:zh|ja)(?:-|$)/.test(locale ?? "") ||
		sentences.some((sentence) => /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u.test(sentence.text)));
	const segmenter = new Intl.Segmenter(locale, { granularity: characters ? "grapheme" : "word" });
	const target = characters ? 300 : 120;
	const limit = characters ? 400 : 160;
	const lengths: number[] = [];
	const terms = sentences.map((sentence) => {
		const words = Array.from(segmenter.segment(sentence.text), (part) =>
			(characters ? part.segment.trim() : part.isWordLike) ? part.segment.toLocaleLowerCase(locale) : "")
			.filter(Boolean);
		lengths.push(Math.max(1, words.length));
		return english ? removeStopwords(words, eng).filter((word) => word.length >= 3) : [];
	});
	let boundary = Array<number>(sentences.length).fill(0);
	if (english) {
		const frequency = new Map<string, number>();
		for (const sentence of terms) for (const word of new Set(sentence)) {
			frequency.set(word, (frequency.get(word) ?? 0) + 1);
		}
		const vector = (first: number, last: number): Map<string, number> => {
			const counts = new Map<string, number>();
			for (let i = first; i < last; i++) for (const word of terms[i]) counts.set(word, (counts.get(word) ?? 0) + 1);
			for (const [word, count] of counts) {
				counts.set(word, (1 + Math.log(count)) * (1 + Math.log((sentences.length + 1) / (frequency.get(word)! + 1))));
			}
			return counts;
		};
		const similarity = Array<number>(sentences.length).fill(0);
		for (let i = 1; i < sentences.length; i++) {
			const left = vector(Math.max(0, i - 3), i);
			const right = vector(i, Math.min(sentences.length, i + 3));
			let dot = 0;
			let leftNorm = 0;
			let rightNorm = 0;
			for (const [word, weight] of left) {
				dot += weight * (right.get(word) ?? 0);
				leftNorm += weight * weight;
			}
			for (const weight of right.values()) rightNorm += weight * weight;
			similarity[i] = leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
		}
		boundary = similarity.map((value, i) => {
			if (!i) return 0;
			// Prefer a local cohesion valley, not merely an uncommon sentence.
			const before = Math.max(...similarity.slice(Math.max(1, i - 3), i + 1));
			const after = Math.max(...similarity.slice(i, Math.min(sentences.length, i + 4)));
			const text = sentences[i].text.trimStart();
			const transition = /^(?:let['\u2019]s (?:turn|move)|turning to|moving on|in (?:summary|conclusion)|to (?:sum up|conclude))\b/i.test(text) ? 0.5 : 0;
			const continuation = /^(?:for example|for instance|in other words|that is)\b/i.test(text) ? 0.75 : 0;
			return 1.5 * (before + after - 2 * value) + transition - continuation;
		});
	}
	const cost = Array<number>(sentences.length + 1).fill(Infinity);
	const next = Array<number>(sentences.length).fill(0);
	cost[sentences.length] = 0;
	// Optimize all breaks together so a length cap does not leave a tiny tail.
	for (let first = sentences.length - 1; first >= 0; first--) {
		let words = 0;
		for (let last = first + 1; last <= sentences.length; last++) {
			words += lengths[last - 1];
			if (words > limit && last > first + 1) break;
			const candidate = ((words - target) / (target / 2)) ** 2 + 0.6 + cost[last] - (boundary[last] ?? 0);
			if (candidate < cost[first]) {
				cost[first] = candidate;
				next[first] = last;
			}
		}
	}
	const paragraphs: T[][] = [];
	for (let first = 0; first < sentences.length; first = next[first]) paragraphs.push(sentences.slice(first, next[first]));
	return paragraphs;
}
