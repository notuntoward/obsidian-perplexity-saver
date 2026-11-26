import { parseLinktext, TFile } from "obsidian";
import type { App } from "obsidian";

/**
 * Resolves an attachment link without Obsidian's implicit ".md" fallback, which
 * turns a broken "x.html" link into a note named "x.html.md".
 */
export function attachmentLinkDestination(app: App, link: string, sourcePath: string): TFile | null {
	const linkPath = parseLinktext(link).path;
	const file = app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
	if (!(file instanceof TFile)) return null;
	const name = linkPath.split("/").pop()?.toLowerCase() ?? "";
	const extension = name.includes(".") ? name.split(".").pop() : undefined;
	return extension && extension !== "md" && file.path.split("/").pop()?.toLowerCase() === `${name}.md` ? null : file;
}
