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
	ctime: number;
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
		return info.isFile() ? { path: filePath, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs } : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function hashOf(file: FileInfo): Promise<string> {
	file.hash ??= await digest(file.path);
	return file.hash;
}

export async function validateTrashNoteFile(
	vaultRoot: string,
	snapshot: NonNullable<AttachmentMoveCandidate["trashNoteSnapshots"]>[number],
): Promise<void> {
	const filePath = path.resolve(vaultRoot, snapshot.path);
	if (!inside(vaultRoot, filePath)) throw new Error("A duplicate attachment is outside the vault; it was not trashed.");
	const before = await fileInfo(filePath);
	if (!before || before.size !== snapshot.size || before.mtime !== snapshot.mtime || before.ctime !== snapshot.ctime ||
		await hashOf(before) !== snapshot.sha256) {
		throw new Error(`Attachment ${snapshot.path} changed since review; it was not trashed.`);
	}
	const after = await fileInfo(filePath);
	if (!after || after.size !== before.size || after.mtime !== before.mtime || after.ctime !== before.ctime) {
		throw new Error(`Attachment ${snapshot.path} changed during verification; it was not trashed.`);
	}
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
	explain?: (reason: string) => void,
): Promise<AttachmentMoveCandidate | undefined> {
	const base = item.linkedAttachmentBaseDirectory;
	const reject = (reason: string): undefined => { explain?.(reason); return undefined; };
	if (!item.linkedAttachmentBaseDirectoryValidated || !base || !path.isAbsolute(base))
		return reject("Obsidian has not yet confirmed its Linked Attachment Base Directory.");
	if (item.libraryType !== "user") return reject("Zotero does not support linked attachments in group libraries.");
	if (noteCitekey !== item.citekey) return reject(`The note's citekey (${noteCitekey}) differs from Zotero's.`);
	if (!problems.length ||
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
	const expectedName = item.attachmentBaseName;
	if (!expectedName || path.basename(expectedName) !== expectedName ||
		/[<>:"/\\|?*]/.test(expectedName) || Array.from(expectedName).some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(expectedName) ||
		/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(expectedName)) {
		return reject("Zotero's attachment naming format did not produce a valid filename.");
	}
	for (const entry of [...zotero.filter((file) => file.inVault), ...zotero.filter((file) => !file.inVault)]) {
		const matches = unpairedNotes.filter((note) => same(note.path, entry.file.path) ||
			(!entry.inVault && name(note.path) === name(entry.file.path)));
		if (matches.length > 1) return;
		if (matches.length) unpairedNotes.splice(unpairedNotes.indexOf(matches[0]), 1);
		units.push({ zotero: entry, note: matches[0] });
	}
	for (const note of unpairedNotes) units.push({ note });

	const expected = expectedName.toLocaleLowerCase();
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
		if (unit.note && unit.zotero && !same(unit.note.path, unit.zotero.file.path) &&
			(unit.note.size !== unit.zotero.file.size || await hashOf(unit.note) !== await hashOf(unit.zotero.file))) continue;
		const key = `${extension(file.path)}:${file.size}:${await hashOf(file)}`;
		groups.set(key, [...(groups.get(key) ?? []), unit]);
	}
	const trashZotero: Array<{ zotero: ZoteroFile; keeper: Unit }> = [];
	const trashNotes: FileInfo[] = [];
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
				trashNotes.push(loser.note);
				keeper.claimed = true;
			}
			units.splice(units.indexOf(loser), 1);
		}
	}

	const relative = (filePath: string): string => path.relative(vaultRoot, filePath).split(path.sep).join("/");
	const missing: string[] = [];
	for (const link of dead) {
		const available = units.filter((unit) => unit.zotero && unit.zotero.file.size > 0 && !unit.note && !unit.claimed &&
			(!link.extension || extension(unit.zotero.file.path) === link.extension));
		const claim = available.find((unit) => link.file && name(unit.zotero!.file.path) === name(link.file.path)) ?? available[0];
		if (claim) {
			claim.claimed = true;
			// The Zotero file replaces this empty placeholder.
			if (link.file && inside(vaultRoot, link.file.path)) trashNotes.push(link.file);
		} else {
			// Nothing replaces this link; keep any empty file and explain the dropped link in the note.
			missing.push(link.file ? relative(link.file.path) : link.target ?? `${link.extension ?? "attachment"} link`);
		}
	}

	const plannedPaths = new Map<Unit, string>();
	const usedPaths = units.flatMap((unit) => unit.note ? [unit.note.path] :
		unit.zotero?.inVault ? [unit.zotero.file.path] : []);
	for (const unit of units) {
		if (unit.note) plannedPaths.set(unit, unit.note.path);
		else if (unit.zotero?.inVault) plannedPaths.set(unit, unit.zotero.file.path);
		else if (unit.zotero) {
			const ext = path.extname(unit.zotero.file.path);
			let index = 1;
			let destination = path.join(base, `${expectedName}${ext}`);
			while (usedPaths.some((used) => same(used, destination))) {
				destination = path.join(base, `${expectedName} ${++index}${ext}`);
			}
			usedPaths.push(destination);
			plannedPaths.set(unit, destination);
		}
	}
	const finalPath = (unit: Unit): string => {
		const destination = plannedPaths.get(unit);
		if (!destination) throw new Error("An attachment has no planned destination.");
		return destination;
	};
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
			resolution: unit.note ? unit.relinked || (identical && name(unit.note.path) !== name(entry.file.path))
				? "keep-destination" : "newest" : "move",
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
	const trashFiles = [...new Map(trashNotes.map((file) => [file.path, file])).values()]
		.filter((file) => !finalPaths.some((kept) => same(kept, file.path)) &&
			!destinations.some((destination) => same(destination, file.path)));
	const trashNoteSnapshots: NonNullable<AttachmentMoveCandidate["trashNoteSnapshots"]> = [];
	for (const original of trashFiles) {
		const filePath = original.path;
		const file = await fileInfo(filePath);
		if (!file || file.size !== original.size || file.mtime !== original.mtime || file.ctime !== original.ctime)
			return reject(`Attachment ${filePath} changed during review.`);
		const sha256 = await hashOf(file);
		const after = await fileInfo(filePath);
		if (!after || after.size !== file.size || after.mtime !== file.mtime || after.ctime !== file.ctime) {
			return reject(`Attachment ${filePath} changed during review.`);
		}
		trashNoteSnapshots.push({ path: relative(filePath), size: file.size, mtime: file.mtime, ctime: file.ctime, sha256 });
	}
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
		trashNoteFiles: trashFiles.map((file) => relative(file.path)),
		trashNoteSnapshots,
		extras,
	};
}
