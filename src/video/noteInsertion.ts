import { StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM, parser } from "@lezer/markdown";
import { flashEditorLine, LINE_FLASH_DEFAULT_PROFILE, type LineFlashMode } from "commons/flash";
import { getActiveLeafInFocusedWindow, getEditorLeafLocations } from "commons/workspace";
import { writeClipboardIn } from "commons/windows";
import { getFrontMatterInfo, MarkdownView, Notice, type App, type WorkspaceLeaf } from "obsidian";
import { timestampClipboardText, timestampLink } from "./youtubeLinks";
import { isTranscriptCapturePosition, transcriptStart } from "../litNote/transcriptProtection";

interface InsertionAnchors {
	[id: number]: number;
}

const setInsertionAnchor = StateEffect.define<{ id: number; position: number }>();
const clearInsertionAnchor = StateEffect.define<number>();
let nextAnchorId = 1;

export const noteInsertionAnchors = StateField.define<InsertionAnchors>({
	create: () => ({}),
	update: (anchors, transaction) => {
		if (!transaction.docChanged && !transaction.effects.some((effect) => effect.is(setInsertionAnchor) || effect.is(clearInsertionAnchor))) return anchors;
		const mapped: InsertionAnchors = {};
		for (const id of Object.keys(anchors)) {
			const numericId = Number(id);
			const position = anchors[numericId];
			if (typeof position === "number") {
				mapped[numericId] = transaction.changes.mapPos(position, 1);
			}
		}
		for (const effect of transaction.effects) {
			if (effect.is(setInsertionAnchor)) mapped[effect.value.id] = effect.value.position;
			else if (effect.is(clearInsertionAnchor)) delete mapped[effect.value];
		}
		return mapped;
	},
});

export function readNoteInsertionAnchors(state: EditorState): InsertionAnchors | null {
	const value: unknown = state.field(noteInsertionAnchors, false);
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const anchors: InsertionAnchors = {};
	for (const [id, position] of Object.entries(value)) {
		const numericId = Number(id);
		if (Number.isInteger(numericId) && typeof position === "number") {
			anchors[numericId] = position;
		}
	}
	return anchors;
}

export interface NoteInsertionAnchor {
	view: EditorView;
	id: number;
}

export interface NoteInsertionTarget {
	leaf: WorkspaceLeaf;
	filePath: string;
	anchor: NoteInsertionAnchor;
	literatureNote?: boolean;
	isValid(): boolean;
}

export interface UnavailableInsertionTarget {
	unavailable: string;
}

/** Resolve one editor without guessing between different cursors for the same note. */
export function resolveNoteInsertionEditor(app: App, filePath: string | null):
	{ leaf: WorkspaceLeaf; view: EditorView; filePath: string } | UnavailableInsertionTarget {
	if (!filePath || !app.vault.getFileByPath(filePath)) return { unavailable: "The associated note is unavailable." };
	const active = getActiveLeafInFocusedWindow(app, { includeSidebars: true });
	const candidates = getEditorLeafLocations(app).map(({ leaf }) => leaf).filter((leaf) =>
		leaf.view instanceof MarkdownView && leaf.view.file?.path === filePath);
	if (active?.view instanceof MarkdownView && active.view.file?.path === filePath && !candidates.includes(active)) candidates.push(active);
	const leaf = active && candidates.includes(active) ? active : candidates.length === 1 ? candidates[0] : null;
	if (!leaf) return { unavailable: candidates.length > 1
		? "Several editors show this note. Focus the intended editor before inserting."
		: "The associated note is not open in an editor." };
	if (!(leaf.view instanceof MarkdownView) || leaf.view.getMode() !== "source") return { unavailable: "The associated note is not editable." };
	const editorEl = leaf.view.containerEl.querySelector<HTMLElement>(".cm-editor");
	const view = editorEl ? EditorView.findFromDOM(editorEl) : null;
	if (!view || !view.dom.isConnected || view.state.readOnly) return { unavailable: "The associated note is not editable." };
	return { leaf, view, filePath };
}

