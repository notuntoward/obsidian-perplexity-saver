import type { ZoteroItemPayload } from "./types";

export type CollectionAdoptionState =
	{ status: "managed"; baseline: string[] } | { status: "obsidian" };

export type CollectionAdoptions = Record<string, CollectionAdoptionState>;

function isRecord(input: unknown): input is Record<string, unknown> {
	return !!input && typeof input === "object" && !Array.isArray(input);
}

export function sameCollectionMembership(left: unknown, right: unknown): boolean {
	const list = (value: unknown): string[] | undefined => {
		if (value === undefined) return [];
		return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? value : undefined;
	};
	const a = list(left);
	const b = list(right);
	if (!a || !b) return false;
	const leftSet = new Set(a);
	const rightSet = new Set(b);
	return leftSet.size === rightSet.size && [...leftSet].every((entry) => rightSet.has(entry));
}

export function collectionAdoptionKey(
	item: Pick<ZoteroItemPayload, "itemkey" | "libraryURI">
): string | undefined {
	if (!item.itemkey || !item.libraryURI) return undefined;
	return JSON.stringify([item.libraryURI, item.itemkey]);
}

export function getCollectionAdoption(
	adoptions: CollectionAdoptions | undefined,
	item: Pick<ZoteroItemPayload, "itemkey" | "libraryURI">
): CollectionAdoptionState | undefined {
	const key = collectionAdoptionKey(item);
	if (!key) return undefined;
	const state: unknown = adoptions?.[key];
	if (!isRecord(state)) return undefined;
	const candidate = state;
	if (candidate.status === "obsidian") return { status: "obsidian" };
	if (
		candidate.status === "managed" &&
		Array.isArray(candidate.baseline) &&
		candidate.baseline.every((value) => typeof value === "string")
	) {
		return { status: "managed", baseline: candidate.baseline };
	}
	return undefined;
}

export function isCollectionAdoptions(input: unknown): input is CollectionAdoptions {
	if (!isRecord(input)) return false;
	return Object.values(input).every((state) => {
		if (!isRecord(state)) return false;
		const candidate = state;
		return (
			candidate.status === "obsidian" ||
			(candidate.status === "managed" &&
				Array.isArray(candidate.baseline) &&
				candidate.baseline.every((value) => typeof value === "string"))
		);
	});
}
