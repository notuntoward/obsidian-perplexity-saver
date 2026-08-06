import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, WidgetType, EditorView } from "@codemirror/view";
import { createPerplexityNote } from "./note-creator";
import { registerRemoveSourcesWithNoDialogCommand } from "./commands/removeNoDialog";
import { registerSyncCommand } from "./commands/sync";
import { registerDeleteTurnCommand } from "./commands/delete";
import { registerRemoveSourcesWithNoCiteCommand } from "./commands/removeNoCite";
import { suggestFilenameFromClipboard } from "./commands/import";
import { HeadlineMethod, HeadlineOptions } from "./normalize/headlines";
import { detectAndParse } from "./parsers/detect";
import { resolveSourceTitles } from "./scraper";
import { stripLeadingFrontmatterIfPresent } from "./normalize/frontmatter";
import { DialogFile } from "./parsers/types";

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
}

const startPerplexityInput = StateEffect.define<InlineInputData>();
const clearPerplexityInput = StateEffect.define<null>();

export default class PerplexitySaverPlugin extends Plugin {
	settings: PerplexitySaverSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

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
		const defaultFilename = hasSelection
			? cm6View.state.doc.sliceString(selection.from, selection.to)
			: suggestFilenameFromClipboard(noteContent, "");

		// Start pre-fetching source titles in parallel immediately as soon as command is run
		let prefetchedDialogPromise: Promise<DialogFile> | undefined = undefined;
		try {
			if (this.settings.autoFetchSourceTitles) {
				const { body: stripped } = stripLeadingFrontmatterIfPresent(noteContent);
				const dialog = detectAndParse(stripped);
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

		const pos = selection.from;
		cm6View.dispatch({
			changes: hasSelection
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

class InlineInputWidget extends WidgetType {
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

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 10);

		input.addEventListener("keydown", async (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				const filename = input.value.trim();
				if (filename) {
					await this.handleSubmit(filename);
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.data.editorView.dispatch({
					effects: clearPerplexityInput.of(null),
				});
				this.data.editorView.focus();
			}
		});

		wrap.appendChild(input);
		return wrap;
	}

	ignoreEvent(): boolean {
		return true;
	}

	private async handleSubmit(filename: string): Promise<void> {
		const { noteContent, activeFile, editorView, from, to, prefetchedDialogPromise } = this.data;

		const result = await createPerplexityNote({
			app: this.plugin.app,
			activeFile,
			clipboardContent: noteContent,
			filename,
			searchesFolder: this.plugin.settings.searchesFolder,
			generatedTag: this.plugin.settings.generatedTag,
			collapseBlankLines: this.plugin.settings.collapseBlankLines,
			collapsePromptCallouts: this.plugin.settings.collapsePromptCallouts,
			headlineOptions: this.plugin.headlineOptions(),
			autoFetchSourceTitles: this.plugin.settings.autoFetchSourceTitles,
			sourceTitleMaxChars: this.plugin.settings.sourceTitleMaxChars,
			prefetchedDialogPromise,
		});

		if (!result.success) {
			new Notice(result.error);
			return;
		}

		editorView.dispatch({
			changes: { from, to, insert: result.linkText },
			effects: clearPerplexityInput.of(null),
		});

		editorView.focus();
		new Notice(`Saved note to ${result.newNotePath}`);
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
	}
}
