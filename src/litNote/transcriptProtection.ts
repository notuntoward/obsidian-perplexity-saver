import { EditorState, Facet, StateEffect, StateField, Transaction, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { parser } from "@lezer/markdown";
import { editorInfoField, getFrontMatterInfo, MarkdownView, Notice, setIcon, setTooltip, type Plugin, type TFile } from "obsidian";
import { getActiveLeafInFocusedWindow } from "commons/workspace";
import { askNoteDecision } from "./decisionModal";
import { DEFAULT_TRANSCRIPT_HEADING, detectTranscriptSections, normalizeTranscriptHeading } from "./transcriptSection";

interface TranscriptRange {
	from: number;
	to: number;
	headingEnd: number;
}

interface ProtectionConfig {
	heading(): string;
	requestUnlock(view: EditorView): Promise<void>;
}

const config = Facet.define<ProtectionConfig, ProtectionConfig>({
	combine: (values) => values[0],
});
const setUnlocked = StateEffect.define<boolean>();
const approvedUpdates = new WeakMap<TFile, string>();
const parsedRanges = new WeakMap<Text, { heading: string; ranges: TranscriptRange[] }>();

/** Permit only the exact document produced by Saver's confirmed transcript repair. */
export function approveTranscriptUpdate(file: TFile, content: string): void {
	approvedUpdates.set(file, content);
}

function isApprovedUpdate(transaction: Transaction): boolean {
	if (transaction.annotation(Transaction.userEvent) !== undefined) return false;
	const file = transaction.startState.field(editorInfoField, false)?.file;
	return !!file && approvedUpdates.get(file) === transaction.newDoc.toString();
}

/** Parse the current editor text, not the potentially stale vault heading cache. */
export function protectedTranscriptRanges(doc: Text, heading: string): TranscriptRange[] {
	const cached = parsedRanges.get(doc);
	if (cached?.heading === heading) return cached.ranges;
	const content = doc.toString();
	const offset = getFrontMatterInfo(content).contentStart;
	const headings: { from: number; to: number; level: number; title: string }[] = [];
	const tree = parser.parse(content.slice(offset));
	for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
		const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
		if (!match) continue;
		const first = node.firstChild;
		const last = node.lastChild;
		const from = node.name.startsWith("ATX") && first?.name === "HeaderMark" ? first.to : node.from;
		const to = last?.name === "HeaderMark" && (node.name.startsWith("Setext") || last.from > from)
			? last.from : node.to;
		headings.push({
			from: node.from + offset,
			to: node.to + offset,
			level: Number(match[1]),
			title: content.slice(from + offset, to + offset).trim().toLowerCase(),
		});
	}
	const wanted = normalizeTranscriptHeading(heading).toLowerCase();
	let ranges = headings.flatMap((item, index) => {
		if (item.title !== wanted && item.title !== DEFAULT_TRANSCRIPT_HEADING.toLowerCase()) return [];
		const next = headings.slice(index + 1).find((candidate) => candidate.level <= item.level);
		return [{ from: item.from, to: next?.from ?? doc.length, headingEnd: item.to }];
	});
	if (!ranges.length) {
		// Same fallback as the transcript panel: one section that is recognizably a transcript, under any heading.
		const detected = detectTranscriptSections(content, headings.map((item) => ({ level: item.level, start: item.from, end: item.to })));
		if (detected.length === 1) {
			const item = headings[detected[0].index];
			ranges = [{ from: item.from, to: detected[0].range.end, headingEnd: item.to }];
		}
	}
	parsedRanges.set(doc, { heading, ranges });
	return ranges;
}

interface ProtectionState {
	ranges: TranscriptRange[];
	unlocked: boolean;
	filePath: string | null;
	heading: string;
	decorations: DecorationSet;
}

class LockWidget extends WidgetType {
	constructor(private readonly unlocked: boolean) { super(); }

	eq(other: LockWidget): boolean { return this.unlocked === other.unlocked; }

	toDOM(view: EditorView): HTMLElement {
		const el = view.dom.ownerDocument.createDocumentFragment().createSpan({ cls: "saver-transcript-lock" });
		if (this.unlocked) el.classList.add("is-unlocked");
		const button = el.createEl("button", { cls: "clickable-icon saver-transcript-lock-button" });
		button.type = "button";
		setIcon(button, this.unlocked ? "lock-open" : "lock");
		setTooltip(button, this.unlocked ? "Transcript unlocked · Click to lock" : "Transcript protected · Click to unlock");
		button.setAttribute("aria-label", this.unlocked ? "Lock transcript" : "Unlock transcript for editing");
		if (this.unlocked) el.createSpan({ text: "Unlocked" });
		button.addEventListener("click", () => {
			if (this.unlocked) lockTranscript(view);
			else void view.state.facet(config).requestUnlock(view).catch((error: unknown) => {
				console.error("Perplexity Saver: could not unlock transcript", error);
				new Notice("Could not unlock the transcript.");
			});
		});
		return el;
	}
}

function protectionState(state: EditorState, unlocked: boolean): ProtectionState {
	const heading = state.facet(config).heading();
	const ranges = protectedTranscriptRanges(state.doc, heading);
	return {
		ranges, unlocked, heading,
		filePath: state.field(editorFilePath, false) ?? null,
		decorations: Decoration.set(ranges.map((range) => Decoration.widget({
			widget: new LockWidget(unlocked), side: 1,
		}).range(range.headingEnd))),
	};
}

// File identity is supplied by Obsidian through its public editor state field.
const editorFilePath = StateField.define<string | null>({
	create: (state) => state.field(editorInfoField, false)?.file?.path ?? null,
	update: (_path, transaction) => transaction.state.field(editorInfoField, false)?.file?.path ?? null,
});

