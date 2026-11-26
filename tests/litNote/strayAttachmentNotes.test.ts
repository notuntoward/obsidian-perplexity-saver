import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import { createdNotices } from "../__mocks__/obsidian";

const ask = vi.hoisted(() => vi.fn());
vi.mock("../../src/litNote/decisionModal", () => ({ askNoteDecision: ask }));

import { findStrayAttachmentNotes, isStrayAttachmentNote, offerStrayAttachmentNoteCleanup } from "../../src/litNote/strayAttachmentNotes";

describe("empty notes created from broken attachment links", () => {
	it.each([
		["paper.html.md", "", true],
		["paper.pdf.md", "---\ncreated_date: 2026-08-19T21:25:36\nmodified date: 2026-10-13T15:45:46\n---\n", true],
		["paper.pdf.md", "---\ncreated: 2026-08-19\n---\nMy notes.\n", false],
		["paper.pdf.md", "---\ntags:\n  - reading\n---\n", false],
		["paper.md", "", false],
	])("classifies %s", (name, content, expected) => {
		expect(isStrayAttachmentNote(name, content)).toBe(expected);
	});

	it("explains, asks, and trashes only notes that are still empty", async () => {
		const files = ["lit/a.html.md", "lit/b.pdf.md", "lit/paper.md"].map((path) =>
			Object.assign(new TFile(), { path, name: path.split("/").pop() }));
		const contents: Record<string, string> = { "lit/a.html.md": "", "lit/b.pdf.md": "", "lit/paper.md": "" };
		const trashFile = vi.fn(async () => {});
		const app = {
			vault: {
				getMarkdownFiles: () => files,
				cachedRead: async (file: TFile) => contents[file.path],
				read: async (file: TFile) => contents[file.path],
				getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
			},
			metadataCache: { resolvedLinks: { "lit/paper.md": { "lit/a.html.md": 1 } } },
			fileManager: { trashFile },
		} as unknown as App;
		const found = await findStrayAttachmentNotes(app);
		expect(found.map((file) => file.path)).toEqual(["lit/a.html.md", "lit/b.pdf.md"]);
		ask.mockImplementationOnce(async () => {
			contents["lit/b.pdf.md"] = "Typed while the dialog was open.";
			return "create";
		});
		await offerStrayAttachmentNoteCleanup(app, found);
		const message = ask.mock.calls[0][2] as string;
		expect(message).toContain("Obsidian creates an empty note named paper.pdf.md");
		expect(message).toContain("- lit/a.html.md (linked from lit/paper.md)");
		expect(trashFile).toHaveBeenCalledTimes(1);
		expect(trashFile).toHaveBeenCalledWith(files[0]);
		expect(createdNotices.at(-1)?.message).toContain("Moved 1 empty note to trash. Kept 1 that changed");
	});

	it("changes nothing when the user keeps the notes", async () => {
		const file = Object.assign(new TFile(), { path: "a.pdf.md", name: "a.pdf.md" });
		const trashFile = vi.fn();
		const app = { metadataCache: { resolvedLinks: {} }, fileManager: { trashFile } } as unknown as App;
		ask.mockResolvedValueOnce("cancel");
		await offerStrayAttachmentNoteCleanup(app, [file]);
		expect(trashFile).not.toHaveBeenCalled();
	});
});
