import type { ZoteroItemPayload } from "./types";

export function getNoteZoteroSelectUri(item: Pick<ZoteroItemPayload, "itemkey" | "desktopURI"> & Partial<Pick<ZoteroItemPayload, "libraryURI">>): string {
	const group = item.libraryURI?.match(/\/groups\/(\d+)(?:\/|$)/);
	if (item.itemkey && group) return `zotero://select/groups/${group[1]}/items/${encodeURIComponent(item.itemkey)}`;
	if (item.itemkey) return `zotero://select/library/items/${encodeURIComponent(item.itemkey)}`;
	if (item.desktopURI) {
		const match = item.desktopURI.match(/items\/([A-Za-z0-9]+)/);
		return match ? `zotero://select/library/items/${match[1]}` : item.desktopURI;
	}
	return "";
}
