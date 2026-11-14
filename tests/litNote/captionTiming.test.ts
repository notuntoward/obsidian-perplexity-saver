import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Plugin, TFile } from "obsidian";
import { getFrontMatterInfo } from "obsidian";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import { registerCaptionTimingRepair, runCaptionTiming } from "../../src/litNote/captionTiming";
import { fetchYouTubeCaptions } from "../../src/litNote/youtubeTranscript";
import { parseStoredTranscript } from "../../src/litNote/transcriptSection";
import { prepareTranscript } from "../../src/litNote/transcriptSentences";
import { readInlineTimings } from "../../src/litNote/transcriptTimingStorage";
import { createdNotices } from "../__mocks__/obsidian";
import { cacheForTest } from "./transcriptAlignment.test";

vi.mock("../../src/litNote/decisionModal", () => ({ askNoteDecision: vi.fn() }));
vi.mock("../../src/litNote/youtubeTranscript", async (original) => ({
	...await original<Record<string, unknown>>(), fetchYouTubeCaptions: vi.fn(),
}));
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
let body: string;
let frontmatter: Record<string, unknown>;
let app: App;

beforeEach(() => {
	vi.resetAllMocks();
	createdNotices.length = 0;
	body = '# Transcript\n[0:21](https://youtu.be/abcdefghijk?t=21 "21-30") We left. We stayed.\n';
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
	vi.mocked(fetchYouTubeCaptions).mockResolvedValue({
		language: "en", lines: [{ offset: 21000, duration: 9000, text: "We left. We stayed.", wordStarts: [21000, null, 25000, null] }],
	});
});

