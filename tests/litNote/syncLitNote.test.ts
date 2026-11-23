import { afterEach, describe, expect, it, vi } from "vitest";
import { App, FileSystemAdapter, TFile } from "obsidian";
import { mkdtemp, rmdir, stat, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { syncLitNote } from "../../src/litNote/syncLitNote";
import { createdNotices } from "../__mocks__/obsidian";
import type { ZoteroItemPayload } from "../../src/litNote/types";
import type { AttachmentReviewRow, DecisionButton, NoteDecision } from "../../src/litNote/decisionModal";

function accept() {
	return vi.fn(async (_title: string, _message: string, buttons: DecisionButton[], review?: AttachmentReviewRow[]): Promise<NoteDecision> =>
		review ? `review:${JSON.stringify(review.map((row) => row.kind === "note" ? "remove" : row.defaultValue))}`
			: buttons.find((button) => ["use-zotero", "create"].includes(button.value))?.value ?? "cancel");
}

function fixture(legacy = false) {
	const base = path.resolve("test-vault");
	const file = Object.assign(new TFile(), {
		path: "lit/old.md", basename: "old", extension: "md", parent: { path: "lit" },
	});
	const attachment = Object.assign(new TFile(), {
		path: "attachments/new.pdf", basename: "new", extension: "pdf",
	});
	const fm: Record<string, unknown> = {
		category: ["literaturenote"], citekey: "old", zotero_item_key: "ABC",
		...(legacy ? {} : { zotero_library_uri: "http://zotero.org/users/1" }),
		title: "Old title", aliases: ["Old title", "OLD TITLE", "Personal alias"],
		tags: ["personal"], read: true, created_date: "original",
	};
	let body = `> [!info]- &nbsp;[**Zotero**](zotero://select/library/items/ABC)${legacy ? " | **[[old.pdf|PDF]]**" : "<!-- zotero-attachments:start --> | **[[old.pdf|PDF]]**<!-- zotero-attachments:end -->"}\n\nPersonal notes.\n`;
	let references: unknown[] = [];
	const app = {
		metadataCache: {
			getFileCache: () => ({ frontmatter: fm, links: references }),
			getFirstLinkpathDest: (link: string) => link === attachment.path ? attachment : null,
			resolvedLinks: {},
		},
		vault: {
			adapter: Object.assign(new FileSystemAdapter(), {
				getBasePath: () => base,
				stat: async () => ({ type: "file", size: 0, mtime: 0, ctime: 0 }),
			}),
			getAbstractFileByPath: (p: string) => p === attachment.path ? attachment : p === file.path ? file : null,
			getMarkdownFiles: () => [file],
			read: async () => body,
			process: async (_file: TFile, fn: (text: string) => string) => { body = fn(body); },
		},
		fileManager: {
			generateMarkdownLink: (_file: TFile, _source: string, subpath: string, display: string) => `[[attachments/new.pdf${subpath}|${display}]]`,
			processFrontMatter: async (_file: TFile, fn: (frontmatter: Record<string, unknown>) => void) => fn(fm),
			renameFile: async (_file: TFile, target: string) => { file.path = target; },
		},
	} as unknown as App;
	const item: ZoteroItemPayload = {
		title: "New title", citekey: "new", itemkey: "ABC",
		libraryURI: "http://zotero.org/users/1",
		citationKeyCheck: { citekey: "old", matches: [] },
		attachments: [{ isFile: true, path: path.join(base, "attachments", "new.pdf") }],
	};
	function addBodyLink(original: string, link: string): void {
		const start = body.length;
		const line = body.split("\n").length - 1;
		body += original;
		references = [{
			original, link, displayText: "Read", position: {
				start: { offset: start, line, col: 0 },
				end: { offset: start + original.length, line, col: original.length },
			},
		}];
	}
	function addHeaderLink(original: string, link: string): void {
		const start = body.indexOf("\n");
		body = body.slice(0, start) + original + body.slice(start);
		references = [{
			original, link, displayText: "Read", position: {
				start: { offset: start, line: 0, col: start },
				end: { offset: start + original.length, line: 0, col: start + original.length },
			},
		}];
	}
	return { app, file, fm, item, getBody: () => body, addBodyLink, addHeaderLink };
}

const temporaryAttachmentFolders: string[] = [];
afterEach(async () => {
	for (const folder of temporaryAttachmentFolders.splice(0)) {
		await unlink(path.join(folder, "old.pdf"));
		await unlink(path.join(folder, "new.pdf"));
		await rmdir(folder);
	}
});

async function setUpIdenticalAttachments(f: ReturnType<typeof fixture>): Promise<string> {
	const folder = await mkdtemp(path.join(tmpdir(), "lit-sync-test-"));
	temporaryAttachmentFolders.push(folder);
	await writeFile(path.join(folder, "old.pdf"), "same");
	await writeFile(path.join(folder, "new.pdf"), "same");
	const old = Object.assign(new TFile(), { path: "attachments/old.pdf", extension: "pdf" });
	const lookup = f.app.metadataCache.getFirstLinkpathDest;
	f.app.metadataCache.getFirstLinkpathDest = (link, source) => link === "old.pdf" ? old : lookup(link, source);
	const adapter = f.app.vault.adapter as FileSystemAdapter;
	adapter.getFullPath = (filePath) => path.join(folder, path.basename(filePath));
	adapter.stat = async (filePath) => {
		const info = await stat(adapter.getFullPath(filePath));
		return { type: "file", size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs };
	};
	return folder;
}

describe("literature note reconciliation", () => {
	it("updates key and attachment links without changing personal content or metadata", async () => {
		const f = fixture();
		const confirm = accept();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", confirm);
		expect(result.status).toBe("updated");
		expect(confirm.mock.calls.map((call) => call[0])).toEqual([
			"Citekeys differ", "Attachment links differ", "Review attachment links", "Update literature note",
		]);
		expect(f.file.path).toBe("lit/new.md");
		expect(f.fm.citekey).toBe("new");
		expect(f.fm.title).toBe("Old title");
		expect(f.fm.tags).toEqual(["personal"]);
		expect(f.fm.created_date).toBe("original");
		expect(f.getBody()).toContain("**[[attachments/new.pdf|PDF]]**");
		expect(f.getBody()).toContain("Personal notes.");
	});

	it("previews metadata changes and preserves unique existing aliases", async () => {
		const f = fixture();
		f.fm.doi = "10.1/old";
		const confirm = accept();
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "metadata", confirm);
		const preview = confirm.mock.calls.find((call) => call[0] === "Update literature note")?.[1];
		expect(preview).toContain("title:");
		expect(preview).toContain("doi:");
		expect(preview).toContain("alias that is removed or changed");
		expect(f.fm.title).toBe("New title");
		expect(f.fm.doi).toBeUndefined();
		expect(f.fm.aliases).toEqual(["New title", "Old title", "Personal alias"]);
		expect(f.fm.read).toBe(true);
	});

	it("removes managed attachment links when Zotero has no attachments", async () => {
		const f = fixture();
		f.item.attachments = [];
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(result.status).toBe("updated");
		expect(f.getBody()).not.toContain("[[old.pdf|PDF]]");
		expect(f.getBody()).toContain("<!-- zotero-attachments:start --><!-- zotero-attachments:end -->");
		expect(f.getBody()).toContain("Personal notes.");
	});

	it("does not associate a legacy note without confirmation", async () => {
		const f = fixture(true);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn().mockResolvedValue("cancel"));
		expect(result.status).toBe("skipped");
		expect(f.file.path).toBe("lit/old.md");
		expect(f.fm.zotero_library_uri).toBeUndefined();
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
	});

	it("requires explicit confirmation to reassociate a changed library identity", async () => {
		const f = fixture();
		f.item.libraryURI = "http://zotero.org/users/2";
		const confirm = vi.fn().mockResolvedValue("cancel");
		const automatic = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", confirm);
		expect(automatic.status).toBe("missing");
		const manual = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "metadata", confirm);
		expect(manual.status).toBe("skipped");
		expect(confirm.mock.calls[0][1]).toContain("different Zotero library");
		expect(f.fm.zotero_library_uri).toBe("http://zotero.org/users/1");
		const accepted = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "metadata", accept());
		expect(accepted.status).toBe("updated");
		expect(f.fm.zotero_library_uri).toBe("http://zotero.org/users/2");
	});

	it("reports a destination collision without changing the note", async () => {
		const f = fixture();
		const original = f.app.vault.getAbstractFileByPath;
		f.app.vault.getAbstractFileByPath = vi.fn((p: string) =>
			p === "lit/new.md" ? Object.assign(new TFile(), { path: p }) : original.call(f.app.vault, p)
		);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(result.status).toBe("error");
		expect(result.error).toContain("already exists");
		expect(f.fm.citekey).toBe("old");
	});

	it("preserves existing links and metadata when an attachment is unavailable", async () => {
		const f = fixture();
		f.item.attachments = [{ isFile: true, path: path.resolve("outside-vault", "new.pdf") }];
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(result.status).toBe("error");
		expect(f.file.path).toBe("lit/old.md");
		expect(f.fm.citekey).toBe("old");
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
	});

	it("refuses ambiguous duplicate notes for the same Zotero item", async () => {
		const f = fixture();
		const duplicate = Object.assign(new TFile(), {
			path: "lit/duplicate.md", basename: "duplicate", extension: "md", parent: { path: "lit" },
		});
		f.app.vault.getMarkdownFiles = vi.fn(() => [f.file, duplicate]);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(result.status).toBe("error");
		expect(result.error).toContain("More than one");
		expect(f.fm.citekey).toBe("old");
	});

	it("reports a partial failure and can retry when a header write fails", async () => {
		const f = fixture();
		const process = f.app.vault.process;
		f.app.vault.process = vi.fn().mockRejectedValueOnce(new Error("write failed")).mockImplementation(process);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(result.error).toContain("partial");
		expect(f.file.path).toBe("lit/old.md");
		const retry = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(retry.status).toBe("updated");
		expect(f.file.path).toBe("lit/new.md");
		expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
	});

	it("asks before changing Zotero and returns the selected note key without modifying the note", async () => {
		const f = fixture();
		const prompt = vi.fn().mockResolvedValue("use-obsidian");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result).toMatchObject({ status: "set-zotero-key", noteCitekey: "old", expectedZoteroKey: "new" });
		expect(prompt.mock.calls[0][4]).toMatchObject({
			noteCitekey: "old", zoteroCitekey: "new", itemkey: "ABC", notePath: "lit/old.md",
		});
		expect(prompt.mock.calls[0][1]).toContain("Search Zotero for the item key");
		expect(prompt.mock.calls[0][1]).toContain("Zotero changes now");
		expect(prompt.mock.calls[0][1]).toContain("later cancellation won't undo it");
		expect(prompt.mock.calls[0][1]).not.toContain("Other Zotero items");
		expect(f.file.path).toBe("lit/old.md");
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
	});

	it("does not request a Zotero key change if the selected note filename is occupied", async () => {
		const f = fixture();
		f.fm.citekey = "chosen";
		f.item.citationKeyCheck = { citekey: "chosen", matches: [] };
		const original = f.app.vault.getAbstractFileByPath;
		f.app.vault.getAbstractFileByPath = vi.fn((p: string) =>
			p === "lit/chosen.md" ? Object.assign(new TFile(), { path: p }) : original.call(f.app.vault, p)
		);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn().mockResolvedValue("use-obsidian"));
		expect(result.status).toBe("error");
		expect(result.error).toContain("Zotero was not changed");
		expect(f.file.path).toBe("lit/old.md");
	});

	it("shows actual matching Zotero items and identifies an older note's missing library", async () => {
		const f = fixture(true);
		f.item.libraryName = "My Zotero Library";
		f.item.citationKeyCheck = {
			citekey: "old",
			matches: [{ title: "Other work", citekey: "old", libraryURI: "other", itemkey: "OTHER" }],
		};
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(prompt.mock.calls[0][1]).toContain("Other work (old; another library)");
		expect(prompt.mock.calls[0][1]).toContain("The note doesn't record its Zotero library");
		expect(prompt.mock.calls[0][1]).toContain("My Zotero Library");
		expect(prompt.mock.calls[0][2].map((button: DecisionButton) => button.label)).toEqual([
			"Use Obsidian citekey", "Use Zotero citekey", "Cancel",
		]);
	});

	it("does not present a choice when the duplicate check is absent or stale", async () => {
		const f = fixture();
		f.item.citationKeyCheck = { citekey: "stale", matches: [] };
		const prompt = vi.fn();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("error");
		expect(result.error).toContain("Could not verify");
		expect(prompt).not.toHaveBeenCalled();
		expect(f.fm.citekey).toBe("old");
	});

	it("does not mutate the note during preparation and rejects a stale note at apply time", async () => {
		const f = fixture();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept(), { prepareOnly: true });
		expect(prepared.status).toBe("prepared");
		expect(f.fm.citekey).toBe("old");
		expect(f.file.path).toBe("lit/old.md");
		f.addBodyLink("[[personal.pdf|Read]]", "personal.pdf");
		const applied = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept(), {
			expectedContent: prepared.snapshot,
		});
		expect(applied.status).toBe("error");
		expect(applied.error).toContain("changed while the update was pending");
		expect(f.fm.citekey).toBe("old");
	});

	it("cancels a key mismatch without changing either the note or its links", async () => {
		const f = fixture();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn().mockResolvedValue("cancel"));
		expect(result.status).toBe("skipped");
		expect(f.fm.citekey).toBe("old");
		expect(f.file.path).toBe("lit/old.md");
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
	});

	it("preserves a selected note-only link and explicitly reports unresolved differences", async () => {
		const f = fixture();
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) =>
			review ? `review:${JSON.stringify(review.map((row) => row.defaultValue))}`
				: title === "Citekeys differ" ? "use-zotero" : "create");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("error");
		expect(result.error).toContain("attachment differences remain");
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
		expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
	});

	it("warns about indexed backlinks without pretending to know the link-update setting", async () => {
		const f = fixture();
		f.app.metadataCache.resolvedLinks = { "other.md": { "lit/old.md": 1 } };
		const prompt = accept();
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const preview = prompt.mock.calls.find((call) => call[0] === "Update literature note")?.[1];
		expect(preview).toContain("1 indexed note");
		expect(preview).toContain("does not expose whether automatic link updates are enabled");
	});

	it("rejects frontmatter changed while the user is deciding", async () => {
		const f = fixture();
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) => {
			if (title === "Update literature note") {
				f.fm.citekey = "changed";
				return "create";
			}
			return review ? `review:${JSON.stringify(review.map((row) => row.kind === "note" ? "remove" : row.defaultValue))}`
				: title === "Citekeys differ" ? "use-zotero" : "create";
		});
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("error");
		expect(result.error).toContain("changed while the update was pending");
		expect(f.file.path).toBe("lit/old.md");
	});

	it("reconciles an indexed attachment link elsewhere in the note only when selected", async () => {
		const f = fixture();
		f.addBodyLink("[[old.pdf|Read]]", "old.pdf");
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) =>
			review ? `review:${JSON.stringify(review.map((row) => row.kind === "note" ? "remove" : row.kind === "body" ? "0" : row.defaultValue))}`
				: title === "Citekeys differ" ? "use-zotero" : "create");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("updated");
		expect(f.getBody()).not.toContain("[[old.pdf|Read]]");
		expect(f.getBody()).toContain("Personal notes.\n[[attachments/new.pdf|Read]]");
	});

	it("includes resolvable attachment candidates in the review", async () => {
		const f = fixture();
		f.addBodyLink("[[old.pdf|Read]]", "old.pdf");
		const prompt = accept();
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const review = prompt.mock.calls.find((call) => call[3])?.[3];
		expect(review?.find((row) => row.kind === "add")?.files).toEqual([
			{ path: "attachments/new.pdf", modified: undefined, role: "Zotero attachment" },
		]);
		expect(review?.find((row) => row.kind === "body")?.files).toEqual([
			{ path: "attachments/new.pdf", modified: undefined, role: "Zotero attachment" },
		]);
		expect(review?.find((row) => row.kind === "body")?.label).toBe("Another note link to old.pdf");
	});

	it("leaves an unrelated PDF link alone instead of offering a Zotero attachment as its replacement", async () => {
		const f = fixture();
		const unrelated = Object.assign(new TFile(), { path: "lit/lit_sources/Jas20.pdf", extension: "pdf" });
		const lookup = f.app.metadataCache.getFirstLinkpathDest;
		f.app.metadataCache.getFirstLinkpathDest = (link, source) =>
			link === "Jas20.pdf" ? unrelated : lookup(link, source);
		f.addBodyLink("[[Jas20.pdf|Poisson GLM regression model]]", "Jas20.pdf");
		const prompt = accept();
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const review = prompt.mock.calls.find((call) => call[3])?.[3];
		expect(review?.some((row) => row.kind === "body")).toBe(false);
		expect(f.getBody()).toContain("[[Jas20.pdf|Poisson GLM regression model]]");
	});

	it("selects an identical Zotero attachment without an attachment-choice prompt", async () => {
		const f = fixture();
		f.item.citekey = "old";
		await setUpIdenticalAttachments(f);
		const prompt = accept();
		const before = f.getBody();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		expect(prepared.status).toBe("prepared");
		expect(prepared.identicalAttachments).toHaveLength(1);
		expect(prompt).not.toHaveBeenCalled();
		expect(f.getBody()).toBe(before);
		const check = vi.fn();
		const trash = vi.fn(async () => {});
		const applied = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, {
			expectedContent: before, expectedIdenticalAttachments: prepared.identicalAttachments,
			beforeApply: check, trashIdenticalAttachments: trash,
		});
		expect(applied.status).toBe("updated");
		expect(check).toHaveBeenCalledOnce();
		expect(trash).toHaveBeenCalledWith(prepared.identicalAttachments, "lit/old.md");
		expect(f.getBody()).toContain("**[[attachments/new.pdf|PDF]]**");
		expect(f.getBody()).not.toContain("**[[old.pdf|PDF]]**");
		expect(createdNotices.at(-1)?.message).toContain("old.pdf → attachments/new.pdf");
	});

	it("rejects an identical attachment plan if file contents change before applying", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const folder = await setUpIdenticalAttachments(f);
		const prompt = accept();
		const before = f.getBody();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		await writeFile(path.join(folder, "old.pdf"), "diff");
		const trash = vi.fn(async () => {});
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, {
			expectedContent: before, expectedIdenticalAttachments: prepared.identicalAttachments,
			beforeApply: vi.fn(), trashIdenticalAttachments: trash,
		});
		expect(result.status).toBe("error");
		expect(result.error).toContain("Attachment files changed");
		expect(f.getBody()).toBe(before);
		expect(trash).not.toHaveBeenCalled();
	});

	it("retargets indexed note links to the identical survivor, preserving the subpath and label", async () => {
		const f = fixture();
		f.item.citekey = "old";
		await setUpIdenticalAttachments(f);
		f.addBodyLink("[[old.pdf#page=2|Read]]", "old.pdf#page=2");
		const prompt = accept();
		const before = f.getBody();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, {
			expectedContent: before, expectedIdenticalAttachments: prepared.identicalAttachments,
			beforeApply: vi.fn(), trashIdenticalAttachments: vi.fn(async () => {}),
		});
		expect(result.status).toBe("updated");
		expect(f.getBody()).toContain("[[attachments/new.pdf#page=2|Read]]");
		expect(f.getBody()).not.toContain("[[old.pdf#page=2|Read]]");
	});

	it("reports a partial update if duplicate cleanup fails after the note was written", async () => {
		const f = fixture();
		f.item.citekey = "old";
		await setUpIdenticalAttachments(f);
		const prompt = accept();
		const before = f.getBody();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, {
			expectedContent: before, expectedIdenticalAttachments: prepared.identicalAttachments,
			beforeApply: vi.fn(), trashIdenticalAttachments: vi.fn(async () => { throw new Error("Trash unavailable"); }),
		});
		expect(result.status).toBe("error");
		expect(result.error).toContain("Update may be partial");
		expect(result.error).toContain("Trash unavailable");
		expect(f.getBody()).toContain("**[[attachments/new.pdf|PDF]]**");
	});

	it("preserves a body attachment link if the user keeps it and reports it as unresolved", async () => {
		const f = fixture();
		f.addBodyLink("[[old.pdf|Read]]", "old.pdf");
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) =>
			review ? `review:${JSON.stringify(review.map((row) => row.kind === "note" ? "remove" : row.defaultValue))}`
				: title === "Citekeys differ" ? "use-zotero" : "create");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("error");
		expect(result.error).toContain("[[old.pdf|Read]]");
		expect(f.getBody()).toContain("[[old.pdf|Read]]");
	});

	it("leaves an unrelated link in the info header unchanged", async () => {
		const f = fixture();
		f.addHeaderLink("[[outside.pdf|Read]]", "outside.pdf");
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) =>
			review ? `review:${JSON.stringify(review.map((row) => row.kind === "note" ? "remove" : row.kind === "body" ? "0" : row.defaultValue))}`
				: title === "Citekeys differ" ? "use-zotero" : "create");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("updated");
		expect(prompt.mock.calls.find((call) => call[3])?.[3]?.some((row) => row.kind === "body")).toBe(false);
		expect(f.getBody()).toContain("[[outside.pdf|Read]]");
		expect(f.getBody()).not.toContain("[[attachments/new.pdf|Read]]");
	});

	it("shows Zotero changes and new attachments separately, and leaves the note untouched on cancel", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.item.zoteroChanges = {
			previousCitekey: "previous",
			attachmentMoves: [{ itemkey: "ATT1", from: "before.pdf", to: "after.pdf" }],
		};
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) => {
			if (review) {
				expect(review.some((row) => row.kind === "zotero" && row.label.includes("before.pdf → after.pdf"))).toBe(true);
				expect(review.some((row) => row.kind === "add" && row.label.includes("new.pdf"))).toBe(true);
				return `review:${JSON.stringify(review.map((row) => row.defaultValue))}`;
			}
			return title === "Update literature note" ? "cancel" : "create";
		});
		const before = f.getBody();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const preview = prompt.mock.calls.find((call) => call[0] === "Update literature note")?.[1];
		expect(preview).toContain("Already changed in Zotero");
		expect(preview).toContain("previous → old");
		expect(preview).toContain("Cancel leaves the Zotero changes in place");
		expect(result.status).toBe("skipped");
		expect(f.getBody()).toBe(before);
		expect(f.fm.citekey).toBe("old");
	});

	it("rejects malformed or unavailable attachment choices without modifying the note", async () => {
		const f = fixture();
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) =>
			review ? 'review:["delete-everything"]' : title === "Citekeys differ" ? "use-zotero" : "create");
		const before = f.getBody();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("error");
		expect(result.error).toContain("attachment review");
		expect(f.getBody()).toBe(before);
		expect(f.fm.citekey).toBe("old");
	});
});
