import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { getFrontMatterInfo } from "obsidian";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import { runWhisperxExperiment } from "../../src/litNote/whisperxExperiment";
import { runWhisperx } from "../../src/litNote/whisperxProcess";
import { parseStoredTranscript } from "../../src/litNote/transcriptSection";
import { prepareTranscript } from "../../src/litNote/transcriptSentences";
import { readInlineTimings } from "../../src/litNote/transcriptTimingStorage";

vi.mock("../../src/litNote/decisionModal", () => ({ askNoteDecision: vi.fn() }));
vi.mock("../../src/litNote/whisperxProcess", () => ({ runWhisperx: vi.fn() }));
vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	getFrontMatterInfo: (content: string) => {
		const end = content.indexOf("\n---\n", 4);
		return content.startsWith("---\n") && end >= 0
			? { exists: true, frontmatter: content.slice(4, end), contentStart: end + 5 }
			: { exists: false, frontmatter: "", contentStart: 0 };
	},
	parseYaml: (text: string) => JSON.parse(text),
}));

const file = { path: "note.md", basename: "note", extension: "md" } as TFile;
const options = { pythonPath: "python", helperPath: "align.py" };
let body: string;
let frontmatter: Record<string, unknown>;
let app: App;

function mismatchFor(value: unknown) {
	const request = value as { sourceHash: string; videoId: string; words: unknown[] };
	return {
		version: 2, status: "transcript-mismatch", sourceHash: request.sourceHash, videoId: request.videoId,
		reason: request.words.length ? "wording" : "format", expectedWords: request.words.length,
		actualWords: 3, audioDuration: 100,
		captions: [{ startSec: 0, endSec: 12, text: "A fresh transcript." }],
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	body = "# Transcript\n[0:00](https://youtu.be/abcdefghijk?t=0 \"0-12\") we finished the experiment we checked the results\n";
	frontmatter = { title: "Keep me" };
	const content = () => `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
	app = {
		vault: {
			cachedRead: vi.fn(async () => content()),
			process: vi.fn(async (_file, fn) => {
				const updated: string = fn(content());
				body = updated.slice(getFrontMatterInfo(updated).contentStart);
				return updated;
			}),
		},
		metadataCache: { getFileCache: () => ({
			frontmatter,
			headings: Array.from(content().matchAll(/^(#+) (.*)$/gm), (match) => ({
				heading: match[2], level: match[1].length,
				position: { start: { offset: match.index }, end: { offset: match.index + match[0].length } },
			})),
		}) },
		fileManager: { processFrontMatter: vi.fn(async (_file, fn) => { fn(frontmatter); }) },
	} as unknown as App;
	vi.mocked(askNoteDecision).mockResolvedValue("create");
	vi.mocked(runWhisperx).mockImplementation(async (value) => {
		const request = value as { sourceHash: string; videoId: string; words: { text: string }[] };
		return {
			version: 2, sourceHash: request.sourceHash, videoId: request.videoId,
			engine: "whisperx-3.8.6", model: "WAV2VEC2_ASR_BASE_960H", paddingSeconds: 0,
			createdAt: "2026-11-13T00:00:00Z", audioSha256: "a".repeat(64), audioDuration: 100,
			captionSha256: "b".repeat(64),
			captions: [{ first: 0, last: request.words.length, start: 0, end: request.words.length }],
			wordSources: request.words.map((_, i) => i === 0 ? "caption" : "acoustic"),
			words: request.words.map((_, i) => i === 0 ? [0, null, null] : [i, 0.5 + i, 0.9]),
		};
	});
});

describe("local word timing consent and offline persistence", () => {
	it.each([3, 8])("offers cancellation without changing the existing transcript or cache (current words=%s)", async (count) => {
		const original = body;
		frontmatter.whisperx_transcript = { version: 1 };
		vi.mocked(runWhisperx).mockImplementationOnce(async (value) => {
			const mismatch = mismatchFor(value);
			if (count === 8) {
				mismatch.actualWords = 8;
				mismatch.captions[0].text = "We finished this new experiment and checked results.";
			}
			return mismatch;
		});
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("cancel");
		expect(await runWhisperxExperiment(app, file, "Transcript", options)).toBeNull();
		expect(askNoteDecision).toHaveBeenLastCalledWith(app, "Transcript differs from YouTube captions",
			expect.stringContaining(`8 stored words; ${count} current words`), expect.arrayContaining([
				expect.objectContaining({ value: "cancel" }), expect.objectContaining({ value: "overwrite" }),
			]));
		expect(runWhisperx).toHaveBeenCalledOnce();
		expect(app.vault.process).not.toHaveBeenCalled();
		expect(body).toBe(original);
		expect(frontmatter.whisperx_transcript).toEqual({ version: 1 });
	});

	it("replaces only the transcript after explicit confirmation and saves fresh compact timings", async () => {
		const prefix = "# Summary\nWritten content stays here.\n\n";
		const suffix = "\n# Notes\nMy comments.\n";
		body = prefix + body + suffix;
		frontmatter.whisperx_transcript = { version: 1 };
		vi.mocked(runWhisperx).mockImplementationOnce(async (value) => mismatchFor(value));
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("overwrite");
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(body.startsWith(prefix)).toBe(true);
		expect(body.endsWith(suffix)).toBe(true);
		expect(body).toContain("A fresh transcript.");
		expect(body).not.toContain("we finished the experiment");
		expect(body).toContain("; w=");
		expect(frontmatter.title).toBe("Keep me");
		expect(frontmatter.whisperx_transcript).toBeUndefined();
		expect(runWhisperx).toHaveBeenCalledTimes(2);
		const request = vi.mocked(runWhisperx).mock.calls[1][0] as { words: { text: string }[] };
		expect(request.words.map((word) => word.text)).toEqual(["A", "fresh", "transcript."]);
	});

	it("offers the same safe replacement for an unrecognized transcript format using the note video URL", async () => {
		body = "# Transcript\nOld transcript without recognized timestamp links.\n";
		frontmatter.url = "https://youtu.be/abcdefghijk";
		vi.mocked(runWhisperx).mockImplementationOnce(async (value) => mismatchFor(value));
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("overwrite");
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(askNoteDecision).toHaveBeenLastCalledWith(app, "Transcript differs from YouTube captions",
			expect.stringContaining("Stored word count unavailable"), expect.any(Array));
		expect(body).toContain("A fresh transcript.");
		expect(body).not.toContain("Old transcript");
	});

	it("leaves old text intact if timing fails after overwrite consent or captions change again", async () => {
		const original = body;
		vi.mocked(runWhisperx).mockImplementationOnce(async (value) => mismatchFor(value));
		vi.mocked(runWhisperx).mockRejectedValueOnce(new Error("Model failed"));
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("overwrite");
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("Model failed");
		expect(body).toBe(original);
		vi.mocked(runWhisperx).mockImplementationOnce(async (value) => mismatchFor(value));
		vi.mocked(runWhisperx).mockImplementationOnce(async (value) => mismatchFor(value));
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("overwrite");
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("changed again");
		expect(body).toBe(original);
		expect(app.vault.process).not.toHaveBeenCalled();
	});

	it("rejects malformed replacement captions rather than offering an unsafe overwrite", async () => {
		const original = body;
		vi.mocked(runWhisperx).mockImplementationOnce(async (value) => ({ ...mismatchFor(value), actualWords: 99 }));
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("replacement caption word count");
		expect(askNoteDecision).toHaveBeenCalledOnce();
		expect(app.vault.process).not.toHaveBeenCalled();
		expect(body).toBe(original);
	});

	it("confirms before downloading, preserves the note and reuses saved timings offline", async () => {
		const original = body;
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(askNoteDecision).toHaveBeenCalledOnce();
		expect(frontmatter.whisperx_transcript).toBeUndefined();
		expect(frontmatter.title).toBe("Keep me");
		expect(body).toContain("; w=");
		expect(prepareTranscript(parseStoredTranscript(body)).text).toBe(prepareTranscript(parseStoredTranscript(original)).text);
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(body)))).not.toBeNull();
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
		expect(JSON.stringify(vi.mocked(runWhisperx).mock.calls[0][0])).not.toContain("Keep me");
		vi.mocked(runWhisperx).mockClear();
		vi.mocked(askNoteDecision).mockClear();
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(runWhisperx).not.toHaveBeenCalled();
		expect(askNoteDecision).not.toHaveBeenCalled();
	});

	it("migrates a legacy cache offline and removes only that property after saving compact timings", async () => {
		const original = body;
		await runWhisperxExperiment(app, file, "Transcript", options);
		const legacy: unknown = await vi.mocked(runWhisperx).mock.results[0].value;
		body = original;
		frontmatter.whisperx_transcript = legacy;
		frontmatter.jev_transcript = { untouched: true };
		vi.mocked(runWhisperx).mockClear();
		vi.mocked(askNoteDecision).mockClear();
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(body).toContain("; w=");
		expect(frontmatter.whisperx_transcript).toBeUndefined();
		expect(frontmatter.jev_transcript).toEqual({ untouched: true });
		expect(frontmatter.title).toBe("Keep me");
		expect(runWhisperx).not.toHaveBeenCalled();
		expect(askNoteDecision).not.toHaveBeenCalled();
	});

	it("retains the old cache if the compact write fails and supports retrying a failed property cleanup", async () => {
		const original = body;
		await runWhisperxExperiment(app, file, "Transcript", options);
		const legacy: unknown = await vi.mocked(runWhisperx).mock.results[0].value;
		body = original;
		frontmatter.whisperx_transcript = legacy;
		vi.mocked(app.vault.process).mockRejectedValueOnce(new Error("Write failed"));
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("Write failed");
		expect(frontmatter.whisperx_transcript).toEqual(legacy);
		expect(body).toBe(original);
		vi.mocked(app.vault.process).mockResolvedValueOnce("");
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("verification failed");
		expect(frontmatter.whisperx_transcript).toEqual(legacy);
		vi.mocked(app.fileManager.processFrontMatter).mockRejectedValueOnce(new Error("Cleanup failed"));
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("Cleanup failed");
		expect(frontmatter.whisperx_transcript).toEqual(legacy);
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(body)))).not.toBeNull();
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(frontmatter.whisperx_transcript).toBeUndefined();
	});

	it("preserves unrelated note sections and frontmatter edits made while the helper runs", async () => {
		const prefix = "# Summary\nWritten content stays here.\n\n";
		const suffix = "\n# Notes\nMy comments.\n";
		body = prefix + body + suffix;
		const implementation = vi.mocked(runWhisperx).getMockImplementation()!;
		vi.mocked(runWhisperx).mockImplementationOnce(async (...args) => {
			const result = await implementation(...args);
			frontmatter.extra = "Edited while aligning";
			return result;
		});
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(body.startsWith(prefix)).toBe(true);
		expect(body.endsWith(suffix)).toBe(true);
		expect(frontmatter.extra).toBe("Edited while aligning");
	});

	it("does nothing after declined consent, cancellation, helper failure, or concurrent body edits", async () => {
		vi.mocked(askNoteDecision).mockResolvedValueOnce("cancel");
		expect(await runWhisperxExperiment(app, file, "Transcript", options)).toBeNull();
		expect(runWhisperx).not.toHaveBeenCalled();
		const controller = new AbortController();
		controller.abort();
		await expect(runWhisperxExperiment(app, file, "Transcript", { ...options, signal: controller.signal }))
			.rejects.toThrow("cancelled");
		vi.mocked(runWhisperx).mockRejectedValueOnce(new Error("Download failed"));
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("Download failed");
		const implementation = vi.mocked(runWhisperx).getMockImplementation()!;
		vi.mocked(runWhisperx).mockImplementationOnce(async (...args) => {
			const result = await implementation(...args);
			body += "\nEdited while aligning\n";
			return result;
		});
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("body changed");
		expect(frontmatter.whisperx_transcript).toBeUndefined();
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});

	it("guards duplicate runs and rejects malformed helper results rather than saving success", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		vi.mocked(runWhisperx).mockImplementationOnce(async () => { await waiting; return {}; });
		const first = runWhisperxExperiment(app, file, "Transcript", options);
		await vi.waitFor(() => expect(runWhisperx).toHaveBeenCalledOnce());
		await expect(runWhisperxExperiment(app, file, "Transcript", options)).rejects.toThrow("already running");
		release();
		await expect(first).rejects.toThrow("different transcript");
		expect(frontmatter.whisperx_transcript).toBeUndefined();
	});
});
