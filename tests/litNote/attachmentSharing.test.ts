import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { FileSystemAdapter, TFile } from "obsidian";
import type { App } from "obsidian";
import { assertAttachmentsUnshared } from "../../src/litNote/attachmentSharing";
import type { IdenticalAttachment } from "../../src/litNote/attachmentIdentity";

const mocks = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("fs/promises", () => ({ stat: mocks.stat }));

function fixture() {
	const root = path.resolve("test-vault");
	const old = Object.assign(new TFile(), { path: "attachments/old.pdf" });
	const current = Object.assign(new TFile(), { path: "lit/current.md" });
	const other = Object.assign(new TFile(), { path: "lit/other.md" });
	const files = new Map([[old.path, old], [current.path, current], [other.path, other]]);
	const adapter = Object.assign(new FileSystemAdapter(), { getFullPath: (p: string) => path.join(root, p) });
	const metadataCache = {
		resolvedLinks: {} as Record<string, Record<string, number>>,
		unresolvedLinks: {} as Record<string, Record<string, number>>,
		getFileCache: vi.fn<(file: TFile) => object | null>(() => ({})),
	};
	const app = {
		vault: {
			adapter, getMarkdownFiles: () => [current, other],
			getAbstractFileByPath: (p: string) => files.get(p) ?? null,
		},
		metadataCache,
	} as unknown as App;
	const snap = (p: string) => ({ path: p, size: 4, mtime: 1, ctime: 1, sha256: "hash" });
	const pairs: IdenticalAttachment[] = [{ note: snap(old.path), zotero: snap("attachments/new.pdf") }];
	return { app, pairs, metadataCache, current, other, old, oldPath: path.join(root, old.path), survivorPath: path.join(root, "attachments/new.pdf") };
}

describe("duplicate attachment sharing checks", () => {
	beforeEach(() => {
		mocks.stat.mockReset();
	});

	it("allows an unshared file and verifies that the Zotero survivor exists", async () => {
		const f = fixture();
		mocks.stat.mockImplementation(async (p: string) => ({
			dev: 1, ino: p === f.oldPath ? 1 : 2, isFile: () => true,
		}));
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath])).resolves.toBeUndefined();
	});

	it("blocks a duplicate linked by another note, including a filesystem alias", async () => {
		const f = fixture();
		const alias = Object.assign(new TFile(), { path: "attachments/alias.pdf" });
		const originalLookup = f.app.vault.getAbstractFileByPath;
		f.app.vault.getAbstractFileByPath = (p: string) => p === alias.path ? alias : originalLookup(p);
		f.metadataCache.resolvedLinks[f.other.path] = { [alias.path]: 1 };
		mocks.stat.mockImplementation(async (p: string) => ({
			dev: 1, ino: p === f.survivorPath ? 2 : 1, isFile: () => true,
		}));
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath]))
			.rejects.toThrow("also links to attachments/old.pdf");
	});

	it("blocks links found in note metadata even when the resolved-links index is stale", async () => {
		const f = fixture();
		mocks.stat.mockImplementation(async (p: string) => ({
			dev: 1, ino: p === f.survivorPath ? 2 : 1, isFile: () => true,
		}));
		f.metadataCache.getFileCache.mockImplementation((file) =>
			file === f.other ? { embeds: [{ link: "attachments/old.pdf" }] } : {});
		f.app.metadataCache.getFirstLinkpathDest = () => f.old;
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath]))
			.rejects.toThrow("also links to attachments/old.pdf");
	});

	it("blocks a duplicate referenced by any Zotero attachment", async () => {
		const f = fixture();
		mocks.stat.mockImplementation(async (p: string) => ({
			dev: 1, ino: p === f.survivorPath ? 2 : 1, isFile: () => true,
		}));
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath, f.oldPath]))
			.rejects.toThrow("Another Zotero attachment uses");
	});

	it("blocks a duplicate referenced by a literature-note property", async () => {
		const f = fixture();
		mocks.stat.mockImplementation(async (p: string) => ({
			dev: 1, ino: p === f.survivorPath ? 2 : 1, isFile: () => true,
		}));
		f.metadataCache.getFileCache.mockReturnValue({ frontmatterLinks: [{ link: "attachments/old.pdf", key: "file" }] });
		f.app.metadataCache.getFirstLinkpathDest = () => f.old;
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath]))
			.rejects.toThrow("has a property linking to attachments/old.pdf");
	});

	it("blocks removal when a note is unindexed or has an unresolved possible attachment", async () => {
		const f = fixture();
		mocks.stat.mockImplementation(async (p: string) => ({
			dev: 1, ino: p === f.survivorPath ? 2 : 1, isFile: () => true,
		}));
		f.metadataCache.getFileCache.mockReturnValueOnce(null);
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath]))
			.rejects.toThrow("has not indexed");
		f.metadataCache.unresolvedLinks[f.other.path] = { "missing.pdf#page=1": 1 };
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath]))
			.rejects.toThrow("unresolved attachment link");
		f.metadataCache.unresolvedLinks[f.other.path] = { "old#page=1": 1 };
		await expect(assertAttachmentsUnshared(f.app, f.current.path, f.pairs, [f.survivorPath]))
			.rejects.toThrow("unresolved attachment link");
	});
});
