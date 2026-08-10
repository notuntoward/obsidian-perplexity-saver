import { App } from "obsidian";
import { parseSourceLine, renderSourceLine, SourceLinkState } from "./sourceLinkState";
import { ZoteroClient, ZoteroItemData } from "./zoteroClient";
import { findLitNoteForCitekey } from "./matcher";
import type { AutoRelinkSettings } from "./autoRelink";

export interface RelinkOptions {
	zoteroPort?: number;
	litNotesFolder?: string;
	minTitleMatchScore?: number;
	zoteroClient?: ZoteroClient;
	forceRefresh?: boolean;
	cacheTtlMs?: number;
	onProgress?: (message: string) => void;
}

export interface RelinkResult {
	updatedText: string;
	relinkedCount: number;
	zoteroCount: number;
	litNoteCount: number;
}

/**
 * Automatically relinks sources in note text if autoRelinkSources setting is enabled.
 * Catches any connection/Zotero errors and displays a Notice without blocking the main workflow.
 */
export async function autoRelinkSourcesInNote(
	app: App,
	noteText: string,
	settings: AutoRelinkSettings,
	zoteroClient?: ZoteroClient
): Promise<string> {
	if (!settings.autoRelinkSources) {
		return noteText;
	}

	try {
		const result = await relinkSourcesInNote(app, noteText, {
			zoteroPort: settings.zoteroPort,
			litNotesFolder: settings.litNotesFolder,
			minTitleMatchScore: settings.minTitleMatchScore,
			zoteroClient,
		});
		return result.updatedText;
	} catch (err: any) {
		console.warn("Auto-relinking failed:", err);
		const { Notice } = await import("obsidian");
		new Notice("Auto-relinking with Zotero failed: Zotero may not be running.");
		return noteText;
	}
}

/**
 * Relink sources in an AI note's text by checking Zotero and Obsidian literature notes.
 */
export async function relinkSourcesInNote(
	app: App,
	noteText: string,
	options: RelinkOptions = {}
): Promise<RelinkResult> {
	const minScore = options.minTitleMatchScore ?? 95;
	const client = options.zoteroClient ?? new ZoteroClient({ port: options.zoteroPort ?? 23119 });

	let zoteroItems: ZoteroItemData[] = [];
	try {
		zoteroItems = await client.getItems({
			forceRefresh: options.forceRefresh,
			ttlMs: options.cacheTtlMs,
			onProgress: options.onProgress,
		});
	} catch (err: any) {
		console.warn("Could not connect to local Zotero HTTP API:", err);
		const detail = err?.message ? ` (${err.message})` : "";
		throw new Error(
			`Could not connect to Zotero${detail}. Ensure Zotero 7/8/9 is running with Local API enabled (port ` +
				(options.zoteroPort ?? 23119) +
				")."
		);
	}

	if (zoteroItems.length === 0) {
		return { updatedText: noteText, relinkedCount: 0, zoteroCount: 0, litNoteCount: 0 };
	}

	const sourcesMatch = noteText.match(/(# Sources\n+)([\s\S]*)$/);
	if (!sourcesMatch) {
		return { updatedText: noteText, relinkedCount: 0, zoteroCount: 0, litNoteCount: 0 };
	}

	const sourcesHeader = sourcesMatch[1];
	const sourcesContent = sourcesMatch[2];
	const sourceLines = sourcesContent.split("\n");

	let zoteroCount = 0;
	let litNoteCount = 0;
	const updatedSourceLines: string[] = [];

	for (const line of sourceLines) {
		const parsed = parseSourceLine(line);
		if (!parsed) {
			updatedSourceLines.push(line);
			continue;
		}

		let newState: SourceLinkState | null = null;
		let preservedRawUrl = parsed.rawUrl;

		if (parsed.state.kind === "raw") {
			const targetUrl = parsed.state.url || parsed.rawUrl;
			const targetTitle = parsed.state.title;

			let match = targetUrl ? client.findItemByUrl(targetUrl) : undefined;
			if (!match && targetTitle) {
				const titleMatch = client.findItemByTitle(targetTitle, minScore);
				if (titleMatch) {
					match = titleMatch.item;
				}
			}

			if (match) {
				const title = targetTitle || match.title;
				const litNoteStem = findLitNoteForCitekey(app, match.citekey, options.litNotesFolder);
				if (litNoteStem) {
					newState = { kind: "lit-note", citekey: litNoteStem, title };
				} else {
					newState = { kind: "zotero-item", citekey: match.citekey, zotkey: match.zotkey, title };
				}
				preservedRawUrl = targetUrl || match.url || "";
			}
		} else if (parsed.state.kind === "zotero-item") {
			const zotkey = parsed.state.zotkey;
			const fallbackCitekey = parsed.state.citekey;

			const matchedItem = zoteroItems.find(
				(i) => i.zotkey === zotkey || i.citekey === fallbackCitekey
			);

			const realCitekey = matchedItem ? matchedItem.citekey : fallbackCitekey;
			const title = matchedItem ? matchedItem.title : parsed.state.title;

			const litNoteStem = findLitNoteForCitekey(app, realCitekey, options.litNotesFolder);

			if (litNoteStem) {
				newState = { kind: "lit-note", citekey: litNoteStem, title };
			} else {
				newState = { kind: "zotero-item", citekey: realCitekey, zotkey, title };
			}
		} else if (parsed.state.kind === "lit-note") {
			const citekey = parsed.state.citekey;
			const matchedItem = zoteroItems.find((i) => i.citekey === citekey);
			const title = matchedItem ? matchedItem.title : parsed.state.title;

			newState = { kind: "lit-note", citekey, title };
		}

		if (newState) {
			const newLine = renderSourceLine(parsed.id, newState, parsed.turnIds, preservedRawUrl);
			if (newLine !== line) {
				if (newState.kind === "lit-note") {
					litNoteCount++;
				} else {
					zoteroCount++;
				}
			}
			updatedSourceLines.push(newLine);
		} else {
			updatedSourceLines.push(line);
		}
	}

	const prefix = noteText.slice(0, sourcesMatch.index);
	const updatedText = prefix + sourcesHeader + updatedSourceLines.join("\n");
	const relinkedCount = zoteroCount + litNoteCount;

	return {
		updatedText,
		relinkedCount,
		zoteroCount,
		litNoteCount,
	};
}
