import { App, Editor, FuzzyMatch, FuzzySuggestModal, MarkdownView, Notice, SearchResult, TFile, renderResults } from "obsidian";
import { getLitNoteFiles } from "../litNote/litNoteFinder";
import type { ZoteroClient } from "../zotero/zoteroClient";
import { sortByEngagement } from "../litNote/engagementSort";
import type { ViewTracker } from "../litNote/viewTracker";
import { extractLitNoteMetadata, readLitNote } from "../litNote/litNoteReader";

export interface LitNoteInfo {
	file: TFile;
	title: string;
	aliases: string[];
	citekey: string;
	publication_date?: string;
	displayText?: string;
}

export interface LinkOption {
	displayText: string;
	linkText: string;
}

const MIN_HIGHLIGHT_RUN = 2;

/** Drop single-character match ranges so scattered fuzzy hits don't speckle the row. */
function pruneShortRuns(result: SearchResult): SearchResult {
	const matches = result.matches.filter(([start, end]) => end - start >= MIN_HIGHLIGHT_RUN);
	return matches.length > 0 ? { score: result.score, matches } : result;
}

/**
 * Level 1 Modal: Select a Literature Note from the vault folder.
 */
export class LitNoteSelectModal extends FuzzySuggestModal<LitNoteInfo> {
	constructor(
		app: App,
		private items: LitNoteInfo[],
		private onSelectNote: (note: LitNoteInfo) => void
	) {
		super(app);
		this.setPlaceholder("Select a literature note...");
	}

	getItems(): LitNoteInfo[] {
		return this.items;
	}

	private keyOf(item: LitNoteInfo): string {
		return item.citekey || item.file.basename;
	}

	getItemText(item: LitNoteInfo): string {
		return item.displayText ?? (item.title ? `${item.title} (${this.keyOf(item)})` : item.file.basename);
	}

	renderSuggestion(match: FuzzyMatch<LitNoteInfo>, el: HTMLElement): void {
		el.addClass("litnote-suggestion");
		const item = match.item;
		const result = pruneShortRuns(match.match);
		if (!item.title) {
			renderResults(el.createDiv({ cls: "litnote-title" }), item.file.basename, result);
			return;
		}

		renderResults(el.createDiv({ cls: "litnote-title" }), item.title, result);
		// The + 2 accounts for the " (" between title and key in getItemText.
		renderResults(
			el.createDiv({ cls: "litnote-citekey" }),
			this.keyOf(item),
			result,
			-(item.title.length + 2)
		);
	}

	onChooseItem(item: LitNoteInfo, _evt: MouseEvent | KeyboardEvent): void {
		this.onSelectNote(item);
	}
}

/**
 * Level 2 Modal: Select link display text option (title, then aliases, then citekey).
 */
export class LinkOptionSelectModal extends FuzzySuggestModal<LinkOption> {
	constructor(
		app: App,
		private options: LinkOption[],
		private onSelectOption: (option: LinkOption) => void
	) {
		super(app);
		this.setPlaceholder("Select link text...");
	}

	getItems(): LinkOption[] {
		return this.options;
	}

	getItemText(item: LinkOption): string {
		return item.displayText;
	}

	onChooseItem(item: LinkOption, _evt: MouseEvent | KeyboardEvent): void {
		this.onSelectOption(item);
	}
}

/**
 * Synchronously extract LitNoteInfo from Obsidian's in-memory metadataCache.
 * Avoids slow disk I/O when opening the picker.
 */
export function getLitNoteInfo(app: App, file: TFile): LitNoteInfo {
	const cache = app.metadataCache?.getFileCache(file);
	const fm = (cache?.frontmatter || (file as any).frontmatter) as
		| Record<string, unknown>
		| undefined;
	const meta = extractLitNoteMetadata(fm, file.basename);
	const title = meta.title;
	const citekey = meta.citekey || file.basename;
	const key = citekey || file.basename;
	const displayText = title ? `${title} (${key})` : file.basename;

	return {
		file,
		title,
		aliases: meta.aliases,
		citekey,
		publication_date: meta.publication_date,
		displayText,
	};
}

