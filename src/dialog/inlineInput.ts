import { type Editor, type MarkdownView, Notice, type TFile } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, WidgetType, EditorView } from "@codemirror/view";
import { readClipboardIn, setTimeoutIn } from "commons/windows";
import type PerplexitySaverPlugin from "../main";
import { createPerplexityNote } from "../note-creator";
import { suggestFilenameFromClipboard } from "../commands/import";
import { sanitizeFilename, suggestFilenameFromSelection, determineWikilinkAlias } from "../utils";
import { detectAndParse } from "../parsers/detect";
import { resolveSourceTitles } from "../scraper";
import { stripLeadingFrontmatterIfPresent } from "../normalize/frontmatter";
import type { DialogFile } from "../parsers/types";
import { deduplicateDialogCitations } from "../normalize/turns";

interface InlineInputData {
	pos: number;
	from: number;
	to: number;
	noteContent: string;
	defaultFilename: string;
	activeFile: TFile;
	editorView: EditorView;
	prefetchedDialogPromise?: Promise<DialogFile>;
	originalSelectedText?: string;
}

const startPerplexityInput = StateEffect.define<InlineInputData>();
const clearPerplexityInput = StateEffect.define<null>();

export async function startImport(plugin: PerplexitySaverPlugin, editor: Editor, view: MarkdownView): Promise<void> {
	const activeFile = view.file;
	if (!activeFile) {
		new Notice("No active file found.");
		return;
	}

	const cm6Candidate: unknown = (editor as unknown as { cm?: unknown }).cm;
	const cm6View = cm6Candidate instanceof EditorView ? cm6Candidate : null;
	if (!cm6View) {
		new Notice("Could not access editor.");
		return;
	}

	const noteContent = await readClipboardIn((typeof activeWindow !== "undefined" ? activeWindow : null) ?? window);
	if (!noteContent) {
		new Notice("Clipboard is empty. Copy an AI dialog first.");
		return;
	}

	const selection = cm6View.state.selection.main;
	const hasSelection = selection.from !== selection.to;
	const selectedText = hasSelection
		? cm6View.state.doc.sliceString(selection.from, selection.to)
		: "";
	const trimmedSelectedText = selectedText.trim();
	const isWhitespaceSelection = hasSelection && trimmedSelectedText === "";
	const hasNonWhitespaceSelection = hasSelection && trimmedSelectedText !== "";

	let defaultFilename = "";
	if (hasNonWhitespaceSelection) {
		defaultFilename = suggestFilenameFromSelection(selectedText);
	}
	if (!defaultFilename) {
		defaultFilename = suggestFilenameFromClipboard(noteContent, "");
	}

	// Start pre-fetching source titles in parallel immediately as soon as command is run
	let prefetchedDialogPromise: Promise<DialogFile> | undefined = undefined;
	try {
		if (plugin.settings.autoFetchSourceTitles) {
			const { body: stripped } = stripLeadingFrontmatterIfPresent(noteContent);
			const dialog = detectAndParse(stripped);
			deduplicateDialogCitations(dialog);
			prefetchedDialogPromise = (async () => {
				try {
					await resolveSourceTitles(dialog, {
						autoFetchSourceTitles: plugin.settings.autoFetchSourceTitles,
						sourceTitleMaxChars: plugin.settings.sourceTitleMaxChars,
					});
					return dialog;
				} catch (err) {
					console.error("Error pre-fetching source titles asynchronously:", err);
					throw err;
				}
			})();
		}
	} catch (err) {
		console.error("Error setting up pre-fetched dialog promise:", err);
		prefetchedDialogPromise = undefined;
	}

	const pos = isWhitespaceSelection ? selection.to : selection.from;
	cm6View.dispatch({
		changes: hasNonWhitespaceSelection
			? { from: selection.from, to: selection.to, insert: "" }
			: undefined,
		effects: startPerplexityInput.of({
			pos,
			from: pos,
			to: pos,
			noteContent,
			defaultFilename,
			activeFile,
			editorView: cm6View,
			prefetchedDialogPromise,
			originalSelectedText: hasNonWhitespaceSelection ? selectedText : undefined,
		}),
	});
}


