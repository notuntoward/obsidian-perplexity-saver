import { stat } from "fs/promises";
import path from "path";
import { FileSystemAdapter, parseLinktext, TFile } from "obsidian";
import type { App } from "obsidian";
import type { PendingReview } from "./pendingReviews";

export interface UncertainAttachmentDetails {
	message: string;
	paths: Array<{ label: string; path: string; status: string }>;
}

function samePath(first: string, second: string): boolean {
	if (!path.isAbsolute(first) || !path.isAbsolute(second)) return false;
	const a = path.resolve(first);
	const b = path.resolve(second);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function fileStatus(filePath: string): Promise<string> {
	if (!path.isAbsolute(filePath)) return "Path is not absolute; file not checked.";
	try {
		const info = await stat(filePath);
		return info.isFile() ? "File exists." : "Not a file.";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "File is missing.";
		return `Could not check file: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export async function inspectUncertainAttachments(app: App, review: PendingReview): Promise<UncertainAttachmentDetails> {
	const paths: UncertainAttachmentDetails["paths"] = [];
	const messages: string[] = [];
	const adapter = app.vault.adapter;
	const note = review.notePath ? app.vault.getAbstractFileByPath(review.notePath) : null;
	const cache = note instanceof TFile ? app.metadataCache.getFileCache(note) : null;
	const noteLinks: Array<{ target: string; path?: string }> = [];
	if (note instanceof TFile && cache && adapter instanceof FileSystemAdapter) {
		const extensions = new Set([".pdf", ".html", ".htm", ".doc", ".docx", ".ppt", ".pptx", ".epub", ".txt"]);
		for (const attachment of review.uncertainAttachments ?? []) {
			if (attachment.path) extensions.add(path.extname(attachment.path).toLowerCase());
		}
		for (const reference of [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])]) {
			const target = parseLinktext(reference.link).path;
			const file = app.metadataCache.getFirstLinkpathDest(target, note.path);
			if (!extensions.has(path.extname(file instanceof TFile ? file.path : target).toLowerCase())) continue;
			noteLinks.push({ target, path: file instanceof TFile ? adapter.getFullPath(file.path) : undefined });
		}
	} else {
		messages.push("The note's attachment links could not be checked.");
	}
	if (review.uncertainAttachmentCheckError) {
		messages.push(`Zotero attachment details could not be checked: ${review.uncertainAttachmentCheckError}`);
	} else if (!review.uncertainAttachments) {
		messages.push("Zotero attachment details are unavailable. Keep Zotero open and try again.");
	} else {
		if (review.uncertainAttachmentsCheckedAt) {
			messages.push(`Zotero attachment details last received at ${new Date(review.uncertainAttachmentsCheckedAt).toLocaleTimeString()}.`);
		}
		if (!review.uncertainAttachments.length) messages.push("Zotero reported no file attachments for this item.");
	}
	for (const attachment of review.uncertainAttachments ?? []) {
		const label = attachment.title || attachment.itemkey || "Attachment";
		const attachmentPath = attachment.path;
		if (!attachmentPath) {
			messages.push(`${label}: Zotero did not provide a file path.`);
			continue;
		}
		const linkStatus = cache && adapter instanceof FileSystemAdapter
			? noteLinks.some((link) => link.path && samePath(link.path, attachmentPath))
				? "The note links to this path."
				: "No note attachment link resolves to this path."
			: "The note link could not be checked.";
		paths.push({ label: "Zotero attachment", path: attachmentPath, status: `${label}: ${await fileStatus(attachmentPath)} ${linkStatus}` });
	}
	for (const link of noteLinks) {
		if (!link.path) messages.push(`Obsidian attachment link does not resolve: ${link.target}`);
		else if (!(review.uncertainAttachments ?? []).some((attachment) => attachment.path && link.path && samePath(attachment.path, link.path))) {
			paths.push({ label: "Obsidian attachment", path: link.path, status: await fileStatus(link.path) });
		}
	}
	for (const planned of review.uncertainAttachmentPaths ?? []) {
		for (const [label, filePath] of [["Original before the attempt", planned.sourcePath], ["Planned vault location", planned.destinationPath]] as const) {
			if (paths.some((entry) => samePath(entry.path, filePath))) continue;
			paths.push({ label, path: filePath, status: await fileStatus(filePath) });
		}
	}
	if (!review.uncertainAttachmentPaths) messages.push("The earlier attempt did not record its original and destination paths.");
	return { message: messages.join("\n"), paths };
}
