import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, type App, type Plugin } from "obsidian";
import { onEachDocument, setTimeoutIn, type CancelTimer } from "commons/windows";

const highlightFootnote = StateEffect.define<number | null>();
const footnoteHighlight = StateField.define({
	create: () => Decoration.none,
	update: (decorations, transaction) => {
		if (transaction.docChanged) decorations = Decoration.none;
		for (const effect of transaction.effects) {
			if (effect.is(highlightFootnote)) {
				decorations = effect.value === null ? Decoration.none : Decoration.set([
					Decoration.line({ class: "perplexity-saver-footnote-target" })
						.range(transaction.state.doc.lineAt(effect.value).from),
				]);
			}
		}
		return decorations;
	},
	provide: field => EditorView.decorations.from(field),
});

export const footnoteNavigationHighlight = [
	footnoteHighlight,
	ViewPlugin.fromClass(class {
		private cancel: CancelTimer | undefined;

		update(update: ViewUpdate): void {
			if (update.docChanged) {
				this.cancel?.();
				this.cancel = undefined;
			}
			for (const transaction of update.transactions) {
				for (const effect of transaction.effects) {
					if (!effect.is(highlightFootnote)) continue;
					this.cancel?.();
					this.cancel = undefined;
					const win = update.view.dom.ownerDocument.defaultView;
					if (effect.value !== null && win) {
						this.cancel = setTimeoutIn(win, () => {
							this.cancel = undefined;
							update.view.dispatch({ effects: highlightFootnote.of(null) });
						}, 2000);
					}
				}
			}
		}

		destroy(): void {
			this.cancel?.();
		}
	}),
];

interface FootnoteTarget {
	view: EditorView;
	offset: number;
}

export function footnoteTargetForEvent(event: MouseEvent, app: App): FootnoteTarget | null {
	if (event.button !== 0 || event.defaultPrevented || event.shiftKey || event.altKey) return null;
	const target = event.target as Element | null;
	if (!target || typeof target.closest !== "function" || !target.closest(".cm-footref")) return null;
	const editor = target.closest<HTMLElement>(".cm-editor");
	if (!editor) return null;
	const modified = event.ctrlKey || event.metaKey;
	if (!modified && !target.closest(".markdown-source-view.is-live-preview")) return null;
	const view = EditorView.findFromDOM(editor);
	if (!view || view.composing) return null;
	const file = view.state.field(editorInfoField, false)?.file;
	if (!file) return null;
	const position = view.posAtDOM(target);
	if (!modified && view.hasFocus &&
		view.state.doc.lineAt(position).number === view.state.doc.lineAt(view.state.selection.main.head).number) return null;
	const cache = app.metadataCache.getFileCache(file);
	const reference = cache?.footnoteRefs?.find(ref =>
		ref.position.start.offset <= position && ref.position.end.offset >= position);
	if (!reference) return null;
	const definition = cache?.footnotes?.find(note => note.id === reference.id);
	if (!definition) return null;
	const offset = definition.position.start.offset;
	// Metadata can lag behind typing; never jump using coordinates for different text.
	if (offset > view.state.doc.length ||
		view.state.sliceDoc(reference.position.start.offset, reference.position.end.offset) !== `[^${reference.id}]` ||
		view.state.sliceDoc(offset, offset + reference.id.length + 4) !== `[^${reference.id}]:`) return null;
	return { view, offset };
}

export function registerFootnoteNavigation(plugin: Plugin): void {
	plugin.registerEditorExtension(footnoteNavigationHighlight);
	const swallow = (event: MouseEvent): void => {
		if (!footnoteTargetForEvent(event, plugin.app)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	onEachDocument(plugin, "mousedown", swallow, true);
	onEachDocument(plugin, "mouseup", swallow, true);
	onEachDocument(plugin, "click", event => {
		const target = footnoteTargetForEvent(event, plugin.app);
		if (!target) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		target.view.dispatch({
			selection: { anchor: target.offset },
			effects: [
				EditorView.scrollIntoView(target.offset, { y: "center" }),
				highlightFootnote.of(target.offset),
			],
		});
		target.view.focus();
	}, true);
}
