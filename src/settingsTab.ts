import path from "path";
import { App, FileSystemAdapter, Notice, PluginSettingTab, type Setting, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_TRANSCRIPT_HEADING } from "commons/youtube";
import type PerplexitySaverPlugin from "./main";
import { ZoteroClient } from "./zotero/zoteroClient";
import type { NameStyle } from "./litNote/bibtexName";
import { litNotesFolderError } from "./litNote/writeLitNote";

export class PerplexitySaverSettingTab extends PluginSettingTab {
	plugin: PerplexitySaverPlugin;
	private litNoteLocations?: Setting;

	constructor(app: App, plugin: PerplexitySaverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		if (key === "zoteroPort") {
			const n = Number(value);
			if (!isNaN(n) && n > 0) {
				this.plugin.zoteroClient = new ZoteroClient({ port: n });
			}
		}
		if (key === "litNotesFolder") {
			if (this.plugin.litNoteServerSettings) {
				this.plugin.litNoteServerSettings.litNotesFolder = String(value).trim();
			}
			this.litNoteLocations?.setDesc(this.describeLitNoteLocations());
		}
		if (key === "validateAuthorNameFormat") {
			if (this.plugin.litNoteServerSettings) {
				this.plugin.litNoteServerSettings.validateAuthorNameFormat = Boolean(value);
			}
		}
		if (key === "authorFormatStyle") {
			if (this.plugin.litNoteServerSettings) {
				this.plugin.litNoteServerSettings.authorFormatStyle = value as NameStyle;
			}
		}
		if (key === "authorDropVon") {
			if (this.plugin.litNoteServerSettings) {
				this.plugin.litNoteServerSettings.authorDropVon = Boolean(value);
			}
		}
		if (key === "downloadYoutubeTranscripts") {
			if (this.plugin.litNoteServerSettings) {
				this.plugin.litNoteServerSettings.downloadYoutubeTranscripts = Boolean(value);
			}
		}
		if (key === "transcriptHeading") {
			this.plugin.applyTranscriptHeading();
		}
		await this.plugin.saveSettings();
		this.refreshDomState();
	}

