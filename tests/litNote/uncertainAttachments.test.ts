import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { FileSystemAdapter, TFile } from "obsidian";
import type { App } from "obsidian";
import type { PendingReview } from "../../src/litNote/pendingReviews";
import { inspectUncertainAttachments } from "../../src/litNote/uncertainAttachments";

const root = mkdtempSync(path.join(os.tmpdir(), "saver-review-"));
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("uncertain attachment inspection", () => {
	it("reports each current file, broken note links, and recorded paths without changing files", async () => {
		const source = path.join(root, "original.pdf");
		const destination = path.join(root, "vault.pdf");
		const missing = path.join(root, "missing.pdf");
		writeFileSync(source, "original");
		writeFileSync(destination, "vault");
		const note = Object.assign(new TFile(), { path: "note.md" });
		const vaultFile = Object.assign(new TFile(), { path: "vault.pdf" });
		const adapter = Object.assign(new FileSystemAdapter(), { getFullPath: () => destination });
		const app = {
			vault: { adapter, getAbstractFileByPath: () => note },
			metadataCache: {
				getFileCache: () => ({ links: [{ link: "vault" }, { link: "missing.pdf" }] }),
				getFirstLinkpathDest: (target: string) => target === "vault" ? vaultFile : null,
			},
		} as unknown as App;
		const review = {
			notePath: "note.md",
			uncertainAttachments: [
				{ itemkey: "A", title: "Original", path: source, mode: "stored" },
				{ itemkey: "B", title: "Vault", path: destination, mode: "linked" },
			],
			uncertainAttachmentPaths: [{ itemkey: "A", sourcePath: source, destinationPath: missing }],
		} as PendingReview;
		const result = await inspectUncertainAttachments(app, review);
		expect(result.paths).toEqual([
			{ label: "Zotero attachment", path: source, status: "Original: File exists. No note attachment link resolves to this path." },
			{ label: "Zotero attachment", path: destination, status: "Vault: File exists. The note links to this path." },
			{ label: "Planned vault location", path: missing, status: "File is missing." },
		]);
		expect(result.message).toContain("Obsidian attachment link does not resolve: missing.pdf");
	});

	it("reports unavailable evidence rather than claiming links or copies are safe", async () => {
		const app = { vault: { adapter: {}, getAbstractFileByPath: () => null } } as unknown as App;
		const result = await inspectUncertainAttachments(app, { uncertainAttachmentCheckError: "Zotero unavailable" } as PendingReview);
		expect(result.message).toContain("The note's attachment links could not be checked.");
		expect(result.message).toContain("Zotero unavailable");
		expect(result.message).toContain("did not record");
		expect(result.paths).toEqual([]);
	});
});
