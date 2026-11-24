import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildAttachmentMoveCandidate } from "../../src/litNote/attachmentMove";
import type { AttachmentProblem } from "../../src/litNote/buildLitNote";
import type { ZoteroItemPayload } from "../../src/litNote/types";

let root = "";

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = "";
});

async function fixture(files: Record<string, string> = { "paper.html": "zotero copy" }) {
	root = await mkdtemp(path.join(tmpdir(), "saver-attachment-move-"));
	const vault = path.join(root, "vault");
	const base = path.join(vault, "attachments");
	const zotero = path.join(root, "zotero");
	await Promise.all([mkdir(base, { recursive: true }), mkdir(zotero)]);
	const item: ZoteroItemPayload = {
		title: "Paper",
		citekey: "Paper2024",
		itemkey: "ITEM1",
		libraryURI: "library",
		libraryType: "user",
		linkedAttachmentBaseDirectory: base,
		linkedAttachmentBaseDirectoryValidated: true,
		attachments: [],
	};
	const problems: AttachmentProblem[] = [];
	let index = 0;
	for (const [name, content] of Object.entries(files)) {
		const source = path.join(zotero, name);
		await writeFile(source, content);
		const itemkey = `ATTACH${++index}`;
		item.attachments!.push({ itemkey, path: source, mode: "stored", isFile: true });
		problems.push({
			path: source, itemkey, mode: "stored", label: "PDF",
			title: "Stored Zotero attachment has not been moved into the vault",
			problem: "Outside vault", action: "Move it",
		});
	}
	const source = (name: string): string => path.join(zotero, name);
	const inVault = async (name: string, content: string, mtime?: number): Promise<string> => {
		const target = path.join(base, name);
		await writeFile(target, content);
		if (mtime !== undefined) await utimes(target, mtime, mtime);
		return target;
	};
	return { vault, base, item, problems, source, inVault };
}

