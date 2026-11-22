import { createHash } from "crypto";
import { open, stat } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { FileSystemAdapter } from "obsidian";
import type { App, TFile } from "obsidian";

export interface AttachmentSnapshot {
	path: string;
	size: number;
	mtime: number;
	ctime: number;
	sha256: string;
}

export interface IdenticalAttachment {
	note: AttachmentSnapshot;
	zotero: AttachmentSnapshot;
}

async function readChunk(handle: FileHandle, buffer: Buffer, length: number, position: number): Promise<void> {
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (!bytesRead) throw new Error("An attachment was truncated while being compared.");
		offset += bytesRead;
	}
}

async function compareFiles(app: App, note: TFile, zotero: TFile): Promise<IdenticalAttachment | null> {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) throw new Error("Attachment comparison requires a desktop vault.");
	const files = [note, zotero] as const;
	const paths = files.map((file) => adapter.getFullPath(file.path));
	const before = await Promise.all(files.map((file) => adapter.stat(file.path)));
	if (before.some((entry) => !entry || entry.type !== "file")) {
		throw new Error("An attachment is unavailable for comparison.");
	}
	const noteStat = before[0]!;
	const zoteroStat = before[1]!;
	if (noteStat.size !== zoteroStat.size) return null;
	const first = await open(paths[0], "r");
	try {
		const second = await open(paths[1], "r");
		try {
			const handles = [first, second];
			const handleBefore = await Promise.all(handles.map((handle) => handle.stat()));
			const buffers = [Buffer.allocUnsafe(256 * 1024), Buffer.allocUnsafe(256 * 1024)];
			const hash = createHash("sha256");
			let identical = true;
			for (let position = 0; position < noteStat.size; position += buffers[0].length) {
				const length = Math.min(buffers[0].length, noteStat.size - position);
				await Promise.all(handles.map((handle, index) => readChunk(handle, buffers[index], length, position)));
				if (!buffers[0].subarray(0, length).equals(buffers[1].subarray(0, length))) {
					identical = false;
					break;
				}
				hash.update(buffers[0].subarray(0, length));
			}
			const after = await Promise.all(files.map((file) => adapter.stat(file.path)));
			const handleAfter = await Promise.all(handles.map((handle) => handle.stat()));
			const pathAfter = await Promise.all(paths.map((filePath) => stat(filePath)));
			for (let index = 0; index < files.length; index++) {
				const a = before[index]!;
				const b = after[index];
				const h = handleBefore[index];
				const h2 = handleAfter[index];
				const p = pathAfter[index];
				if (!b || b.type !== "file" || a.size !== b.size || a.mtime !== b.mtime || a.ctime !== b.ctime ||
					h.size !== a.size || h.size !== h2.size || h.mtimeMs !== h2.mtimeMs || h.ctimeMs !== h2.ctimeMs ||
					h.dev !== p.dev || h.ino !== p.ino) {
					throw new Error(`Attachment changed while being read: ${files[index].path}`);
				}
			}
			if (!identical) return null;
			const sha256 = hash.digest("hex");
			return {
				note: { path: note.path, size: noteStat.size, mtime: noteStat.mtime, ctime: noteStat.ctime, sha256 },
				zotero: { path: zotero.path, size: zoteroStat.size, mtime: zoteroStat.mtime, ctime: zoteroStat.ctime, sha256 },
			};
		} finally {
			await second.close();
		}
	} finally {
		await first.close();
	}
}

export async function findIdenticalAttachments(
	app: App,
	noteFiles: TFile[],
	zoteroFiles: TFile[]
): Promise<IdenticalAttachment[]> {
	const zotero = [...zoteroFiles].sort((a, b) => a.path.localeCompare(b.path));
	const matches: IdenticalAttachment[] = [];
	for (const file of noteFiles) {
		for (const candidate of zotero) {
			const match = await compareFiles(app, file, candidate);
			if (match) {
				matches.push(match);
				break;
			}
		}
	}
	return matches;
}