/**
 * How long to wait, after the user submits the filename, before showing any
 * "busy" visual on the input. Saves usually finish well under this and
 * should not flash a busy indicator; only a save that is genuinely taking a
 * while (e.g. a slow Zotero lookup) should visibly change the input's
 * appearance.
 */
const BUSY_INDICATOR_DELAY_MS = 350;

class InlineInputWidget extends WidgetType {
	private wrapEl?: HTMLElement;
	private inputEl?: HTMLInputElement;
	private submitting = false;
	private widgetWin: Window = window; // updated in toDOM to the editor's window

	constructor(
		private plugin: PerplexitySaverPlugin,
		private data: InlineInputData
	) {
		super();
	}

	eq(other: InlineInputWidget): boolean {
		return other.data.pos === this.data.pos;
	}

	toDOM(): HTMLElement {
		const doc = this.data.editorView.dom.ownerDocument;
		const win = doc.defaultView ?? window;
		this.widgetWin = win;
		const wrap = doc.createElement("span");
		wrap.className = "perplexity-inline-wrap";
		this.wrapEl = wrap;

		const input = doc.createElement("input");
		input.type = "text";
		input.placeholder = "Enter filename...";
		input.value = this.data.defaultFilename;
		input.className = "perplexity-inline-input";
		this.inputEl = input;

		const spinner = doc.createElement("span");
		spinner.className = "perplexity-inline-spinner";
		spinner.setAttribute("aria-hidden", "true");

		setTimeoutIn(win, () => {
			input.focus();
			input.select();
		}, 10);

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			void this.handleKeydown(e);
		});

		wrap.appendChild(input);
		wrap.appendChild(spinner);
		return wrap;
	}

	private async handleKeydown(e: KeyboardEvent): Promise<void> {
		const input = this.inputEl;
		if (!input) return;
		if (e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			if (this.submitting) return;
			const filename = input.value.trim();
			if (filename) {
				this.submitting = true;
				try {
					await this.handleSubmit(filename);
				} finally {
					// Must run even if handleSubmit throws (e.g. an
					// uncaught vault I/O or CM6 dispatch error):
					// otherwise `submitting` stays stuck at true forever
					// and every later Enter press silently no-ops,
					// looking exactly like a permanent hang.
					this.submitting = false;
				}
			}
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			const originalText = this.data.originalSelectedText;
			this.data.editorView.dispatch({
				changes: originalText
					? { from: this.data.pos, to: this.data.pos, insert: originalText }
					: undefined,
				effects: clearPerplexityInput.of(null),
			});
			this.data.editorView.focus();
		}
	}

	ignoreEvent(): boolean {
		return true;
	}

	/**
	 * Toggle the visible "busy" state (dims/disables the input, shows a
	 * spinner). Called only after BUSY_INDICATOR_DELAY_MS has elapsed
	 * without the save finishing, so a fast save never flashes it.
	 */
	private setBusy(busy: boolean): void {
		this.wrapEl?.classList.toggle("is-busy", busy);
	}

	private async handleSubmit(filename: string): Promise<void> {
		const { noteContent, activeFile, editorView, from, to, prefetchedDialogPromise } =
			this.data;

		// Disable the input immediately so it can't be edited or re-submitted
		// mid-save, but don't change its appearance yet — that only happens
		// if the save is still running after BUSY_INDICATOR_DELAY_MS.
		if (this.inputEl) {
			this.inputEl.disabled = true;
		}
		const busyTimer = setTimeoutIn(this.widgetWin, () => this.setBusy(true), BUSY_INDICATOR_DELAY_MS);

		// Live status (e.g. Zotero relink progress) surfaced via a single
		// persistent Notice, updated in place rather than stacking multiple
		// notices. This supplements, but is not a substitute for, the busy
		// indicator on the input itself — the Notice can be missed or
		// dismissed, but the input's own appearance can't be.
		let progressNotice: Notice | undefined;
		const onProgress = (message: string) => {
			if (!progressNotice) {
				progressNotice = new Notice(message, 0);
			} else {
				progressNotice.setMessage(message);
			}
		};

		const rawInput = filename;
		const sanitizedFilename = sanitizeFilename(rawInput).trim();

		const alias = determineWikilinkAlias(
			sanitizedFilename,
			this.data.originalSelectedText,
			this.data.defaultFilename,
			rawInput
		);

		try {
			const result = await createPerplexityNote({
				app: this.plugin.app,
				activeFile,
				clipboardContent: noteContent,
				filename: sanitizedFilename,
				alias,
				searchesFolder: this.plugin.settings.searchesFolder,
				generatedTag: this.plugin.settings.generatedTag,
				collapseBlankLines: this.plugin.settings.collapseBlankLines,
				collapsePromptCallouts: this.plugin.settings.collapsePromptCallouts,
				headlineOptions: this.plugin.headlineOptions(),
				autoFetchSourceTitles: this.plugin.settings.autoFetchSourceTitles,
				sourceTitleMaxChars: this.plugin.settings.sourceTitleMaxChars,
				prefetchedDialogPromise,
				autoRelinkSources: this.plugin.settings.autoRelinkSources,
				zoteroPort: this.plugin.settings.zoteroPort,
				litNotesFolder: this.plugin.settings.litNotesFolder,
				minTitleMatchScore: this.plugin.settings.minTitleMatchScore,
				zoteroClient: this.plugin.zoteroClient,
				onProgress,
			});

			if (!result.success) {
				new Notice(result.error);
				return; // input re-enabled below in `finally`, regardless of outcome
			}

			// Explicitly place the cursor immediately after the inserted link.
			// Without this, CM6 maps the pre-existing collapsed selection
			// through the change using its default association, which lands
			// the cursor at the *start* of the inserted text (inside the
			// link) rather than past it — leaving the link rendered "open"
			// (raw [[...]] syntax visible) instead of closed.
			//
			// Placing the cursor immediately at the end of the link (right
			// after `]]`) is not enough on its own: Obsidian's Live Preview
			// keeps a [[link]] rendered as raw/open text whenever the
			// cursor merely touches its boundary, not only when it's
			// inside. Insert a trailing space and place the cursor past
			// that space instead, so the cursor is unambiguously outside
			// the link's range and it renders closed.
			const insertText = result.linkText + " ";
			editorView.dispatch({
				changes: { from, to, insert: insertText },
				selection: { anchor: from + insertText.length },
				effects: clearPerplexityInput.of(null),
			});

			editorView.focus();
			new Notice(`Saved note to ${result.newNotePath}`);
		} catch (err) {
			// Any unexpected error (vault I/O, CM6 dispatch, an uncaught
			// network error somewhere in the pipeline, etc.) must not leave
			// the input permanently disabled with no visible feedback —
			// that looks exactly like a hang, since a disabled <input>
			// doesn't receive further keydown events at all. Surface it and
			// fall through to `finally`, which always re-enables the input.
			console.error("Error saving AI dialog note:", err);
			new Notice("Failed to save the note — see console for details.");
		} finally {
			busyTimer();
			this.setBusy(false);
			progressNotice?.hide();
			if (this.inputEl) {
				this.inputEl.disabled = false;
			}
		}
	}
}

export function perplexityInputStateField(plugin: PerplexitySaverPlugin) {
	return StateField.define<DecorationSet>({
		create() {
			return Decoration.none;
		},
		update(value, tr) {
			value = value.map(tr.changes);

			for (const effect of tr.effects) {
				if (effect.is(startPerplexityInput)) {
					const deco = Decoration.widget({
						widget: new InlineInputWidget(plugin, effect.value),
						side: 1,
					});
					return Decoration.set([deco.range(effect.value.pos)]);
				}
				if (effect.is(clearPerplexityInput)) {
					return Decoration.none;
				}
			}
			return value;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
}
