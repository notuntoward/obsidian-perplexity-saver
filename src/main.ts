import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TFile,
	debounce,
	type WorkspaceLeaf,
} from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, WidgetType, EditorView } from "@codemirror/view";
import http from "http";
import { createPerplexityNote } from "./note-creator";
import { registerRemoveSourcesWithNoDialogCommand } from "./commands/removeNoDialog";
import { registerSyncCommand, registerSyncViaLinkCommand } from "./commands/sync";
import { registerReplaceViaLinkCommand } from "./commands/replace";
import { registerDeleteTurnCommand } from "./commands/delete";
import { registerRemoveSourcesWithNoCiteCommand } from "./commands/removeNoCite";
import { registerRelinkSourcesCommand } from "./commands/relink";
import { registerJumpCommand } from "./commands/jump";
import { registerGetLitNoteLinkCommand } from "./commands/getLitNoteLink";
import { suggestFilenameFromClipboard } from "./commands/import";
import { sanitizeFilename, suggestFilenameFromSelection, determineWikilinkAlias } from "./utils";
import { HeadlineMethod, HeadlineOptions } from "./normalize/headlines";
import { detectAndParse } from "./parsers/detect";
import { resolveSourceTitles } from "./scraper";
import { stripLeadingFrontmatterIfPresent } from "./normalize/frontmatter";
import { registerFootnoteNavigation } from "./normalize/footnoteNavigation";
import { DialogFile } from "./parsers/types";
import { ZoteroClient } from "./zotero/zoteroClient";
import { deduplicateDialogCitations } from "./normalize/turns";
import { startLitNoteServer, stopLitNoteServer, type LitNoteServerSettings } from "./litNote/litNoteServer";
import type { NameStyle } from "./litNote/bibtexName";
import { ViewTracker } from "./litNote/viewTracker";
import { DEFAULT_TRANSCRIPT_HEADING } from "./litNote/transcriptSection";
import { registerTranscriptFolding } from "./litNote/transcriptFolding";
import { DEFAULT_TRANSCRIPT_FORMAT, type TranscriptFormat } from "./litNote/youtubeTranscript";
import {
	TRANSCRIPT_VIEW_TYPE,
	TranscriptView,
	hideTranscriptPanels,
	showTranscriptPanel,
	TRANSCRIPT_LOCATIONS,
	visibleTranscriptLeaves,
	loadTranscriptLines,
	transcriptSearchCommands,
	type TranscriptPanelLocation,
	type TranscriptPlacement,
	type TranscriptSearchSettings,
} from "./litNote/transcriptView";
import {
	VIDEO_VIEW_TYPE,
	VideoView,
	getVideoLeaf,
	noteVideoId,
	openVideoViewer,
	type VideoViewerLocation,
	type VideoToolbarCaptureAction,
} from "./video/videoView";
import {
	createNoteInsertionAnchor,
	noteInsertionAnchors,
	releaseNoteInsertionAnchor,
	type NoteInsertionTarget,
} from "./video/noteInsertion";
import { registerTimestampLinks, type TimestampClickAction, type TimestampRequest } from "./video/timestampLinks";
import { parseYouTubeUrl, watchUrl, type TimestampCopyFormat } from "./video/youtubeLinks";
import { nextPart, PART_ORDER, type NotePart } from "./video/switchParts";
import { VideoWorkspaceModal, VIDEO_WORKSPACE_LABELS, type PreferredVideoWorkspace, type VideoWorkspaceLayout, type VideoPlaybackPosition } from "./video/workspaceLayout";
import { BackgroundPlayback, type NotePlayback } from "./video/backgroundPlayback";
import { registerVideoNoteFocusIndicator } from "./video/focusIndicator";
import { buildNavigationModel, closePopoutWindowIfEmpty, getGroupForLeaf, isInCollapsedSidebar, isSidebarLeaf, findLeafForFile, getActiveLeafInFocusedWindow, getLeafFileKey, getMainWindow, getWindowForLeaf, openFileInLeaf, revealAndFocusLeaf } from "commons/workspace";
import { setTimeoutIn, readClipboardIn } from "commons/windows";
import { raiseWindow } from "commons/os";
import { getCommandHotkeyLabel } from "commons/modal";

export interface PerplexitySaverSettings {
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
	 * by default (`> [!Prompt]-`). When off, they are rendered as
	 * expanded by default (`> [!Prompt]+`).
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
	 * Local HTTP Port for Zotero API communication.
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
	litNoteLastViewed: Record<string, number>;
	/**
	 * When enabled, validates that author and creator names are in '<last_name>, <first_name>'
	 * format before creating literature notes from Zotero items.
	 */
	validateAuthorNameFormat: boolean;
	/**
	 * Format style for author names in literature notes ('last-first', 'bibtex', 'first-last', 'von-last', 'initials').
	 */
	authorFormatStyle: NameStyle;
	/**
	 * When enabled with 'last-first' style, drops 'von' particles (e.g. "Beethoven, Ludwig" instead of "van Beethoven, Ludwig").
	 */
	authorDropVon: boolean;
	/**
	 * When enabled, automatically downloads the timestamped transcript and inserts it
	 * under the transcript heading when creating literature notes from YouTube video references.
	 */
	downloadYoutubeTranscripts: boolean;
	/**
	 * Text of the level-1 heading that downloaded YouTube transcripts are stored
	 * under, and that the transcript side panel reads from.
	 */
	transcriptHeading: string;
	/** Fold the stored transcript once whenever its note opens. */
	collapseTranscriptOnOpen: boolean;
	/**
	 * "cues": one line per caption cue with millisecond start and end times (lossless).
	 * "blocks": one line per 5 cues with a whole-second start time only.
	 */
	transcriptFormat: TranscriptFormat;
	/** What a plain click on a YouTube timestamp link does; Ctrl/Cmd-click does the other. */
	timestampClickAction: TimestampClickAction;
	/** Where a new video viewer opens: a split next to the note, or its own window. */
	videoViewerLocation: VideoViewerLocation;
	timestampCopyFormat: TimestampCopyFormat;
	videoToolbarCaptureAction: VideoToolbarCaptureAction;
	showYoutubeCaptions: boolean;
	videoNoteFocusIndicator: boolean;
	preferredVideoWorkspace: PreferredVideoWorkspace;
	videoPlayback: Record<string, VideoPlaybackPosition>;
	/** Where the transcript panel opens: the right sidebar, or below the video viewer. */
	transcriptPanelLocation: TranscriptPanelLocation;
	/** Scroll transcript panels to keep the line the video viewer is playing in view. */
	followTranscript: boolean;
	transcriptSearchBehavior: TranscriptSearchSettings["keyboard"];
	transcriptSearchMatching: TranscriptSearchSettings["matching"];
	transcriptSearchHighlights: TranscriptSearchSettings["highlights"];
}