describe("native caption timing consent and safe persistence", () => {
	function openingWatcher() {
		const events = new Map<string, (file: TFile | null) => void>();
		let active: TFile | null = file;
		let ready!: () => void;
		let cleanup!: () => void;
		Object.assign(app, { workspace: {
			getActiveFile: () => active,
			on: (name: string, callback: (file: TFile | null) => void) => { events.set(name, callback); return {}; },
			onLayoutReady: (callback: () => void) => { ready = callback; },
		} });
		Object.assign(app.metadataCache, { on: (name: string, callback: (file: TFile | null) => void) => {
			events.set(`metadata-${name}`, callback);
			return {};
		} });
		const plugin = { app, registerEvent: vi.fn(), register: (callback: () => void) => { cleanup = callback; } } as unknown as Plugin;
		const repair = vi.fn(async (target: TFile) => { await runCaptionTiming(app, target, "Transcript"); });
		registerCaptionTimingRepair(plugin, () => "Transcript", repair);
		return { events, ready, cleanup, repair, activate: (target: TFile | null) => { active = target; } };
	}

	it("offers repair for a restored untimed note without downloading or writing before consent, once per source per session", async () => {
		vi.mocked(askNoteDecision).mockResolvedValue("cancel");
		const watcher = openingWatcher();
		watcher.ready();
		await vi.waitFor(() => expect(askNoteDecision).toHaveBeenCalledOnce());
		expect(askNoteDecision).toHaveBeenCalledWith(app, "Transcript timing needs repair",
			expect.stringContaining("Sentence timestamps may repeat or be inaccurate"), [
				{ label: "Redownload transcript", value: "create", cta: true },
				{ label: "Cancel", value: "cancel" },
			]);
		watcher.events.get("file-open")!(file);
		watcher.events.get("metadata-changed")!(file);
		await Promise.resolve();
		expect(watcher.repair).toHaveBeenCalledOnce();
		expect(fetchYouTubeCaptions).not.toHaveBeenCalled();
		expect(app.vault.process).not.toHaveBeenCalled();
	});

	it("waits for headings after file-open and offers repair once metadata becomes available", async () => {
		vi.mocked(askNoteDecision).mockResolvedValue("cancel");
		const original = app.metadataCache.getFileCache;
		vi.spyOn(app.metadataCache, "getFileCache").mockReturnValueOnce(null);
		const watcher = openingWatcher();
		watcher.events.get("file-open")!(file);
		await vi.waitFor(() => expect(app.metadataCache.getFileCache).toHaveBeenCalledOnce());
		expect(watcher.repair).not.toHaveBeenCalled();
		vi.mocked(app.metadataCache.getFileCache).mockImplementation(original);
		watcher.events.get("metadata-changed")!(file);
		await vi.waitFor(() => expect(watcher.repair).toHaveBeenCalledOnce());
	});

	it("does not warn for saved native or legacy acoustic timings, unrelated notes, or a note left during the read", async () => {
		await runCaptionTiming(app, file, "Transcript");
		vi.mocked(askNoteDecision).mockClear();
		const watcher = openingWatcher();
		watcher.ready();
		await Promise.resolve();
		expect(watcher.repair).not.toHaveBeenCalled();
		body = '# Transcript\n[0:21](https://youtu.be/abcdefghijk?t=21 "21-30") We left. We stayed.\n';
		frontmatter.whisperx_transcript = cacheForTest();
		watcher.events.get("file-open")!(file);
		await Promise.resolve();
		expect(watcher.repair).not.toHaveBeenCalled();
		delete frontmatter.whisperx_transcript;
		body = "# Summary\nNo transcript here.\n";
		watcher.events.get("file-open")!(file);
		await Promise.resolve();
		expect(watcher.repair).not.toHaveBeenCalled();
		body = "# Transcript\n[0:00](https://youtu.be/abcdefghijk?t=0) Old blocks.\n";
		watcher.events.get("file-open")!(file);
		watcher.activate(null);
		await Promise.resolve();
		expect(watcher.repair).not.toHaveBeenCalled();
		expect(askNoteDecision).not.toHaveBeenCalled();
	});

	it("stops a pending opening check when the plugin unloads", async () => {
		const watcher = openingWatcher();
		watcher.ready();
		watcher.cleanup();
		await Promise.resolve();
		expect(watcher.repair).not.toHaveBeenCalled();
	});

	it("offers repair when an already-cached note becomes active after file-open", async () => {
		vi.mocked(askNoteDecision).mockResolvedValue("cancel");
		const watcher = openingWatcher();
		watcher.activate(null);
		watcher.events.get("file-open")!(file);
		await Promise.resolve();
		expect(watcher.repair).not.toHaveBeenCalled();
		watcher.activate(file);
		watcher.events.get("active-leaf-change")!(null);
		await vi.waitFor(() => expect(watcher.repair).toHaveBeenCalledOnce());
	});

	it("offers a confirmed refresh for malformed saved timing without modifying the note on cancel", async () => {
		frontmatter.whisperx_transcript = { version: 2, paddingSeconds: 0,
			sourceHash: prepareTranscript(parseStoredTranscript(body)).hash, engine: "invalid" };
		const originalBody = body;
		const originalCache = frontmatter.whisperx_transcript;
		vi.mocked(askNoteDecision).mockResolvedValue("cancel");
		const watcher = openingWatcher();
		watcher.ready();
		await vi.waitFor(() => expect(askNoteDecision).toHaveBeenCalledOnce());
		expect(body).toBe(originalBody);
		expect(frontmatter.whisperx_transcript).toBe(originalCache);
		expect(fetchYouTubeCaptions).not.toHaveBeenCalled();
		expect(app.vault.process).not.toHaveBeenCalled();
	});

	it("redownloads a legacy block into native captions after accepting the opening popup, preserving other content", async () => {
		const prefix = "# Summary\nMy summary.\n\n";
		const suffix = "\n# Notes\nMy own notes.\n";
		body = prefix + "# Transcript\n[0:21](https://youtu.be/abcdefghijk?t=21) We left. We stayed.\n" + suffix;
		vi.mocked(fetchYouTubeCaptions).mockResolvedValueOnce({
			language: "en", lines: [
				{ offset: 21050, duration: 3000, text: "We left.", wordStarts: [21050, 21550] },
				{ offset: 25550, duration: 5000, text: "We stayed.", wordStarts: [25550, 26150] },
			],
		});
		const watcher = openingWatcher();
		watcher.ready();
		await vi.waitFor(() => expect(app.vault.process).toHaveBeenCalledOnce());
		const prepared = prepareTranscript(parseStoredTranscript(body.slice(prefix.length, -suffix.length)));
		expect(prepared.lines.map(({ startSec, endSec }) => ({ startSec, endSec })))
			.toEqual([{ startSec: 21.05, endSec: 24.05 }, { startSec: 25.55, endSec: 30.55 }]);
		expect(readInlineTimings(prepared)?.words).toEqual([[21.05, null, null], [21.55, null, null], [25.55, null, null], [26.15, null, null]]);
		expect(body.startsWith(prefix)).toBe(true);
		expect(body.endsWith(suffix)).toBe(true);
		expect(frontmatter).toEqual({ title: "Keep me" });
		expect(askNoteDecision).toHaveBeenCalledOnce();
		expect(fetchYouTubeCaptions).toHaveBeenCalledOnce();
	});

	it("fetches JSON3 once and persists native starts and language without acoustic setup", async () => {
		await runCaptionTiming(app, file, "Transcript");
		const prepared = prepareTranscript(parseStoredTranscript(body));
		expect(prepared.language).toBe("en");
		expect(readInlineTimings(prepared)?.words).toEqual([[21, null, null], null, [25, null, null], null]);
		expect(fetchYouTubeCaptions).toHaveBeenCalledOnce();
		expect(frontmatter).toEqual({ title: "Keep me" });
		expect(createdNotices.at(-1)?.message).toContain("No audio or model downloads");
	});

	it("reuses compact results offline and migrates legacy acoustic caches without discarding timings", async () => {
		const legacy = cacheForTest();
		frontmatter.whisperx_transcript = legacy;
		await runCaptionTiming(app, file, "Transcript");
		expect(frontmatter.whisperx_transcript).toBeUndefined();
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(body)))?.words).toEqual(legacy.words);
		expect(body).not.toContain("saver-transcript-language");
		await runCaptionTiming(app, file, "Transcript");
		expect(fetchYouTubeCaptions).not.toHaveBeenCalled();
		expect(askNoteDecision).not.toHaveBeenCalled();
	});

	it.each(["cancel", "overwrite"] as const)("requires an explicit decision before replacing different wording (%s)", async (choice) => {
		const prefix = "# Summary\nWritten content stays here.\n\n";
		const suffix = "\n# Notes\nMy comments.\n";
		body = prefix + body + suffix;
		const original = body;
		vi.mocked(fetchYouTubeCaptions).mockResolvedValueOnce({
			language: "fr", lines: [{ offset: 0, duration: 12000, text: "Une nouvelle transcription.", wordStarts: [0, null, null] }],
		});
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce(choice);
		const result = await runCaptionTiming(app, file, "Transcript");
		if (choice === "cancel") {
			expect(result).toBeNull();
			expect(body).toBe(original);
			expect(app.vault.process).not.toHaveBeenCalled();
		} else {
			expect(body.startsWith(prefix)).toBe(true);
			expect(body.endsWith(suffix)).toBe(true);
			expect(body).toContain("Une nouvelle transcription.");
			const prepared = prepareTranscript(parseStoredTranscript(body.slice(prefix.length, -suffix.length)));
			expect(prepared.language).toBe("fr");
			expect(readInlineTimings(prepared)).not.toBeNull();
			expect(frontmatter.title).toBe("Keep me");
		}
		expect(fetchYouTubeCaptions).toHaveBeenCalledOnce();
	});

	it("offers replacement when words match but native times do not fit stored cue bounds", async () => {
		body = body.replace('"21-30"', '"21-24"');
		const original = body;
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("cancel");
		expect(await runCaptionTiming(app, file, "Transcript")).toBeNull();
		expect(askNoteDecision).toHaveBeenCalledTimes(2);
		expect(body).toBe(original);
	});

	it("does not map timestamps onto different words even when word counts match", async () => {
		body = body.replace("stayed", "waited");
		const original = body;
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("cancel");
		expect(await runCaptionTiming(app, file, "Transcript")).toBeNull();
		expect(askNoteDecision).toHaveBeenCalledTimes(2);
		expect(body).toBe(original);
		expect(app.vault.process).not.toHaveBeenCalled();
	});

	it("retains a verified compact copy and the legacy property if cleanup fails, then retries offline", async () => {
		const legacy = cacheForTest();
		frontmatter.whisperx_transcript = legacy;
		vi.mocked(app.fileManager.processFrontMatter).mockRejectedValueOnce(new Error("Cleanup failed"));
		await expect(runCaptionTiming(app, file, "Transcript")).rejects.toThrow("Cleanup failed");
		expect(frontmatter.whisperx_transcript).toEqual(legacy);
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(body)))?.words).toEqual(legacy.words);
		await runCaptionTiming(app, file, "Transcript");
		expect(frontmatter.whisperx_transcript).toBeUndefined();
		expect(fetchYouTubeCaptions).not.toHaveBeenCalled();
	});

	it("recovers an unrecognized format only with a transcript heading, note URL and explicit replacement", async () => {
		body = "# Transcript\nOld unrecognized text.\n";
		frontmatter.url = "https://youtu.be/abcdefghijk";
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("overwrite");
		await runCaptionTiming(app, file, "Transcript");
		expect(body).not.toContain("Old unrecognized text");
		expect(body).toContain("; w=");
		expect(askNoteDecision).toHaveBeenLastCalledWith(app, "Transcript differs from YouTube captions",
			expect.stringContaining("Stored word count unavailable"), expect.any(Array));
	});

	it("does not fetch or write after declined consent or cancellation, and preserves text on download failure", async () => {
		const original = body;
		vi.mocked(askNoteDecision).mockResolvedValueOnce("cancel");
		expect(await runCaptionTiming(app, file, "Transcript")).toBeNull();
		const controller = new AbortController();
		controller.abort();
		await expect(runCaptionTiming(app, file, "Transcript", { signal: controller.signal })).rejects.toThrow("cancelled");
		expect(fetchYouTubeCaptions).not.toHaveBeenCalled();
		vi.mocked(fetchYouTubeCaptions).mockRejectedValueOnce(new Error("Download failed"));
		await expect(runCaptionTiming(app, file, "Transcript")).rejects.toThrow("Download failed");
		expect(body).toBe(original);
		expect(app.vault.process).not.toHaveBeenCalled();
	});

	it("rejects concurrent edits and stops a cancelled request before saving", async () => {
		const value = await vi.mocked(fetchYouTubeCaptions).getMockImplementation()!("");
		vi.mocked(fetchYouTubeCaptions).mockImplementationOnce(async () => {
			body += "\nEdited while fetching.\n";
			return value;
		});
		await expect(runCaptionTiming(app, file, "Transcript")).rejects.toThrow("body changed");
		const controller = new AbortController();
		vi.mocked(fetchYouTubeCaptions).mockImplementationOnce(async () => {
			controller.abort();
			return value;
		});
		await expect(runCaptionTiming(app, file, "Transcript", { signal: controller.signal })).rejects.toThrow("cancelled");
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
		expect(readInlineTimings(prepareTranscript(parseStoredTranscript(body)))).toBeNull();
	});

	it("prevents concurrent timing runs from applying competing results", async () => {
		const value = await vi.mocked(fetchYouTubeCaptions).getMockImplementation()!("");
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		vi.mocked(fetchYouTubeCaptions).mockImplementationOnce(async () => { await waiting; return value; });
		const first = runCaptionTiming(app, file, "Transcript");
		await vi.waitFor(() => expect(fetchYouTubeCaptions).toHaveBeenCalledOnce());
		await expect(runCaptionTiming(app, file, "Transcript")).rejects.toThrow("already running");
		release();
		await first;
		expect(app.vault.process).toHaveBeenCalledOnce();
	});
});
