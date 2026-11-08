import { StateEffect, StateField, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { WorkspaceLeaf } from "obsidian";
import { timestampLink } from "./youtubeLinks";

interface InsertionAnchors {
	[id: number]: number;
}

const setInsertionAnchor = StateEffect.define<{ id: number; position: number }>();
const clearInsertionAnchor = StateEffect.define<number>();
let nextAnchorId = 1;

export const noteInsertionAnchors = StateField.define<InsertionAnchors>({
	create: () => ({}),
	update: (anchors, transaction) => {
		const mapped: InsertionAnchors = {};
		for (const [id, position] of Object.entries(anchors)) {
			mapped[Number(id)] = transaction.changes.mapPos(position, 1);
		}
		for (const effect of transaction.effects) {
			if (effect.is(setInsertionAnchor)) mapped[effect.value.id] = effect.value.position;
			else if (effect.is(clearInsertionAnchor)) delete mapped[effect.value];
		}
		return mapped;
	},
});

export interface NoteInsertionAnchor {
	view: EditorView;
	id: number;
}

export interface NoteInsertionTarget {
	leaf: WorkspaceLeaf;
	filePath: string;
	anchor: NoteInsertionAnchor;
	isValid(): boolean;
}

/** Track the editor cursor through edits while an asynchronous capture is running. */
export function createNoteInsertionAnchor(view: EditorView): NoteInsertionAnchor | null {
	if (!view.state.field(noteInsertionAnchors, false)) return null;
	const id = nextAnchorId++;
	view.dispatch({ effects: setInsertionAnchor.of({ id, position: view.state.selection.main.head }) });
	return { view, id };
}

export function getNoteInsertionPosition(anchor: NoteInsertionAnchor): number | null {
	return anchor.view.state.field(noteInsertionAnchors, false)?.[anchor.id] ?? null;
}

export function releaseNoteInsertionAnchor(anchor: NoteInsertionAnchor): void {
	if (getNoteInsertionPosition(anchor) === null || !anchor.view.dom.isConnected) return;
	anchor.view.dispatch({ effects: clearInsertionAnchor.of(anchor.id) });
}

/** Insert at the tracked cursor without replacing selected text. */
export function insertAtNoteInsertionAnchor(
	anchor: NoteInsertionAnchor,
	text: string,
	cursorOffset = text.length
): boolean {
	const position = getNoteInsertionPosition(anchor);
	if (position === null || !anchor.view.dom.isConnected) return false;
	anchor.view.dispatch({
		changes: { from: position, to: position, insert: text },
		selection: { anchor: position + cursorOffset },
		scrollIntoView: true,
		effects: clearInsertionAnchor.of(anchor.id),
	});
	return true;
}

/** Add a timestamp bullet, keeping surrounding text and any existing selection intact. */
export function timestampBulletInsertion(doc: Text, position: number, videoId: string, seconds: number): { text: string; cursorOffset: number } {
	return blockInsertion(doc, position, `- ${timestampLink(videoId, seconds)}: `);
}

/** Put a timestamped screenshot on its own list item at the captured note position. */
export function timestampedScreenshotBlock(embed: string, videoId: string, seconds: number): string {
	return `- ${timestampLink(videoId, seconds)}:\n  ${embed}`;
}

/** Insert a Markdown block without joining it to text on either side of the cursor. */
export function blockInsertion(doc: Text, position: number, block: string): { text: string; cursorOffset: number } {
	const line = doc.lineAt(position);
	const before = doc.sliceString(line.from, position);
	const after = doc.sliceString(position, line.to);
	const list = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/.exec(before);
	if (list && !after.trim() && block.startsWith("- ")) {
		const [, indent, marker, spacing] = list;
		const empty = !before.slice(list[0].length).trim();
		const nextMarker = /^\d/.test(marker) ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker;
		const prefix = empty ? "" : `\n${indent}${nextMarker}${spacing}`;
		const continuation = indent + " ".repeat((empty ? marker : nextMarker).length + spacing.length);
		const content = block.slice(2).replace(/\n {2}/g, `\n${continuation}`);
		const text = prefix + content;
		return { text, cursorOffset: text.length };
	}
	const prefix = before.trim() ? "\n\n" : "";
	const suffix = after.trim() ? "\n\n" : "";
	return { text: `${prefix}${block}${suffix}`, cursorOffset: prefix.length + block.length };
}
