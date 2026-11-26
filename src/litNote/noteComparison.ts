import { MarkdownView, Notice } from "obsidian";
import type { App, TFile, WorkspaceLeaf, WorkspaceSplit } from "obsidian";
import { buildNavigationModel, getGroupForLeaf, getGroupsInWindow } from "commons/workspace";

// Panes created for the previous comparison; reused so repeated comparisons do not pile up tabs.
let comparisonLeaves: WorkspaceLeaf[] = [];
// "Keep this note" buttons added to the comparison panes' headers.
let keepActions: HTMLElement[] = [];

function removeKeepActions(): void {
	for (const action of keepActions) action.remove();
	keepActions = [];
}

/** The group for the other notes: a previous comparison group, else another group in the window, preferring the right. */
function otherGroup(app: App, first: WorkspaceLeaf, reused: WorkspaceLeaf[]): { parent: WorkspaceSplit; size: number } | undefined {
	const model = buildNavigationModel(app, first);
	const current = getGroupForLeaf(model, first);
	if (!current) return undefined;
	const previous = reused.map((leaf) => getGroupForLeaf(model, leaf)).find((group) => group && group.group !== current.group);
	const others = getGroupsInWindow(model, current.window).filter((group) => group.group !== current.group);
	const group = previous ?? others.find((entry) => entry.direction === "right") ?? others[0];
	// A tab group is a valid createLeafInParent parent even though the API types it as a split.
	return group && { parent: group.group, size: group.leaves.length };
}

/**
 * Open the notes for comparison with as few tab groups as possible: the first note as a tab in the
 * current group and the rest as tabs in one other group. A group is split off only when the window
 * has no other group. With `onKeep`, each pane's header gets a "Keep this note" button.
 */
export async function openNotesSideBySide(app: App, files: TFile[], onKeep?: (file: TFile) => void): Promise<void> {
	if (!files.length) return;
	removeKeepActions();
	const live = new Set(app.workspace.getLeavesOfType("markdown"));
	const reusable = comparisonLeaves.filter((leaf) => live.has(leaf));
	const first = reusable[0] ?? app.workspace.getLeaf("tab");
	const leaves: WorkspaceLeaf[] = [first];
	let target = files.length > 1 && reusable.length < files.length ? otherGroup(app, first, reusable.slice(1)) : undefined;
	for (let index = 1; index < files.length; index++) {
		let leaf = reusable[index];
		if (!leaf && target) leaf = app.workspace.createLeafInParent(target.parent, target.size++);
		if (!leaf) {
			leaf = app.workspace.createLeafBySplit(first, "vertical");
			target = { parent: leaf.parent, size: 1 };
		}
		leaves.push(leaf);
	}
	for (const [index, file] of files.entries()) await leaves[index].openFile(file, { active: index === 0 });
	for (const extra of reusable.slice(files.length)) extra.detach();
	comparisonLeaves = leaves;
	if (onKeep) {
		const compared = new Set(files.map((file) => file.path));
		for (const leaf of leaves) {
			if (!(leaf.view instanceof MarkdownView)) continue;
			const view = leaf.view;
			keepActions.push(view.addAction("git-merge", "Keep this note and merge the other compared notes into it", () => {
				const file = view.file;
				if (file && compared.has(file.path)) onKeep(file);
				else new Notice("This pane no longer shows one of the compared notes.");
			}));
		}
	}
	app.workspace.setActiveLeaf(first, { focus: true });
}

/**
 * End a comparison: show the kept note in the first comparison pane, at `line` when given, and close
 * the other comparison panes.
 */
export async function showKeptNote(app: App, file: TFile, line?: number): Promise<void> {
	removeKeepActions();
	const live = new Set(app.workspace.getLeavesOfType("markdown"));
	const [first, ...rest] = comparisonLeaves.filter((leaf) => live.has(leaf));
	comparisonLeaves = [];
	const leaf = first ?? app.workspace.getLeaf(false);
	await leaf.openFile(file, { active: true, ...(line === undefined ? {} : { eState: { line } }) });
	for (const extra of rest) extra.detach();
	app.workspace.setActiveLeaf(leaf, { focus: true });
}
