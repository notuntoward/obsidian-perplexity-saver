import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import {
	createOrUpdateTranscript,
	transcriptVideoFromUrl,
	transcriptVideoSources,
	type TranscriptVideoSource,
} from "../../src/litNote/transcriptCreation";
import { fetchYouTubeCaptions } from "../../src/litNote/youtubeTranscript";
import { createdNotices } from "../__mocks__/obsidian";

vi.mock("../../src/litNote/youtubeTranscript", async (original) => ({
	...await original<Record<string, unknown>>(),
	fetchYouTubeCaptions: vi.fn(),
}));

const FIRST = "abcdefghijk";
const SECOND = "dQw4w9WgXcQ";
const file = { path: "note.md", basename: "note", extension: "md" } as TFile;

function vault(initial: string) {
	let content = initial;
	const process = vi.fn(async (_file: TFile, update: (current: string) => string) => {
		content = update(content);
	});
	const app = {
		vault: {
			cachedRead: vi.fn(async () => content),
			process,
		},
	} as unknown as App;
	return { app, process, read: () => content };
}

beforeEach(() => {
	vi.resetAllMocks();
	createdNotices.length = 0;
	vi.mocked(fetchYouTubeCaptions).mockResolvedValue({
		language: "en",
		lines: [{ offset: 12_000, duration: 3_000, text: "Selected video captions.", wordStarts: [12_000] }],
	});
});

