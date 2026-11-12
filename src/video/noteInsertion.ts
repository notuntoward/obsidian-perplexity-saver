import { StateEffect, StateField, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice, type WorkspaceLeaf } from "obsidian";
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

/** Which list form the timestamp insertion creates. */
export type TimestampListStyle = "match" | "unordered" | "ordered" | "task";

/** A list item's content: the first line after its marker, plus any indented block lines below it. */
export interface ListItemBlock {
	content: string;
	tail?: string[];
}

export interface NoteInsertion {
	text: string;
	cursorOffset: number;
	/** Replace this document range instead of inserting at the tracked position. */
	replace?: { from: number; to: number };
}

interface ListMark {
	indent: string;
	marker: string;
	spacing: string;
	task: boolean;
}

interface ParsedListPrefix {
	mark: ListMark;
	length: number;
}

const LIST_PREFIX = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(?:\[([ xX])\]([ \t]*))?/;

function isOrdered(marker: string): boolean {
	return /^\d/.test(marker);
}

/** The next sibling's marker: ordered lists advance, unordered lists keep their marker. */
function nextMarker(marker: string): string {
	return isOrdered(marker) ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker;
}

/** Parse a list marker at the start of the text before the cursor. */
export function parseListPrefix(text: string): ParsedListPrefix | null {
	const match = LIST_PREFIX.exec(text);
	if (!match) return null;
	return {
		mark: {
			indent: match[1],
			marker: match[2],
			spacing: match[3],
			task: match[4] !== undefined,
		},
		length: match[0].length,
	};
}

/** Choose the marker for the new item, continuing the current list when asked to match it. */
function chooseMark(parsed: ListMark | null, style: TimestampListStyle): ListMark {
	const indent = parsed?.indent ?? "";
	const spacing = parsed?.spacing || " ";
	if (style === "match") {
		return parsed
			? { indent, marker: nextMarker(parsed.marker), spacing: parsed.spacing, task: parsed.task }
			: { indent, marker: "-", spacing, task: false };
	}
	if (style === "ordered") {
		return {
			indent,
			marker: parsed && isOrdered(parsed.marker) ? nextMarker(parsed.marker) : "1.",
			spacing,
			task: false,
		};
	}
	return {
		indent,
		marker: parsed && !isOrdered(parsed.marker) ? parsed.marker : "-",
		spacing,
		task: style === "task",
	};
}

/** An empty item is reused, so the selected form keeps its current number when it is already ordered. */
function chooseReuseMark(current: ListMark, style: TimestampListStyle): ListMark {
	if (style === "match") return current;
	const ordered = isOrdered(current.marker);
	return {
		indent: current.indent,
		marker: style === "ordered" ? (ordered ? current.marker : "1.") : ordered ? "-" : current.marker,
		spacing: current.spacing,
		task: style === "task",
	};
}

function listPrefix(mark: ListMark): string {
	return `${mark.indent}${mark.marker}${mark.spacing}${mark.task ? "[ ] " : ""}`;
}

/** Continuation lines align with the item's text, after its marker and spacing. */
function listContinuation(mark: ListMark): string {
	return mark.indent + " ".repeat(mark.marker.length + mark.spacing.length);
}

function renderBlock(mark: ListMark, block: ListItemBlock): string {
	const continuation = listContinuation(mark);
	return listPrefix(mark) + block.content +
		(block.tail ?? []).map((line) => `\n${continuation}${line}`).join("");
}

/** Content inserted after an existing marker that is being reused unchanged. */
function renderContent(mark: ListMark, block: ListItemBlock): string {
	const continuation = listContinuation(mark);
	return block.content + (block.tail ?? []).map((line) => `\n${continuation}${line}`).join("");
}

/**
 * Insert a list item at the cursor without joining it to text on either side.
 * At the end of a list item it creates a sibling with the same indentation and
 * the next marker; an empty item is reused. Inside other text the item becomes
 * its own block.
 */
export function blockInsertion(
	doc: Text,
	position: number,
	block: ListItemBlock,
	style: TimestampListStyle = "match"
): NoteInsertion {
	const line = doc.lineAt(position);
	const before = doc.sliceString(line.from, position);
	const after = doc.sliceString(position, line.to);
	const parsed = parseListPrefix(before);
	if (parsed && !after.trim()) {
		const rest = before.slice(parsed.length);
		if (!rest.trim()) {
			if (style === "match") {
				const text = renderContent(parsed.mark, block);
				return { text, cursorOffset: text.length };
			}
			const mark = chooseReuseMark(parsed.mark, style);
			const existingPrefix = before.slice(0, parsed.length);
			if (existingPrefix === listPrefix(mark)) {
				const text = renderContent(mark, block);
				return { text, cursorOffset: text.length };
			}
			const text = renderBlock(mark, block);
			return { text, cursorOffset: text.length, replace: { from: position - parsed.length, to: position } };
		}
		const text = `\n${renderBlock(chooseMark(parsed.mark, style), block)}`;
		return { text, cursorOffset: text.length };
	}
	const mark = chooseMark(parsed?.mark ?? null, style);
	const rendered = renderBlock(mark, block);
	const prefix = before.trim() ? "\n\n" : "";
	const suffix = after.trim() ? "\n\n" : "";
	const text = `${prefix}${rendered}${suffix}`;
	return { text, cursorOffset: prefix.length + rendered.length };
}

export function insertPlaybackTimestamp(
	target: NoteInsertionTarget,
	videoId: string | null,
	seconds: number,
	pause: () => void,
	style: TimestampListStyle = "match"
): boolean {
	if (!videoId || !target.isValid()) {
		releaseNoteInsertionAnchor(target.anchor);
		new Notice("The literature note or insertion point is no longer available.");
		return false;
	}
	pause();
	const position = getNoteInsertionPosition(target.anchor);
	if (position === null) {
		new Notice("The literature note insertion point is no longer available.");
		return false;
	}
	const insertion = timestampListItemInsertion(target.anchor.view.state.doc, position, videoId, seconds, style);
	if (!insertAtNoteInsertionAnchor(target.anchor, insertion.text, insertion.cursorOffset, insertion.replace)) {
		new Notice("Could not insert a timestamp into the literature note.");
		return false;
	}
	return true;
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
	cursorOffset = text.length,
	replace?: { from: number; to: number }
): boolean {
	const position = getNoteInsertionPosition(anchor);
	if (position === null || !anchor.view.dom.isConnected) return false;
	const from = replace?.from ?? position;
	const to = replace?.to ?? position;
	anchor.view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + cursorOffset },
		scrollIntoView: true,
		effects: clearInsertionAnchor.of(anchor.id),
	});
	return true;
}

/** First-line content and any indented block lines for a timestamped list item. */
export function timestampListItemBlock(videoId: string, seconds: number): ListItemBlock {
	return { content: `${timestampLink(videoId, seconds)}: ` };
}

/** First-line content and indented embed for a timestamped screenshot list item. */
export function timestampedScreenshotItem(embed: string, videoId: string, seconds: number): ListItemBlock {
	return { content: `${timestampLink(videoId, seconds)}:`, tail: [embed] };
}

/** Add a timestamp list item, keeping surrounding text and any existing selection intact. */
export function timestampListItemInsertion(
	doc: Text,
	position: number,
	videoId: string,
	seconds: number,
	style: TimestampListStyle = "match"
): NoteInsertion {
	return blockInsertion(doc, position, timestampListItemBlock(videoId, seconds), style);
}