export async function copyInsertionFallback(win: Window | null, text: string, subject: string, reason: string): Promise<boolean> {
	try {
		if (win && await writeClipboardIn(win, text)) {
			new Notice(`${subject} copied to clipboard instead. ${reason} Paste it into your note.`);
			return true;
		}
		console.error("Perplexity Saver: insertion clipboard unavailable", subject, reason);
	} catch (error) {
		console.error("Perplexity Saver: could not copy insertion fallback", error);
	}
	new Notice(`${subject} was not inserted and could not be copied to the clipboard. ${reason}`);
	return false;
}

/** Which form the timestamp insertion creates. */
export type TimestampListStyle = "match" | "unordered" | "ordered" | "task" | "link";

type ExplicitListStyle = Exclude<TimestampListStyle, "match" | "link">;

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
function chooseMark(parsed: ListMark | null, style: "match" | ExplicitListStyle): ListMark {
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
function chooseReuseMark(current: ListMark, style: "match" | ExplicitListStyle): ListMark {
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

function renderPlainBlock(block: ListItemBlock): string {
	return [block.content, ...(block.tail ?? [])].join("\n");
}

function renderStyleBlock(mark: ListMark | null, block: ListItemBlock, style: TimestampListStyle): string {
	return style === "link" ? renderPlainBlock(block) : renderBlock(chooseMark(mark, style), block);
}

function renderReuseStyleBlock(mark: ListMark, block: ListItemBlock, style: TimestampListStyle): string {
	return style === "link" ? renderPlainBlock(block) : renderBlock(chooseReuseMark(mark, style), block);
}

/** Content inserted after an existing marker that is being reused unchanged. */
function renderContent(mark: ListMark, block: ListItemBlock): string {
	const continuation = listContinuation(mark);
	return block.content + (block.tail ?? []).map((line) => `\n${continuation}${line}`).join("");
}

/** Why an insertion was moved outside its current block. */
type UnsafeReason = "properties" | "transcript" | "callout or quote" | "code block" | "table" | "HTML block";

const UNSAFE_BLOCKS: Record<string, UnsafeReason> = {
	Blockquote: "callout or quote",
	FencedCode: "code block",
	CodeBlock: "code block",
	Table: "table",
	HTMLBlock: "HTML block",
	CommentBlock: "HTML block",
	ProcessingInstructionBlock: "HTML block",
	LinkReference: "HTML block",
};

const markdownParser = parser.configure(GFM);
type Tree = ReturnType<typeof markdownParser.parse>;
type SyntaxNode = Tree["topNode"];

export interface PlacedInsertion extends NoteInsertion {
	/** Describes where the insertion went when that is not where the cursor was, for example "after the paragraph". */
	moved?: string;
}

/** Parsed note body with positions mapped back to the whole document. */
class NoteStructure {
	private readonly tree: Tree;
	readonly bodyStart: number;

	constructor(readonly doc: Text) {
		const content = doc.toString();
		this.bodyStart = getFrontMatterInfo(content).contentStart;
		this.tree = markdownParser.parse(content.slice(this.bodyStart));
	}

	/** Innermost node at the line's first non-space character. */
	nodeAtLine(lineNumber: number): SyntaxNode | null {
		const line = this.doc.line(lineNumber);
		if (line.to < this.bodyStart) return null;
		const indent = line.text.length - line.text.trimStart().length;
		return this.tree.resolveInner(Math.max(line.from + indent, this.bodyStart) - this.bodyStart, 1);
	}

	from(node: SyntaxNode): number { return node.from + this.bodyStart; }

	to(node: SyntaxNode): number { return node.to + this.bodyStart; }

	topBlocks(): SyntaxNode[] {
		const blocks: SyntaxNode[] = [];
		for (let node = this.tree.topNode.firstChild; node; node = node.nextSibling) blocks.push(node);
		return blocks;
	}

	/** The paragraph-like kind of a line, used to keep lazy continuation from joining blocks. */
	lineKind(lineNumber: number): "none" | "blank" | "list" | "paragraph" | "other" {
		if (lineNumber < 1 || lineNumber > this.doc.lines) return "none";
		if (!this.doc.line(lineNumber).text.trim()) return "blank";
		const node = this.nodeAtLine(lineNumber);
		if (!node) return "other";
		if (ancestor(node, (n) => n.name === "ListItem")) return "list";
		return ancestor(node, (n) => n.name === "Paragraph")?.parent?.name === "Document" ? "paragraph" : "other";
	}
}

const noteStructures = new WeakMap<Text, NoteStructure>();

function ancestor(node: SyntaxNode | null, test: (node: SyntaxNode) => boolean): SyntaxNode | null {
	for (let current = node; current; current = current.parent) if (test(current)) return current;
	return null;
}

function isHeading(node: SyntaxNode): boolean {
	return /^(?:ATX|Setext)Heading[1-6]$/.test(node.name);
}

function isList(node: SyntaxNode): boolean {
	return node.name === "BulletList" || node.name === "OrderedList";
}

/** Last non-blank line at or before `position`, so trailing blank lines stay between blocks. */
function lastContentLine(doc: Text, position: number) {
	let line = doc.lineAt(position);
	while (line.number > 1 && !line.text.trim()) line = doc.line(line.number - 1);
	return line;
}

function at(position: number, text: string, cursorOffset: number, moved?: string): PlacedInsertion {
	return { text, cursorOffset, replace: { from: position, to: position }, moved };
}

/** A sibling after the whole item, including its children, so it never steals them. */
function siblingAfter(structure: NoteStructure, item: SyntaxNode, block: ListItemBlock, style: TimestampListStyle, moved?: string): PlacedInsertion {
	const doc = structure.doc;
	const mark = parseListPrefix(doc.lineAt(structure.from(item)).text)?.mark ?? null;
	const end = lastContentLine(doc, structure.to(item));
	const text = `${style === "link" ? "\n\n" : "\n"}${renderStyleBlock(mark, block, style)}`;
	return at(end.to, text, text.length, moved);
}

/** A new block after `node`, separated from the text on both sides. */
function blockAfter(structure: NoteStructure, node: SyntaxNode, block: ListItemBlock, style: TimestampListStyle, moved?: string): PlacedInsertion {
	const end = lastContentLine(structure.doc, structure.to(node));
	const rendered = renderStyleBlock(null, block, style);
	const text = `\n\n${rendered}${structure.lineKind(end.number + 1) === "paragraph" ? "\n" : ""}`;
	return at(end.to, text, 2 + rendered.length, moved);
}

/** The first item under a heading: at the top of a list that follows it, or a new list. */
function underHeading(structure: NoteStructure, heading: SyntaxNode, block: ListItemBlock, style: TimestampListStyle, moved?: string): PlacedInsertion {
	const doc = structure.doc;
	const next = heading.nextSibling;
	if (next && isList(next)) {
		const first = doc.lineAt(structure.from(next));
		const mark = parseListPrefix(first.text)?.mark;
		const rendered = mark ? renderReuseStyleBlock(mark, block, style) : renderStyleBlock(null, block, style);
		return at(first.from, `${rendered}${style === "link" ? "\n\n" : "\n"}`, rendered.length, moved);
	}
	const end = lastContentLine(doc, structure.to(heading));
	const rendered = renderStyleBlock(null, block, style);
	const text = `\n${rendered}${structure.lineKind(end.number + 1) === "paragraph" ? "\n" : ""}`;
	return at(end.to, text, 1 + rendered.length, moved);
}

function appendToList(structure: NoteStructure, list: SyntaxNode, block: ListItemBlock, style: TimestampListStyle, moved?: string): PlacedInsertion {
	const item = list.lastChild;
	if (!item || item.name !== "ListItem") throw new Error("Could not resolve the notes list insertion point.");
	const line = structure.doc.lineAt(structure.from(item));
	if (structure.to(item) <= line.to) {
		const empty = reuseEmptyItem(line, block, style);
		if (empty) return { ...empty, moved };
	}
	return siblingAfter(structure, item, block, style, moved);
}

/** Exit the whole block and continue only an adjacent list, never a later topic. */
function outsideBlock(structure: NoteStructure, node: SyntaxNode, notesEnd: number, block: ListItemBlock, style: TimestampListStyle, moved: string): PlacedInsertion {
	if (structure.to(node) > notesEnd) throw new Error("Cannot safely insert before the transcript: a Markdown block crosses its boundary.");
	const next = node.nextSibling;
	if (next && isList(next) && structure.to(next) <= notesEnd) return appendToList(structure, next, block, style, moved);
	return blockAfter(structure, node, block, style, moved);
}

function calloutKind(structure: NoteStructure, node: SyntaxNode): string | undefined {
	if (node.name !== "Blockquote") return;
	return /^>\s*\[!(info|note)\]/i.exec(structure.doc.lineAt(structure.from(node)).text)?.[1].toLowerCase();
}

/** Leading source blocks are optional; ordinary notes start with their first content block. */
function initialNotesArea(structure: NoteStructure, notesEnd: number, literatureNote: boolean): { before: SyntaxNode | null; first: SyntaxNode | null; openingEnd: number } {
	const blocks = structure.topBlocks().filter((node) => structure.from(node) < notesEnd);
	let index = 0;
	if (blocks[0] && isHeading(blocks[0])) index++;
	const generatedPreamble = literatureNote && !!blocks[index] && calloutKind(structure, blocks[index]) === "info";
	if (generatedPreamble) while (blocks[index]?.name === "Blockquote") index++;
	if (generatedPreamble && blocks[index]?.name === "HorizontalRule" && blocks[index + 1] &&
		calloutKind(structure, blocks[index + 1]) === "note") index += 2;
	const first = blocks[index] ?? null;
	return {
		before: blocks[index - 1] ?? null,
		first,
		openingEnd: generatedPreamble ? (first ? structure.from(first) : notesEnd) : (blocks[0] ? structure.from(blocks[0]) : notesEnd),
	};
}

function inInitialNotesArea(structure: NoteStructure, area: ReturnType<typeof initialNotesArea>, notesEnd: number,
	block: ListItemBlock, style: TimestampListStyle, reason: string): PlacedInsertion {
	const moved = `in the initial notes area (the cursor was in the ${reason})`;
	const { before, first } = area;
	if (first && isList(first) && structure.to(first) <= notesEnd) return appendToList(structure, first, block, style, moved);
	if (before && !isHeading(before)) return outsideBlock(structure, before, notesEnd, block, style, moved);
	if (first && !isHeading(first)) return outsideBlock(structure, first, notesEnd, block, style, moved);
	if (before) return underHeading(structure, before, block, style, moved);
	const rendered = renderStyleBlock(null, block, style);
	const following = structure.doc.sliceString(structure.bodyStart).trim() ? "\n\n" : "";
	return at(structure.bodyStart, rendered + following, rendered.length, moved);
}

function reuseEmptyItem(line: ReturnType<Text["line"]>, block: ListItemBlock, style: TimestampListStyle): PlacedInsertion | null {
	const parsed = parseListPrefix(line.text);
	if (!parsed || line.text.slice(parsed.length).trim()) return null;
	if (style === "link") {
		const text = renderPlainBlock(block);
		return { text, cursorOffset: text.length, replace: { from: line.from, to: line.to } };
	}
	const mark = chooseReuseMark(parsed.mark, style);
	if (style === "match" || line.text.slice(0, parsed.length) === listPrefix(mark)) {
		const text = renderContent(mark, block);
		return at(line.to, text, text.length);
	}
	const text = renderBlock(mark, block);
	return { text, cursorOffset: text.length, replace: { from: line.from, to: line.to } };
}

/**
 * Place a list item at the nearest block boundary to the cursor, never splitting
 * text. An empty list item or blank line is used as is; in a list item it becomes
 * a sibling after the item and its children; in a paragraph it follows the
 * paragraph; on a heading it becomes the first item below. Properties, the
 * transcript and opening source material use the initial notes area; other
 * unsafe blocks continue an adjacent list or get a new list immediately below.
 */
export function blockInsertion(
	doc: Text,
	position: number,
	block: ListItemBlock,
	style: TimestampListStyle = "match",
	notesEnd: number = doc.length,
	inTranscript = false,
	literatureNote = false
): PlacedInsertion {
	let structure = noteStructures.get(doc);
	if (!structure) {
		structure = new NoteStructure(doc);
		noteStructures.set(doc, structure);
	}
	const area = initialNotesArea(structure, notesEnd, literatureNote);
	if (position < structure.bodyStart) return inInitialNotesArea(structure, area, notesEnd, block, style, "properties");
	if (inTranscript) return inInitialNotesArea(structure, area, notesEnd, block, style, "transcript");
	if ((area.first || area.before) && (position < area.openingEnd ||
		position === structure.bodyStart)) return inInitialNotesArea(structure, area, notesEnd, block, style, "opening area");
	const line = doc.lineAt(position);
	const node = structure.nodeAtLine(line.number);
	const unsafe = ancestor(node, (n) => n.name in UNSAFE_BLOCKS);
	if (unsafe) {
		const outerItem = ancestor(unsafe.parent, (n) => n.name === "ListItem");
		if (outerItem) return siblingAfter(structure, outerItem, block, style, `below the list item containing the ${UNSAFE_BLOCKS[unsafe.name]}`);
		let outer = unsafe;
		while (outer.parent?.parent) outer = outer.parent;
		return outsideBlock(structure, outer, notesEnd, block, style, `below the ${UNSAFE_BLOCKS[unsafe.name]}`);
	}

	const empty = reuseEmptyItem(line, block, style);
	if (empty) return empty;

	if (!line.text.trim()) {
		const rendered = renderStyleBlock(null, block, style);
		const suffix = structure.lineKind(line.number + 1) === "paragraph" ? "\n" : "";
		return style === "link" && line.text
			? { text: rendered + suffix, cursorOffset: rendered.length, replace: { from: line.from, to: line.to } }
			: at(position, rendered + suffix, rendered.length);
	}

	const item = ancestor(node, (n) => n.name === "ListItem");
	if (item) {
		const placed = siblingAfter(structure, item, block, style);
		return placed.replace?.from === position ? placed : { ...placed, moved: "below the list item" };
	}
	const heading = ancestor(node, isHeading);
	if (heading) return underHeading(structure, heading, block, style, "under the heading");
	let top = node;
	while (top?.parent?.parent) top = top.parent;
	if (!top || top.name === "Document") {
		const rendered = renderStyleBlock(null, block, style);
		return at(line.to, `\n\n${rendered}`, 2 + rendered.length, "on a new line");
	}
	return blockAfter(structure, top, block, style, top.name === "Paragraph" ? "after the paragraph" : "below the divider");
}

/** "Timestamp inserted." or, when the cursor was not a safe place, where it went instead. */
export function insertionMessage(subject: string, insertion: PlacedInsertion): string {
	return `${subject} inserted${insertion.moved ? ` ${insertion.moved}` : ""}.`;
}

export interface InsertionFlashSettings {
	mode: LineFlashMode | "off";
	durationMs: number;
	sizeChars: number;
	useThemeColors: boolean;
	lightColor: string;
	darkColor: string;
}

export function insertionThemeFlashAppearance(): { color: string; opacity: number } {
	return { color: "var(--interactive-accent)", opacity: LINE_FLASH_DEFAULT_PROFILE.opacity };
}

/** Briefly highlight the line at the editor's cursor, after CodeMirror has scrolled it into view. */
export function flashInsertedLine(view: EditorView, flash: InsertionFlashSettings): void {
	const mode = flash.mode;
	if (mode === "off") return;
	const appearance = flash.useThemeColors
		? insertionThemeFlashAppearance()
		: {
			color: view.dom.ownerDocument.body.classList.contains("theme-dark") ? flash.darkColor : flash.lightColor,
			opacity: LINE_FLASH_DEFAULT_PROFILE.opacity,
		};
	view.requestMeasure({
		read: () => view.dom.isConnected ? view.coordsAtPos(view.state.selection.main.head, -1) : null,
		write: (coords) => {
			if (coords) flashEditorLine(view, coords, {
				mode,
				...appearance,
				sizeChars: flash.sizeChars,
				durationMs: flash.durationMs,
			});
		},
	});
}

/** Place a list item near the tracked cursor and insert it as one undoable change. */
export function insertBlockAtNoteInsertionAnchor(
	anchor: NoteInsertionAnchor,
	block: ListItemBlock,
	style: TimestampListStyle = "match",
	literatureNote = false
): PlacedInsertion | null {
	const position = getNoteInsertionPosition(anchor);
	if (position === null) return null;
	const state = anchor.view.state;
	const insertion = blockInsertion(state.doc, position, block, style,
		transcriptStart(state) ?? state.doc.length, isTranscriptCapturePosition(state, position), literatureNote);
	return insertAtNoteInsertionAnchor(anchor, insertion.text, insertion.cursorOffset, insertion.replace) ? insertion : null;
}

export function insertPlaybackTimestamp(
	target: NoteInsertionTarget,
	videoId: string | null,
	seconds: number,
	pause: () => void,
	style: TimestampListStyle = "match"
): PlacedInsertion | null {
	if (!Number.isFinite(seconds) || seconds < 0) {
		releaseNoteInsertionAnchor(target.anchor);
		new Notice("The timestamp insertion time is not available.");
		return null;
	}
	if (!videoId || !target.isValid()) {
		releaseNoteInsertionAnchor(target.anchor);
		new Notice("The note or insertion point is no longer available.");
		return null;
	}
	pause();
	if (getNoteInsertionPosition(target.anchor) === null) {
		new Notice("The note insertion point is no longer available.");
		return null;
	}
	const insertion = insertBlockAtNoteInsertionAnchor(target.anchor, timestampListItemBlock(videoId, seconds, style), style, target.literatureNote);
	if (!insertion) new Notice("Could not insert a timestamp into the note.");
	return insertion;
}

/** Track the editor cursor through edits while an asynchronous capture is running. */
export function createNoteInsertionAnchor(view: EditorView): NoteInsertionAnchor | null {
	if (readNoteInsertionAnchors(view.state) === null) return null;
	const id = nextAnchorId++;
	view.dispatch({ effects: setInsertionAnchor.of({ id, position: view.state.selection.main.head }) });
	return { view, id };
}

export function getNoteInsertionPosition(anchor: NoteInsertionAnchor): number | null {
	return readNoteInsertionAnchors(anchor.view.state)?.[anchor.id] ?? null;
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
	if (isTranscriptCapturePosition(anchor.view.state, from, to)) {
		releaseNoteInsertionAnchor(anchor);
		new Notice("Cannot insert into the transcript. Choose a location in your notes.");
		return false;
	}
	anchor.view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + cursorOffset },
		scrollIntoView: true,
		effects: clearInsertionAnchor.of(anchor.id),
	});
	const inserted = getNoteInsertionPosition(anchor) === null;
	if (!inserted) releaseNoteInsertionAnchor(anchor);
	return inserted;
}

/** First-line content and any indented block lines for a timestamp insertion. */
export function timestampListItemBlock(videoId: string, seconds: number, style: TimestampListStyle = "match"): ListItemBlock {
	const link = timestampLink(videoId, seconds);
	return { content: style === "link" ? link : `${link}: ` };
}

export function timestampInsertionClipboardText(videoId: string, seconds: number, style: TimestampListStyle): string {
	return timestampClipboardText(videoId, seconds, style === "match" ? "unordered" : style);
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
): PlacedInsertion {
	return blockInsertion(doc, position, timestampListItemBlock(videoId, seconds, style), style);
}