describe("YouTube transcript creation", () => {
	const chooseFirst = async (_app: App, sources: TranscriptVideoSource[]) => sources[0] ?? null;

	it("deduplicates timestamps while preserving distinct videos in note order", () => {
		const sources = transcriptVideoSources([
			`[0:01](https://youtu.be/${FIRST}?t=1)`,
			`https://youtu.be/${SECOND}?t=4`,
			`[0:09](https://youtu.be/${FIRST}?t=9)`,
		].join("\n"));
		expect(sources.map((source) => source.videoId)).toEqual([FIRST, SECOND]);
		expect(sources[0].alias).toContain("First link in note");
	});

	it("validates manually entered URLs as YouTube videos", () => {
		expect(transcriptVideoFromUrl(` https://youtu.be/${SECOND}?t=5 `)).toEqual({
			videoId: SECOND,
			url: `https://www.youtube.com/watch?v=${SECOND}`,
			label: "Entered YouTube URL",
			alias: `https://youtu.be/${SECOND}?t=5`,
			origin: "entered",
		});
		expect(transcriptVideoFromUrl(`https://example.com/watch?v=${SECOND}`)).toBeNull();
		expect(transcriptVideoFromUrl("https://www.youtube.com/channel/example")).toBeNull();
	});

	it("creates a configured heading from the only distinct video", async () => {
		const state = vault("---\ntitle: Keep me\n---\n# Notes\nhttps://youtu.be/abcdefghijk?t=30\n");
		const result = await createOrUpdateTranscript(state.app, file, "Subtitles", { chooseVideo: chooseFirst });

		expect(result).toEqual({ action: "created", videoId: FIRST, cueCount: 1 });
		expect(fetchYouTubeCaptions).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${FIRST}`);
		expect(state.read()).toContain("# Notes\nhttps://youtu.be/abcdefghijk?t=30");
		expect(state.read()).toContain("# Subtitles\n");
		expect(state.read()).toContain(`https://youtu.be/${FIRST}?t=12`);
		expect(state.read()).toContain("title: Keep me");
		expect(createdNotices.at(-1)?.message).toContain('Created the "Subtitles" section with 1 caption cue');
	});

	it("uses a chooser for distinct videos and creates from the selected source", async () => {
		const state = vault(`# Notes\nhttps://youtu.be/${FIRST}\nhttps://youtu.be/${SECOND}\n`);
		const choose = vi.fn(async (
			_app: App,
			sources: TranscriptVideoSource[],
			preferred: string | null
		) => {
			expect(sources.map((source) => source.videoId)).toEqual([FIRST, SECOND]);
			expect(preferred).toBe(SECOND);
			return sources[1];
		});

		const result = await createOrUpdateTranscript(state.app, file, "Transcript", {
			preferredVideoId: SECOND,
			chooseVideo: choose,
		});

		expect(result?.videoId).toBe(SECOND);
		expect(choose).toHaveBeenCalledOnce();
		expect(fetchYouTubeCaptions).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${SECOND}`);
		const transcript = state.read().slice(state.read().indexOf("# Transcript"));
		expect(transcript).toContain(`https://youtu.be/${SECOND}?t=12`);
		expect(transcript).not.toContain(`https://youtu.be/${FIRST}`);
	});

	it("replaces an existing transcript without changing surrounding sections", async () => {
		const state = vault([
			"# Notes",
			`Use https://youtu.be/${SECOND}`,
			"# Transcript",
			`[0:01](https://youtu.be/${FIRST}?t=1) old captions`,
			"# Later",
			"Keep this section.",
		].join("\n"));

		const result = await createOrUpdateTranscript(state.app, file, "Transcript", {
			preferredVideoId: SECOND,
			chooseVideo: async (_app, sources) => sources.find((source) => source.videoId === SECOND) ?? null,
		});

		expect(result?.action).toBe("updated");
		const content = state.read();
		expect(content).toContain("# Notes\nUse https://youtu.be/dQw4w9WgXcQ");
		expect(content).toContain("# Later\nKeep this section.");
		expect(content).not.toContain("old captions");
		expect(content).toContain(`https://youtu.be/${SECOND}?t=12`);
	});

	it("uses the live note text instead of stale transcript URLs remaining in persisted content", async () => {
		const persisted = [
			`# Notes\nhttps://youtu.be/${FIRST}`,
			"# Transcript",
			`[0:00](https://youtu.be/${FIRST}?t=0 "0-2") old caption`,
		].join("\n");
		const live = `# Notes\nhttps://youtu.be/${SECOND}?t=4`;
		const state = vault(persisted);
		const sources: TranscriptVideoSource[][] = [];
		const result = await createOrUpdateTranscript(state.app, file, "Transcript", {
			noteText: live,
			chooseVideo: async (_app, choices) => {
				sources.push(choices);
				return choices[0];
			},
		});

		expect(sources[0].map((source) => source.videoId)).toEqual([SECOND]);
		expect(result?.videoId).toBe(SECOND);
		expect(state.read()).toContain(live);
		expect(state.read()).not.toContain("old caption");
		expect(fetchYouTubeCaptions).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${SECOND}`);
	});

	it("ignores orphaned generated transcript cues whose heading was deleted", () => {
		const content = [
			`# Notes\nhttps://youtu.be/${SECOND}?t=5`,
			"<!-- saver-word-timing:1 hash -->",
			`[0:00](https://youtu.be/${FIRST}?t=0 "0-2") old caption`,
			`[0:03](https://youtu.be/${FIRST}?t=3 "3-4; w=abc") more`,
		].join("\n");
		expect(transcriptVideoSources(content).map((source) => source.videoId)).toEqual([SECOND]);
	});

	it("does not fetch or change the note when selection or confirmation is cancelled", async () => {
		const state = vault(`# Notes\nhttps://youtu.be/${FIRST}\nhttps://youtu.be/${SECOND}`);
		expect(await createOrUpdateTranscript(state.app, file, "Transcript", {
			chooseVideo: async () => null,
		})).toBeNull();
		expect(fetchYouTubeCaptions).not.toHaveBeenCalled();
		expect(state.process).not.toHaveBeenCalled();
	});

	it("leaves the note unchanged when YouTube has no usable captions", async () => {
		const state = vault(`# Notes\nhttps://youtu.be/${FIRST}`);
		vi.mocked(fetchYouTubeCaptions).mockResolvedValue(null);

		expect(await createOrUpdateTranscript(state.app, file, "Transcript", { chooseVideo: chooseFirst })).toBeNull();
		expect(state.process).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toBe("This video has no usable YouTube captions. The note was not changed.");
	});

	it("does not overwrite edits made while captions are downloading", async () => {
		const state = vault(`# Notes\nhttps://youtu.be/${FIRST}`);
		state.process.mockImplementationOnce(async (_file, update) => {
			update(state.read() + "\nUser edit while downloading.\n");
		});

		expect(await createOrUpdateTranscript(state.app, file, "Transcript", { chooseVideo: chooseFirst })).toBeNull();
		expect(state.read()).not.toContain("# Transcript");
		expect(createdNotices.at(-1)?.message).toContain("note changed while captions were downloading");
	});
});
