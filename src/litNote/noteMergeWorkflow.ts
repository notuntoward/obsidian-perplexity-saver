import { Notice } from "obsidian";
import type { App, TFile } from "obsidian";
import { executeMerge, planMerge } from "./noteMerge";
import type { MergeResult } from "./noteMerge";
import { chooseMergeOptions, reviewMergedProperties } from "./mergeNotesModal";
import { changesProperties } from "./noteMerge";
import { showKeptNote } from "./noteComparison";
import { requestItemTrash } from "./zoteroItemTrash";

let merging = false;

/** Describe a finished merge in one or two sentences. */
export function mergeSummary(keeper: TFile, result: MergeResult): string {
	const parts = [`Merged ${result.merged.length} ${result.merged.length === 1 ? "note" : "notes"} into ${keeper.basename}`];
	const details: string[] = [];
	if (result.copiedBlocks) details.push(`copied ${result.copiedBlocks} ${result.copiedBlocks === 1 ? "block" : "blocks"} of text`);
	if (result.redirectedLinks) details.push(`redirected ${result.redirectedLinks} ${result.redirectedLinks === 1 ? "link" : "links"}`);
	if (result.changedProperties) details.push(`updated ${result.changedProperties} ${result.changedProperties === 1 ? "property" : "properties"}`);
	if (result.zoteroItemsToTrash.length) details.push(`asked Zotero to move ${result.zoteroItemsToTrash.length} ${result.zoteroItemsToTrash.length === 1 ? "item" : "items"} to its trash`);
	let summary = `${parts[0]}${details.length ? `: ${details.join(", ")}` : ""}.`;
	if (result.kept.length) {
		summary += ` Kept ${result.kept.map((entry) => `${entry.file.basename} (${entry.reason})`).join("; ")}; run the merge again after checking ${result.kept.length === 1 ? "it" : "them"}.`;
	}
	return summary;
}

/**
 * Show the merge plan, apply the user's choices and open the kept note for tidying. Resolves undefined
 * when the user cancels or another merge is still running.
 */
export async function mergeNotesInteractively(app: App, keeper: TFile, sources: TFile[]): Promise<MergeResult | undefined> {
	if (merging) {
		new Notice("A merge is already in progress.");
		return undefined;
	}
	merging = true;
	try {
		const plan = await planMerge(app, keeper, sources.filter((file) => file.path !== keeper.path));
		if (!plan.sources.length) {
			new Notice("Choose at least one other note to merge.");
			return undefined;
		}
		const choices = await chooseMergeOptions(app, plan);
		if (!choices) return undefined;
		if (changesProperties(plan.properties)) {
			const approved = await reviewMergedProperties(app, plan);
			if (!approved) return undefined;
			choices.properties = approved;
		}
		const result = await executeMerge(app, plan, choices);
		if (result.zoteroItemsToTrash.length) requestItemTrash(result.zoteroItemsToTrash);
		await showKeptNote(app, keeper, result.markerLine);
		return result;
	} catch (error) {
		console.error("Could not merge the notes", error);
		new Notice(`Could not finish the merge: ${error instanceof Error ? error.message : String(error)}. A note is moved to trash only after its links point to the kept note, so running the merge again is safe.`, 0);
		return undefined;
	} finally {
		merging = false;
	}
}
