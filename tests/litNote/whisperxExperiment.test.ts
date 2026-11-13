import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import { runWhisperxExperiment } from "../../src/litNote/whisperxExperiment";
import { runWhisperx } from "../../src/litNote/whisperxProcess";

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

beforeEach(() => {
	vi.clearAllMocks();
	body = "# Transcript\n[0:00](https://youtu.be/abcdefghijk?t=0 \"0-5\") we finished the experiment we checked the results\n";
	frontmatter = { title: "Keep me" };
	const content = () => `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
	app = {
		vault: { cachedRead: vi.fn(async () => content()) },
		metadataCache: { getFileCache: () => ({
			frontmatter,
			headings: [{ heading: "Transcript", level: 1, position: { end: { offset: content().indexOf("# Transcript") + 12 } } }],
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
			captions: [{ first: 0, last: request.words.length, start: 20, end: 20 + request.words.length }],
			wordSources: request.words.map((_, i) => i === 0 ? "caption" : "acoustic"),
			words: request.words.map((_, i) => i === 0 ? [20, null, null] : [20 + i, 20.5 + i, 0.9]),
		};
	});
});

describe("local word timing consent and offline persistence", () => {
	it("confirms before downloading, preserves the note and reuses saved timings offline", async () => {
		const original = body;
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(askNoteDecision).toHaveBeenCalledOnce();
		expect(frontmatter.whisperx_transcript).toBeDefined();
		expect(frontmatter.title).toBe("Keep me");
		expect(body).toBe(original);
		expect(JSON.stringify(vi.mocked(runWhisperx).mock.calls[0][0])).not.toContain("Keep me");
		vi.mocked(runWhisperx).mockClear();
		vi.mocked(askNoteDecision).mockClear();
		await runWhisperxExperiment(app, file, "Transcript", options);
		expect(runWhisperx).not.toHaveBeenCalled();
		expect(askNoteDecision).not.toHaveBeenCalled();
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
