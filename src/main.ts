import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, WidgetType, EditorView } from "@codemirror/view";
import { createPerplexityNote } from "./note-creator";
import { registerRemoveSourcesWithNoDialogCommand } from "./commands/removeNoDialog";
import { registerSyncCommand } from "./commands/sync";
import { registerDeleteTurnCommand } from "./commands/delete";
import { registerRemoveSourcesWithNoCiteCommand } from "./commands/removeNoCite";
import { registerRelinkSourcesCommand } from "./commands/relink";
import { suggestFilenameFromClipboard } from "./commands/import";
import { sanitizeFilename, suggestFilenameFromSelection, determineWikilinkAlias } from "./utils";
import { HeadlineMethod, HeadlineOptions } from "./normalize/headlines";
import { detectAndParse } from "./parsers/detect";
import { resolveSourceTitles } from "./scraper";
import { stripLeadingFrontmatterIfPresent } from "./normalize/frontmatter";
import { DialogFile } from "./parsers/types";
import { ZoteroClient } from "./zotero/zoteroClient";
import { deduplicateDialogCitations } from "./normalize/turns";

interface PerplexitySaverSettings {
	searchesFolder: string;
	generatedTag: string;
	/**
	 * When on, the note body is post-processed to remove blank lines
	 * immediately before and after every heading and to collapse any run
	 * of 2+ blank lines to one. Produces a denser, more uniform file.
	 */
	collapseBlankLines: boolean;
	/**
	 * When on (the default), prompt callouts are rendered as collapsed
	 * by default (`> [!Prompt]+`). When off, they are rendered as
	 * expanded by default (`> [!Prompt]-`).
	 */
	collapsePromptCallouts: boolean;
	/**
	 * Algorithm for the summary heading above each user prompt in a saved
	 * note. "lead" uses the first sentence (fast, no deps); "tf-idf" ranks
	 * every sentence by TF-IDF with a lead-position prior and picks the
	 * best (requires the `stopword` package).
	 */
	headlineMethod: HeadlineMethod;
	/** Max length of the summary heading, including a possible ellipsis. */
	headlineMaxChars: number;
	/**
	 * Lead-position prior for the TF-IDF method. 0 disables it. The
	 * sentence in position i gets bonus `leadBias * (1 - i / N)`. Reasonable
	 * range: 0.05 to 0.35. Ignored when headlineMethod is "lead".
	 */
	headlineLeadBias: number;
	/**
	 * Automatically fetch webpage titles to build clean markdown links for sources.
	 */
	autoFetchSourceTitles: boolean;
	/**
	 * Maximum length of a fetched source link title.
	 */
	sourceTitleMaxChars: number;
	/**
	 * Local HTTP Port for Zotero 7 API communication.
	 */
	zoteroPort: number;
	/**
	 * Literature notes folder path in vault (defaults to lit/lit_notes from refwrangle).
	 */
	litNotesFolder: string;
	/**
	 * Minimum title fuzzy match score (0-100) for matching sources to Zotero items.
	 */
	minTitleMatchScore: number;
	/**
	 * Automatically relink sources with Zotero and Obsidian literature notes when importing/syncing.
	 */
	autoRelinkSources: boolean;
}

const DEFAULT_SETTINGS: PerplexitySaverSettings = {
	searchesFolder: "ai-searches",
	generatedTag: "ai-generated",
	collapseBlankLines: true,
	collapsePromptCallouts: true,
	headlineMethod: "lead",
	headlineMaxChars: 100,
	headlineLeadBias: 0.20,
	autoFetchSourceTitles: true,
	sourceTitleMaxChars: 100,
	zoteroPort: 23119,
	litNotesFolder: "lit/lit_notes",
	minTitleMatchScore: 95,
	autoRelinkSources: false,
};

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

export default class PerplexitySaverPlugin extends Plugin {
	settings!: PerplexitySaverSettings;
	zoteroClient!: ZoteroClient;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.zoteroClient = new ZoteroClient({ port: this.settings.zoteroPort });

		this.registerEditorExtension(perplexityInputStateField(this));