function replacesDocument(transaction: Transaction): boolean {
	let full = false;
	transaction.changes.iterChangedRanges((from, to) => {
		if (from === 0 && to === transaction.startState.doc.length) full = true;
	});
	return transaction.docChanged && full && transaction.annotation(Transaction.userEvent) === undefined;
}

export const transcriptProtectionState = StateField.define<ProtectionState>({
	create: (state) => protectionState(state, false),
	update: (value, transaction) => {
		let unlocked = value.unlocked;
		if (replacesDocument(transaction) || transaction.docChanged && isApprovedUpdate(transaction) ||
			transaction.state.field(editorFilePath) !== value.filePath) unlocked = false;
		for (const effect of transaction.effects) {
			if (effect.is(setUnlocked)) unlocked = effect.value;
		}
		if (!transaction.docChanged && unlocked === value.unlocked &&
			transaction.state.facet(config).heading() === value.heading &&
			transaction.state.field(editorFilePath) === value.filePath) return value;
		return protectionState(transaction.state, unlocked);
	},
	provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function lockTranscript(view: EditorView): void {
	view.dispatch({ effects: setUnlocked.of(false), annotations: Transaction.addToHistory.of(false) });
}

export function unlockTranscript(view: EditorView): void {
	view.dispatch({ effects: setUnlocked.of(true), annotations: Transaction.addToHistory.of(false) });
}

export function isTranscriptCapturePosition(state: EditorState, from: number, to = from): boolean {
	const value = state.field(transcriptProtectionState, false);
	return !!value && protectedTranscriptRanges(state.doc, state.facet(config).heading())
		.some((range) => from <= range.to && to >= range.from);
}

/** Start of the first protected transcript section, or null when the note has none. */
export function transcriptStart(state: EditorState): number | null {
	if (!state.field(transcriptProtectionState, false)) return null;
	const ranges = protectedTranscriptRanges(state.doc, state.facet(config).heading());
	return ranges.length ? Math.min(...ranges.map((range) => range.from)) : null;
}

export function transcriptProtectionExtension(options: ProtectionConfig): Extension {
	let lastWarning = -Infinity;
	return [
		config.of(options), editorFilePath, transcriptProtectionState,
		EditorState.transactionFilter.of((transaction) => {
			const protection = transaction.startState.field(transcriptProtectionState);
			// Obsidian loads notes and applies vault.process updates by replacing the
			// document without a user event. These updates also reset the session lock.
			if (!transaction.docChanged || protection.unlocked || replacesDocument(transaction) || isApprovedUpdate(transaction)) return transaction;
			const ranges = protectedTranscriptRanges(transaction.startState.doc, options.heading());
			let blocked = false;
			transaction.changes.iterChangedRanges((from, to) => {
				if (ranges.some((range) => from === to
					? from >= range.from && from < range.to || from === range.to && range.to === transaction.startState.doc.length
					: from < range.to && to > range.from)) blocked = true;
			});
			if (!blocked && ranges.length) {
				const updated = protectedTranscriptRanges(transaction.newDoc, options.heading());
				// Removing a neighbouring newline or terminating heading must not
				// merge ordinary notes into the protected transcript.
				blocked = ranges.some((range) => !updated.some((candidate) =>
					candidate.from === transaction.changes.mapPos(range.from, 1) &&
					transaction.newDoc.sliceString(candidate.from, candidate.to) ===
						transaction.startState.doc.sliceString(range.from, range.to)));
			}
			if (!blocked) return transaction;
			const now = Date.now();
			if (now - lastWarning >= 2500) {
				lastWarning = now;
				new Notice("Transcript is protected. Unlock it from the transcript heading or command palette to edit.");
			}
			return [];
		}),
	];
}

export function registerTranscriptProtection(plugin: Plugin, heading: () => string): void {
	const requestUnlock = async (view: EditorView): Promise<void> => {
		const doc = view.state.doc;
		const filePath = view.state.field(editorFilePath);
		const choice = await askNoteDecision(plugin.app, "Unlock transcript for editing?",
			"Editing transcript text can invalidate word timings. Unlock until you lock it again or close this note? Relocking does not undo edits or repair timings.",
			[{ label: "Cancel", value: "cancel" }, { label: "Unlock", value: "unlock", warning: true }]);
		if (choice !== "unlock") return;
		if (!view.dom.isConnected || view.state.doc !== doc || view.state.field(editorFilePath) !== filePath) {
			new Notice("The note changed or closed before unlocking. The transcript remains protected.");
			return;
		}
		unlockTranscript(view);
	};
	plugin.registerEditorExtension(transcriptProtectionExtension({ heading, requestUnlock }));
	for (const unlocked of [false, true]) {
		plugin.addCommand({
			id: unlocked ? "lock-transcript" : "unlock-transcript-for-editing",
			name: unlocked ? "Lock transcript" : "Unlock transcript for editing",
			checkCallback: (checking: boolean) => {
				const leaf = getActiveLeafInFocusedWindow(plugin.app, { includeSidebars: true });
				if (!(leaf?.view instanceof MarkdownView)) return false;
				const el = leaf.view.containerEl.querySelector<HTMLElement>(".cm-editor");
				const view = el ? EditorView.findFromDOM(el) : null;
				const protection = view?.state.field(transcriptProtectionState, false);
				if (!view || !protection || protection.unlocked !== unlocked || !protection.ranges.length) return false;
				if (!checking) {
					if (unlocked) lockTranscript(view);
					else void requestUnlock(view).catch((error: unknown) => {
						console.error("Perplexity Saver: could not unlock transcript", error);
						new Notice("Could not unlock the transcript.");
					});
				}
				return true;
			},
		});
	}
}
