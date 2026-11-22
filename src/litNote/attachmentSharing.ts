import { stat } from "fs/promises";
import path from "path";
import { FileSystemAdapter, parseLinktext, TFile } from "obsidian";
import type { App } from "obsidian";
import type { IdenticalAttachment } from "./attachmentIdentity";

interface FileIdentity {
	dev: number;
	ino: number;
}

function sameFile(first: FileIdentity, second: FileIdentity): boolean {
	return first.dev === second.dev && first.ino === second.ino;
}

export async function assertAttachmentsUnshared(
	app: App,
	notePath: string,
	pairs: IdenticalAttachment[],
	zoteroPaths: string[],
	previousNotePath = notePath
): Promise<void> {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) throw new Error("Cannot verify shared files without a desktop vault.");
	if (!app.metadataCache.resolvedLinks || !app.metadataCache.unresolvedLinks) {
		throw new Error("Obsidian's link index is unavailable; duplicate attachments were not removed.");
	}
	for (const file of app.vault.getMarkdownFiles()) {
		if (!app.metadataCache.getFileCache(file)) {
			throw new Error(`Obsidian has not indexed ${file.path}; duplicate attachments were not removed.`);
		}
	}
	const identities = new Map<string, FileIdentity>();
	async function identity(absolutePath: string): Promise<FileIdentity> {
		const cached = identities.get(absolutePath);
		if (cached) return cached;
		if (!path.isAbsolute(absolutePath)) throw new Error("A Zotero attachment path is not absolute.");
		const info = await stat(absolutePath);
		if (!info.isFile() || !info.ino) throw new Error(`Cannot verify attachment identity: ${absolutePath}`);
		const value = { dev: info.dev, ino: info.ino };
		identities.set(absolutePath, value);
		return value;
	}
	const zoteroIdentities = [];
	for (const attachmentPath of zoteroPaths) zoteroIdentities.push(await identity(attachmentPath));
	for (const pair of pairs) {
		if (pair.note.path === pair.zotero.path) continue;
		const duplicate = await identity(adapter.getFullPath(pair.note.path));
		const survivor = await identity(adapter.getFullPath(pair.zotero.path));
		if (sameFile(duplicate, survivor)) {
			throw new Error(`The duplicate and surviving attachment refer to the same file: ${pair.note.path}`);
		}
		if (!zoteroIdentities.some((candidate) => sameFile(candidate, survivor))) {
			throw new Error(`The surviving Zotero attachment could not be verified: ${pair.zotero.path}`);
		}
		if (zoteroIdentities.some((candidate) => sameFile(candidate, duplicate))) {
			throw new Error(`Another Zotero attachment uses ${pair.note.path}; it was not removed.`);
		}
		const note = app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) throw new Error("The literature note is unavailable for checking attachment links.");
		const cache = app.metadataCache.getFileCache(note);
		if (!cache) throw new Error("The literature note is not indexed; duplicate attachments were not removed.");
		const extension = path.extname(pair.note.path).toLowerCase();
		const basename = path.basename(pair.note.path, path.extname(pair.note.path)).toLowerCase();
		const couldReferToDuplicate = (linkPath: string): boolean => {
			const linkExtension = path.extname(linkPath).toLowerCase();
			return linkExtension === extension ||
				(!linkExtension && path.basename(linkPath).toLowerCase() === basename);
		};
		for (const reference of cache.frontmatterLinks ?? []) {
			const linkPath = parseLinktext(reference.link).path;
			const target = app.metadataCache.getFirstLinkpathDest(linkPath, notePath);
			if (target instanceof TFile && sameFile(await identity(adapter.getFullPath(target.path)), duplicate)) {
				throw new Error(`The literature note has a property linking to ${pair.note.path}; it was not removed.`);
			}
			if (!target && couldReferToDuplicate(linkPath)) {
				throw new Error(`An unresolved literature-note property could refer to ${pair.note.path}; it was not removed.`);
			}
		}
		for (const source of app.vault.getMarkdownFiles()) {
			if (source.path === notePath || source.path === previousNotePath) continue;
			const metadata = app.metadataCache.getFileCache(source);
			if (!metadata) throw new Error(`Obsidian has not indexed ${source.path}; duplicate attachments were not removed.`);
			for (const reference of [...(metadata.links ?? []), ...(metadata.embeds ?? []), ...(metadata.frontmatterLinks ?? [])]) {
				const linkPath = parseLinktext(reference.link).path;
				const target = app.metadataCache.getFirstLinkpathDest(linkPath, source.path);
				if (target instanceof TFile && sameFile(await identity(adapter.getFullPath(target.path)), duplicate)) {
					throw new Error(`${source.path} also links to ${pair.note.path}; it was not removed.`);
				}
				if (!target && couldReferToDuplicate(linkPath)) {
					throw new Error(`An unresolved attachment link in ${source.path} could refer to ${pair.note.path}; it was not removed.`);
				}
			}
		}
		for (const [source, destinations] of Object.entries(app.metadataCache.unresolvedLinks)) {
			if (source !== notePath && source !== previousNotePath &&
				Object.keys(destinations).some((link) => couldReferToDuplicate(parseLinktext(link).path))) {
				throw new Error(`An unresolved attachment link in ${source} could refer to ${pair.note.path}; it was not removed.`);
			}
		}
		for (const [source, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
			if (source === notePath || source === previousNotePath) continue;
			for (const destination of Object.keys(destinations)) {
				const file = app.vault.getAbstractFileByPath(destination);
				if (!(file instanceof TFile)) throw new Error(`Obsidian's link index is stale: ${destination}`);
				if (sameFile(await identity(adapter.getFullPath(file.path)), duplicate)) {
					throw new Error(`${source} also links to ${pair.note.path}; it was not removed.`);
				}
			}
		}
	}
}
