import { App, Notice, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { createLineFlashSettingsGroup } from "commons/flash";
import { DEFAULT_TRANSCRIPT_HEADING } from "commons/youtube";
import type PerplexitySaverPlugin from "./main";
import { ZoteroClient } from "./zotero/zoteroClient";
import type { NameStyle } from "./litNote/bibtexName";
import { TRANSCRIPT_VIEW_TYPE, TranscriptView, TRANSCRIPT_LOCATIONS } from "./litNote/transcriptView";
import { insertionThemeFlashAppearance } from "./video/noteInsertion";
import { VIDEO_WORKSPACE_LABELS } from "./video/workspaceLayout";

export class PerplexitySaverSettingTab extends PluginSettingTab {
	plugin: PerplexitySaverPlugin;

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
		if (key === "transcriptSearchBehavior" || key === "transcriptSearchMatching" || key === "transcriptSearchHighlights") {
			for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
				if (leaf.view instanceof TranscriptView) leaf.view.refreshSearchSettings();
			}
		}
		await this.plugin.saveSettings();
		if (key === "insertFlashMode") this.update();
		else this.refreshDomState();
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
						name: "Initial video workspace",
						desc: "Pane combination for a note with no saved viewing session. Timestamp links and Open or change workspace restore that note's last pane combination and geometry first. Picker choices do not change this initial default.",
						control: {
							type: "dropdown",
							key: "preferredVideoWorkspace",
							options: {
								video: VIDEO_WORKSPACE_LABELS.video,
								transcript: VIDEO_WORKSPACE_LABELS.transcript,
								both: VIDEO_WORKSPACE_LABELS.both,
							},
						},
					},
					{
						name: "Video note focus indicator",
						desc: "Mark the focused video or transcript pane, or its literature note while the player or transcript is visible. Unrelated notes are not marked.",
						control: {
							type: "toggle",
							key: "videoNoteFocusIndicator",
						},
					},
					{
						name: "Collapse transcript on open",
						desc: "Start each note with its transcript heading folded, in editing and reading view. Click the heading arrow to expand it; it stays open while you work.",
						control: {
							type: "toggle",
							key: "collapseTranscriptOnOpen",
						},
					},
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
						desc: "Text of the heading that YouTube transcripts are stored under in literature notes, and that the transcript side panel reads. Leading '#' characters are ignored. Notes that still use the default 'Transcript' heading are also found, and so is a single section that is recognizably a Saver transcript under any other name. To rename older headings, run the command 'Transcript: rename other transcript headings to the current name'.",
						control: {
							type: "text",
							key: "transcriptHeading",
							placeholder: DEFAULT_TRANSCRIPT_HEADING,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Transcript panel",
				items: [
					{
						name: "Search keyboard behavior",
						desc: "Emacs: Perplexity Saver's Transcript search: Forward Emacs / Reverse Emacs commands navigate using their assigned hotkeys; Enter accepts and Escape cancels. Assign shortcuts in Settings → Hotkeys. No other plugin is required. Obsidian: Enter next; Shift+Enter previous; Escape accepts. Tab accepts without playing; Ctrl/Cmd+G cancels; Ctrl/Cmd+Enter plays.",
						control: {
							type: "dropdown",
							key: "transcriptSearchBehavior",
							options: { emacs: "Emacs-style", obsidian: "Obsidian-style (default)" },
						},
					},
					{
						name: "Transcript matching",
						desc: "All words matches each word in any order. Literal phrase requires the exact phrase. Both ignore case.",
						control: {
							type: "dropdown",
							key: "transcriptSearchMatching",
							options: { "all-words": "All words (default)", phrase: "Literal phrase" },
						},
					},
					{
						name: "Highlight all matches",
						desc: "Always highlights every matching row. On demand uses the search bar's highlighter button. Off highlights only the current match. Filtering is independent.",
						control: {
							type: "dropdown",
							key: "transcriptSearchHighlights",
							options: { always: "Always (default)", "on-demand": "On demand", off: "Off" },
						},
					},
					{
						name: "Initial transcript panel location",
						desc: "Placement when no saved workspace geometry is being restored. Use the transcript's below/beside icon or orientation toggle command to change the current note's layout without changing this initial default.",
						control: {
							type: "dropdown",
							key: "transcriptPanelLocation",
							options: TRANSCRIPT_LOCATIONS,
						},
					},
					{
						name: "Follow playback in transcript",
						desc: "While the video viewer plays, highlight the current line in the transcript panel and scroll to keep it in view. Scrolling stops for a few seconds after you scroll the panel yourself, and while a search is active.",
						control: {
							type: "toggle",
							key: "followTranscript",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Video viewer",
				items: [
					{
						name: "Timestamp link click",
						desc: "Open this note's viewing workspace and play at the clicked time, or open the link in your browser. Existing media panes stay as arranged; otherwise the last workspace is restored, falling back to Initial video workspace. Ctrl/Cmd-click does the other.",
						control: {
							type: "dropdown",
							key: "timestampClickAction",
							options: {
								viewer: "Play in the note's video workspace (default)",
								browser: "Open in the browser",
							},
						},
					},
					{
						name: "Initial video viewer location",
						desc: "Placement when no saved workspace geometry is being restored. Reopening restores the note's saved placement; an already-open associated viewer is reused.",
						control: {
							type: "dropdown",
							key: "videoViewerLocation",
							options: {
								split: "Split next to the note (default)",
								window: "New window",
							},
						},
					},
					{
						name: "Toolbar screenshot action",
						desc: "Default click action for the camera. Right-click it or use its alternatives button for both destinations. Shift-click captures the whole picture. Timestamp insert and copy buttons are always explicit. Insert requires the associated note in editing view.",
						control: {
							type: "dropdown",
							key: "videoToolbarCaptureAction",
							options: {
								insert: "Insert into note (default)",
								copy: "Copy to clipboard",
							},
						},
					},
					{
						name: "Show YouTube captions",
						desc: "Show closed captions over the video picture. Off by default for clearer screenshots. Applies to open viewers without restarting playback. Separate from the transcript panel; cannot remove captions burned into the video.",
						control: { type: "toggle", key: "showYoutubeCaptions" },
					},
					{
						name: "Insert timestamp format",
						desc: "Format used by timestamp insertion commands and buttons. Match current list keeps the marker and follows ordered numbering. Unordered, ordered, and task start that list form; plain timestamp inserts only the link with no list marker or description suffix. Inserts never split text or steal sub-items. Unsafe blocks continue an adjacent list or get a new item immediately below, without crossing a heading. Properties, the transcript and the opening source area use the initial notes area. Ordinary Markdown notes do not require a callout or quote.",
						control: {
							type: "dropdown",
							key: "timestampListStyle",
							options: {
								match: "Match current list (default)",
								unordered: "Unordered list (-)",
								ordered: "Ordered list (1.)",
								task: "Task list (- [ ])",
								link: "Plain timestamp only",
							},
						},
					},
					{
						name: "Copy timestamp format",
						desc: "Format for timestamp copy commands and buttons, including transcript-row copy. Copy writes Markdown to the clipboard only; it does not insert into the note or move focus. The copied time is resolved like timestamp insertion: a selected transcript time when available, otherwise current playback. Link-only, unordered, ordered and task formats are available. List items end with a trailing space for a description. This setting does not affect insertion or screenshot copying.",
						control: {
							type: "dropdown",
							key: "timestampCopyFormat",
							options: {
								link: "Timestamp link only (default)",
								unordered: "Unordered list (-)",
								ordered: "Ordered list (1.)",
								task: "Task list (- [ ])",
							},
						},
					},
					{
						name: "Pause playback for timestamp and screenshot actions",
						desc: "On by default. Pause playback when a timestamp or screenshot is copied or inserted, and while selecting or capturing any screenshot. Turn off to let playback continue through these actions.",
						control: {
							type: "toggle",
							key: "pausePlaybackOnMediaActions",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Insertion marking",
				items: [
					{
						name: "Show insertion target",
						desc: "Mark the safe insertion location while the associated note editor is unfocused. The marker does not change note text or move the cursor.",
						control: { type: "toggle", key: "showInsertionTarget" },
					},
				],
			},
			createLineFlashSettingsGroup({
				heading: "Insertion flash",
				mode: {
					key: "insertFlashMode",
					aliases: ["Highlight inserted line", "Insertion flash direction"],
					desc: "Briefly highlight the note line where a timestamp or screenshot was inserted, so you can see where it went.",
				},
				duration: {
					key: "insertFlashDuration",
					aliases: ["Inserted line highlight duration"],
					disabled: () => this.plugin.settings.insertFlashMode === "off",
				},
				size: {
					key: "insertFlashSize",
					aliases: ["Inserted line highlight width", "Inserted line highlight size"],
					disabled: () => this.plugin.settings.insertFlashMode === "off",
				},
				colors: {
					desc: "Use Obsidian's accent color, or choose separate insertion-flash colors for light and dark themes.",
					disabled: () => this.plugin.settings.insertFlashMode === "off",
					themeFlash: insertionThemeFlashAppearance,
					useTheme: {
						get: () => this.plugin.settings.insertFlashUseThemeColors,
						set: (value) => this.setControlValue("insertFlashUseThemeColors", value),
					},
					light: {
						get: () => this.plugin.settings.insertFlashColorLight,
						set: (value) => this.setControlValue("insertFlashColorLight", value),
					},
					dark: {
						get: () => this.plugin.settings.insertFlashColorDark,
						set: (value) => this.setControlValue("insertFlashColorDark", value),
					},
				},
			}, this.containerEl?.ownerDocument),
		];
	}

}
