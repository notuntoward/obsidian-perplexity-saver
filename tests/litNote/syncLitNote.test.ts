import { afterEach, describe, expect, it, vi } from "vitest";
import { App, FileSystemAdapter, TFile } from "obsidian";
import { mkdtemp, mkdir, rm, rmdir, stat, unlink, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { tmpdir } from "os";
import path from "path";
import { finishAttachmentMove, MISMATCH_PROPERTY, recordRecoveredAutomaticAttachments, syncLitNote,
} from "../../src/litNote/syncLitNote";
import { createdNotices } from "../__mocks__/obsidian";
import type { ZoteroItemPayload } from "../../src/litNote/types";
import type { AttachmentReviewRow, DecisionButton, NoteDecision,
} from "../../src/litNote/decisionModal";

function accept() {
	return vi.fn(async (_title: string, _message: string, buttons: DecisionButton[], review?: AttachmentReviewRow[]): Promise<NoteDecision> =>
		review ? `review:${JSON.stringify(review.map((row) => (row.kind === "note" ? "remove" : row.defaultValue)))}`
				: (buttons.find((button) => ["use-zotero", "create"].includes(button.value))?.value ?? "cancel")
	);
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
			getFirstLinkpathDest: (link: string) => (link === attachment.path ? attachment : null),
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
		},
		];
	}
	function addHeaderLink(original: string, link: string): void {
		const start = body.indexOf("\n");
		body = body.slice(0, start) + original + body.slice(start);
		references = [{
			original, link, displayText: "Read", position: {
				start: { offset: start, line: 0, col: start },
				end: { offset: start + original.length, line: 0, col: start + original.length },
			},
		},
		];
	}
	return { app, file, fm, item, getBody: () => body, setBody: (text: string) => { body = text; }, addBodyLink, addHeaderLink,
	};
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
	it("logs a missing automatic attachment without showing a pop-up", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "saver-missing-attachment-"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const f = fixture();
			(f.app.vault.adapter as FileSystemAdapter).getBasePath = () => root;
			Object.assign(f.item, {
				citekey: "old", automaticAttachments: true, libraryType: "user",
				linkedAttachmentBaseDirectory: path.join(root, "attachments"), linkedAttachmentBaseDirectoryValidated: true,
				attachments: [{ itemkey: "ATT", isFile: true, mode: "linked", path: path.join(root, "missing", "old.pdf"),
					},
				],
			});
			const previousNotices = createdNotices.length;
			const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn());
			expect(result.status).toBe("attachment-error");
			expect(result.error).toContain("The Zotero attachment is missing or empty");
			expect(log).toHaveBeenCalledWith("Automatic Zotero attachment reconciliation failed", result.error);
			expect(createdNotices).toHaveLength(previousNotices);
		} finally {
			log.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("warns persistently and leaves the note alone when the linked attachment base is invalid", async () => {
		const f = fixture();
		Object.assign(f.item, {
			citekey: "old", automaticAttachments: true, libraryType: "user",
			linkedAttachmentBaseDirectory: path.resolve("outside-vault"), linkedAttachmentBaseDirectoryValidated: false,
		});
		const before = f.getBody();
		const prompt = vi.fn();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("attachment-error");
		expect(result.error).toContain("Linked Attachment Base Directory");
		expect(createdNotices.at(-1)?.message).toContain("Linked Attachment Base Directory");
		expect(f.getBody()).toBe(before);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("keeps a different nonempty note attachment, records the original, and does not review it again", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "saver-auto-attachment-"));
		try {
			const vaultRoot = path.join(root, "vault");
			const base = path.join(vaultRoot, "attachments");
			await mkdir(base, { recursive: true });
			const source = path.join(root, "old.pdf");
			const destination = path.join(base, "old.pdf");
			await writeFile(source, "original Zotero file");
			await writeFile(destination, "preferred note file");
			const f = fixture();
			const attachment = Object.assign(new TFile(), { path: "attachments/old.pdf", basename: "old", extension: "pdf",
			});
			const adapter = f.app.vault.adapter as FileSystemAdapter;
			adapter.getBasePath = () => vaultRoot;
			adapter.stat = async (relative) => {
				try {
					const info = await stat(path.join(vaultRoot, relative));
					return { type: "file", size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs,
					};
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				}
			};
			f.app.vault.getAbstractFileByPath = (p) => p === attachment.path ? attachment : p === f.file.path ? f.file : null;
			f.app.metadataCache.getFirstLinkpathDest = (p) => p === attachment.path || p === "old.pdf" ? attachment : null;
			f.app.fileManager.generateMarkdownLink = () => "[[attachments/old.pdf|PDF]]";
			Object.assign(f.item, {
				citekey: "old", automaticAttachments: true, libraryType: "user",
				linkedAttachmentBaseDirectory: base, linkedAttachmentBaseDirectoryValidated: true,
				attachments: [{ itemkey: "ATT", isFile: true, mode: "linked", path: source }],
			});
			const prompt = vi.fn();
			const planned = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
			expect(planned.attachmentMove?.attachments[0]).toMatchObject({
				sourcePath: source, destinationPath: destination, resolution: "keep-note",
			});
			f.item.attachments![0].path = destination;
			await finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item, planned.attachmentMove!, [{
				itemkey: "ATT", from: source, to: destination, newKey: "ATT",
			},
				], planned.snapshot);
			expect(f.fm.zotero_attachment_preserved_copies).toMatchObject([{
				sourceKey: "ATT", linkedKey: "ATT", sourcePath: source, destinationPath: destination,
			},
			]);
			f.fm.zotero_attachment_preserved_copies = [];
			await recordRecoveredAutomaticAttachments(f.app, f.file, f.item, [
				{ itemkey: "ATT", sourcePath: source, destinationPath: destination },
				{ itemkey: "NOT-MOVED", sourcePath: source, destinationPath: destination },
			]);
			expect(f.fm.zotero_attachment_preserved_copies).toMatchObject([{
				sourceKey: "ATT", linkedKey: "ATT", sourcePath: source, destinationPath: destination,
			},
			]);
			const archive = path.join(root, "archive.pdf");
			await writeFile(archive, "original Zotero file");
			f.fm.zotero_attachment_preserved_copies = [];
			f.item.attachments![0].itemkey = "NEW";
			await finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item, planned.attachmentMove!, [{
				itemkey: "ATT", from: source, to: destination, newKey: "NEW", archivePath: archive,
			},
				]);
			expect(f.fm.zotero_attachment_preserved_copies).toMatchObject([{
				sourceKey: "ATT", linkedKey: "NEW", sourcePath: archive, originalPath: source, destinationPath: destination,
			},
			]);
			f.fm.zotero_attachment_preserved_copies = [];
			await unlink(source);
			await recordRecoveredAutomaticAttachments(f.app, f.file, f.item, [
				{ itemkey: "ATT", sourcePath: source, destinationPath: destination, archivePath: archive,
				},
			]);
			expect(f.fm.zotero_attachment_preserved_copies).toMatchObject([{
				sourceKey: "ATT", linkedKey: "NEW", sourcePath: archive, originalPath: source, destinationPath: destination,
			},
			]);
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true,
					})).status).toBe("skipped");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([false, true])("reconciles a missing Zotero source without claiming a preserved main file (resources: %s)", async (resources) => {
		const root = await mkdtemp(path.join(tmpdir(), "saver-missing-attachment-"));
		try {
			const vaultRoot = path.join(root, "vault");
			const base = path.join(vaultRoot, "attachments");
			await mkdir(base, { recursive: true });
			const source = path.join(root, "storage", "old.pdf");
			await mkdir(path.dirname(source));
			const archiveDirectory = path.join(root, "resource-archive");
			if (resources) {
				await mkdir(archiveDirectory);
				await writeFile(path.join(path.dirname(source), "image.png"), "resource");
				await writeFile(path.join(archiveDirectory, "image.png"), "resource");
			}
			const destination = path.join(base, "old.pdf");
			await writeFile(destination, "preferred note file");
			const f = fixture();
			const attachment = Object.assign(new TFile(), { path: "attachments/old.pdf", basename: "old", extension: "pdf",
				});
			const adapter = f.app.vault.adapter as FileSystemAdapter;
			adapter.getBasePath = () => vaultRoot;
			adapter.stat = async (relative) => {
				const info = await stat(path.join(vaultRoot, relative));
				return { type: "file", size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs,
					};
			};
			f.app.vault.getAbstractFileByPath = (p) => p === attachment.path ? attachment : p === f.file.path ? f.file : null;
			f.app.metadataCache.getFirstLinkpathDest = (p) => p === attachment.path || p === "old.pdf" ? attachment : null;
			f.app.fileManager.generateMarkdownLink = () => "[[attachments/old.pdf|PDF]]";
			Object.assign(f.item, {
				citekey: "old", automaticAttachments: true, libraryType: "user",
				linkedAttachmentBaseDirectory: base, linkedAttachmentBaseDirectoryValidated: true,
				attachments: [{ itemkey: "ATT", isFile: true, mode: resources ? "stored" : "linked", path: source,
						},
					],
			});
			const prompt = vi.fn();
			const planned = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
			expect(planned.attachmentMove?.attachments[0]).toMatchObject({
				sourcePath: source, sourceMissing: true, destinationPath: destination, resolution: "keep-note",
			});
			f.item.attachments![0].path = destination;
			f.item.attachments![0].mode = "linked";
			if (resources) f.item.attachments![0].itemkey = "NEW";
			await finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item, planned.attachmentMove!, resources ? [{
				itemkey: "ATT", from: source, to: destination, newKey: "NEW", archiveDirectory,
			},
							] : [], planned.snapshot);
			if (resources) {
				expect(f.fm.zotero_attachment_preserved_copies).toMatchObject([{
					sourceKey: "ATT", linkedKey: "NEW", sourcePath: archiveDirectory, originalPath: source,
					resourcesOnly: true, resourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
					]);
				f.fm.zotero_attachment_preserved_copies = [];
				await recordRecoveredAutomaticAttachments(f.app, f.file, f.item, [{
					itemkey: "ATT", sourcePath: source, destinationPath: destination, archiveDirectory,
				},
					]);
				expect(f.fm.zotero_attachment_preserved_copies).toMatchObject([{ resourcesOnly: true },
					]);
			} else expect(f.fm.zotero_attachment_preserved_copies).toBeUndefined();
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true })).status).toBe("skipped");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("makes an absolute in-vault attachment link relative without asking for review", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const absolute = f.item.attachments![0].path!;
		f.setBody(`> [!info]- [**Zotero**]()<!-- zotero-attachments:start --> | **[[${absolute}|PDF]]**<!-- zotero-attachments:end -->\n`);
		const prompt = vi.fn();

		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		expect(prepared.status).toBe("prepared");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { expectedContent: prepared.snapshot,
		});

		expect(result.status).toBe("updated");
		expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
		expect(f.getBody()).not.toContain(absolute);
		expect(prompt).not.toHaveBeenCalled();
		expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt)).status).toBe("skipped");
	});

	it("recognizes the same Zotero and note attachment without asking for a decision", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.setBody("> [!info]- [**Zotero**]()<!-- zotero-attachments:start --> | **[[attachments/new.pdf|PDF]]**<!-- zotero-attachments:end -->\n");
		const prompt = vi.fn();
		const before = f.getBody();

		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true,
		});

		expect(result.status).toBe("skipped");
		expect(prompt).not.toHaveBeenCalled();
		expect(f.getBody()).toBe(before);
	});

	it.each([true, false])("verifies the repaired note link resolves to the copied file: %s", async (resolves) => {
		const root = await mkdtemp(path.join(tmpdir(), "saver-repair-note-"));
		try {
			await mkdir(path.join(root, "attachments"));
			const source = path.join(root, "source.pdf");
			const destination = path.join(root, "attachments", "new.pdf");
			await writeFile(source, "PDF data");
			await writeFile(destination, "PDF data");
			const f = fixture();
			f.item.citekey = "old";
			f.item.attachments = [
				{ itemkey: "ORIGINAL", mode: "stored", path: source, isFile: true },
				{ itemkey: "LINKED", mode: "linked", path: destination, isFile: true },
			];
			(f.app.vault.adapter as FileSystemAdapter).getBasePath = () => root;
			if (!resolves) f.app.metadataCache.getFirstLinkpathDest = () => null;
			const snapshot = f.getBody();
			const operation = finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item,
				{ baseDirectory: path.join(root, "attachments"), attachments: [], linkNoteFiles: [], trashNoteFiles: [], extras: [],
					},
				[{ itemkey: "ORIGINAL", from: source, to: destination, newKey: "LINKED", copied: true,
						},
					], snapshot);
			if (resolves) {
				await expect(operation).resolves.toEqual({ trashed: [] });
				expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
			} else {
				await expect(operation).rejects.toThrow("The note does not link to the copied attachment");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("corrects a stale note citekey when its filename matches Zotero, then leaves attachments for the next sync", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.fm.citekey = "wrong";
		f.item.citationKeyCheck = undefined;
		f.item.attachments = [{ isFile: true, mode: "stored", path: path.resolve("outside-vault", "paper.pdf") },
		];
		const before = f.getBody();
		const prompt = vi.fn();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		expect(prepared.status).toBe("prepared");
		expect(f.fm.citekey).toBe("wrong");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { expectedContent: prepared.snapshot,
		});
		expect(result.status).toBe("updated");
		expect(f.fm.citekey).toBe("old");
		expect(f.getBody()).toBe(before);
		expect(prompt).not.toHaveBeenCalled();
		const next = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(next.errorTitle).toBe("Stored Zotero attachment has not been moved into the vault");
	});

	it("does not apply the automatic citekey correction if the note identity changes", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.fm.citekey = "wrong";
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn(), {
			beforeApply: () => { f.fm.zotero_item_key = "OTHER"; },
		});
		expect(result.status).toBe("error");
		expect(f.fm.citekey).toBe("wrong");
	});

	it("relinks a markerless note after a confirmed move and flags extra files below the callout", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const vault = await mkdtemp(path.join(tmpdir(), "lit-trash-test-"));
		await mkdir(path.join(vault, "attachments"));
		await writeFile(path.join(vault, "attachments", "empty.pdf"), "");
		const info = await stat(path.join(vault, "attachments", "empty.pdf"));
		(f.app.vault.adapter as FileSystemAdapter).getBasePath = () => vault;
		f.item.attachments = [{ isFile: true, path: path.join(vault, "attachments", "new.pdf") }];
		const empty = Object.assign(new TFile(), { path: "attachments/empty.pdf", extension: "pdf",
		});
		const lookup = f.app.metadataCache.getFirstLinkpathDest;
		f.app.metadataCache.getFirstLinkpathDest = (link, source) => link === "empty.pdf" ? empty : lookup(link, source);
		const find = f.app.vault.getAbstractFileByPath;
		f.app.vault.getAbstractFileByPath = (p) => (p === empty.path ? empty : find(p));
		(f.app.metadataCache as { resolvedLinks: unknown }).resolvedLinks = { "lit/old.md": { [empty.path]: 1 },
		};
		const trashFile = vi.fn();
		(f.app.fileManager as unknown as { trashFile: unknown }).trashFile = trashFile;
		f.setBody("> [!info]- &nbsp;[**Zotero**]() | **[[arXiv Fulltext PDF|PDF]]** | **[[empty.pdf|PDF]]**\r\n> Abstract.\r\nPersonal notes.\r\n");

		try {
			await finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item, {
				baseDirectory: "attachments", attachments: [], linkNoteFiles: [],
				trashNoteFiles: [empty.path],
				trashNoteSnapshots: [{ path: empty.path, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, sha256: createHash("sha256").digest("hex"),
					},
				],
				extras: [{ path: "attachments/new.pdf", origin: "zotero" }],
			});
		} finally {
			await rm(vault, { recursive: true, force: true });
		}

		const lines = f.getBody().split("\r\n");
		expect(lines[0]).toContain("[[attachments/new.pdf|PDF]]");
		expect(lines[0]).not.toContain("arXiv Fulltext PDF");
		expect(lines.slice(1, 5)).toEqual([
			"> Abstract.", "", expect.stringMatching(/^==🔴Zotero\/note attachment mismatch: only the Zotero item had \[\[attachments\/new\.pdf\|new\.pdf\]\].*==$/), "",
		]);
		expect(lines[5]).toBe("Personal notes.");
		expect(f.fm[MISMATCH_PROPERTY]).toBe(true);
		expect(trashFile).toHaveBeenCalledWith(empty);
	});

	it("explains a dropped link to a missing file in the mismatch line", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.setBody("> [!info]- &nbsp;[**Zotero**]() | **[[Missing Book|EPUB]]**\n> Abstract.\nPersonal notes.\n");

		await finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item, {
			baseDirectory: "attachments", attachments: [], linkNoteFiles: [], trashNoteFiles: [],
			extras: [{ path: "Missing Book", origin: "missing" }],
		});

		const line = f.getBody().split("\n")[3];
		expect(line).toMatch(/^==🔴Zotero\/note attachment mismatch: .*linked Missing Book, which pointed to a missing or empty file that no Zotero attachment replaced; Saver removed that link\..*==$/);
		expect(f.fm[MISMATCH_PROPERTY]).toBe(true);
	});

	it("keeps note files that other notes still link to", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const empty = Object.assign(new TFile(), { path: "attachments/empty.pdf", extension: "pdf",
		});
		f.app.metadataCache.getFirstLinkpathDest = (link) => (link === "empty.pdf" ? empty : null);
		(f.app.metadataCache as { resolvedLinks: unknown }).resolvedLinks = { "lit/old.md": { [empty.path]: 1 }, "other.md": { [empty.path]: 1 },
		};
		const trashFile = vi.fn();
		(f.app.fileManager as unknown as { trashFile: unknown }).trashFile = trashFile;
		f.setBody("> [!info]- &nbsp;[**Zotero**]() | **[[empty.pdf|PDF]]**\n\nPersonal notes.\n");

		await finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item, {
			baseDirectory: "attachments", attachments: [], linkNoteFiles: [], trashNoteFiles: [empty.path], extras: [],
		});

		expect(trashFile).not.toHaveBeenCalled();
		expect(f.getBody()).not.toContain("mismatch");
		expect(f.fm[MISMATCH_PROPERTY]).toBeUndefined();
	});

	it("links a copied Zotero attachment and ignores the preserved source on later syncs", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "saver-preserved-copy-"));
		try {
			const vaultRoot = path.join(root, "vault");
			await mkdir(vaultRoot);
			await mkdir(path.join(vaultRoot, "attachments"));
			await mkdir(path.join(root, "storage"));
			const sourcePath = path.join(root, "storage", "shared.pdf");
			const destinationPath = path.join(vaultRoot, "attachments", "new.pdf");
			await writeFile(sourcePath, "PDF fixture");
			await writeFile(destinationPath, "PDF fixture");
			const f = fixture();
			f.item.citekey = "old";
			const adapter = f.app.vault.adapter as FileSystemAdapter;
			adapter.getBasePath = () => vaultRoot;
			adapter.stat = async (relative) => {
				try {
					const info = await stat(path.join(vaultRoot, relative));
					return { type: "file", size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs,
					};
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				}
			};
			f.item.attachments = [
				{ itemkey: "ATT-SOURCE", isFile: true, mode: "stored", path: sourcePath },
				{
					itemkey: "ATT-COPY",
					isFile: true,
					mode: "linked",
					path: destinationPath,
				},
			];

			await finishAttachmentMove(
				f.app,
				{ litNotesFolder: "lit" },
				f.item,
				{
					baseDirectory: "attachments",
					attachments: [],
					linkNoteFiles: [],
					trashNoteFiles: [],
					extras: [],
				},
				[
					{
						itemkey: "ATT-SOURCE",
						from: sourcePath,
						to: destinationPath,
						newKey: "ATT-COPY",
						copied: true,
					},
				]
			);

			expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
			expect(f.fm.zotero_attachment_preserved_keys).toEqual(["ATT-SOURCE"]);
			expect(f.fm.zotero_attachment_preserved_copies).toEqual([{
				sourceKey: "ATT-SOURCE", linkedKey: "ATT-COPY", sourcePath, destinationPath,
				sha256: createHash("sha256").update("PDF fixture").digest("hex"),
			},
			]);
			expect(createdNotices.at(-1)?.message).toContain(
				"Copied new.pdf into the vault and linked the copies in Obsidian and Zotero."
			);
			expect(createdNotices.at(-1)?.message).toContain(
				"The Zotero originals remain. Another attachment references them."
			);
			expect(createdNotices.at(-1)?.message).toContain(
				"Verify the references before manually deleting an original."
			);

			const next = await syncLitNote(
				f.app,
				{ litNotesFolder: "lit" },
				f.item,
				"auto",
				vi.fn()
			);
			expect(next.status).toBe("skipped");
			await unlink(sourcePath);
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("skipped");
			await writeFile(destinationPath, "Different PDF");
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			await writeFile(destinationPath, "PDF fixture");
			await writeFile(sourcePath, "Different PDF");
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			await writeFile(sourcePath, "PDF fixture");
			await writeFile(destinationPath, "Different PDF");
			await writeFile(sourcePath, "Different PDF");
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			await writeFile(sourcePath, "PDF fixture");
			await writeFile(destinationPath, "PDF fixture");
			const originalCopies = f.fm.zotero_attachment_preserved_copies;
			f.fm.zotero_attachment_preserved_copies = [];
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			f.fm.zotero_attachment_preserved_copies = originalCopies;
			const source = f.item.attachments![0];
			const linked = f.item.attachments![1];
			source.itemkey = "OTHER-SOURCE";
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			source.itemkey = "ATT-SOURCE";
			source.path = path.join(root, "storage", "other.pdf");
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			source.path = sourcePath;
			linked.itemkey = "OTHER-COPY";
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			linked.itemkey = "ATT-COPY";
			linked.path = path.join(vaultRoot, "attachments", "other.pdf");
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
			linked.path = destinationPath;
			await unlink(destinationPath);
			expect((await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", vi.fn())).status).toBe("error");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps note duplicates and explains why originals remain when Zotero reference checking fails", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const vaultRoot = (f.app.vault.adapter as FileSystemAdapter).getBasePath();
		const sourcePath = path.resolve("zotero-storage", "shared.pdf");
		const destination = path.join(vaultRoot, "attachments", "new.pdf");
		f.item.attachments = [
			{ itemkey: "ATT-SOURCE", isFile: true, mode: "stored", path: sourcePath },
			{ itemkey: "ATT-COPY", isFile: true, mode: "linked", path: destination },
		];
		const trashFile = vi.fn();
		(f.app.fileManager as unknown as { trashFile: unknown }).trashFile = trashFile;
		f.addHeaderLink(" | [[attachments/new.pdf]]", "attachments/new.pdf");
		(f.app.metadataCache as { resolvedLinks: unknown }).resolvedLinks = { "lit/old.md": { "attachments/new.pdf": 1 },
		};

		await finishAttachmentMove(f.app, { litNotesFolder: "lit" }, f.item, {
			baseDirectory: "attachments", attachments: [], linkNoteFiles: [],
			trashNoteFiles: ["attachments/new.pdf"], extras: [],
		}, [{ itemkey: "ATT-SOURCE", from: sourcePath, to: destination, copied: true, referenceCheckFailed: true,
				},
			]);

		expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
		expect(trashFile).not.toHaveBeenCalled();
		expect(createdNotices.at(-1)?.message).toContain("Copied new.pdf into the vault and linked the copies in Obsidian and Zotero.");
		expect(createdNotices.at(-1)?.message).toContain("Zotero could not check for other references.");
		expect(createdNotices.at(-1)?.message).toContain("Verify the references before manually deleting an original.");
	});

	it("offers a bulk category for a simple rename confirmation", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.item.attachments = [];
		f.file.path = "lit/different.md";
		f.setBody("> [!info]- &nbsp;[**Zotero**]()<!-- zotero-attachments:start --><!-- zotero-attachments:end -->\n");
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(prompt.mock.calls[0][0]).toBe("Rename and update the note");
		expect(prompt.mock.calls[0][5]).toContain("Rename notes");
		expect(prompt.mock.calls[0][1]).toContain("lit/different.md → lit/old.md");
	});

	it("shows attachment details and choices together with the item and note identity", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const prompt = vi.fn().mockResolvedValue("cancel");
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("skipped");
		expect(prompt).toHaveBeenCalledOnce();
		expect(prompt.mock.calls[0][0]).toBe("Attachment links differ");
		expect(prompt.mock.calls[0][1]).toMatch(/^1 note attachment link\(s\) could not be matched to Zotero attachments\./);
		expect(prompt.mock.calls[0][3].map((row: AttachmentReviewRow) => row.kind)).toEqual(["note", "add",
		]);
		expect(prompt.mock.calls[0][4]).toMatchObject({ itemkey: "ABC", notePath: "lit/old.md" });
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
	});

	it("describes the user's citation-key change without implying an earlier operation", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.item.zoteroChanges = {
			previousCitekey: "previous",
			attachmentMoves: [{ itemkey: "ATT1", from: "before.pdf", to: "after.pdf" }],
		};
		f.addBodyLink("[[old.pdf|Read]]", "old.pdf");
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const message = prompt.mock.calls[0][1] as string;
		expect(prompt.mock.calls[0][3].some((row: AttachmentReviewRow) => row.kind === "body")).toBe(true);
		expect(message).toContain("The citation-key change you just made in Zotero was previous");
		expect(message).not.toContain("already");
		expect(message).toContain("Cancel stops this Obsidian update; it does not undo your Zotero citation-key change");
	});

	it("shows unmatched links without counting matching rendered links as differences", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.app.vault.read = async () => "> [!info]- &nbsp;[**Zotero**]()<!-- zotero-attachments:start --> | **[[old.pdf|PDF]]** | **[[other.pdf|PDF]]** | **[[attachments/new.pdf|PDF]]**<!-- zotero-attachments:end -->\n";
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const review = prompt.mock.calls[0][3] as AttachmentReviewRow[];
		expect(review.map((row) => row.kind)).toEqual(["note", "note"]);
	});

	it("does not claim links differ when reviewing only earlier Zotero changes", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.item.attachments = [];
		f.item.zoteroChanges = {
			previousCitekey: "previous",
			attachmentMoves: [{ itemkey: "ATT1", from: "before.pdf", to: "after.pdf" }],
		};
		f.app.vault.read = async () => "> [!info]- &nbsp;[**Zotero**]()<!-- zotero-attachments:start --><!-- zotero-attachments:end -->\n";
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(prompt.mock.calls[0][0]).toBe("Zotero attachments changed");
		expect(prompt.mock.calls[0][3].map((row: AttachmentReviewRow) => row.kind)).toEqual(["zotero",
		]);
	});

	it("recognizes unbolded legacy attachment links without changing the URL or page references", async () => {
		const f = fixture(true);
		f.item.citekey = "old";
		const name = "Zygmunt17fastHyperband";
		const folder = await mkdtemp(path.join(tmpdir(), "lit-legacy-test-"));
		const filenames = [`${name}.pdf`, `${name}.html`];
		try {
			await Promise.all(filenames.map((filename, index) => writeFile(path.join(folder, filename), `content-${index}`)));
			const files = filenames.map((filename) => Object.assign(new TFile(), {
				path: `lit/lit_sources/${filename}`, extension: filename.split(".").pop(),
			}));
			const adapter = f.app.vault.adapter as FileSystemAdapter;
			adapter.getFullPath = (filePath) => path.join(folder, path.basename(filePath));
			adapter.stat = async (filePath) => {
				const info = await stat(adapter.getFullPath(filePath));
				return { type: "file", size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs };
			};
			f.app.vault.getAbstractFileByPath = (p) => files.find((file) => file.path === p) ?? (p === f.file.path ? f.file : null);
			f.app.metadataCache.getFirstLinkpathDest = (link) =>
				files.find((file) => file.path === link || path.basename(file.path) === link) ?? null;
			f.app.fileManager.generateMarkdownLink = (file, _source, subpath, display) => `[[${file.path}${subpath}|${display}]]`;
			f.item.attachments = files.map((file) => ({ isFile: true, path: path.join(adapter.getBasePath(), file.path),
			}));
			f.setBody(`> [!info]- : [**Zotero**](zotero://select/library/items/G4GFYAVP)   | [**URL**](https://fastml.com/tuning-hyperparams-fast-with-hyperband/) | [[${name}.pdf|PDF]] | [[${name}.html|HTM]]\n\nPersonal notes.\n`);
			f.addBodyLink(`[[${name}.pdf#page=2&annotation=ABC|Read]]`, `${name}.pdf#page=2&annotation=ABC`);
			const prompt = accept();
			const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
			expect(result.status).toBe("updated");
			expect(prompt.mock.calls.map((call) => call[0])).toEqual(["Add the Zotero library and update the note",
			]);
			expect(f.getBody()).toContain("[**URL**](https://fastml.com/tuning-hyperparams-fast-with-hyperband/)");
			expect(f.getBody()).toContain(`[[${name}.pdf#page=2&annotation=ABC|Read]]`);
			expect(f.getBody()).toContain("<!-- zotero-attachments:start -->");
			expect(f.getBody()).toContain(`**[[lit/lit_sources/${name}.pdf|PDF]]**`);
			expect(f.getBody()).toContain(`**[[lit/lit_sources/${name}.html|HTM]]**`);
			expect(f.getBody()).not.toContain(`[[${name}.pdf|PDF]]`);
			expect(f.getBody()).not.toContain(`[[${name}.html|HTM]]`);
		} finally {
			await Promise.all(filenames.map((filename) => unlink(path.join(folder, filename))));
			await rmdir(folder);
		}
	});

	it("shows both unresolved unbolded legacy links in the first review", async () => {
		const f = fixture(true);
		f.item.citekey = "old";
		f.setBody("> [!info]- : [**Zotero**](zotero://select/library/items/G4GFYAVP)   | [**URL**](https://example.com/) | [[old.pdf|PDF]] | [[old.html|HTM]]\n");
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const review = prompt.mock.calls[0][3] as AttachmentReviewRow[];
		expect(review.filter((row) => row.kind === "note").map((row) => row.copyValue)).toEqual(["old.pdf", "old.html",
		]);
		expect(review.filter((row) => row.kind === "add")).toHaveLength(1);
		expect(review[0].description).toContain("could not resolve");
		expect(f.getBody()).toContain("[**URL**](https://example.com/)");
	});

	it("does not report a markerless note whose link resolves to the Zotero file", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const attachment = f.app.vault.getAbstractFileByPath("attachments/new.pdf");
		f.app.metadataCache.getFirstLinkpathDest = (link) =>
			(link === "new.pdf" || link === "attachments/new.pdf") && attachment instanceof TFile ? attachment : null;
		const content = "> [!info]- [**Zotero**]() | [[new.pdf|PDF]]\n";
		f.setBody(content);
		const prompt = vi.fn();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("skipped");
		expect(prompt).not.toHaveBeenCalled();
		expect(f.getBody()).toBe(content);
	});

	it.each([
		["missing", false], ["empty", false], ["missing", true], ["empty", true],
	])("repairs a %s attachment link (markers: %s) using the only non-empty Zotero file", async (kind, marked) => {
		const f = fixture();
		f.item.citekey = "old";
		const empty = Object.assign(new TFile(), { path: "attachments/old.pdf", extension: "pdf",
			});
		const lookup = f.app.metadataCache.getFirstLinkpathDest;
		f.app.metadataCache.getFirstLinkpathDest = (link, source) =>
			link === "old.pdf" && kind === "empty" ? empty : lookup(link, source);
		f.app.vault.adapter.stat = async (filePath) => ({
			type: "file", size: filePath === empty.path ? 0 : 25, mtime: 1, ctime: 1,
		});
		const content = `> [!info]- [**Zotero**]()${marked ? "<!-- zotero-attachments:start -->" : ""} | [[old.pdf|PDF]]${marked ? "<!-- zotero-attachments:end -->" : ""}\n\nPersonal notes.\n`;
		f.setBody(content);
		const prompt = vi.fn();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		expect(prepared.status).toBe("prepared");
		expect(f.getBody()).toBe(content);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { expectedContent: prepared.snapshot });
		expect(result.status).toBe("updated");
		expect(prompt).not.toHaveBeenCalled();
		expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
		expect(f.getBody()).not.toContain("[[old.pdf|PDF]]");
		expect(f.getBody()).toContain("Personal notes.");
	});

	it.each(["rename", "zotero-change"])("repairs a broken link in the confirmed %s plan, ignoring a stray .md note with the link's name", async (kind) => {
		const f = fixture();
		f.fm.citekey = "new";
		if (kind === "zotero-change") {
			f.file.path = "lit/new.md";
			f.item.zoteroChanges = { previousCitekey: "old", attachmentMoves: [] };
		}
		const stray = Object.assign(new TFile(), { path: "lit/old.pdf.md", name: "old.pdf.md", basename: "old.pdf", extension: "md",
			});
		const lookup = f.app.metadataCache.getFirstLinkpathDest;
		f.app.metadataCache.getFirstLinkpathDest = (link, source) => link === "old.pdf" ? stray : lookup(link, source);
		f.app.vault.adapter.stat = async () => ({ type: "file", size: 25, mtime: 1, ctime: 1 });
		f.setBody("> [!info]- [**Zotero**]() | **[[old.pdf|PDF]]**\n\nPersonal notes.\n");
		const prompt = accept();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("updated");
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0][3]).toBeUndefined();
		expect(prompt.mock.calls[0][1]).toContain("Replace 1 broken attachment link(s) with the Zotero attachment:\n- old.pdf → attachments/new.pdf");
		expect(f.getBody()).toContain("[[attachments/new.pdf|PDF]]");
		expect(f.getBody()).not.toContain("old.pdf");
		expect(f.file.path).toBe("lit/new.md");
	});

	it("does not replace a broken link with an empty Zotero file", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.setBody("> [!info]- [**Zotero**]() | [[old.pdf|PDF]]\n");
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(prompt).toHaveBeenCalled();
		expect(prompt.mock.calls[0][0]).toBe("Attachment links differ");
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
	});

	it("does not choose between multiple Zotero files for a broken link", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const second = Object.assign(new TFile(), { path: "attachments/second.pdf", extension: "pdf",
		});
		const lookup = f.app.metadataCache.getFirstLinkpathDest;
		f.app.metadataCache.getFirstLinkpathDest = (link, source) => link === second.path ? second : lookup(link, source);
		const find = f.app.vault.getAbstractFileByPath;
		f.app.vault.getAbstractFileByPath = (name) => (name === second.path ? second : find(name));
		f.app.fileManager.generateMarkdownLink = (file, _source, _subpath, display) => `[[${file.path}|${display}]]`;
		f.app.vault.adapter.stat = async () => ({ type: "file", size: 25, mtime: 1, ctime: 1 });
		f.item.attachments!.push({ isFile: true, path: path.join(path.resolve("test-vault"), second.path),
		});
		f.setBody("> [!info]- [**Zotero**]() | [[old.pdf|PDF]]\n");
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(prompt).toHaveBeenCalled();
		expect(prompt.mock.calls[0][0]).toBe("Attachment links differ");
		expect(f.getBody()).toContain("[[old.pdf|PDF]]");
	});

	it("distinguishes mixed attachment problems without guessing their cause", async () => {
		const f = fixture();
		f.item.attachments = [
			{ isFile: true, mode: "stored", path: path.resolve("outside-vault", "new.pdf") },
			{ isFile: true, mode: "linked", usesRelativePath: true, title: "Unresolved PDF" },
		];
		f.item.linkedAttachmentBaseDirectory = "";
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(result.errorTitle).toBe("Zotero attachments need attention");
		expect(result.attachmentProblems).toMatchObject([
			{ title: "Stored Zotero attachment has not been moved into the vault", dialogProblem: expect.stringContaining("Vault:"), action: expect.stringContaining("Move the attachment into the vault"),
			},
			{ title: "Zotero attachment path could not be resolved", action: expect.stringContaining("Base Directory is unset"),
			},
		]);
	});

	it("updates key and attachment links without changing personal content or metadata", async () => {
		const f = fixture();
		const confirm = accept();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", confirm);
		expect(result.status).toBe("updated");
		expect(confirm.mock.calls.map((call) => call[0])).toEqual([
			"Citekeys differ", "Attachment links differ", "Rename and update the note",
		]);
		expect(f.file.path).toBe("lit/new.md");
		expect(f.fm.citekey).toBe("new");
		expect(f.fm.title).toBe("Old title");
		expect(f.fm.tags).toEqual(["personal"]);
		expect(f.fm.created_date).toBe("original");
		expect(f.getBody()).toContain("**[[attachments/new.pdf|PDF]]**");
		expect(f.getBody()).toContain("Personal notes.");
	});

	it("does not update collections from an automatic sync payload yet", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["old_collection"];
		f.item.collections = ["New Collection"];
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", accept());
		expect(result.status).toBe("updated");
		expect(f.fm.zotero_collections).toEqual(["old_collection"]);
	});

	it("previews additions, removals and renames before adopting collections", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["old_collection", "stay"];
		f.item.collections = ["Stay", "New Collection"];
		const confirm = accept();
		const persist = vi.fn().mockResolvedValue(undefined);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "metadata", confirm,
			{ persistCollectionAdoption: persist }
		);
		const preview = confirm.mock.calls.find((call) => call[0] === "Rename and update the note")?.[1];
		expect(result.status).toBe("updated");
		expect(preview).toContain("zotero_collections:");
		expect(preview).toContain("old_collection");
		expect(preview).toContain("new_collection");
		expect(preview).toContain("Adopt the current Zotero collection membership");
		expect(f.fm.zotero_collections).toEqual(["stay", "new_collection"]);
		expect(f.fm.tags).toEqual(["personal"]);
		expect(f.fm.read).toBe(true);
		expect(f.getBody()).toContain("Personal notes.");
		expect(persist).toHaveBeenCalledWith(["stay", "new_collection"]);
	});

	it("warns before replacing a collection value edited since adoption", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["note_edit"];
		f.item.collections = ["Zotero Collection"];
		const confirm = accept();
		const persist = vi.fn().mockResolvedValue(undefined);
		const result = await syncLitNote(
			f.app,
			{ litNotesFolder: "lit" },
			f.item,
			"metadata",
			confirm,
			{
				collectionAdoption: { status: "managed", baseline: ["last_accepted"] },
				persistCollectionAdoption: persist,
			}
		);
		const preview = confirm.mock.calls.find(
			(call) => call[0] === "Rename and update the note"
		)?.[1];
		expect(result.status).toBe("updated");
		expect(preview).toContain("edited after the last accepted update");
		expect(f.fm.zotero_collections).toEqual(["zotero_collection"]);
		expect(persist).toHaveBeenCalledWith(["zotero_collection"]);
	});

	it("reports a failed adoption-state save after changing the note", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["old_collection"];
		f.item.collections = ["New Collection"];
		const persist = vi.fn().mockRejectedValue(new Error("settings write failed"));
		const result = await syncLitNote(
			f.app,
			{ litNotesFolder: "lit" },
			f.item,
			"metadata",
			accept(),
			{ persistCollectionAdoption: persist }
		);
		expect(result.status).toBe("error");
		expect(result.error).toContain("may be partial");
		expect(result.error).toContain("settings write failed");
		expect(f.fm.zotero_collections).toEqual(["new_collection"]);
	});

	it("preserves collections when a manual update omits collection data", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["old_collection"];
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "metadata", accept());
		expect(result.status).toBe("updated");
		expect(f.fm.zotero_collections).toEqual(["old_collection"]);
	});

	it("removes collections and records an empty adoption baseline", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["old_collection"];
		f.item.collections = [];
		const persist = vi.fn().mockResolvedValue(undefined);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "metadata", accept(),
			{ persistCollectionAdoption: persist }
		);
		expect(result.status).toBe("updated");
		expect(f.fm.zotero_collections).toBeUndefined();
		expect(persist).toHaveBeenCalledWith([]);
	});

	it("previews metadata changes and preserves unique existing aliases", async () => {
		const f = fixture();
		f.fm.doi = "10.1/old";
		const confirm = accept();
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "metadata", confirm);
		const preview = confirm.mock.calls.find((call) => call[0] === "Rename and update the note")?.[1];
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
		expect(result.errorTitle).toBe("Zotero attachment is outside the Obsidian vault");
		expect(result.error).toMatch(/^Zotero attachment:/);
		expect(result.error).toContain("outside the Obsidian vault");
		expect(result.error).toContain("Note attachment links can only target files inside the vault");
		expect(result.error).not.toContain("confirm that the intended vault is open");
		expect(result.attachmentProblems).toMatchObject([{ path: path.resolve("outside-vault", "new.pdf") },
		]);
		expect(result.error).not.toContain("Linked Attachment Base Directory");
		expect(result.identity).toMatchObject({ itemkey: "ABC", notePath: "lit/old.md" });
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
		expect(result.identity).toMatchObject({
			itemkey: "ABC",
			notePaths: ["lit/old.md", "lit/duplicate.md"],
		});
		expect(result.dialogMessage).toContain("No notes or attachments were changed");
		expect(result.dialogMessage).toContain("zotero_item_key");
		expect(result.dialogMessage).toContain("zotero_library_uri");
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
		expect(result).toMatchObject({ status: "set-zotero-key", noteCitekey: "old", expectedZoteroKey: "new",
		});
		expect(prompt.mock.calls[0][4]).toMatchObject({
			noteCitekey: "old", zoteroCitekey: "new", itemkey: "ABC", notePath: "lit/old.md",
		});
		expect(prompt.mock.calls[0][1]).toContain("Choose which citation key to keep");
		expect(prompt.mock.calls[0][1]).toContain("Zotero changes now");
		expect(prompt.mock.calls[0][1]).toContain("canceling later will not undo");
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
			matches: [{ title: "Other work", citekey: "old", libraryURI: "other", itemkey: "OTHER" },
			],
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

	it("queues the citekey decision instead of an error when a background recheck has no key check", async () => {
		const f = fixture();
		delete f.item.citationKeyCheck;
		const prompt = vi.fn();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		expect(result.status).toBe("error");
		expect(result.errorTitle).toBe("Citekeys differ");
		expect(result.error).toContain("The note uses citation key old; Zotero uses new.");
		expect(prompt).not.toHaveBeenCalled();
		expect(f.fm.citekey).toBe("old");
	});

	it("does not present a choice when the duplicate check is stale", async () => {
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

	it("does not adopt collection changes when the user cancels", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["old_collection"];
		f.item.collections = ["New Collection"];
		const persist = vi.fn().mockResolvedValue(undefined);
		const prompt = vi.fn().mockResolvedValue("cancel");
		const result = await syncLitNote(
			f.app,
			{ litNotesFolder: "lit" },
			f.item,
			"metadata",
			prompt,
			{ persistCollectionAdoption: persist }
		);
		expect(result.status).toBe("skipped");
		expect(f.fm.zotero_collections).toEqual(["old_collection"]);
		expect(f.fm.tags).toEqual(["personal"]);
		expect(persist).not.toHaveBeenCalled();
	});

	it("rejects a stale manual collection adoption plan", async () => {
		const f = fixture();
		f.fm.zotero_collections = ["old_collection"];
		f.item.collections = ["New Collection"];
		const persist = vi.fn().mockResolvedValue(undefined);
		const prepared = await syncLitNote(
			f.app,
			{ litNotesFolder: "lit" },
			f.item,
			"metadata",
			accept(),
			{ prepareOnly: true }
		);
		expect(prepared.status).toBe("prepared");
		f.addBodyLink("[[personal.pdf|Read]]", "personal.pdf");
		const applied = await syncLitNote(
			f.app,
			{ litNotesFolder: "lit" },
			f.item,
			"metadata",
			accept(),
			{
				expectedContent: prepared.snapshot,
				persistCollectionAdoption: persist,
			}
		);
		expect(applied.status).toBe("error");
		expect(applied.error).toContain("changed while the update was pending");
		expect(f.fm.zotero_collections).toEqual(["old_collection"]);
		expect(persist).not.toHaveBeenCalled();
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
		const preview = prompt.mock.calls.find((call) => call[0] === "Rename and update the note")?.[1];
		expect(preview).toContain("1 indexed note");
		expect(preview).toContain("does not expose whether automatic link updates are enabled");
	});

	it("rejects frontmatter changed while the user is deciding", async () => {
		const f = fixture();
		const prompt = accept();
		prompt.mockImplementation(async (title, _message, _buttons, review) => {
			if (title === "Rename and update the note") {
				f.fm.citekey = "changed";
				return "create";
			}
			return review ? `review:${JSON.stringify(review.map((row) => (row.kind === "note" ? "remove" : row.defaultValue)))}`
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
			review ? `review:${JSON.stringify(review.map((row) => (row.kind === "note" ? "remove" : row.kind === "body" ? "0" : row.defaultValue)))}`
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
			{ path: "attachments/new.pdf", modified: undefined, role: "Zotero item attachment" },
		]);
		expect(review?.find((row) => row.kind === "body")?.files).toEqual([
			{ path: "attachments/new.pdf", modified: undefined, role: "Zotero item attachment" },
		]);
		expect(review?.find((row) => row.kind === "body")?.label).toBe("Another Obsidian note link: old.pdf");
	});

	it("explains an unresolved note link whose filename matches a Zotero item attachment", async () => {
		const f = fixture();
		f.item.citekey = "old";
		f.app.vault.read = async () => "> [!info]- &nbsp;[**Zotero**]()<!-- zotero-attachments:start --> | **[[new.pdf|PDF]]**<!-- zotero-attachments:end -->\n";
		const prompt = vi.fn(async (_title: string, _message: string, _buttons: DecisionButton[], review?: AttachmentReviewRow[]): Promise<NoteDecision> => (review ? "cancel" : "create")
		);
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const reviewCall = prompt.mock.calls.find((call) => call[3]);
		const review = reviewCall?.[3];
		expect(result.status).toBe("skipped");
		expect(reviewCall?.[1]).toContain("1 note attachment link(s) could not be matched to Zotero attachments.");
		expect(review?.find((row) => row.kind === "note")).toEqual(expect.objectContaining({
			label: "Obsidian note link target: new.pdf",
			description: expect.stringContaining("same filename, but the Obsidian note link could not be resolved"),
			defaultValue: "keep",
			files: [],
		}));
		expect(review?.find((row) => row.kind === "note")?.description).toContain("cannot determine whether they refer to the same file");
		expect(review?.find((row) => row.kind === "add")).toEqual(expect.objectContaining({
			defaultValue: "add",
			files: [{ path: "attachments/new.pdf", modified: undefined, role: "Zotero item attachment",
					},
				],
		}));
	});

	it("explains when resolved attachment files have different contents", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const folder = await setUpIdenticalAttachments(f);
		await writeFile(path.join(folder, "old.pdf"), "different");
		const prompt = vi.fn(async (_title: string, _message: string, _buttons: DecisionButton[], review?: AttachmentReviewRow[]): Promise<NoteDecision> => (review ? "cancel" : "create")
		);
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const review = prompt.mock.calls.find((call) => call[3])?.[3];
		expect(review?.find((row) => row.kind === "note")?.description).toBe("The file contents differ from the available Zotero item attachments.");
	});

	it("explains when files with the same basename resolve to different contents", async () => {
		const f = fixture();
		f.item.citekey = "old";
		const folder = await setUpIdenticalAttachments(f);
		await writeFile(path.join(folder, "old.pdf"), "different");
		const old = Object.assign(new TFile(), { path: "other/new.pdf", extension: "pdf" });
		const lookup = f.app.metadataCache.getFirstLinkpathDest;
		f.app.metadataCache.getFirstLinkpathDest = (link, source) => link === "new.pdf" ? old : lookup(link, source);
		const adapter = f.app.vault.adapter as FileSystemAdapter;
		adapter.getFullPath = (filePath) => path.join(folder, filePath === old.path ? "old.pdf" : "new.pdf");
		f.setBody("> [!info]- &nbsp;[**Zotero**]()<!-- zotero-attachments:start --> | [[new.pdf|PDF]]<!-- zotero-attachments:end -->\n");
		const prompt = vi.fn().mockResolvedValue("cancel");
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const review = prompt.mock.calls[0][3] as AttachmentReviewRow[];
		expect(review.find((row) => row.kind === "note")?.description).toContain("same filename, but the file contents differ");
		expect(review.find((row) => row.kind === "note")?.files?.[0].path).toBe("other/new.pdf");
		expect(review.find((row) => row.kind === "add")?.files?.[0].path).toBe("attachments/new.pdf");
	});

	it("leaves an unrelated PDF link alone instead of offering a Zotero attachment as its replacement", async () => {
		const f = fixture();
		const unrelated = Object.assign(new TFile(), { path: "lit/lit_sources/Jas20.pdf", extension: "pdf",
		});
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

	it("asks before replacing a duplicate attachment and moving a file to Trash", async () => {
		const f = fixture();
		f.item.citekey = "old";
		await setUpIdenticalAttachments(f);
		const prompt = accept();
		const before = f.getBody();
		const prepared = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt, { prepareOnly: true });
		expect(prepared.status).toBe("prepared");
		expect(prepared.identicalAttachments).toHaveLength(1);
		expect(prompt).toHaveBeenCalledWith(
			"Remove duplicate attachment files", expect.stringContaining("Move the duplicate Obsidian files to Trash"),
			expect.any(Array), undefined, expect.any(Object), expect.stringContaining("Move duplicate files to Trash")
		);
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

	it("explains who applies the proposed note and duplicate-file changes", async () => {
		const f = fixture(true);
		f.item.citekey = "old";
		await setUpIdenticalAttachments(f);
		const prompt = vi.fn().mockResolvedValue("cancel");
		const before = f.getBody();
		await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const message = prompt.mock.calls.find((call) => call[0] === "Add the Zotero library and update the note")?.[1] as string;
		expect(message).toContain("Saver will update the note:");
		expect(message).toContain("Set the note's Zotero library identity (zotero_library_uri)");
		expect(message).toContain("Link to 1 Zotero attachment file with identical contents");
		expect(message).toContain("Move the duplicate Obsidian files to Trash after checking for shared references");
		expect(f.getBody()).toBe(before);
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
			review ? `review:${JSON.stringify(review.map((row) => (row.kind === "note" ? "remove" : row.defaultValue)))}`
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
			review ? `review:${JSON.stringify(review.map((row) => (row.kind === "note" ? "remove" : row.kind === "body" ? "0" : row.defaultValue)))}`
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
			return title === "Confirm attachment link changes" ? "cancel" : "create";
		});
		const before = f.getBody();
		const result = await syncLitNote(f.app, { litNotesFolder: "lit" }, f.item, "auto", prompt);
		const preview = prompt.mock.calls.find((call) => call[0] === "Confirm attachment link changes")?.[1];
		expect(preview).toContain("Your Zotero changes");
		expect(preview).toContain("previous → old");
		expect(preview).toContain("Cancel stops this Obsidian update; it does not undo your Zotero citation-key change");
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
