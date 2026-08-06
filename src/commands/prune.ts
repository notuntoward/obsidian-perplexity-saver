import { App, Notice, TFile } from "obsidian";
import { parseSourceLine, renderSourceLine, ParsedSourceLine } from "../zotero/sourceLinkState";
import { getSurvivingTurnIds } from "../normalize/turns";
import { extractSourcesSection } from "../normalize/buildNote";

export interface PrunableSource extends ParsedSourceLine {
	rawLine: string;
	/** Turn IDs on this source's ownership list that no longer exist. */
	deadTurnIds: number[];
	/** Turn IDs on this source's ownership list that still exist, if any. */
	survivingTurnIds: number[];
}

/**
 * Find every source line that cites at least one turn no longer present
 * in the note body (a `^turn-N-*` anchor was deleted). A source is only
 * ever fully removed once ALL of its citing turns are gone; if some but
 * not all of its owning turns survive, it is still "prunable" in the
 * sense that its stale turn reference(s) need to be dropped, but the
 * source line itself is kept (see applyPrune).
 */
export function findPrunableSources(noteText: string): PrunableSource[] {
	const survivingIds = getSurvivingTurnIds(noteText);
	const sourcesText = extractSourcesSection(noteText);
	const out: PrunableSource[] = [];
	for (const line of sourcesText.split("\n")) {
		const parsed = parseSourceLine(line);
		if (!parsed) continue;
		const deadTurnIds = parsed.turnIds.filter((t) => !survivingIds.has(t));
		if (deadTurnIds.length === 0) continue; // every citing turn still exists; nothing to do
		const survivingTurnIds = parsed.turnIds.filter((t) => survivingIds.has(t));
		out.push({ ...parsed, rawLine: line, deadTurnIds, survivingTurnIds });
	}
	return out;
}

/**
 * Apply the prune. For each prunable source: if none of its citing turns
 * survive, remove the line entirely. If some but not all survive, rewrite
 * the line with only the surviving turn IDs in its ownership list, leaving
 * everything else (id, link state, url) untouched. Lines not in the
 * prunable set are left completely alone.
 */
export function applyPrune(noteText: string, toRemove: PrunableSource[]): string {
	if (toRemove.length === 0) return noteText;
	const byRawLine = new Map(toRemove.map((s) => [s.rawLine, s]));
	return noteText
		.split("\n")
		.map((line) => {
			const item = byRawLine.get(line);
			if (!item) return line;
			if (item.survivingTurnIds.length === 0) return null;
			return renderSourceLine(item.id, item.state, item.survivingTurnIds, item.rawUrl);
		})
		.filter((line): line is string => line !== null)
		.join("\n");
}

/**
 * Register the "Prune orphaned sources" command on the plugin.
 */
export function registerPruneSourcesCommand(
	plugin: { addCommand: (cmd: unknown) => unknown; app: App }
): void {
	plugin.addCommand({
		id: "prune-orphaned-sources",
		name: "Prune orphaned sources in this dialog note",
		editorCallback: async (_editor: unknown, view: { file?: TFile }) => {
			const file = view.file;
			if (!file) {
				new Notice("No active file.");
				return;
			}
			const noteText = await plugin.app.vault.read(file);
			const toRemove = findPrunableSources(noteText);
			if (toRemove.length === 0) {
				new Notice("No orphaned sources found.");
				return;
			}
			const updated = applyPrune(noteText, toRemove);
			await plugin.app.vault.modify(file, updated);
			const fullyRemoved = toRemove.filter((s) => s.survivingTurnIds.length === 0).length;
			const adjusted = toRemove.length - fullyRemoved;
			new Notice(
				`Removed ${fullyRemoved} source(s)${adjusted ? `, adjusted ${adjusted} other(s)` : ""}.`
			);
		},
	});
}