const DEFAULT_SETTINGS: PerplexitySaverSettings = {
	searchesFolder: "ai-searches",
	generatedTag: "ai-generated",
	collapseBlankLines: true,
	collapsePromptCallouts: true,
	headlineMethod: "lead",
	headlineMaxChars: 100,
	headlineLeadBias: 0.2,
	autoFetchSourceTitles: true,
	sourceTitleMaxChars: 100,
	zoteroPort: 23119,
	litNotesFolder: "lit/lit_notes",
	minTitleMatchScore: 95,
	autoRelinkSources: false,
	litNoteLastViewed: {},
	validateAuthorNameFormat: false,
	authorFormatStyle: "last-first" as NameStyle,
	authorDropVon: false,
	downloadYoutubeTranscripts: true,
	transcriptHeading: DEFAULT_TRANSCRIPT_HEADING,
	collapseTranscriptOnOpen: true,
	transcriptFormat: DEFAULT_TRANSCRIPT_FORMAT,
	timestampClickAction: "viewer",
	videoViewerLocation: "split",
	timestampCopyFormat: "list",
	videoToolbarCaptureAction: "insert",
	showYoutubeCaptions: false,
	videoNoteFocusIndicator: true,
	preferredVideoWorkspace: "video",
	videoPlayback: {},
	transcriptPanelLocation: "sidebar",
	followTranscript: true,
	transcriptSearchBehavior: "obsidian",
	transcriptSearchMatching: "all-words",
	transcriptSearchHighlights: "always",
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
	viewTracker!: ViewTracker;
	litNoteServerSettings: LitNoteServerSettings | null = null;
	private litNoteServer: http.Server | null = null;
	private refreshVideoNoteFocusIndicator: (() => void) | null = null;
	private transcriptLocations = new Map<string, TranscriptPanelLocation>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refreshVideoNoteFocusIndicator = registerVideoNoteFocusIndicator(this, () => this.settings.videoNoteFocusIndicator);
		this.registerEditorExtension(noteInsertionAnchors);
		registerFootnoteNavigation(this);
		const foldOpenedTranscript = registerTranscriptFolding(this, () => this.settings);
		this.zoteroClient = new ZoteroClient({ port: this.settings.zoteroPort });

		this.viewTracker = new ViewTracker(this.settings.litNoteLastViewed);
		this.viewTracker.seedIfEmpty(this.app.workspace.getLastOpenFiles(), Date.now());

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.viewTracker.record(file.path, Date.now());
					this.persistViews();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.viewTracker.rename(oldPath, file.path);
				const playback = this.settings.videoPlayback[oldPath];
				if (playback) {
					this.settings.videoPlayback[file.path] = playback;
					delete this.settings.videoPlayback[oldPath];
				}
				this.persistViews();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.viewTracker.remove(file.path);
				delete this.settings.videoPlayback[file.path];
				this.persistViews();
			})
		);

		// Start the Zotero companion HTTP listener (desktop only — node:http).
		this.litNoteServerSettings = {
			litNotesFolder: this.settings.litNotesFolder,
			validateAuthorNameFormat: this.settings.validateAuthorNameFormat,
			authorFormatStyle: this.settings.authorFormatStyle,
			authorDropVon: this.settings.authorDropVon,
			downloadYoutubeTranscripts: this.settings.downloadYoutubeTranscripts,
			transcriptHeading: this.settings.transcriptHeading,
			transcriptFormat: this.settings.transcriptFormat,
			onNoteOpened: foldOpenedTranscript,
		};
		this.litNoteServer = startLitNoteServer(this.app, this.litNoteServerSettings);

		this.registerView(
			TRANSCRIPT_VIEW_TYPE,
			(leaf) =>
				new TranscriptView(leaf, {
					getHeadingName: () => this.settings.transcriptHeading,
					getSearchSettings: () => ({
						keyboard: this.settings.transcriptSearchBehavior,
						matching: this.settings.transcriptSearchMatching,
						highlights: this.settings.transcriptSearchHighlights,
					}),
					playAt: (filePath, url, seconds, play) => void this.playTranscriptAt(filePath, url, seconds, play),
					movePanel: async (filePath, location) => {
						const file = this.app.vault.getFileByPath(filePath);
						if (!file) throw new Error(`Transcript note not found: ${filePath}`);
						await this.showTranscript(file, this.partLeaves(file).video, location);
					},
					toggleOrientation: async (filePath) => {
						const file = this.app.vault.getFileByPath(filePath);
						if (!file) throw new Error(`Transcript note not found: ${filePath}`);
						await this.toggleTranscriptOrientation(file, this.partLeaves(file).video);
					},
					closePanel: (leaf) => this.closeTranscript(leaf),
				})
		);
		this.registerTranscriptCommands();
		this.registerVideoWorkspaceCommands();

		this.registerView(
			VIDEO_VIEW_TYPE,
			(leaf) =>
				new VideoView(leaf, {
					getTranscriptHeading: () => this.settings.transcriptHeading,
					getTimestampCopyFormat: () => this.settings.timestampCopyFormat,
					getToolbarCaptureAction: () => this.settings.videoToolbarCaptureAction,
					getShowYoutubeCaptions: () => this.settings.showYoutubeCaptions,
					insertTimestamp: (view) => this.insertTimestampIntoNote(view),
					insertScreenshot: (view, whole) => this.insertScreenshotIntoNote(view, whole),
					isTranscriptShown: (viewer) => visibleTranscriptLeaves(this.app, null,
						viewer.view instanceof VideoView ? viewer.view.getFilePath() : null).length > 0,
					toggleTranscript: (file, viewer) => this.toggleTranscript(file, viewer),
					onPlayback: (videoId, filePath, seconds) => {
						if (filePath) this.stopBackgroundPlayback(filePath);
						this.showPlayback(videoId, filePath, seconds);
					},
					rememberPlayback: (videoId, filePath, seconds) => {
						if (!filePath || !Number.isFinite(seconds) || seconds < 0) return;
						this.settings.videoPlayback[filePath] = { videoId, seconds };
						void this.saveData(this.settings).catch((error: unknown) => {
							console.error("Perplexity Saver: could not save video position", error);
							new Notice("Could not save video playback position.");
						});
					},
					focusNote: (target) => this.focusNoteInsertionTarget(target),
				})
		);
		this.addBoundAlias({
			id: "open-youtube-video-viewer",
			name: "Go to YouTube video viewer (legacy shortcut)",
			checkCallback: (checking: boolean) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.goToPart("video", file, this.partLeaves(file)).catch((error: unknown) => {
					console.error("Perplexity Saver: could not open video viewer", error);
					new Notice("Could not open video viewer.");
				});
				return true;
			},
		});
		// Keyboard switching between a literature note, its video and its transcript panel, across windows and sidebars.
		const switchCommands: [id: string, name: string, target: NotePart][] = [
			["go-to-literature-note", "Go to literature note (from its video or transcript)", "note"],
			["go-to-video-viewer", "Go to YouTube video viewer", "video"],
			["go-to-transcript-panel", "Go to YouTube transcript panel", "transcript"],
		];
		for (const [id, name, target] of switchCommands) {
			this.addCommand({
				id,
				name,
				checkCallback: (checking: boolean) => {
					const { file } = this.activePart();
					if (!file) return false;
					if (!checking) {
						const leaves = this.partLeaves(file);
						void this.goToPart(target, file, leaves).catch((error: unknown) => {
							console.error("Perplexity Saver: could not navigate note parts", error);
							new Notice("Could not navigate literature note, video or transcript.");
						});
					}
					return true;
				},
			});
		}
		this.registerVideoCommands();
		registerTimestampLinks(
			this,
			() => this.settings.timestampClickAction,
			(request) => void this.openTimestamp(request).catch((error: unknown) => {
				console.error("Perplexity Saver: could not open timestamp", error);
				new Notice("Could not open timestamp in video viewer.");
			})
		);

		this.registerEditorExtension(perplexityInputStateField(this));

		this.addCommand({
			id: "import-ai-dialog-from-clipboard",
			name: "Import AI dialog from clipboard",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.startImport(editor, view);
			},
		});

		registerSyncCommand(this);
		registerSyncViaLinkCommand(this);
		registerReplaceViaLinkCommand(this);
		registerDeleteTurnCommand(this);
		registerRemoveSourcesWithNoCiteCommand(this);
		registerRemoveSourcesWithNoDialogCommand(this);
		registerJumpCommand(this);
		registerRelinkSourcesCommand(this);
		registerGetLitNoteLinkCommand(this);

		this.addSettingTab(new PerplexitySaverSettingTab(this.app, this));

		// Pre-warm Zotero library cache in background so auto-relink is instant on first import
		if (this.settings.autoRelinkSources) {
			const mainWin = getMainWindow(this.app) ?? window;
			setTimeoutIn(mainWin, () => {
				this.zoteroClient.getItems().catch((err) => {
					console.debug("Background Zotero cache warming skipped:", err);
				});
			}, 1000);
		}
	}

	private registerVideoCommands(): void {
		const audioCommands: [id: string, name: string, run: (view: NotePlayback) => unknown][] = [
			["video-viewer-play-pause", "Video viewer: play or pause", (v) => v.togglePlay()],
			["video-viewer-back-10", "Video viewer: back 10 seconds", (v) => v.skip(-10)],
			["video-viewer-forward-10", "Video viewer: forward 10 seconds", (v) => v.skip(10)],
			["video-viewer-back-5", "Video viewer: back 5 seconds", (v) => v.skip(-5)],
			["video-viewer-forward-5", "Video viewer: forward 5 seconds", (v) => v.skip(5)],
			["video-viewer-faster", "Video viewer: faster playback", (v) => v.stepRate(1)],
			["video-viewer-slower", "Video viewer: slower playback", (v) => v.stepRate(-1)],
			["video-viewer-normal-speed", "Video viewer: normal speed", (v) => v.setRate(1)],
			["video-viewer-next-note-timestamp", "Video viewer: next timestamp from the note", (v) => v.jumpToMark(1)],
			["video-viewer-previous-note-timestamp", "Video viewer: previous timestamp from the note", (v) => v.jumpToMark(-1)],
			["video-viewer-copy-timestamp", "Video viewer: copy timestamp link", (v) => v.copyTimestampLink()],
			["video-viewer-insert-timestamp", "Video viewer: insert timestamp bullet into literature note", (v) => this.insertTimestampIntoNote(v)],
			["video-viewer-open-in-browser", "Video viewer: open in browser at the current time", (v) => v.openInBrowser()],
		];
		const backgroundCommands = new Map(audioCommands.map(([id, , run]) => [id, run]));
		const viewerCommands: [id: string, name: string, run: (view: VideoView) => unknown][] = [
			...audioCommands,
			["video-viewer-zoom-in", "Video viewer: zoom in", (v) => v.zoomBy(1.25)],
			["video-viewer-zoom-out", "Video viewer: zoom out", (v) => v.zoomBy(1 / 1.25)],
			["video-viewer-zoom-reset", "Video viewer: reset zoom", (v) => v.resetZoom()],
			["video-viewer-screenshot", "Video viewer: screenshot (drag an area)", (v) => v.screenshot()],
			["video-viewer-screenshot-whole", "Video viewer: screenshot of the whole picture", (v) => v.screenshot(true)],
			["video-viewer-insert-screenshot", "Video viewer: insert screenshot (drag an area)", (v) => this.insertScreenshotIntoNote(v, false)],
			["video-viewer-insert-screenshot-whole", "Video viewer: insert screenshot of the whole picture", (v) => this.insertScreenshotIntoNote(v, true)],
			["video-viewer-toggle-transcript", "Toggle YouTube transcript panel (legacy viewer shortcut)", (v) => v.toggleTranscript()],
		];
		for (const [id, name, run] of viewerCommands) {
			const register = id === "video-viewer-toggle-transcript" ? this.addBoundAlias.bind(this) : this.addCommand.bind(this);
			register({
				id,
				name,
				checkCallback: (checking: boolean) => {
					const view = this.videoViewForActivePart();
					const file = this.activePart().file;
					const background = backgroundCommands.get(id);
					const transcript = file && !view ? this.visiblePartLeaves(file).transcript : null;
					if ((!view?.getVideoId() && !(background && transcript)) || (id.includes("screenshot") && !Platform.isDesktopApp)) return false;
					if (!checking) void Promise.resolve().then(async () => {
						if (view) return run(view);
						if (file && background) {
							const playback = await this.backgroundPlaybackFor(file);
							if (playback) return background(playback);
						}
					}).catch((error: unknown) => {
						console.error(`Perplexity Saver: could not run ${id}`, error);
						new Notice(`Could not run "${name}".`);
					});
					return true;
				},
			});
		}
	}

	private addBoundAlias(command: import("obsidian").Command): void {
		if (getCommandHotkeyLabel(this.app, `${this.manifest.id}:${command.id}`)) this.addCommand(command);
	}

	private registerVideoWorkspaceCommands(): void {
		const choose = (file: TFile): void => {
			void this.chooseVideoWorkspace(file).catch((error: unknown) => {
				console.error("Perplexity Saver: could not open video workspace picker", error);
				new Notice("Could not open video workspace picker.");
			});
		};
		this.addCommand({
			id: "video-workspace",
			name: "Video workspace...",
			checkCallback: (checking) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) choose(file);
				return true;
			},
		});
		for (const direction of [1, -1] as const) {
			this.addCommand({
				id: direction === 1 ? "cycle-note-video-transcript" : "cycle-note-video-transcript-back",
				name: direction === 1 ? "Cycle visible literature-note panes" : "Cycle visible literature-note panes backwards",
				checkCallback: (checking) => {
					const { file, part } = this.activePart();
					if (!file || file.extension !== "md") return false;
					if (!checking) void this.cycleVisibleParts(file, part, direction).catch((error: unknown) => {
						console.error("Perplexity Saver: could not cycle visible note panes", error);
						new Notice("Could not cycle visible literature-note panes.");
					});
					return true;
				},
			});
		}
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFile && file.extension === "md") {
				menu.addItem((item) => item.setTitle("Video workspace...").setIcon("youtube").onClick(() => choose(file)));
			}
		}));
	}

	private isPartVisible(leaf: WorkspaceLeaf | null): leaf is WorkspaceLeaf {
		return !!leaf && leaf.view.containerEl.isShown() && !isInCollapsedSidebar(this.app, leaf);
	}

	private visiblePartLeaves(file: TFile): Record<NotePart, WorkspaceLeaf | null> {
		const leaves: Record<NotePart, WorkspaceLeaf | null> = { note: null, video: null, transcript: null };
		// Prefer a visible duplicate over a hidden tab for the same file.
		for (const part of PART_ORDER) {
			const type = part === "note" ? "markdown" : part === "video" ? VIDEO_VIEW_TYPE : TRANSCRIPT_VIEW_TYPE;
			leaves[part] = this.app.workspace.getLeavesOfType(type).find((leaf) =>
				this.partFileKey(leaf) === file.path && this.isPartVisible(leaf)) ?? null;
		}
		return leaves;
	}

	private async cycleVisibleParts(file: TFile, current: NotePart | null, direction: 1 | -1): Promise<void> {
		const leaves = this.visiblePartLeaves(file);
		const part = nextPart(current, direction, PART_ORDER.filter((key) => leaves[key]));
		const leaf = part ? leaves[part] : null;
		if (leaf) await this.activatePartLeaf(leaf, leaves.video);
	}

	private async chooseVideoWorkspace(file: TFile): Promise<void> {
		const parts = this.partLeaves(file);
		if (!parts.video && !parts.transcript && !await noteVideoId(this.app, file)) {
			new Notice(`No YouTube link in ${file.basename}.`);
			return;
		}
		const visible = this.visiblePartLeaves(file);
		const current = visible.video ? (visible.transcript ? "both" : "video") : visible.transcript ? "transcript" : "note";
		new VideoWorkspaceModal(this.app, current, this.settings.preferredVideoWorkspace, (layout) => {
			void this.applyVideoWorkspace(file, layout).catch((error: unknown) => {
				console.error("Perplexity Saver: could not apply video workspace", error);
				new Notice("Could not apply video workspace.");
			});
		}).open();
	}

	private changingVideoWorkspace = false;

	private async applyVideoWorkspace(file: TFile, layout: VideoWorkspaceLayout): Promise<void> {
		if (this.changingVideoWorkspace) {
			new Notice("A video workspace change is already in progress.");
			return;
		}
		this.changingVideoWorkspace = true;
		try {
			const wantsVideo = layout === "video" || layout === "both";
			const wantsTranscript = layout === "transcript" || layout === "both";
			const leaves = this.partLeaves(file);
			// Validate missing content before closing any existing panes.
			if (wantsVideo && !leaves.video && !await noteVideoId(this.app, file)) {
				new Notice(`No YouTube link in ${file.basename}.`);
				return;
			}
			if (wantsTranscript && !leaves.transcript && !(await loadTranscriptLines(this.app, file, this.settings.transcriptHeading))?.length) {
				new Notice(`No timestamped transcript under a "${this.settings.transcriptHeading}" heading in ${file.basename}.`);
				return;
			}
			if (!leaves.note) {
				await openFileInLeaf(this.app, file, { raiseWindow: Platform.isDesktopApp ? raiseWindow : undefined });
				leaves.note = this.partLeaves(file).note;
			}
			if (!leaves.note) throw new Error("Could not open the literature note.");
			if (wantsVideo) {
				if (!leaves.video) leaves.video = await this.openViewerForNote(file, false, true);
				if (!leaves.video) throw new Error("Could not open the video player.");
				await this.app.workspace.revealLeaf(leaves.video);
			}
			if (wantsTranscript) {
				if (!leaves.transcript) {
					await this.showTranscript(file, wantsVideo ? leaves.video : null, undefined, true);
					leaves.transcript = this.partLeaves(file).transcript;
				}
				if (!leaves.transcript) throw new Error("Could not open the transcript.");
				if (leaves.transcript.view instanceof TranscriptView) leaves.transcript.view.pinToNote();
				await this.app.workspace.revealLeaf(leaves.transcript);
			}
			await this.separateWorkspaceTabs(leaves, layout);
			const videos = this.app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE).filter((leaf) => this.partFileKey(leaf) === file.path);
			const playingView = videos.find((leaf) => leaf.view instanceof VideoView && leaf.view.isPlaying())?.view;
			const audioView = !wantsVideo && wantsTranscript ? playingView ?? leaves.video?.view : null;
			const audioId = audioView instanceof VideoView ? audioView.getVideoId() : null;
			const audio = audioView instanceof VideoView && audioId ? {
				videoId: audioId,
				seconds: audioView.getPlaybackSeconds(),
				autoplay: audioView.isPlaying(),
				playbackRate: audioView.getPlaybackRate(),
			} : null;
			if (audioView instanceof VideoView && audioView.isPlaying()) audioView.pausePlayback();
			for (const leaf of videos) this.rememberVideoPlayback(leaf);
			if (layout !== "note") this.settings.preferredVideoWorkspace = layout;
			await this.saveData(this.settings);
			const closedWindows = new Set<Window>();
			const rememberWindow = (leaf: WorkspaceLeaf): void => {
				const win = getWindowForLeaf(leaf);
				if (win) closedWindows.add(win);
			};
			if (!wantsTranscript) {
				this.stopBackgroundPlayback(file.path);
				const panels = this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).filter((leaf) => this.partFileKey(leaf) === file.path);
				const visible = new Set(visibleTranscriptLeaves(this.app, null, file.path));
				panels.forEach(rememberWindow);
				hideTranscriptPanels(this.app, null, file.path);
				for (const leaf of panels) if (!visible.has(leaf)) leaf.detach();
			}
			if (!wantsVideo) for (const leaf of videos) {
				rememberWindow(leaf);
				leaf.detach();
			}
			if (audio) await this.backgroundPlaybackFor(file, audio);
			// Layout changes leave the user in the note, ready to take notes.
			await this.activatePartLeaf(leaves.note, wantsVideo ? leaves.video : null);
			for (const win of closedWindows) closePopoutWindowIfEmpty(this.app, win);
		} finally {
			this.changingVideoWorkspace = false;
		}
	}

	private async separateWorkspaceTabs(leaves: Record<NotePart, WorkspaceLeaf | null>, layout: VideoWorkspaceLayout): Promise<void> {
		const model = buildNavigationModel(this.app, leaves.note);
		const retained: WorkspaceLeaf[] = leaves.note ? [leaves.note] : [];
		for (const part of ["video", "transcript"] as const) {
			if (layout !== part && layout !== "both") continue;
			const leaf = leaves[part];
			if (!leaf) continue;
			const group = getGroupForLeaf(model, leaf);
			if (group && retained.some((other) => getGroupForLeaf(model, other) === group)) {
				const anchor = part === "transcript" && leaves.video && layout === "both" ? leaves.video : leaves.note;
				if (!anchor) throw new Error("Cannot split workspace panes without a note.");
				const direction = part === "transcript" && (this.transcriptLocations.get(this.partFileKey(leaf) ?? "") ??
					this.settings.transcriptPanelLocation) === "viewer" ? "horizontal" : "vertical";
				const replacement = this.app.workspace.createLeafBySplit(anchor, direction);
				const view = leaf.view;
				const state = view instanceof VideoView
					? { ...view.getState(), time: view.getPlaybackSeconds(), autoplay: view.isPlaying() }
					: view.getState();
				try {
					await replacement.setViewState({ type: view.getViewType(), active: false, state });
					if (replacement.view instanceof TranscriptView && view instanceof TranscriptView) replacement.view.copySessionFrom(view);
					await this.app.workspace.revealLeaf(replacement);
				} catch (error) {
					replacement.detach();
					throw error;
				}
				leaf.detach();
				leaves[part] = replacement;
			}
			const kept = leaves[part];
			if (kept) retained.push(kept);
		}
	}

	private rememberVideoPlayback(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		if (!(view instanceof VideoView)) return;
		const file = view.getFilePath();
		const videoId = view.getVideoId();
		const seconds = view.getPlaybackSeconds();
		if (file && videoId && Number.isFinite(seconds) && seconds >= 0) {
			this.settings.videoPlayback[file] = { videoId, seconds };
		}
	}

	private registerTranscriptCommands(): void {
		this.addCommand({
			id: "show-youtube-transcript",
			name: "Toggle YouTube transcript panel",
			checkCallback: (checking: boolean) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.toggleTranscript(file, this.partLeaves(file).video).catch((error: unknown) => {
					console.error("Perplexity Saver: could not toggle transcript", error);
					new Notice("Could not show or hide transcript.");
				});
				return true;
			},
		});
		this.addCommand({
			id: "search-youtube-transcript",
			name: "Search YouTube transcript",
			checkCallback: (checking: boolean) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.focusTranscriptSearch(this.partLeaves(file).transcript, file).catch((error: unknown) => {
					console.error("Perplexity Saver: could not focus transcript search", error);
					new Notice("Could not focus transcript search.");
				});
				return true;
			},
		});
		for (const command of transcriptSearchCommands(this.app)) this.addCommand(command);
		this.addCommand({
			id: "transcript-toggle-orientation",
			name: "Transcript: toggle below / beside video",
			checkCallback: (checking: boolean) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.toggleTranscriptOrientation(file, this.partLeaves(file).video).catch((error: unknown) => {
					console.error("Perplexity Saver: could not change transcript orientation", error);
					new Notice("Could not change transcript orientation.");
				});
				return true;
			},
		});
		for (const location of Object.keys(TRANSCRIPT_LOCATIONS) as TranscriptPanelLocation[]) {
			this.addBoundAlias({
				id: `transcript-location-${location}`,
				name: `Transcript: move to ${TRANSCRIPT_LOCATIONS[location].toLowerCase()} (legacy shortcut)`,
				checkCallback: (checking: boolean) => {
					const file = this.activePart().file;
					if (!file || file.extension !== "md") return false;
					if (!checking) void this.showTranscript(file, this.partLeaves(file).video, location).catch((error: unknown) => {
						console.error("Perplexity Saver: could not move transcript", error);
						new Notice("Could not move transcript panel.");
					});
					return true;
				},
			});
		}
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (leaf.view instanceof TranscriptView) leaf.view.stopBackgroundPlayback();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE)) this.rememberVideoPlayback(leaf);
		void this.saveData(this.settings).catch((error: unknown) => {
			console.error("Perplexity Saver: could not save video positions on unload", error);
			new Notice("Could not save video playback positions.");
		});
		if (this.litNoteServer) {
			stopLitNoteServer(this.litNoteServer);
			this.litNoteServer = null;
		}
	}

	private persistViews = debounce(() => {
		this.settings.litNoteLastViewed = this.viewTracker.toRecord();
		void this.saveSettings();
	}, 5000, true);

	/** Propagate a changed transcript heading to note creation and open transcript panels. */
	applyTranscriptHeading(): void {
		if (this.litNoteServerSettings) {
			this.litNoteServerSettings.transcriptHeading = this.settings.transcriptHeading;
		}
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (leaf.view instanceof TranscriptView) void leaf.view.reload();
		}
	}

	/** Mark the playing line in transcript panels showing this video (scrolling them if the setting is on). */
	private showPlayback(videoId: string, filePath: string | null, seconds: number): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TranscriptView && view.showsVideo(filePath, videoId)) {
				view.showPlayback(seconds, this.settings.followTranscript);
			}
		}
	}

	/** Transcript panel: show the video from a line in the video viewer, starting playback with `play`. */
	private async playTranscriptAt(filePath: string, url: string, seconds: number, play: boolean): Promise<void> {
		let videoId = url ? parseYouTubeUrl(url)?.videoId ?? null : null;
		if (!videoId) {
			const file = this.app.vault.getFileByPath(filePath);
			videoId = file ? await noteVideoId(this.app, file) : null;
		}
		if (!videoId) {
			new Notice("No YouTube link for this transcript.");
			return;
		}
		const file = this.app.vault.getFileByPath(filePath);
		if (file && !this.partLeaves(file).video && this.visiblePartLeaves(file).transcript) {
			const background = await this.backgroundPlaybackFor(file, { videoId, seconds });
			if (background) {
				background.seekTo(seconds);
				if (play) background.play();
			}
			return;
		}
		await openVideoViewer(this.app, { videoId, seconds, sourcePath: filePath, autoplay: play }, this.settings.videoViewerLocation);
	}

	/** Reveal a transcript panel (opening the active note's if none is open) and focus its search box. */
	private async focusTranscriptSearch(leaf: WorkspaceLeaf | null, file: TFile | null): Promise<void> {
		if (!leaf) {
			if (!file) return;
			await this.showTranscript(file, this.partLeaves(file).video);
			leaf = this.partLeaves(file).transcript;
			if (!leaf) return;
		}
		await this.activatePartLeaf(leaf, file ? this.partLeaves(file).video : null, true);
	}

	/** The note a clicked element belongs to: its editor/reading view, or the transcript panel's note. */
	private sourcePathFor(el: Element): string | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(el)) return view.file?.path ?? null;
		}
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TranscriptView && view.containerEl.contains(el)) return view.getFilePath();
		}
		return this.app.workspace.getActiveFile()?.path ?? null;
	}

	private async openTimestamp(request: TimestampRequest): Promise<void> {
		const filePath = this.sourcePathFor(request.target);
		const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
		if (file && !this.partLeaves(file).video && this.visiblePartLeaves(file).transcript) {
			await this.playTranscriptAt(file.path, watchUrl(request.videoId, request.seconds), request.seconds, true);
			return;
		}
		await openVideoViewer(
			this.app,
			{ videoId: request.videoId, seconds: request.seconds, sourcePath: this.sourcePathFor(request.target), autoplay: true },
			this.settings.videoViewerLocation
		);
	}

	/** Which of note / video / transcript is active, and the literature note it belongs to. */
	private activePart(): { part: NotePart | null; file: TFile | null } {
		const ws = this.app.workspace;
		const byPath = (path: string | null): TFile | null => (path ? this.app.vault.getFileByPath(path) : null);
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true })?.view;
		if (active instanceof VideoView) return { part: "video", file: byPath(active.getFilePath()) };
		if (active instanceof TranscriptView) return { part: "transcript", file: byPath(active.getFilePath()) };
		if (active instanceof MarkdownView && active.file) return { part: "note", file: active.file };
		const video = ws.getActiveViewOfType(VideoView);
		if (video) return { part: "video", file: byPath(video.getFilePath()) };
		const transcript = ws.getActiveViewOfType(TranscriptView);
		if (transcript) return { part: "transcript", file: byPath(transcript.getFilePath()) };
		const note = ws.getActiveViewOfType(MarkdownView);
		if (note?.file) return { part: "note", file: note.file };
		return { part: null, file: ws.getActiveFile() };
	}

	private partFileKey(leaf: WorkspaceLeaf): string | null {
		const view = leaf.view;
		return view instanceof VideoView || view instanceof TranscriptView ? view.getFilePath() : getLeafFileKey(leaf);
	}

	/** The open note, video viewer and transcript panel for `file` (in any window or sidebar). */
	private partLeaves(file: TFile): Record<NotePart, WorkspaceLeaf | null> {
		const ws = this.app.workspace;
		const note = findLeafForFile(this.app, file);
		const noteWin = note ? getWindowForLeaf(note) : null;
		const videos = ws.getLeavesOfType(VIDEO_VIEW_TYPE).filter((leaf) => this.partFileKey(leaf) === file.path);
		const activeWin = getWindowForLeaf(getActiveLeafInFocusedWindow(this.app, { includeSidebars: true }) ?? note);
		const video = videos.find((leaf) => getWindowForLeaf(leaf) === activeWin)
			?? videos.find((leaf) => getWindowForLeaf(leaf) === noteWin) ?? videos[0] ?? null;
		const transcripts = ws.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).filter((leaf) => this.partFileKey(leaf) === file.path);
		const transcript = transcripts.find((leaf) => getWindowForLeaf(leaf) === activeWin) ?? transcripts[0] ?? null;
		return { note, video, transcript };
	}

	/** Prefer the video associated with the focused note/transcript over another viewer in the same window. */
	private videoViewForActivePart(): VideoView | null {
		const { file } = this.activePart();
		if (file) {
			const related = this.partLeaves(file).video?.view;
			return related instanceof VideoView ? related : null;
		}
		const fallback = getVideoLeaf(this.app)?.view;
		return fallback instanceof VideoView ? fallback : null;
	}

	private async backgroundPlaybackFor(file: TFile, request?: { videoId: string; seconds: number; autoplay?: boolean; playbackRate?: number }): Promise<BackgroundPlayback | null> {
		const leaf = this.visiblePartLeaves(file).transcript;
		if (!(leaf?.view instanceof TranscriptView)) {
			new Notice("Open the transcript before playing audio in the background.");
			return null;
		}
		const transcript = leaf.view;
		const videoId = request?.videoId ?? transcript.getBackgroundPlayback()?.getVideoId() ?? await noteVideoId(this.app, file);
		if (!videoId) {
			new Notice(`No YouTube link in ${file.basename}.`);
			return null;
		}
		// Metadata reads may finish after a layout change or another command.
		if (!this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).includes(leaf) ||
			transcript.getFilePath() !== file.path || !this.isPartVisible(leaf)) {
			new Notice("The transcript workspace changed before playback could start.");
			return null;
		}
		if (this.partLeaves(file).video) {
			new Notice("A video pane is open; use its playback controls.");
			return null;
		}
		const existing = this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)
			.map((panel) => panel.view instanceof TranscriptView ? panel.view.getBackgroundPlayback() : null)
			.find((playback) => playback?.getFilePath() === file.path);
		if (existing?.getVideoId() === videoId) return existing;
		if (existing) this.stopBackgroundPlayback(file.path);
		const saved = this.settings.videoPlayback[file.path];
		const playback = new BackgroundPlayback(this.app, transcript.containerEl, file.path, videoId,
			request?.seconds ?? (saved?.videoId === videoId ? saved.seconds : 0), {
				getTranscriptHeading: () => this.settings.transcriptHeading,
				getTimestampCopyFormat: () => this.settings.timestampCopyFormat,
				onPlayback: (id, path, seconds) => this.showPlayback(id, path, seconds),
				remember: (id, path, seconds) => {
					this.settings.videoPlayback[path] = { videoId: id, seconds };
					void this.saveData(this.settings).catch((error: unknown) => {
						console.error("Perplexity Saver: could not save background playback position", error);
						new Notice("Could not save video playback position.");
					});
				},
				focusNote: (target) => this.focusNoteInsertionTarget(target),
			}, request);
		transcript.setBackgroundPlayback(playback);
		return playback;
	}

	private stopBackgroundPlayback(filePath: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (leaf.view instanceof TranscriptView && leaf.view.getFilePath() === filePath) leaf.view.stopBackgroundPlayback();
		}
	}

	/** Reveal (opening it if needed) and focus one part, raising its window and giving it keyboard focus. */
	private async goToPart(part: NotePart, file: TFile, leaves: Record<NotePart, WorkspaceLeaf | null>): Promise<void> {
		let leaf = leaves[part];
		if (!leaf) {
			if (part === "note") {
				await openFileInLeaf(this.app, file, { raiseWindow: Platform.isDesktopApp ? raiseWindow : undefined });
				return;
			} else if (part === "video") {
				leaf = await this.openViewerForNote(file);
			} else {
				await this.showTranscript(file, leaves.video);
				return;
			}
		}
		if (!leaf) return;
		await this.activatePartLeaf(leaf, leaves.video);
	}

	private createNoteInsertionTarget(view: Pick<NotePlayback, "getFilePath">): NoteInsertionTarget | null {
		const filePath = view.getFilePath();
		const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true });
		const activeNote = active?.view instanceof MarkdownView && active.view.file?.path === file?.path ? active : null;
		const leaf = activeNote ?? (file ? findLeafForFile(this.app, file.path) : null);
		if (!file || !leaf || !(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== file.path) {
			new Notice("Open the literature note in editing view before inserting a video capture.");
			return null;
		}
		const editorEl = leaf.view.containerEl.querySelector(".cm-editor");
		const editorView = editorEl ? EditorView.findFromDOM(editorEl as HTMLElement) : null;
		if (!editorView) {
			new Notice("Switch the literature note to editing view and place the Cursor where you want the insertion.");
			return null;
		}
		const anchor = createNoteInsertionAnchor(editorView);
		if (!anchor) {
			new Notice("Could not track the literature note insertion point.");
			return null;
		}
		const targetPath = file.path;
		return {
			leaf,
			filePath: targetPath,
			anchor,
			isValid: () =>
				leaf.view instanceof MarkdownView &&
				leaf.view.file?.path === targetPath &&
				editorView.dom.isConnected,
		};
	}

	private async insertTimestampIntoNote(view: NotePlayback): Promise<void> {
		const target = this.createNoteInsertionTarget(view);
		if (!target) return;
		try {
			await view.insertTimestampBullet(target);
		} catch (error) {
			releaseNoteInsertionAnchor(target.anchor);
			console.error("Perplexity Saver: could not insert timestamp", error);
			new Notice("Could not insert a timestamp into the literature note.");
		}
	}

	private async insertScreenshotIntoNote(view: VideoView, whole: boolean): Promise<void> {
		const target = this.createNoteInsertionTarget(view);
		if (!target) return;
		try {
			await this.activatePartLeaf(view.leaf, null);
			await view.insertScreenshotForNote(target, whole);
		} catch (error) {
			releaseNoteInsertionAnchor(target.anchor);
			console.error("Perplexity Saver: could not start screenshot insertion", error);
			new Notice("Could not start screenshot insertion.");
		}
	}

	private async focusNoteInsertionTarget(target: NoteInsertionTarget): Promise<void> {
		if (!target.isValid()) throw new Error("The literature note insertion target is no longer available.");
		await revealAndFocusLeaf(this.app, target.leaf, {
			raiseWindow: Platform.isDesktopApp ? raiseWindow : undefined,
			onFocus: () => {
				if (!target.isValid()) throw new Error("The literature note insertion target changed before focus.");
				target.anchor.view.focus();
			},
		});
	}

	private async activatePartLeaf(leaf: WorkspaceLeaf, viewer: WorkspaceLeaf | null, search = false): Promise<void> {
		await revealAndFocusLeaf(this.app, leaf, {
			raiseWindow: Platform.isDesktopApp ? raiseWindow : undefined,
			onFocus: (target) => {
				const view = target.view;
				if (view instanceof VideoView) view.focusKeys();
				else if (view instanceof TranscriptView) {
					const video = viewer?.view;
					const videoId = video instanceof VideoView ? video.getVideoId() : null;
					const sameVideo = video instanceof VideoView && videoId && view.showsVideo(video.getFilePath(), videoId);
					const seconds = sameVideo ? video.getPlaybackSeconds() : view.getBackgroundPlayback()?.getPlaybackSeconds() ?? null;
					if (search) {
						view.showPlayback(seconds, this.settings.followTranscript);
						view.focusSearch();
					} else view.focusPlayback(seconds, this.settings.followTranscript);
				} else if (view instanceof MarkdownView) view.editor.focus();
			},
		});
	}

	/** Open the viewer on the video a note links to (the first YouTube link in it). */
	private async openViewerForNote(file: TFile, autoplay = false, associatedOnly = false): Promise<WorkspaceLeaf | null> {
		const videoId = await noteVideoId(this.app, file);
		if (!videoId) {
			new Notice(`No YouTube link in ${file.basename}.`);
			return null;
		}
		const saved = this.settings.videoPlayback[file.path];
		const background = this.partLeaves(file).transcript?.view;
		const playback = background instanceof TranscriptView ? background.getBackgroundPlayback() : null;
		const sameVideo = playback?.getVideoId() === videoId;
		const seconds = sameVideo ? playback.getPlaybackSeconds() : saved?.videoId === videoId ? saved.seconds : 0;
		const playing = sameVideo ? playback.isPlaying() : autoplay;
		const rate = sameVideo ? playback.getPlaybackRate() : null;
		this.stopBackgroundPlayback(file.path);
		const leaf = await openVideoViewer(
			this.app,
			{ videoId, seconds, sourcePath: file.path, autoplay: playing, associatedOnly },
			this.settings.videoViewerLocation
		);
		if (rate !== null && leaf.view instanceof VideoView) leaf.view.setRate(rate);
		return leaf;
	}

	/**
	 * Show a note's transcript using its session placement or the saved default.
	 * The sidebar default maps to beside a pop-out viewer; explicit moves can use
	 * the main sidebar, below or beside without changing the saved default.
	 */
	async showTranscript(file: TFile, preferredViewer?: WorkspaceLeaf | null, location?: TranscriptPanelLocation, workspaceOnly = false): Promise<void> {
		let viewer = preferredViewer ?? getVideoLeaf(this.app);
		if (!(viewer?.view instanceof VideoView) || viewer.view.getFilePath() !== file.path) viewer = this.partLeaves(file).video;
		let placement: TranscriptPlacement | null = null;
		const selected = location ?? this.transcriptLocations.get(file.path) ?? this.settings.transcriptPanelLocation;
		if (!location && !this.transcriptLocations.has(file.path) && selected === "sidebar" && viewer && this.viewerInPopout(viewer)) {
			placement = { nextTo: viewer, direction: "vertical" };
		} else if (selected !== "sidebar") {
			const nextTo = viewer ?? (workspaceOnly ? this.partLeaves(file).note : await this.openViewerForNote(file, false));
			if (!nextTo) return;
			placement = { nextTo, direction: selected === "viewer" ? "horizontal" : "vertical" };
		}
		const replaceLeaf = location ? this.partLeaves(file).transcript : null;
		const leaf = await showTranscriptPanel(this.app, file, this.settings.transcriptHeading, placement, replaceLeaf, workspaceOnly);
		if (leaf) {
			if (location) this.transcriptLocations.set(file.path, location);
			await this.activatePartLeaf(leaf, viewer ?? placement?.nextTo ?? null);
		}
	}

	private viewerInPopout(viewer: WorkspaceLeaf): boolean {
		const win = getWindowForLeaf(viewer);
		return !!win && win !== getMainWindow(this.app);
	}

	private async closeTranscript(leaf: WorkspaceLeaf): Promise<void> {
		if (!(leaf.view instanceof TranscriptView)) throw new Error("Expected a transcript pane.");
		const filePath = leaf.view.getFilePath();
		const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
		const viewer = file ? this.partLeaves(file).video : null;
		hideTranscriptPanels(this.app, leaf, filePath);
		if (viewer) await this.activatePartLeaf(viewer, null);
	}

	/** The viewer's transcript button: close a visible transcript panel, or show this note's. */
	async toggleTranscript(file: TFile | null, viewer: WorkspaceLeaf | null): Promise<void> {
		if (!file) {
			new Notice("This video is not linked to a note.");
			return;
		}
		if (hideTranscriptPanels(this.app, null, file.path)) {
			if (viewer) await this.activatePartLeaf(viewer, null);
			return;
		}
		await this.showTranscript(file, viewer);
	}

	async toggleTranscriptOrientation(file: TFile, viewer: WorkspaceLeaf | null): Promise<void> {
		let current = this.transcriptLocations.get(file.path) ?? this.settings.transcriptPanelLocation;
		const panel = this.partLeaves(file).transcript;
		if (panel && isSidebarLeaf(this.app, panel)) current = "sidebar";
		else if (panel && viewer) {
			const direction = getGroupForLeaf(buildNavigationModel(this.app, viewer), panel)?.direction;
			if (direction === "below" || direction === "above") current = "viewer";
			else if (direction === "left" || direction === "right") current = "beside";
		}
		await this.showTranscript(file, viewer, current === "viewer" ? "beside" : "viewer");
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
		this.settings.videoPlayback = { ...this.settings.videoPlayback };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshVideoNoteFocusIndicator?.();
		for (const leaf of this.app.workspace?.getLeavesOfType?.(VIDEO_VIEW_TYPE) ?? []) {
			if (leaf.view instanceof VideoView) {
				leaf.view.updateToolbarCaptureLabels();
				leaf.view.updateYoutubeCaptions();
			}
		}
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
		if (key === "transcriptFormat") {
			if (this.plugin.litNoteServerSettings) {
				this.plugin.litNoteServerSettings.transcriptFormat = value as TranscriptFormat;
			}
		}
		await this.plugin.saveSettings();
		this.refreshDomState();
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
						name: "Collapse transcript on open",
						desc: "Start each note with its transcript heading folded, in editing and reading view. Click the heading arrow to expand it; it stays open while you work.",
						control: {
							type: "toggle",
							key: "collapseTranscriptOnOpen",
						},
					},
					{
						name: "Download YouTube transcripts",
						desc: "When enabled, automatically downloads the timestamped transcript and inserts it under the transcript heading when creating literature notes from YouTube video references.",
						control: {
							type: "toggle",
							key: "downloadYoutubeTranscripts",
						},
					},
					{
						name: "Transcript heading",
						desc: "Text of the heading that YouTube transcripts are stored under in literature notes, and that the transcript side panel reads. Leading '#' characters are ignored. Notes that still use the default 'Transcript' heading are also found.",
						control: {
							type: "text",
							key: "transcriptHeading",
							placeholder: DEFAULT_TRANSCRIPT_HEADING,
						},
					},
					{
						name: "Transcript detail",
						desc: "How downloaded YouTube transcripts are written. Every caption keeps each caption as a short m:ss link, with its exact start and end time in the link title (shown on hover; lossless, and gives the best paragraph formatting in the transcript panel). 5-caption blocks are shorter but keep only a whole-second start time per block of 5 captions.",
						control: {
							type: "dropdown",
							key: "transcriptFormat",
							options: {
								cues: "Every caption, start and end times (default)",
								blocks: "5-caption blocks, start time only",
							},
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
						name: "Default transcript panel location",
						desc: "Initial placement. Use the transcript's Layout menu or orientation toggle command to change the current note's layout without changing this default.",
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
						desc: "What clicking a YouTube link with a timestamp does, in notes and in the transcript panel. Ctrl/Cmd-click does the other.",
						control: {
							type: "dropdown",
							key: "timestampClickAction",
							options: {
								viewer: "Open in the video viewer (default)",
								browser: "Open in the browser",
							},
						},
					},
					{
						name: "Video viewer location",
						desc: "Where a new video viewer opens. An open viewer is always reused.",
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
						name: "Toolbar timestamp and screenshot action",
						desc: "Default click action for the player's timestamp and screenshot icons. Right-click either icon for both actions. Shift-click the camera captures the whole picture using this destination. Insert requires the associated note in editing view.",
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
						name: "Copied timestamp format",
						desc: "Format used when copying a timestamp from the toolbar or copy command. The list item ends with ': ' so pasting leaves the cursor ready for a plain-text description outside the link. Insertions, transcript-row and screenshot copies are unchanged.",
						control: {
							type: "dropdown",
							key: "timestampCopyFormat",
							options: {
								list: "List item: - <timestamp link>: (default)",
								link: "Timestamp link only",
							},
						},
					},
				],
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("AI save folder")
			.setDesc(
				"The name of the folder where AI notes are stored (relative to the active note)."
			)
			.addText((text) =>
				text
					.setPlaceholder("Ai-searches")
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
					.setPlaceholder("Ai-generated")
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
				toggle.setValue(this.plugin.settings.collapseBlankLines).onChange(async (value) => {
					this.plugin.settings.collapseBlankLines = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Collapse prompt callouts")
			.setDesc(
				"When on, prompt callouts start collapsed (`> [!Prompt]-`). When off, they start expanded (`> [!Prompt]+`)."
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
		new Setting(containerEl).setName("Prompt heading").setHeading();

		// isTfidf is computed once and used to gate the lead-bias input.
		// The max-chars input is always active because both methods use it.
		const isTfidf = this.plugin.settings.headlineMethod === "tf-idf";

		new Setting(containerEl)
			.setName("Heading max characters")
			.setDesc(
				"Maximum length of the summary heading, including a possible ellipsis. 90-120 is suitable for note titles."
			)
			.addText((text) => {
				text.setPlaceholder("100")
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
					.addOption("tf-idf", "Tf-idf ranked sentence")
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
				text.setPlaceholder("0.20")
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

		// "Source link title fetching" group
		new Setting(containerEl).setName("Source link title fetching").setHeading();

		new Setting(containerEl)
			.setName("Auto-fetch source titles")
			.setDesc(
				"Automatically fetch webpage titles to build clean Markdown links for sources."
			)
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
			.setDesc(
				"Maximum length of a fetched source link title, including a possible ellipsis."
			)
			.addText((text) => {
				text.setPlaceholder("100")
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
		new Setting(containerEl).setName("Zotero & literature note relinking").setHeading();

		new Setting(containerEl)
			.setName("Auto-relink sources")
			.setDesc("Automatically run Zotero relinking when importing or syncing new turns.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoRelinkSources).onChange(async (value) => {
					this.plugin.settings.autoRelinkSources = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Better BibTeX HTTP port")
			.setDesc(
				"Port used by the Obsidian auto-relinker to fetch citation metadata from the Zotero better BibTeX plugin (defaults to 23119)."
			)
			.addText((text) => {
				text.setPlaceholder("23119")
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
				"Vault folder where literature notes reside (e.g. Lit/lit_notes). Leave blank to search anywhere in vault."
			)
			.addText((text) => {
				text.setPlaceholder("Lit/lit_notes")
					.setValue(this.plugin.settings.litNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.litNotesFolder = value.trim();
						if (this.plugin.litNoteServerSettings) {
							this.plugin.litNoteServerSettings.litNotesFolder = value.trim();
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Minimum title match score")
			.setDesc(
				"Minimum fuzzy similarity score (0-100) required to match an AI source title to a Zotero item."
			)
			.addText((text) => {
				text.setPlaceholder("95")
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
			.setDesc(
				"Clear in-memory cached Zotero library items to force a fresh fetch from Zotero on the next relink."
			)
			.addButton((button) => {
				button.setButtonText("Clear cache").onClick(() => {
					this.plugin.zoteroClient.clearCache();
					new Notice("Zotero library cache cleared.");
				});
			});

		// Literature note formatting settings
		new Setting(containerEl).setName("Literature note formatting").setHeading();

		new Setting(containerEl)
			.setName("Validate author name format")
			.setDesc(
				"When enabled, warns before creating literature notes if any author or creator name with multiple words is not in 'Last, First' format. " +
				"Single-word names (mononyms such as Aristotle or Prince) are always accepted. " +
				"The check catches ambiguous entries like 'John Smith' where it is unclear which part is the last name — " +
				"Obsidian Bases sorts by the first element of the authors property, so 'Last, First' ordering is required for last-name search to work."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.validateAuthorNameFormat)
					.onChange(async (value) => {
						this.plugin.settings.validateAuthorNameFormat = value;
						if (this.plugin.litNoteServerSettings) {
							this.plugin.litNoteServerSettings.validateAuthorNameFormat = value;
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Author name format style")
			.setDesc(
				"Output format style for author names in literature notes."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("last-first", "Last, first (default)")
					.addOption("bibtex", "BibTeX (von last, jr, first)")
					.addOption("first-last", "First last")
					.addOption("von-last", "Last only")
					.addOption("initials", "Initials (j. Smith)")
					.setValue(this.plugin.settings.authorFormatStyle)
					.onChange(async (value) => {
						this.plugin.settings.authorFormatStyle = value as NameStyle;
						if (this.plugin.litNoteServerSettings) {
							this.plugin.litNoteServerSettings.authorFormatStyle = value as NameStyle;
						}
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("Drop 'von' particle")
			.setDesc(
				"When enabled with 'last, first' style, omits lowercase surname particles such as 'von', 'van', or 'de la'."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.authorDropVon)
					.setDisabled(this.plugin.settings.authorFormatStyle !== "last-first")
					.onChange(async (value) => {
						this.plugin.settings.authorDropVon = value;
						if (this.plugin.litNoteServerSettings) {
							this.plugin.litNoteServerSettings.authorDropVon = value;
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("YouTube transcripts").setHeading();

		new Setting(containerEl)
			.setName("Preferred video workspace")
			.setDesc("First choice in the workspace picker when media is closed. Choosing a media layout updates this preference; closing media does not.")
			.addDropdown((dropdown) => {
				for (const layout of ["video", "transcript", "both"] as const) dropdown.addOption(layout, VIDEO_WORKSPACE_LABELS[layout]);
				dropdown.setValue(this.plugin.settings.preferredVideoWorkspace).onChange(async (value) => {
					if (value !== "video" && value !== "transcript" && value !== "both") return;
					this.plugin.settings.preferredVideoWorkspace = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Video note focus indicator")
			.setDesc("Mark the focused video or transcript pane, or its literature note while the player or transcript is visible. Unrelated notes are not marked.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.videoNoteFocusIndicator)
					.onChange(async (value) => {
						this.plugin.settings.videoNoteFocusIndicator = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Collapse transcript on open")
			.setDesc(
				"Start each note with its transcript heading folded, in editing and reading view. Click the heading arrow to expand it; it stays open while you work."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.collapseTranscriptOnOpen)
					.onChange(async (value) => {
						this.plugin.settings.collapseTranscriptOnOpen = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Download YouTube transcripts")
			.setDesc(
				"When enabled, automatically downloads the timestamped transcript and inserts it under the transcript heading when creating literature notes from YouTube video references."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.downloadYoutubeTranscripts)
					.onChange(async (value) => {
						this.plugin.settings.downloadYoutubeTranscripts = value;
						if (this.plugin.litNoteServerSettings) {
							this.plugin.litNoteServerSettings.downloadYoutubeTranscripts = value;
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Transcript heading")
			.setDesc(
				"Text of the heading that YouTube transcripts are stored under in literature notes, and that the transcript side panel reads. Leading '#' characters are ignored."
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_TRANSCRIPT_HEADING)
					.setValue(this.plugin.settings.transcriptHeading)
					.onChange(async (value) => {
						this.plugin.settings.transcriptHeading = value;
						this.plugin.applyTranscriptHeading();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Transcript detail")
			.setDesc(
				"How downloaded YouTube transcripts are written. Every caption keeps each caption as a short m:ss link, with its exact start and end time in the link title (lossless). 5-caption blocks are shorter but keep only a whole-second start time per block."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("cues", "Every caption, start and end times (default)")
					.addOption("blocks", "5-caption blocks, start time only")
					.setValue(this.plugin.settings.transcriptFormat)
					.onChange(async (value) => {
						this.plugin.settings.transcriptFormat = value as TranscriptFormat;
						if (this.plugin.litNoteServerSettings) {
							this.plugin.litNoteServerSettings.transcriptFormat = value as TranscriptFormat;
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Transcript panel").setHeading();

		this.addChoiceSetting(
			containerEl,
			"Default transcript panel location",
			"Initial placement. Use the transcript's Layout menu or orientation toggle command to change the current note's layout without changing this default.",
			"transcriptPanelLocation",
			TRANSCRIPT_LOCATIONS
		);
		new Setting(containerEl)
			.setName("Follow playback in transcript")
			.setDesc(
				"While the video viewer plays, highlight the current line in the transcript panel and scroll to keep it in view. Scrolling stops for a few seconds after you scroll the panel yourself, and while a search is active."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.followTranscript).onChange(async (value) => {
					this.plugin.settings.followTranscript = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl).setName("Video viewer").setHeading();
		new Setting(containerEl)
			.setName("Show YouTube captions")
			.setDesc("Show closed captions over the video picture. Off by default for clearer screenshots. Applies to open viewers without restarting playback. Separate from the transcript panel; cannot remove captions burned into the video.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showYoutubeCaptions).onChange(async (value) => {
					this.plugin.settings.showYoutubeCaptions = value;
					await this.plugin.saveSettings();
				})
			);

		this.addChoiceSetting(
			containerEl,
			"Timestamp link click",
			"What clicking a YouTube link with a timestamp does, in notes and in the transcript panel. Ctrl/Cmd-click does the other.",
			"timestampClickAction",
			{ viewer: "Open in the video viewer (default)", browser: "Open in the browser" }
		);
		this.addChoiceSetting(
			containerEl,
			"Video viewer location",
			"Where a new video viewer opens. An open viewer is always reused.",
			"videoViewerLocation",
			{ split: "Split next to the note (default)", window: "New window" }
		);
		this.addChoiceSetting(
			containerEl,
			"Toolbar timestamp and screenshot action",
			"Default click action for the player's timestamp and screenshot icons. Right-click either icon for both actions. Shift-click the camera captures the whole picture using this destination. Insert requires the associated note in editing view.",
			"videoToolbarCaptureAction",
			{ insert: "Insert into note (default)", copy: "Copy to clipboard" }
		);
		this.addChoiceSetting(
			containerEl,
			"Copied timestamp format",
			"Format used when copying a timestamp from the toolbar or copy command. The default list item ends with ': ' for a plain-text description after pasting. Insertions, transcript-row and screenshot copies are unchanged.",
			"timestampCopyFormat",
			{ list: "List item: - <timestamp link>: (default)", link: "Timestamp link only" }
		);
	}

	private addChoiceSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: "transcriptPanelLocation" | "timestampClickAction" | "videoViewerLocation" | "timestampCopyFormat" | "videoToolbarCaptureAction",
		options: Record<string, string>
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(options)
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
