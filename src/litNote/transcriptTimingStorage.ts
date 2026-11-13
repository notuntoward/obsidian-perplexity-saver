import { parseStoredTranscript } from "./transcriptSection";
import { prepareTranscript, type PreparedTranscript } from "./transcriptSentences";
import { transcriptVideoId, type WordTimings } from "./transcriptAlignment";
import { formatShortTimestamp } from "./youtubeTranscript";

const MARKER = /^<!-- saver-word-timing:1 ([a-f0-9]{64}) -->$/;
const OFFSET = String.raw`-?\d+(?:\.\d+)?`;
const NATIVE = new RegExp(`^${OFFSET}$`);
const ACOUSTIC = new RegExp(`^a(${OFFSET}):(${OFFSET}):(${OFFSET})$`);

export function readInlineTimings(transcript: PreparedTranscript): WordTimings | null {
	const marker = transcript.lines[0]?.timingMarker;
	if (marker === undefined && transcript.lines.every((line) => line.wordTimings === undefined)) return null;
	const hash = marker?.match(MARKER)?.[1];
	if (!hash) throw new Error("Invalid compact word timing version or source fingerprint.");
	if (hash !== transcript.hash) return null;
	const words: WordTimings["words"] = [];
	const wordSources: WordTimings["wordSources"] = [];
	let previous = 0;
	let position = 0;
	for (let cue = 0; cue < transcript.lines.length; cue++) {
		const line = transcript.lines[cue];
		const tokens = line.wordTimings === "" ? [] : line.wordTimings?.split(",");
		let last = position;
		while (last < transcript.words.length && transcript.words[last].cue === cue) last++;
		if (!tokens || tokens.length !== last - position) throw new Error("Invalid compact word timing word count.");
		// Legacy block starts are floored to whole seconds, not exact next-caption bounds.
		const bound = line.endSec ?? Infinity;
		const seconds = (offset: string): number => Number((line.startSec + Number(offset) / 1000).toFixed(6));
		for (const token of tokens) {
			if (token === "?") {
				words.push(null);
				wordSources.push("unmatched");
				continue;
			}
			const acoustic = token.match(ACOUSTIC);
			if (!acoustic && !NATIVE.test(token)) throw new Error("Invalid compact word timing.");
			const start = seconds(acoustic?.[1] ?? token);
			const end = acoustic ? seconds(acoustic[2]) : null;
			const score = acoustic ? Number(acoustic[3]) : null;
			if (!Number.isFinite(start) || start < previous || start > bound ||
				(end !== null && (!Number.isFinite(end) || end <= start || end > bound)) ||
				(score !== null && (!Number.isFinite(score) || score < 0.3 || score > 1))) {
				throw new Error("Invalid compact word timing order or caption bounds.");
			}
			words.push([start, end, score]);
			wordSources.push(acoustic ? "acoustic" : "youtube");
			previous = end ?? start;
		}
		position = last;
	}
	return { sourceHash: hash, videoId: transcriptVideoId(transcript), words, wordSources };
}

export function writeInlineTimings(section: string, timings: WordTimings): string {
	const lines = parseStoredTranscript(section);
	const transcript = prepareTranscript(lines);
	if (timings.sourceHash !== transcript.hash || timings.videoId !== transcriptVideoId(transcript) ||
		timings.words.length !== transcript.words.length) throw new Error("Word timings do not match the stored transcript.");
	const tokens = transcript.lines.map((): string[] => []);
	transcript.words.forEach((word, index) => {
		const timing = timings.words[index];
		const base = transcript.lines[word.cue].startSec;
		const offset = (seconds: number): number => Number(((seconds - base) * 1000).toFixed(3));
		tokens[word.cue].push(timing === null ? "?" : timing[1] === null
			? String(offset(timing[0])) : `a${offset(timing[0])}:${offset(timing[1])}:${timing[2]}`);
	});
	const indices = new Map(transcript.lines.map((line, index) => [line, index]));
	let position = 0;
	const newline = section.includes("\r\n") ? "\r\n" : "\n";
	const rawLines = section.split(/\r?\n/).filter((raw) => !raw.trim().startsWith("<!-- saver-word-timing:"));
	const annotated = rawLines.map((raw) => {
		if (!parseStoredTranscript(raw).length) return raw;
		const line = lines[position++];
		const index = indices.get(line);
		const match = raw.match(/^(\s*)\[[^\]]+\]\([^)]*\)(.*)$/);
		if (index === undefined || !match) throw new Error("Cannot annotate this transcript timestamp link.");
		const range = `${line.startSec}${line.endSec === undefined ? "" : `-${line.endSec}`}`;
		return `${match[1]}[${formatShortTimestamp(line.startSec * 1000)}](${line.url} "${range}; w=${tokens[index].join(",")}")${match[2]}`;
	});
	annotated.splice(Math.max(0, annotated.findIndex((raw) => raw.trim())), 0,
		`<!-- saver-word-timing:1 ${transcript.hash} -->`);
	const result = annotated.join(newline);
	if (!readInlineTimings(prepareTranscript(parseStoredTranscript(result)))) throw new Error("Compact word timing verification failed.");
	return result;
}