export async function parseLitNoteInfo(app: App, file: TFile): Promise<LitNoteInfo> {
	const cache = app.metadataCache?.getFileCache(file);
	const fm = (cache?.frontmatter || (file as any).frontmatter) as
		| Record<string, unknown>
		| undefined;
	if (fm) {
		return getLitNoteInfo(app, file);
	}
	if (app.vault?.read) {
		const content = await app.vault.read(file);
		const meta = readLitNote(content, file.basename);
		const title = meta.title;
		const citekey = meta.citekey || file.basename;
		const key = citekey || file.basename;
		return {
			file,
			title,
			aliases: meta.aliases,
			citekey,
			publication_date: meta.publication_date,
			displayText: title ? `${title} (${key})` : file.basename,
		};
	}
	return getLitNoteInfo(app, file);
}

export function buildLinkOptionsForNote(note: LitNoteInfo): LinkOption[] {
	const options: LinkOption[] = [];
	const stem = note.file.basename;
	const addedTexts = new Set<string>();

	// 1. Note title property first
	if (note.title) {
		const text = note.title.trim();
		if (text && !addedTexts.has(text.toLowerCase())) {
			addedTexts.add(text.toLowerCase());
			options.push({
				displayText: text,
				linkText: text === stem ? `[[${stem}]]` : `[[${stem}|${text}]]`,
			});
		}
	}

	// 2. Whatever is in aliases property
	for (const alias of note.aliases) {
		const text = alias.trim();
		if (text && !addedTexts.has(text.toLowerCase())) {
			addedTexts.add(text.toLowerCase());
			options.push({
				displayText: text,
				linkText: text === stem ? `[[${stem}]]` : `[[${stem}|${text}]]`,
			});
		}
	}

	// 3. Citekey / basename last
	const citekeyText = (note.citekey || note.file.basename).trim();
	if (citekeyText && !addedTexts.has(citekeyText.toLowerCase())) {
		addedTexts.add(citekeyText.toLowerCase());
		options.push({
			displayText: citekeyText,
			linkText: citekeyText === stem ? `[[${stem}]]` : `[[${stem}|${citekeyText}]]`,
		});
	}

	// Default fallback if no options added
	if (options.length === 0) {
		options.push({
			displayText: stem,
			linkText: `[[${stem}]]`,
		});
	}

	return options;
}

export function registerGetLitNoteLinkCommand(plugin: {
	app: App;
	addCommand: (cmd: unknown) => unknown;
	settings: {
		litNotesFolder: string;
	};
	zoteroClient?: ZoteroClient;
	viewTracker?: ViewTracker;
}): void {
	plugin.addCommand({
		id: "get-literature-note-link",
		name: "Get literature note link",
		editorCallback: (editor: Editor, _view: MarkdownView) => {
			const files = getLitNoteFiles(plugin.app, plugin.settings.litNotesFolder);
			if (files.length === 0) {
				new Notice(`No literature notes found in '${plugin.settings.litNotesFolder}'.`);
				return;
			}

			// Sort BEFORE building items (so engagement order is preserved).
			const sortedFiles = sortByEngagement(files, plugin.viewTracker?.map ?? new Map());
			// Extract note info synchronously from in-memory metadataCache (no disk I/O).
			const notesInfo = sortedFiles.map((f) => getLitNoteInfo(plugin.app, f));

			// Level 1: Select a Literature Note
			const level1Modal = new LitNoteSelectModal(
				plugin.app,
				notesInfo,
				(selectedNote) => {
					const linkOptions = buildLinkOptionsForNote(selectedNote);

					// Level 2: Select Link Text Option (Title -> Aliases -> Citekey)
					const level2Modal = new LinkOptionSelectModal(
						plugin.app,
						linkOptions,
						(selectedOption) => {
							editor.replaceSelection(selectedOption.linkText);
						}
					);

					window.setTimeout(() => level2Modal.open(), 50);
				}
			);

			level1Modal.open();
		},
	});
}
