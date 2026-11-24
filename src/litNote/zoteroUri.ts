import type { ZoteroItemPayload } from "./types";

export function getNoteZoteroSelectUri(item: Pick<ZoteroItemPayload, "itemkey" | "desktopURI">): string {
	if (item.itemkey) return `zotero://select/library/items/${item.itemkey}`;
	if (item.desktopURI) {
		const match = item.desktopURI.match(/items\/([A-Za-z0-9]+)/);
		return match ? `zotero://select/library/items/${match[1]}` : item.desktopURI;
	}
	return "";
}
