import { setTimeoutIn } from "commons/windows";
import { ItemSuggestModal } from "commons/modal";
import { App, Editor, FuzzySuggestModal, MarkdownView, Notice, TFile } from "obsidian";
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

/**
 * Level 1 Modal: Select a Literature Note from the vault folder.
 */
export class LitNoteSelectModal extends ItemSuggestModal<LitNoteInfo> {
	constructor(
		app: App,
		items: LitNoteInfo[],
		onSelectNote: (note: LitNoteInfo) => void
	) {
		const rank = new Map(items.map((item, index) => [item, index]));
		super(app, items, onSelectNote, {
			placeholder: "Select a literature note...",
			minHighlightRun: MIN_HIGHLIGHT_RUN,
			getTitle: (item) => item.title || item.displayText || item.file.basename,
			getSubtitle: (item) => item.title ? item.citekey || item.file.basename : undefined,
			getAliases: () => [],
			sort: (a, b) => (rank.get(a.item) ?? 0) - (rank.get(b.item) ?? 0),
		});
	}

	renderSuggestion(
		match: Parameters<ItemSuggestModal<LitNoteInfo>["renderSuggestion"]>[0],
		el: HTMLElement
	): void {
		el.addClass("litnote-suggestion");
		super.renderSuggestion(match, el);
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
		editorCallback: (editor: Editor, view: MarkdownView) => {
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

					const win = view.containerEl.ownerDocument?.defaultView ?? window;
					setTimeoutIn(win, () => level2Modal.open(), 50);
				}
			);

			level1Modal.open();
		},
	});
}
