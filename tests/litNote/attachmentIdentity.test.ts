import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rmdir, stat, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { FileSystemAdapter, TFile } from "obsidian";
import type { App } from "obsidian";
import { findIdenticalAttachments } from "../../src/litNote/attachmentIdentity";

const temporaryFiles: Array<{ folder: string; names: string[] }> = [];
afterEach(async () => {
	for (const { folder, names } of temporaryFiles.splice(0)) {
		for (const name of names) await unlink(path.join(folder, name));
		await rmdir(folder);
	}
});

async function fixture(contents: Record<string, string>) {
	const folder = await mkdtemp(path.join(tmpdir(), "lit-attachment-test-"));
	const names = Object.keys(contents);
	temporaryFiles.push({ folder, names });
	await Promise.all(names.map((name) => writeFile(path.join(folder, name), contents[name])));
	const files = Object.fromEntries(names.map((name) => [name, Object.assign(new TFile(), { path: name })]));
	const statFile = vi.fn(async (name: string) => {
		const info = await stat(path.join(folder, name));
		return { type: "file" as const, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs };
	});
	const adapter = Object.assign(new FileSystemAdapter(), {
		getFullPath: (name: string) => path.join(folder, name), stat: statFile,
	});
	const app = { vault: { adapter } } as unknown as App;
	return { app, files, statFile };
}

describe("attachment identity", () => {
	it("selects a deterministic Zotero survivor only for identical bytes", async () => {
		const f = await fixture({ "note.pdf": "same", "z2.pdf": "same", "z1.pdf": "same", "other.pdf": "diff" });
		const matches = await findIdenticalAttachments(f.app, [f.files["note.pdf"], f.files["other.pdf"]], [
			f.files["z2.pdf"], f.files["z1.pdf"],
		]);
		expect(matches).toHaveLength(1);
		expect(matches[0].note.path).toBe("note.pdf");
		expect(matches[0].zotero.path).toBe("z1.pdf");
		expect(matches[0].note.sha256).toBe(matches[0].zotero.sha256);
	});

	it("rejects a file that changes while its bytes are read", async () => {
		const f = await fixture({ "note.pdf": "same", "z.pdf": "same" });
		const readStat = f.statFile.getMockImplementation()!;
		let noteReads = 0;
		f.statFile.mockImplementation(async (name) => {
			const info = await readStat(name);
			return name === "note.pdf" && ++noteReads > 1 ? { ...info, mtime: info.mtime + 1 } : info;
		});
		await expect(findIdenticalAttachments(f.app, [f.files["note.pdf"]], [f.files["z.pdf"]]))
			.rejects.toThrow("Attachment changed while being read: note.pdf");
	});

	it("compares the entire file across chunk boundaries", async () => {
		const prefix = "x".repeat(256 * 1024);
		const f = await fixture({ "note.pdf": `${prefix}a`, "same.pdf": `${prefix}a`, "different.pdf": `${prefix}b` });
		expect(await findIdenticalAttachments(f.app, [f.files["note.pdf"]], [f.files["different.pdf"]])).toEqual([]);
		expect(await findIdenticalAttachments(f.app, [f.files["note.pdf"]], [f.files["same.pdf"]])).toHaveLength(1);
	});
});
