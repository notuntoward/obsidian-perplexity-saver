import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import type { AttachmentProblem } from "./buildLitNote";
import type { AttachmentMoveCandidate, AttachmentMoveOperation } from "./pendingReviews";
import type { ZoteroItemPayload } from "./types";

export interface NoteAttachmentLink {
	/** The link target as written in the note, for reporting links that cannot be carried over. */
	target?: string;
	/** Absolute path of the file Obsidian resolves the link to, if any. */
	absolutePath?: string;
	/** Expected extension (for example ".pdf") from the link target or its label. */
	extension?: string;
}

interface FileInfo {
	path: string;
	size: number;
	mtime: number;
	hash?: string;
}

interface ZoteroFile {
	itemkey: string;
	mode: "linked" | "stored";
	file: FileInfo;
	inVault: boolean;
}

interface Unit {
	zotero?: ZoteroFile;
	note?: FileInfo;
	relinked?: boolean;
	claimed?: boolean;
}

async function digest(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.on("data", (chunk: Buffer) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

async function fileInfo(filePath: string): Promise<FileInfo | undefined> {
	try {
		const info = await stat(filePath);
		return info.isFile() ? { path: filePath, size: info.size, mtime: info.mtimeMs } : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function hashOf(file: FileInfo): Promise<string> {
	file.hash ??= await digest(file.path);
	return file.hash;
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function same(first: string, second: string): boolean {
	return path.resolve(first).toLocaleLowerCase() === path.resolve(second).toLocaleLowerCase();
}

function name(filePath: string): string {
	return path.basename(filePath).toLocaleLowerCase();
}

function extension(filePath: string): string {
	return path.extname(filePath).toLocaleLowerCase();
}

function editDistance(first: string, second: string): number {
	let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
	for (let i = 1; i <= first.length; i++) {
		const current = [i];
		for (let j = 1; j <= second.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
				previous[j - 1] + (first[i - 1] === second[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[second.length];
}

/** The file a unit keeps: the newest non-empty copy when a note file and a Zotero file share a name. */
function winner(unit: Unit): FileInfo {
	if (!unit.zotero) return unit.note!;
	if (!unit.note || same(unit.note.path, unit.zotero.file.path)) return unit.zotero.file;
	if (unit.relinked || unit.zotero.file.size === 0) return unit.note;
	return unit.zotero.file.mtime > unit.note.mtime ? unit.zotero.file : unit.note;
}

/**
 * Plans how to make a Zotero item and its Obsidian note link the same files inside the vault.
 * Returns nothing when the result cannot be determined safely.
 */
export async function buildAttachmentMoveCandidate(
	item: ZoteroItemPayload,
	noteCitekey: string,
	noteLinks: NoteAttachmentLink[],
	problems: AttachmentProblem[],
	vaultRoot: string,
): Promise<AttachmentMoveCandidate | undefined> {
	const base = item.linkedAttachmentBaseDirectory;
	if (!item.linkedAttachmentBaseDirectoryValidated || !base || !path.isAbsolute(base) ||
		item.libraryType !== "user" ||
		noteCitekey !== item.citekey || !problems.length ||
		problems.some((problem) => !problem.path || !problem.itemkey || !["linked", "stored"].includes(problem.mode ?? "") ||
			problem.title !== "Zotero attachment is outside the Obsidian vault" &&
			problem.title !== "Stored Zotero attachment has not been moved into the vault")) return;
	if (!inside(vaultRoot, base) && !same(vaultRoot, base)) return;
	const problemKeys = new Set(problems.map((problem) => problem.itemkey));

	const zotero: ZoteroFile[] = [];
	for (const attachment of item.attachments ?? []) {
		if (attachment.mode !== "linked" && attachment.mode !== "stored") continue;
		if (!attachment.itemkey || !attachment.path || !path.isAbsolute(attachment.path)) return;
		const file = await fileInfo(attachment.path);
		if (!file) return;
		const inVault = inside(vaultRoot, attachment.path);
		if (!inVault && !problemKeys.has(attachment.itemkey)) return;
		zotero.push({ itemkey: attachment.itemkey, mode: attachment.mode, file, inVault });
	}
	if (zotero.filter((entry) => problemKeys.has(entry.itemkey)).length !== problemKeys.size) return;
	const outsideNames = zotero.filter((entry) => !entry.inVault).map((entry) => name(entry.file.path));
	if (new Set(outsideNames).size !== outsideNames.length) return;

	const live: FileInfo[] = [];
	const dead: Array<{ extension?: string; file?: FileInfo; target?: string }> = [];
	for (const link of noteLinks) {
		const file = link.absolutePath ? await fileInfo(link.absolutePath) : undefined;
		if (file && file.size > 0) {
			if (!live.some((entry) => same(entry.path, file.path))) live.push(file);
		} else {
			dead.push({ extension: link.extension ?? (file ? extension(file.path) : undefined), file, target: link.target });
		}
	}

	const units: Unit[] = [];
	const unpairedNotes = [...live];
	for (const entry of zotero) {
		const matches = unpairedNotes.filter((note) => same(note.path, entry.file.path) ||
			(!entry.inVault && name(note.path) === name(entry.file.path)));
		if (matches.length > 1) return;
		if (matches.length) unpairedNotes.splice(unpairedNotes.indexOf(matches[0]), 1);
		units.push({ zotero: entry, note: matches[0] });
	}
	for (const note of unpairedNotes) units.push({ note });

	const expected = (item.attachmentBaseName || item.citekey).toLocaleLowerCase();
	const score = (unit: Unit): [number, number, string] => {
		const file = winner(unit);
		return [
			editDistance(path.basename(file.path, path.extname(file.path)).toLocaleLowerCase(), expected),
			unit.note ? 0 : 1,
			file.path,
		];
	};
	const sizes = new Map<number, number>();
	for (const unit of units) sizes.set(winner(unit).size, (sizes.get(winner(unit).size) ?? 0) + 1);
	const groups = new Map<string, Unit[]>();
	for (const unit of units) {
		const file = winner(unit);
		if (file.size === 0 || (sizes.get(file.size) ?? 0) < 2) continue;
		const key = `${file.size}:${await hashOf(file)}`;
		groups.set(key, [...(groups.get(key) ?? []), unit]);
	}
	const trashZotero: Array<{ zotero: ZoteroFile; keeper: Unit }> = [];
	const trashNotes: string[] = [];
	for (const group of groups.values()) {
		// Only consolidate copies involving a Zotero file; identical note-only files stay as linked extras.
		if (group.length < 2 || !group.some((unit) => unit.zotero)) continue;
		group.sort((first, second) => {
			const [a, b] = [score(first), score(second)];
			return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
		});
		const [keeper, ...losers] = group;
		for (const loser of losers) {
			if (loser.zotero) {
				if (!keeper.zotero) {
					keeper.zotero = loser.zotero;
					keeper.relinked = true;
				} else trashZotero.push({ zotero: loser.zotero, keeper });
			}
			if (loser.note) {
				trashNotes.push(loser.note.path);
				keeper.claimed = true;
			}
			units.splice(units.indexOf(loser), 1);
		}
	}

	const relative = (filePath: string): string => path.relative(vaultRoot, filePath).split(path.sep).join("/");
	const missing: string[] = [];
	for (const link of dead) {
		const available = units.filter((unit) => unit.zotero && !unit.note && !unit.claimed &&
			(!link.extension || extension(unit.zotero.file.path) === link.extension));
		const claim = available.find((unit) => link.file && name(unit.zotero!.file.path) === name(link.file.path)) ?? available[0];
		if (claim) {
			claim.claimed = true;
			// The Zotero file replaces this empty placeholder.
			if (link.file && inside(vaultRoot, link.file.path)) trashNotes.push(link.file.path);
		} else {
			// Nothing replaces this link; keep any empty file and explain the dropped link in the note.
			missing.push(link.file ? relative(link.file.path) : link.target ?? `${link.extension ?? "attachment"} link`);
		}
	}

	const finalPath = (unit: Unit): string => unit.note?.path ??
		(unit.zotero!.inVault ? unit.zotero!.file.path : path.join(base, path.basename(unit.zotero!.file.path)));
	const operations: AttachmentMoveOperation[] = [];
	for (const unit of units) {
		const entry = unit.zotero;
		if (!entry) continue;
		if (unit.note && same(unit.note.path, entry.file.path)) continue;
		if (!unit.note && entry.inVault) continue;
		const destinationPath = finalPath(unit);
		const destination = await fileInfo(destinationPath);
		const identical = !!destination && destination.size === entry.file.size &&
			await hashOf(destination) === await hashOf(entry.file);
		operations.push({
			itemkey: entry.itemkey,
			mode: entry.mode,
			basename: path.basename(entry.file.path),
			sourcePath: entry.file.path,
			destinationPath,
			resolution: unit.note ? unit.relinked ? "keep-destination" : "newest" : "move",
			conflict: !unit.note && !!destination && destination.size > 0 && !identical,
			identical,
			sourceMtime: entry.file.mtime,
			...(destination ? { destinationMtime: destination.mtime } : {}),
		});
	}
	for (const { zotero: entry, keeper } of trashZotero) {
		operations.push({
			itemkey: entry.itemkey,
			mode: entry.mode,
			basename: path.basename(entry.file.path),
			sourcePath: entry.file.path,
			destinationPath: finalPath(keeper),
			resolution: "trash",
			conflict: false,
			identical: true,
			sourceMtime: entry.file.mtime,
		});
	}
	const destinations = operations.filter((operation) => operation.resolution !== "trash").map((operation) => operation.destinationPath);
	if (destinations.some((destination, index) => destinations.findIndex((other) => same(other, destination)) !== index)) return;
	if (!operations.some((operation) => !inside(vaultRoot, operation.sourcePath))) return;

	const finalPaths = units.map(finalPath);
	// A file is accounted for only when the item and the note both had it; every other file is an extra.
	const extras: AttachmentMoveCandidate["extras"] = [
		...units.flatMap((unit) => unit.zotero && (unit.note || unit.claimed) ? [] : [{
			path: relative(finalPath(unit)),
			origin: unit.zotero ? "zotero" as const : "note" as const,
		}]),
		...missing.map((target) => ({ path: target, origin: "missing" as const })),
	];
	return {
		baseDirectory: base,
		attachments: operations,
		linkNoteFiles: units.filter((unit) => unit.note && !unit.zotero).map((unit) => unit.note!.path),
		trashNoteFiles: [...new Set(trashNotes)]
			.filter((filePath) => !finalPaths.some((kept) => same(kept, filePath)) &&
				!destinations.some((destination) => same(destination, filePath)))
			.map(relative),
		extras,
	};
}
