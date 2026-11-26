import { Notice } from "obsidian";

export interface ItemTrashRequest {
	id: string;
	itemkey: string;
	libraryURI: string;
	title: string;
}

const requests = new Map<string, ItemTrashRequest>();

/**
 * Ask Zotero to move items to its trash. Zotero collects the requests on its next poll and reports
 * each result; a request that is already done is reported as done, so a retry is harmless.
 */
export function requestItemTrash(items: Array<Omit<ItemTrashRequest, "id">>): void {
	for (const item of items) {
		const id = JSON.stringify([item.libraryURI, item.itemkey]);
		if (!requests.has(id)) requests.set(id, { id, ...item });
	}
}

export function itemTrashRequests(): ItemTrashRequest[] {
	return [...requests.values()];
}

export function finishItemTrash(id: string, error?: string): boolean {
	const request = requests.get(id);
	if (!request) return false;
	requests.delete(id);
	new Notice(error
		? `Zotero did not move "${request.title}" to its trash: ${error}`
		: `Zotero moved "${request.title}" to its trash.`, error ? 0 : 6000);
	return true;
}

export function clearItemTrashRequests(): void {
	requests.clear();
}