	private describeLitNoteLocations(): string {
		const folder = this.plugin.settings.litNotesFolder.trim();
		const error = litNotesFolderError(folder);
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return `The open vault has no local filesystem path to display.${error ? ` ${error}` : ""}`;
		}
		const root = adapter.getBasePath();
		if (error) return `Open vault: ${root}. ${error}`;
		const target = path.resolve(root, folder.replace(/\\/g, "/") || ".");
		return `Open vault: ${root}. Literature notes: ${target}.${folder ? "" : " A blank setting searches the entire vault; new notes are created at its root."}`;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "AI save folder",
				desc: "The name of the folder where AI notes are stored (relative to the active note).",
				control: {
					type: "text",
					key: "searchesFolder",
					placeholder: "ai-searches",
				},
			},
			{
				name: "AI generated tag",
				desc: "The tag inserted into the AI note's frontmatter.",
				control: {
					type: "text",
					key: "generatedTag",
					placeholder: "ai-generated",
				},
			},
			{
				name: "Collapse blank lines",
				desc: "Collapse any run of 2+ blank lines down to one, including around headings. Produces a denser, more uniform file while keeping one blank line between paragraphs and headings.",
				control: {
					type: "toggle",
					key: "collapseBlankLines",
				},
			},
			{
				name: "Collapse prompt callouts",
				desc: "When on, prompt callouts start collapsed (`> [!Prompt]-`). When off, they start expanded (`> [!Prompt]+`).",
				control: {
					type: "toggle",
					key: "collapsePromptCallouts",
				},
			},
			{
				type: "group",
				heading: "Prompt heading",
				items: [
					{
						name: "Heading max characters",
						desc: "Maximum length of the summary heading, including a possible ellipsis. 90-120 is suitable for note titles.",
						control: {
							type: "number",
							key: "headlineMaxChars",
							placeholder: "100",
							min: 1,
						},
					},
					{
						name: "Prompt heading method",
						desc: "Algorithm for the summary heading above each user prompt. 'Lead sentence' uses the first sentence that fits (fast, no extra deps). 'TF-IDF ranked sentence' ranks every sentence by term salience with a lead-position prior and picks the best (requires the stopword package).",
						control: {
							type: "dropdown",
							key: "headlineMethod",
							options: {
								lead: "Lead sentence",
								"tf-idf": "TF-IDF ranked sentence",
							},
						},
					},
					{
						name: "Heading lead bias",
						desc: "Amount to favor sentences near the beginning when picking the best sentence. 0 disables it. Reasonable range 0.05-0.35.",
						control: {
							type: "number",
							key: "headlineLeadBias",
							placeholder: "0.20",
							step: "any",
							min: 0,
							disabled: () => this.plugin.settings.headlineMethod !== "tf-idf",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Source link title fetching",
				items: [
					{
						name: "Auto-fetch source titles",
						desc: "Automatically fetch webpage titles to build clean markdown links for sources.",
						control: {
							type: "toggle",
							key: "autoFetchSourceTitles",
						},
					},
					{
						name: "Source title max characters",
						desc: "Maximum length of a fetched source link title, including a possible ellipsis.",
						control: {
							type: "number",
							key: "sourceTitleMaxChars",
							placeholder: "100",
							min: 1,
							disabled: () => !this.plugin.settings.autoFetchSourceTitles,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Zotero & Literature Note Relinking",
				items: [
					{
						name: "Auto-relink sources",
						desc: "Automatically run Zotero relinking when importing or syncing new turns.",
						control: {
							type: "toggle",
							key: "autoRelinkSources",
						},
					},
					{
						name: "Better BibTeX HTTP Port",
						desc: "Port used by the Obsidian Auto-Relinker to fetch citation metadata from the Zotero Better BibTeX plugin (defaults to 23119).",
						control: {
							type: "number",
							key: "zoteroPort",
							placeholder: "23119",
							min: 1,
						},
					},
					{
						name: "Literature notes folder",
						desc: "Vault folder where literature notes reside (e.g. lit/lit_notes). Leave blank to search anywhere in vault.",
						control: {
							type: "text",
							key: "litNotesFolder",
							placeholder: "lit/lit_notes",
						},
					},
					{
						name: "Resolved literature note locations",
						render: (setting) => {
							this.litNoteLocations = setting;
							setting.setDesc(this.describeLitNoteLocations());
							return () => {
								if (this.litNoteLocations === setting) this.litNoteLocations = undefined;
							};
						},
					},
					{
						name: "Minimum title match score",
						desc: "Minimum fuzzy similarity score (0-100) required to match an AI source title to a Zotero item.",
						control: {
							type: "number",
							key: "minTitleMatchScore",
							placeholder: "95",
							min: 0,
							max: 100,
						},
					},
					{
						name: "Zotero library cache",
						desc: "Clear in-memory cached Zotero library items to force a fresh fetch from Zotero on the next relink.",
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText("Clear cache").onClick(() => {
									this.plugin.zoteroClient.clearCache();
									new Notice("Zotero library cache cleared.");
								});
							});
						},
					},
				],
			},
			{
				type: "group",
				heading: "Literature note formatting",
				items: [
					{
						name: "Validate author name format",
						desc: "When enabled, warns before creating literature notes if any author or creator name with multiple words is not in 'Last, First' format. Single-word names (mononyms such as Aristotle or Prince) are always accepted. The check catches ambiguous entries like 'John Smith' where it is unclear which part is the last name — Obsidian Bases sorts by the first element of the authors property, so 'Last, First' ordering is required for last-name search to work.",
						control: {
							type: "toggle",
							key: "validateAuthorNameFormat",
						},
					},
					{
						name: "Author name format style",
						desc: "Output format style for author names in literature notes. 'Last, First' (default) preserves standard catalog ordering; 'BibTeX' uses 'von Last, Jr, First'; 'First Last' uses natural name order; 'Last only' keeps just the surname; 'Initials' uses 'J. Smith' (or 'J.-P. Smith' for hyphenated names).",
						control: {
							type: "dropdown",
							key: "authorFormatStyle",
							options: {
								"last-first": "Last, First (default)",
								"bibtex": "BibTeX (von Last, Jr, First)",
								"first-last": "First Last",
								"von-last": "Last only",
								"initials": "Initials (J. Smith)",
							},
						},
					},
					{
						name: "Drop 'von' particle",
						desc: "When enabled with 'Last, First' style, omits lowercase surname particles such as 'von', 'van', or 'de la' (e.g. 'Beethoven, Ludwig' instead of 'van Beethoven, Ludwig').",
						control: {
							type: "toggle",
							key: "authorDropVon",
							disabled: () => this.plugin.settings.authorFormatStyle !== "last-first",
						},
					},
				],
			},
			{
				type: "group",
				heading: "YouTube transcripts",
				items: [
					{
						name: "Download YouTube transcripts",
						desc: "When enabled, downloads JSON3 captions when creating literature notes from YouTube video references. New transcripts always retain native YouTube word timings.",
						control: {
							type: "toggle",
							key: "downloadYoutubeTranscripts",
						},
					},
					{
						name: "Transcript heading",
						desc: "Heading used when downloading captions into a literature note. Set the same heading in Watchword if you use it; neither plugin requires the other.",
						control: {
							type: "text",
							key: "transcriptHeading",
							placeholder: DEFAULT_TRANSCRIPT_HEADING,
						},
					},
				],
			},
		];
	}

}