		this.addCommand({
			id: "import-ai-dialog-from-clipboard",
			name: "Import AI dialog from clipboard",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.startImport(editor, view);
			},
		});

		registerSyncCommand(this);
		registerDeleteTurnCommand(this);
		registerRemoveSourcesWithNoDialogCommand(this);
		registerRemoveSourcesWithNoCiteCommand(this);
		registerRelinkSourcesCommand(this);

		this.addSettingTab(new PerplexitySaverSettingTab(this.app, this));
	}

	private async startImport(editor: Editor, view: MarkdownView): Promise<void> {
		const activeFile = view.file;
		if (!activeFile) {
			new Notice("No active file found.");
			return;
		}

		const cm6View = (editor as any).cm as EditorView;
		if (!cm6View) {
			new Notice("Could not access editor.");
			return;
		}

		const noteContent = await navigator.clipboard.readText();
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
			if (this.settings.autoFetchSourceTitles) {
				const { body: stripped } = stripLeadingFrontmatterIfPresent(noteContent);
				const dialog = detectAndParse(stripped);
				deduplicateDialogCitations(dialog);
				prefetchedDialogPromise = (async () => {
					try {
						await resolveSourceTitles(dialog, {
							autoFetchSourceTitles: this.settings.autoFetchSourceTitles,
							sourceTitleMaxChars: this.settings.sourceTitleMaxChars,
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

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Build the HeadlineOptions the renderer consumes from the current
	 * settings. Centralized here so the import path, the append path, and
	 * the settings tab all see the same resolved values.
	 */
	headlineOptions(): HeadlineOptions {
		return {
			method: this.settings.headlineMethod,
			maxChars: this.settings.headlineMaxChars,
			leadBias: this.settings.headlineLeadBias,
		};
	}
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
		const wrap = document.createElement("span");
		wrap.className = "perplexity-inline-wrap";
		this.wrapEl = wrap;

		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "Enter filename...";
		input.value = this.data.defaultFilename;
		input.className = "perplexity-inline-input";
		input.style.marginLeft = "4px";
		input.style.marginRight = "4px";
		input.style.border = "none";
		input.style.borderBottom = "1px solid var(--text-accent)";
		input.style.background = "var(--background-primary-alt)";
		input.style.padding = "2px 6px";
		input.style.minWidth = "200px";
		this.inputEl = input;

		const spinner = document.createElement("span");
		spinner.className = "perplexity-inline-spinner";
		spinner.setAttribute("aria-hidden", "true");

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 10);

		input.addEventListener("keydown", async (e: KeyboardEvent) => {
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
		});

		wrap.appendChild(input);
		wrap.appendChild(spinner);
		return wrap;
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
		const { noteContent, activeFile, editorView, from, to, prefetchedDialogPromise } = this.data;

		// Disable the input immediately so it can't be edited or re-submitted
		// mid-save, but don't change its appearance yet — that only happens
		// if the save is still running after BUSY_INDICATOR_DELAY_MS.
		if (this.inputEl) {
			this.inputEl.disabled = true;
		}
		const busyTimer = window.setTimeout(() => this.setBusy(true), BUSY_INDICATOR_DELAY_MS);

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
			window.clearTimeout(busyTimer);
			this.setBusy(false);
			progressNotice?.hide();
			if (this.inputEl) {
				this.inputEl.disabled = false;
			}
		}
	}
}

function perplexityInputStateField(plugin: PerplexitySaverPlugin) {
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

class PerplexitySaverSettingTab extends PluginSettingTab {
	plugin: PerplexitySaverPlugin;

	constructor(app: App, plugin: PerplexitySaverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("AI save folder")
			.setDesc("The name of the folder where AI notes are stored (relative to the active note).")
			.addText((text) =>
				text
					.setPlaceholder("ai-searches")
					.setValue(this.plugin.settings.searchesFolder)
					.onChange(async (value) => {
						this.plugin.settings.searchesFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("AI generated tag")
			.setDesc("The tag inserted into the AI note's frontmatter.")
			.addText((text) =>
				text
					.setPlaceholder("ai-generated")
					.setValue(this.plugin.settings.generatedTag)
					.onChange(async (value) => {
						this.plugin.settings.generatedTag = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Collapse blank lines")
			.setDesc(
				"Collapse any run of 2+ blank lines down to one, including around headings. Produces a denser, more uniform file while keeping one blank line between paragraphs and headings."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.collapseBlankLines)
					.onChange(async (value) => {
						this.plugin.settings.collapseBlankLines = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Collapse prompt callouts")
			.setDesc(
				"When on, prompt callouts start collapsed (`> [!Prompt]+`). When off, they start expanded (`> [!Prompt]-`)."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.collapsePromptCallouts)
					.onChange(async (value) => {
						this.plugin.settings.collapsePromptCallouts = value;
						await this.plugin.saveSettings();
					})
			);

		// "Prompt heading" group: the three controls that govern how the
		// level-2 summary heading above each user prompt is generated.
		containerEl.createEl("h3", { text: "Prompt heading" });

		// isTfidf is computed once and used to gate the lead-bias input.
		// The max-chars input is always active because both methods use it.
		const isTfidf = this.plugin.settings.headlineMethod === "tf-idf";

		new Setting(containerEl)
			.setName("Heading max characters")
			.setDesc(
				"Maximum length of the summary heading, including a possible ellipsis. 90-120 is suitable for note titles."
			)
			.addText((text) => {
				text
					.setPlaceholder("100")
					.setValue(String(this.plugin.settings.headlineMaxChars))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.headlineMaxChars = n;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(containerEl)
			.setName("Prompt heading method")
			.setDesc(
				"Algorithm for the summary heading above each user prompt. " +
					"'Lead sentence' uses the first sentence that fits (fast, no extra deps). " +
					"'TF-IDF ranked sentence' ranks every sentence by term salience with a " +
					"lead-position prior and picks the best (requires the stopword package)."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("lead", "Lead sentence")
					.addOption("tf-idf", "TF-IDF ranked sentence")
					.setValue(this.plugin.settings.headlineMethod)
					.onChange(async (value) => {
						this.plugin.settings.headlineMethod = value as HeadlineMethod;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		const leadBiasSetting = new Setting(containerEl)
			.setName("Heading lead bias")
			.setDesc(
				isTfidf
					? "Amount to favor sentences near the beginning when picking the best sentence. 0 disables it. Reasonable range 0.05-0.35."
					: "Only applies when 'TF-IDF ranked sentence' is selected above. Grayed out until you switch to TF-IDF."
			)
			.addText((text) => {
				text
					.setPlaceholder("0.20")
					.setValue(String(this.plugin.settings.headlineLeadBias))
					.onChange(async (value) => {
						const n = parseFloat(value);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.headlineLeadBias = n;
							await this.plugin.saveSettings();
						}
					});
			});

		// Gray out the lead-bias input when TF-IDF is not selected. Obsidian's
		// Setting.setDisabled() alone is not enough because the underlying
		// <input> element is not visually grayed by default. The reliable
		// pattern (used by obsidian-visible-cursor and others) is to call
		// setDisabled() AND toggle the `is-disabled` class on the setting
		// container, plus provide a CSS rule for `.is-disabled` to
		// actually make the row look inactive.
		if (!isTfidf) {
			leadBiasSetting.setDisabled(true);
			leadBiasSetting.settingEl.classList.add("is-disabled");
			const inputEl = leadBiasSetting.settingEl.querySelector("input");
			if (inputEl) inputEl.setAttribute("disabled", "true");
		}

		// "Source link title shortening" group
		containerEl.createEl("h3", { text: "Source link title shortening" });

		new Setting(containerEl)
			.setName("Auto-fetch source titles")
			.setDesc("Automatically fetch webpage titles to build clean markdown links for sources.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoFetchSourceTitles)
					.onChange(async (value) => {
						this.plugin.settings.autoFetchSourceTitles = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		const sourceMaxCharsSetting = new Setting(containerEl)
			.setName("Source title max characters")
			.setDesc("Maximum length of a fetched source link title, including a possible ellipsis.")
			.addText((text) => {
				text
					.setPlaceholder("100")
					.setValue(String(this.plugin.settings.sourceTitleMaxChars))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.sourceTitleMaxChars = n;
							await this.plugin.saveSettings();
						}
					});
			});

		if (!this.plugin.settings.autoFetchSourceTitles) {
			sourceMaxCharsSetting.setDisabled(true);
			sourceMaxCharsSetting.settingEl.classList.add("is-disabled");
			const inputEl = sourceMaxCharsSetting.settingEl.querySelector("input");
			if (inputEl) inputEl.setAttribute("disabled", "true");
		}

		// "Zotero & Literature Note Relinking" group
		containerEl.createEl("h3", { text: "Zotero & Literature Note Relinking" });

		new Setting(containerEl)
			.setName("Auto-relink sources")
			.setDesc("Automatically run Zotero relinking when importing or syncing new turns.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoRelinkSources)
					.onChange(async (value) => {
						this.plugin.settings.autoRelinkSources = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Zotero HTTP Port")
			.setDesc("Local HTTP port for Zotero 7 API communication (defaults to 23119).")
			.addText((text) => {
				text
					.setPlaceholder("23119")
					.setValue(String(this.plugin.settings.zoteroPort))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.zoteroPort = n;
							this.plugin.zoteroClient = new ZoteroClient({ port: n });
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(containerEl)
			.setName("Literature notes folder")
			.setDesc(
				"Vault folder where literature notes reside (e.g. lit/lit_notes). Leave blank to search anywhere in vault."
			)
			.addText((text) => {
				text
					.setPlaceholder("lit/lit_notes")
					.setValue(this.plugin.settings.litNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.litNotesFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Minimum title match score")
			.setDesc("Minimum fuzzy similarity score (0-100) required to match an AI source title to a Zotero item.")
			.addText((text) => {
				text
					.setPlaceholder("95")
					.setValue(String(this.plugin.settings.minTitleMatchScore))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0 && n <= 100) {
							this.plugin.settings.minTitleMatchScore = n;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(containerEl)
			.setName("Zotero library cache")
			.setDesc("Clear in-memory cached Zotero library items to force a fresh fetch from Zotero on the next relink.")
			.addButton((button) => {
				button.setButtonText("Clear Cache").onClick(() => {
					this.plugin.zoteroClient.clearCache();
					new Notice("Zotero library cache cleared.");
				});
			});
	}
}
