// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createdNotices, installEditorDomHelpers, TFile } from "../__mocks__/obsidian";
import type { App } from "obsidian";

const decision = vi.hoisted(() => ({ value: "rename" as string }));
vi.mock("../../src/litNote/decisionModal", () => ({
	askNoteDecision: vi.fn(async () => decision.value),
}));

import { askNoteDecision } from "../../src/litNote/decisionModal";
import {
	findStrandedTranscripts,
	notifyNoTranscript,
	renameStrandedTranscriptHeadings,
	renameTranscriptHeading,
} from "../../src/litNote/transcriptHeadingRecovery";
import { headingsFromText } from "../../src/litNote/transcriptSection";

const cues = (count: number): string => Array.from({ length: count }, (_, i) =>
	`[0:0${i}](https://youtu.be/dQw4w9WgXcQ?t=${i} "${i}–${i + 1}") caption ${i}`).join("\n");

const transcriptNote = (heading: string, level = "#"): string => `---\nurl: https://youtu.be/dQw4w9WgXcQ\n---\nIntro\n\n${level} ${heading}\n\n${cues(6)}\n`;

function vaultWith(files: Record<string, string>): { app: App; read: (path: string) => string } {
	const tfiles = new Map(Object.keys(files).map((path) => [path, Object.assign(new TFile(path), { basename: path.replace(/\.md$/, "") }) as unknown as import("obsidian").TFile]));
	const app = {
		vault: {
			getMarkdownFiles: () => [...tfiles.values()],
			cachedRead: async (file: { path: string }) => files[file.path],
			process: async (file: { path: string }, fn: (content: string) => string) => {
				files[file.path] = fn(files[file.path]);
				return files[file.path];
			},
		},
		metadataCache: { getFileCache: (file: { path: string }) => ({ headings: headingsFromText(files[file.path]) }) },
	} as unknown as App;
	return { app, read: (path) => files[path] };
}

beforeAll(() => installEditorDomHelpers(document));
beforeEach(() => {
	createdNotices.length = 0;
	decision.value = "rename";
	vi.mocked(askNoteDecision).mockClear();
});

describe("findStrandedTranscripts", () => {
	it("finds notes with an unambiguous transcript under another heading and skips the rest", async () => {
		const { app } = vaultWith({
			"old.md": transcriptNote("Old captions"),
			"default.md": transcriptNote("Transcript"),
			"current.md": transcriptNote("Subtitles"),
			"ambiguous.md": `# One\n${cues(6)}\n# Two\n${cues(6)}\n`,
			"plain.md": "# Notes\nnothing\n",
		});
		const found = await findStrandedTranscripts(app, "Subtitles");
		expect(found.map((item) => [item.file.path, item.heading])).toEqual([["old.md", "Old captions"], ["default.md", "Transcript"]]);
		expect(found[0]).toMatchObject({ line: 5, cueLines: 6 });
	});
});

describe("renameTranscriptHeading", () => {
	const item = (app: App, path: string, heading: string, line: number) =>
		({ file: app.vault.getMarkdownFiles().find((f) => f.path === path)!, heading, line, cueLines: 6 });

	it("keeps the heading level, closing hashes and line endings", async () => {
		const { app, read } = vaultWith({ "a.md": "intro\r\n## Old name ##\r\n[0:01](https://youtu.be/dQw4w9WgXcQ?t=1) x\r\n" });
		expect(await renameTranscriptHeading(app, item(app, "a.md", "Old name", 1), "Transcript")).toBe(true);
		expect(read("a.md")).toBe("intro\r\n## Transcript ##\r\n[0:01](https://youtu.be/dQw4w9WgXcQ?t=1) x\r\n");
	});

	it("leaves the note untouched when the line is no longer that heading", async () => {
		const { app, read } = vaultWith({ "a.md": "new line\n# Old name\n" });
		expect(await renameTranscriptHeading(app, item(app, "a.md", "Old name", 0), "Transcript")).toBe(false);
		expect(read("a.md")).toBe("new line\n# Old name\n");
	});
});

describe("renameStrandedTranscriptHeadings", () => {
	it("previews, then renames only the heading lines", async () => {
		const files = { "old.md": transcriptNote("Old captions", "##"), "plain.md": "# Notes\n" };
		const { app, read } = vaultWith(files);
		await renameStrandedTranscriptHeadings(app, "Subtitles");
		expect(askNoteDecision).toHaveBeenCalledWith(app, expect.any(String), expect.stringContaining("old.md"), expect.any(Array));
		expect(read("old.md")).toBe(transcriptNote("Subtitles", "##"));
		expect(read("plain.md")).toBe("# Notes\n");
		expect(createdNotices.at(-1)?.message).toBe('Renamed 1 transcript heading to "Subtitles".');
	});

	it("changes nothing when cancelled", async () => {
		decision.value = "cancel";
		const { app, read } = vaultWith({ "old.md": transcriptNote("Old captions") });
		await renameStrandedTranscriptHeadings(app, "Subtitles");
		expect(read("old.md")).toBe(transcriptNote("Old captions"));
	});

	it("says so when there is nothing to rename", async () => {
		const { app } = vaultWith({ "ok.md": transcriptNote("Subtitles") });
		await renameStrandedTranscriptHeadings(app, "Subtitles");
		expect(askNoteDecision).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toContain("No notes have a transcript");
	});
});

describe("notifyNoTranscript", () => {
	const ambiguous = `# First\n${cues(6)}\n# Second\n${cues(7)}\n`;

	it("offers to rename each candidate when a note has several transcript-like sections", async () => {
		const { app, read } = vaultWith({ "n.md": ambiguous });
		await notifyNoTranscript(app, app.vault.getMarkdownFiles()[0], "Subtitles");
		const notice = createdNotices.find((n) => n.messageEl.querySelector("button"))!;
		const buttons = Array.from(notice.messageEl.querySelectorAll("button"));
		expect(notice.messageEl.textContent).toContain('No timestamped transcript under a "Subtitles" heading');
		expect(createdNotices[0].hidden).toBe(true);
		expect(buttons.map((b) => b.textContent)).toEqual(['Rename "First" to "Subtitles"', 'Rename "Second" to "Subtitles"']);
		buttons[1].click();
		await vi.waitFor(() => expect(createdNotices.at(-1)?.message).toContain("Renamed the heading"));
		expect(read("n.md")).toContain("# Subtitles\n");
		expect(read("n.md")).toContain("# First\n");
	});

	it("is a plain message when there is no candidate", async () => {
		const { app } = vaultWith({ "n.md": "# Notes\nmine\n" });
		await notifyNoTranscript(app, app.vault.getMarkdownFiles()[0], "Subtitles");
		expect(createdNotices.at(-1)?.message).toBe('No timestamped transcript under a "Subtitles" heading in n.');
		expect(createdNotices.some((n) => n.hidden)).toBe(false);
	});
});
