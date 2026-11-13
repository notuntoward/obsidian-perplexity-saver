import { describe, expect, it, vi } from "vitest";
import {
	classifyTranscript,
	createJevCache,
	prepareTranscript,
	readJevCache,
	sentenceRows,
	jevParagraphRows,
} from "../../src/litNote/jevTranscript";
import type { StoredTranscriptLine } from "../../src/litNote/transcriptSection";

const lines: StoredTranscriptLine[] = [
	{ startSec: 0, endSec: 5, url: "https://youtu.be/example?t=0", text: "we finished the experiment we" },
	{ startSec: 5, endSec: 9, url: "https://youtu.be/example?t=5", text: "checked the results next topic" },
];

function response(ids: string[]) {
	return {
		model: "jev-1.14.0",
		answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.1 }])),
		usage: { input_tokens: 100, output_tokens: 10 },
	};
}

describe("Jev transcript boundaries", () => {
	it("splits inside a caption and keeps its true timestamp without inventing word timing", () => {
		const transcript = prepareTranscript(lines);
		const probabilities = Array(transcript.words.length - 1).fill(0);
		probabilities[3] = 0.95;
		probabilities[8] = 0.9;
		const rows = sentenceRows(transcript, probabilities, 0.8);
		expect(rows.map((row) => row.text)).toEqual([
			"we finished the experiment", "we checked the results next", "topic",
		]);
		expect(rows.map((row) => row.startSec)).toEqual([0, 0, 5]);
		expect(rows.map((row) => row.text).join(" ")).toBe(transcript.text);
	});

	it("uses existing punctuation as the comparison baseline, including boundaries inside cues", () => {
		const transcript = prepareTranscript([{ ...lines[0], text: "We left. We stayed." }]);
		expect(sentenceRows(transcript).map((row) => row.text)).toEqual(["We left.", "We stayed."]);
	});

	it("groups only at sentence boundaries and permits a sentence longer than the readability target", () => {
		const transcript = prepareTranscript(lines);
		const sentence = Array(transcript.words.length - 1).fill(0);
		const paragraph = [...sentence];
		sentence[3] = 0.9;
		paragraph[1] = 1;
		paragraph[3] = 0.9;
		expect(jevParagraphRows(transcript, sentence, paragraph, 0.8, 0.8).map((row) => row.text))
			.toEqual(["we finished the experiment", "we checked the results next topic"]);
		const long = prepareTranscript([{ ...lines[0], text: Array(160).fill("word").join(" ") }]);
		expect(jevParagraphRows(long, Array(159).fill(0), Array(159).fill(0), 0.8, 0.8)).toHaveLength(1);
	});

	it("round-trips probabilities and invalidates edited text or timing rather than reusing stale scores", () => {
		const transcript = prepareTranscript(lines);
		const cache = createJevCache(transcript);
		cache.sentence[0] = 0.75;
		expect(readJevCache(JSON.parse(JSON.stringify(cache)), transcript)).toEqual(cache);
		expect(readJevCache(cache, prepareTranscript([{ ...lines[0], text: "changed" }, lines[1]]))).toBeNull();
		expect(readJevCache(cache, prepareTranscript([{ ...lines[0], endSec: 6 }, lines[1]]))).toBeNull();
		expect(() => readJevCache({ ...cache, sentence: [2] }, transcript)).toThrow("Invalid Jev");
	});

	it("batches all inter-word positions with explicit positions in question instructions", async () => {
		const transcript = prepareTranscript([{ ...lines[0], text: Array.from({ length: 75 }, (_, i) => `word${i}`).join(" ") }]);
		const request = vi.fn(async (body: { questions: Record<string, { instructions: string }> }) => {
			return response(Object.keys(body.questions));
		});
		const saved: number[] = [];
		const cache = await classifyTranscript(transcript, createJevCache(transcript), request, async (result) => {
			saved.push(result.sentence.filter((p) => p !== null).length);
		});
		expect(saved).toEqual([32, 64, 74]);
		expect(cache.sentence).toEqual(Array(74).fill(0.1));
		expect(cache.paragraph).toEqual(Array(74).fill(0.1));
		expect(cache.inputTokens).toBe(300);
		expect(request.mock.calls[0][0].questions.s0.instructions).toContain("words[0]");
		expect(request.mock.calls[0][0].questions.s0.instructions).toContain("words[1]");
	});

	it("reuses cached results offline and resumes after a later batch failure", async () => {
		const transcript = prepareTranscript([{ ...lines[0], text: Array(40).fill("word").join(" ") }]);
		let persisted = createJevCache(transcript);
		const request = vi.fn(async (body: { questions: Record<string, unknown> }) => {
			if (request.mock.calls.length === 2) throw new Error("Offline");
			return response(Object.keys(body.questions));
		});
		await expect(classifyTranscript(transcript, persisted, request, async (cache) => {
			persisted = structuredClone(cache);
		})).rejects.toThrow("Offline");
		expect(persisted.sentence.filter((p) => p !== null)).toHaveLength(32);
		const retry = vi.fn(async (body: { questions: Record<string, unknown> }) => response(Object.keys(body.questions)));
		const cache = await classifyTranscript(transcript, persisted, retry, async () => {});
		expect(Object.keys(retry.mock.calls[0][0].questions)).toHaveLength(14);
		await classifyTranscript(transcript, cache, async () => { throw new Error("Must not call API"); }, async () => {});
		expect(sentenceRows(transcript, cache.sentence, 0.9)).toHaveLength(1);
	});

	it("rejects incomplete or invalid API responses without persisting a success-shaped cache", async () => {
		const transcript = prepareTranscript(lines);
		const save = vi.fn();
		await expect(classifyTranscript(transcript, createJevCache(transcript), async () => response([]), save))
			.rejects.toThrow("Missing or invalid Jev answer");
		expect(save).not.toHaveBeenCalled();
		expect(() => sentenceRows(transcript, Array(transcript.words.length - 1).fill(null), 0.8))
			.toThrow("incomplete");
	});
});
