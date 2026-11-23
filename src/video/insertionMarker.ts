import { StateEffect, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, type Plugin } from "obsidian";
import { getEditorLeafLocations } from "commons/workspace";
import { forEachWindow } from "commons/windows";
import { hasLiteratureNoteCategory } from "commons/litnote";
import { isTranscriptCapturePosition, transcriptStart } from "../litNote/transcriptProtection";
import { blockInsertion, noteInsertionAnchors, readNoteInsertionAnchors, resolveNoteInsertionEditor, type TimestampListStyle } from "./noteInsertion";
import { loadedPlayers, visibleTranscripts } from "./session";

const refreshMarker = StateEffect.define<null>();

export interface InsertionMarkerContext {
	enabled: boolean;
	literatureNote?: boolean;
	style?: TimestampListStyle;
}

class TargetWidget extends WidgetType {
	constructor(private readonly label: string) { super(); }
	eq(other: TargetWidget): boolean { return this.label === other.label; }
	toDOM(view: EditorView): HTMLElement {
		return view.dom.ownerDocument.createDocumentFragment().createSpan({
			cls: "perplexity-saver-insertion-marker", text: this.label,
		});
	}
}

export function insertionTargetMarker(context: (view: EditorView) => InsertionMarkerContext) {
	return ViewPlugin.fromClass(class {
		decorations: DecorationSet = Decoration.none;
		private lastError: string | null = null;
		constructor(private readonly view: EditorView) { this.refresh(); }
		update(update: ViewUpdate): void {
			if (update.docChanged || update.selectionSet || update.focusChanged ||
				update.startState.readOnly !== update.state.readOnly ||
				update.startState.field(editorInfoField, false)?.file !== update.state.field(editorInfoField, false)?.file ||
				update.startState.field(noteInsertionAnchors, false) !== update.state.field(noteInsertionAnchors, false) ||
				update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshMarker)))) this.refresh();
		}
		private refresh(): void {
			this.decorations = Decoration.none;
			if (this.view.hasFocus) return;
			const options = context(this.view);
			if (!options.enabled) return;
			const state = this.view.state;
			const anchors = readNoteInsertionAnchors(state);
			const firstAnchorId = anchors ? Object.keys(anchors)[0] : undefined;
			const firstAnchorPosition = firstAnchorId === undefined ? undefined : anchors?.[Number(firstAnchorId)];
			const cursor = typeof firstAnchorPosition === "number" ? firstAnchorPosition : state.selection.main.head;
			try {
				const placed = blockInsertion(state.doc, cursor, { content: "" }, options.style,
					transcriptStart(state) ?? state.doc.length, isTranscriptCapturePosition(state, cursor), options.literatureNote);
				const position = placed.replace?.from ?? cursor;
				const line = state.doc.lineAt(position);
				const below = placed.text.startsWith("\n");
				const above = !below && position === line.from && !!line.text.trim();
				const label = below ? "Next insert below" : above ? "Next insert above" : "Next insert here";
				this.decorations = Decoration.set([
					Decoration.line({ class: `perplexity-saver-insertion-target${above ? " is-above" : ""}` }).range(line.from),
					Decoration.widget({ widget: new TargetWidget(label), side: above ? -1 : 1 }).range(position),
				], true);
				this.lastError = null;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== this.lastError) console.error("Perplexity Saver: insertion target preview unavailable", error);
				this.lastError = message;
			}
		}
	}, { decorations: (plugin) => plugin.decorations });
}

export function registerInsertionTargetMarker(plugin: Plugin, settings: () => { showInsertionTarget: boolean; timestampListStyle: TimestampListStyle }): () => void {
	const { app } = plugin;
	plugin.registerEditorExtension(insertionTargetMarker((view) => {
		const file = view.state.field(editorInfoField, false)?.file;
		if (!settings().showInsertionTarget || !file) return { enabled: false };
		const associated = loadedPlayers(app).some(({ view: player }) => player.getFilePath() === file.path) ||
			visibleTranscripts(app).some(({ view: transcript }) => transcript.getFilePath() === file.path);
		if (!associated) return { enabled: false };
		const pending = Object.keys(readNoteInsertionAnchors(view.state) ?? {}).length > 0;
		const destination = pending ? null : resolveNoteInsertionEditor(app, file.path);
		return {
			enabled: !view.state.readOnly && (pending || !!destination && !("unavailable" in destination) && destination.view === view),
			literatureNote: hasLiteratureNoteCategory(app.metadataCache.getFileCache(file)?.frontmatter),
			style: settings().timestampListStyle,
		};
	}));
	const refresh = (): void => {
		for (const { leaf } of getEditorLeafLocations(app)) {
			const element = leaf.view.containerEl.querySelector<HTMLElement>(".cm-editor");
			const view = element ? EditorView.findFromDOM(element) : null;
			if (view) view.dispatch({ effects: refreshMarker.of(null), annotations: Transaction.addToHistory.of(false) });
		}
	};
	plugin.registerEvent(app.workspace.on("layout-change", refresh));
	plugin.registerEvent(app.workspace.on("active-leaf-change", refresh));
	plugin.registerEvent(app.workspace.on("file-open", refresh));
	plugin.registerEvent(app.metadataCache.on("changed", refresh));
	forEachWindow(plugin, (win) => {
		win.addEventListener("focus", refresh);
		win.addEventListener("blur", refresh);
		return () => {
			win.removeEventListener("focus", refresh);
			win.removeEventListener("blur", refresh);
		};
	});
	return refresh;
}