describe("buildAttachmentMoveCandidate", () => {
	it("requires a validated in-vault base directory, matching citekey and a user library", async () => {
		const f = await fixture();
		const links = [{ extension: ".html" }];
		expect(await buildAttachmentMoveCandidate(f.item, "Paper2024", links, f.problems, f.vault)).toMatchObject({
			baseDirectory: f.base,
			attachments: [{ itemkey: "ATTACH1", resolution: "move", sourcePath: f.source("paper.html"), destinationPath: path.join(f.base, "Paper2024.html") }],
		});
		const reasons: string[] = [];
		const explain = (reason: string) => reasons.push(reason);
		expect(await buildAttachmentMoveCandidate({ ...f.item, linkedAttachmentBaseDirectoryValidated: false }, "Paper2024", links, f.problems, f.vault, explain)).toBeUndefined();
		expect(await buildAttachmentMoveCandidate(f.item, "Other2024", links, f.problems, f.vault, explain)).toBeUndefined();
		expect(await buildAttachmentMoveCandidate({ ...f.item, libraryType: "group" }, "Paper2024", links, f.problems, f.vault, explain)).toBeUndefined();
		expect(reasons).toEqual([
			expect.stringContaining("has not yet confirmed its Linked Attachment Base Directory"),
			expect.stringContaining("note's citekey (Other2024) differs"),
			expect.stringContaining("group libraries"),
		]);
	});

	it("renames a stored Zotero file with Zotero's renaming format when moving it into the vault", async () => {
		const f = await fixture({ "most-people-across-24-countries.html": "snapshot" });
		f.item.attachmentBaseName = "Silver25negIsraelViewMostCoutries";
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ extension: ".html" }], f.problems, f.vault);
		expect(candidate?.attachments[0]).toMatchObject({
			resolution: "move", destinationPath: path.join(f.base, "Silver25negIsraelViewMostCoutries.html"),
		});
		expect(candidate?.extras).toEqual([]);
	});

	it("lets Zotero files replace unresolved or placeholder links of the same type without markers", async () => {
		const f = await fixture({ "arxiv.pdf": "pdf", "snapshot.html": "html" });
		// Like [[arXiv Fulltext PDF|PDF]] and [[arXiv.org Snapshot|HTM]], which resolve to no file.
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ extension: ".pdf" }, { extension: ".html" }], f.problems, f.vault);
		expect(candidate?.attachments.map((entry) => [entry.basename, entry.resolution])).toEqual([
			["arxiv.pdf", "move"], ["snapshot.html", "move"],
		]);
		expect(candidate?.extras).toEqual([]);
	});

	it("replaces an empty linked note file with the Zotero file without reporting a conflict", async () => {
		const f = await fixture();
		const empty = await f.inVault("paper.html", "");
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ absolutePath: empty, extension: ".html" }], f.problems, f.vault);
		expect(candidate?.attachments[0]).toMatchObject({ destinationPath: path.join(f.base, "Paper2024.html"), resolution: "move", conflict: false });
		expect(candidate?.trashNoteFiles).toEqual(["attachments/paper.html"]);
		expect(candidate?.extras).toEqual([]);
	});

	it("pairs a note file already named by Zotero's renaming format with the Zotero file", async () => {
		const f = await fixture({ "zotero-generated-name.pdf": "zotero" });
		const note = await f.inVault("Paper2024.pdf", "note", 2_000_000_000);
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ absolutePath: note, extension: ".pdf" }], f.problems, f.vault);
		expect(candidate?.attachments[0]).toMatchObject({ destinationPath: note, resolution: "newest" });
		expect(candidate?.extras).toEqual([]);
	});

	it("pairs same-named note and Zotero files for a newest-wins replacement", async () => {
		const f = await fixture();
		const note = await f.inVault("paper.html", "note copy", 2_000_000_000);
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ absolutePath: note, extension: ".html" }], f.problems, f.vault);
		expect(candidate?.attachments[0]).toMatchObject({ destinationPath: note, resolution: "newest", conflict: false });
		expect(candidate?.extras).toEqual([]);
	});

	it("separates unrelated overwrite conflicts from identical destination files", async () => {
		const f = await fixture();
		await f.inVault("Paper2024.html", "different");
		const conflict = await buildAttachmentMoveCandidate(f.item, "Paper2024", [], f.problems, f.vault);
		expect(conflict?.attachments[0]).toMatchObject({ resolution: "move", conflict: true, identical: false });
		await f.inVault("Paper2024.html", "zotero copy");
		const identical = await buildAttachmentMoveCandidate(f.item, "Paper2024", [], f.problems, f.vault);
		expect(identical?.attachments[0]).toMatchObject({ conflict: false, identical: true });
	});

	it("keeps the identical copy named closest to Zotero's rename pattern", async () => {
		const f = await fixture({ "Paper2024.pdf": "same" });
		const note = await f.inVault("download (1).pdf", "same");
		const kept = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ absolutePath: note, extension: ".pdf" }], f.problems, f.vault);
		expect(kept?.attachments[0]).toMatchObject({ resolution: "move", destinationPath: path.join(f.base, "Paper2024.pdf") });
		expect(kept?.trashNoteFiles).toEqual(["attachments/download (1).pdf"]);
		expect(kept?.extras).toEqual([]);

		const g = await fixture({ "download.pdf": "same" });
		const named = await g.inVault("Paper2024.pdf", "same");
		const relinked = await buildAttachmentMoveCandidate(g.item, "Paper2024",
			[{ absolutePath: named, extension: ".pdf" }], g.problems, g.vault);
		expect(relinked?.attachments[0]).toMatchObject({ resolution: "keep-destination", destinationPath: named });
		expect(relinked?.trashNoteFiles).toEqual([]);
	});

	it("reports files present only in Zotero or only in the note as extras", async () => {
		const f = await fixture({ "a.pdf": "first", "b.pdf": "second" });
		const noteOnly = await f.inVault("notes.txt", "mine");
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ extension: ".pdf" }, { absolutePath: noteOnly, extension: ".txt" }], f.problems, f.vault);
		expect(candidate?.attachments).toHaveLength(2);
		expect(candidate?.linkNoteFiles).toEqual([noteOnly]);
		expect(candidate?.extras).toEqual([
			{ path: "attachments/Paper2024 2.pdf", origin: "zotero" },
			{ path: "attachments/notes.txt", origin: "note" },
		]);
	});

	it("keeps every unmatched file as a linked extra and never trashes it", async () => {
		const f = await fixture({ "Paper2024.pdf": "zotero" });
		// Identical note-only copies are not Zotero duplicates, so both are kept and linked.
		const first = await f.inVault("notes.txt", "mine");
		const second = await f.inVault("notes copy.txt", "mine");
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024",
			[{ absolutePath: first, extension: ".txt" }, { absolutePath: second, extension: ".txt" }],
			f.problems, f.vault);
		expect(candidate?.linkNoteFiles).toEqual([first, second]);
		expect(candidate?.trashNoteFiles).toEqual([]);
		expect(candidate?.extras).toEqual([
			{ path: "attachments/Paper2024.pdf", origin: "zotero" },
			{ path: "attachments/notes.txt", origin: "note" },
			{ path: "attachments/notes copy.txt", origin: "note" },
		]);
	});

	it("keeps an empty placeholder that no Zotero file replaces and reports its dropped link", async () => {
		const f = await fixture({ "Paper2024.pdf": "zotero" });
		const empty = await f.inVault("snapshot.html", "");
		const candidate = await buildAttachmentMoveCandidate(f.item, "Paper2024", [
			{ extension: ".pdf" },
			{ absolutePath: empty, extension: ".html", target: "snapshot.html" },
			{ extension: ".epub", target: "Missing Book" },
		], f.problems, f.vault);
		expect(candidate?.trashNoteFiles).toEqual([]);
		expect(candidate?.extras).toEqual([
			{ path: "attachments/snapshot.html", origin: "missing" },
			{ path: "Missing Book", origin: "missing" },
		]);
	});
});
