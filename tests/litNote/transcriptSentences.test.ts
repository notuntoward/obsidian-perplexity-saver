import { describe, expect, it } from "vitest";
import { prepareTranscript, sentenceRows } from "../../src/litNote/transcriptSentences";

describe("punctuation sentence rows", () => {
	it("splits inside captions while preserving text and original cue timestamps", () => {
		const transcript = prepareTranscript([
			{ startSec: 12, url: "https://youtu.be/abcdefghijk?t=12", text: "We left. We stayed." },
			{ startSec: 16, url: "https://youtu.be/abcdefghijk?t=16", text: "Then we returned." },
		]);
		const rows = sentenceRows(transcript);
		expect(rows.map((row) => row.text)).toEqual(["We left.", "We stayed.", "Then we returned."]);
		expect(rows.map((row) => row.startSec)).toEqual([12, 12, 16]);
		expect(rows.map((row) => row.text).join(" ")).toBe(transcript.text);
		expect(rows.map((row) => row.sourceStart)).toEqual([0, 9, 20]);
	});
});
