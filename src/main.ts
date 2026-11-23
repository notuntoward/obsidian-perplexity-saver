import {
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	debounce,
} from "obsidian";
import http from "http";
import { registerRemoveSourcesWithNoDialogCommand } from "./commands/removeNoDialog";
import { registerSyncCommand, registerSyncViaLinkCommand } from "./commands/sync";
import { registerReplaceViaLinkCommand } from "./commands/replace";
import { registerDeleteTurnCommand } from "./commands/delete";
import { registerRemoveSourcesWithNoCiteCommand } from "./commands/removeNoCite";
import { registerRelinkSourcesCommand } from "./commands/relink";
import { registerJumpCommand } from "./commands/jump";
import { registerGetLitNoteLinkCommand } from "./commands/getLitNoteLink";
import { HeadlineOptions } from "./normalize/headlines";
import { registerFootnoteNavigation } from "./normalize/footnoteNavigation";
import { ZoteroClient } from "./zotero/zoteroClient";
import { startLitNoteServer, stopLitNoteServer, type LitNoteServerSettings } from "./litNote/litNoteServer";
import { ViewTracker } from "./litNote/viewTracker";
import {
	type TimestampCopyFormat,
} from "commons/youtube";
import {
	TRANSCRIPT_VIEW_TYPE,
	TranscriptView,
} from "./litNote/transcriptView";
import { isSavedVideoWorkspace } from "./video/workspaceLayout";
import { getMainWindow } from "commons/workspace";
import { setTimeoutIn } from "commons/windows";
import { DEFAULT_SETTINGS, type PerplexitySaverSettings } from "./settings";
import { PerplexitySaverSettingTab } from "./settingsTab";
import { perplexityInputStateField, startImport } from "./dialog/inlineInput";
import { VideoController } from "./video/videoController";

export type { PerplexitySaverSettings };

const FRAME_PENDING_CLASS = "perplexity-saver-frame-pending";

export default class PerplexitySaverPlugin extends Plugin {
	settings!: PerplexitySaverSettings;
	zoteroClient!: ZoteroClient;
	viewTracker!: ViewTracker;
	litNoteServerSettings: LitNoteServerSettings | null = null;
	private litNoteServer: http.Server | null = null;

	private framePendingBody: HTMLElement | null = null;
	readonly video = new VideoController(this);

	// Obsidian assigns the top-corner tab group classes only once the layout is ready, after views have rendered.
	private markFramePending(): void {
		const body = this.app.workspace.containerEl.ownerDocument.body;
		body.addClass(FRAME_PENDING_CLASS);
		this.framePendingBody = body;
		this.app.workspace.onLayoutReady(() => {
			body.removeClass(FRAME_PENDING_CLASS);
			this.framePendingBody = null;
		});
	}

	async onload(): Promise<void> {
		this.markFramePending();
		await this.loadSettings();
		this.video.registerEditorFeatures();
		registerFootnoteNavigation(this);
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
				this.video.renameNote(oldPath, file.path);
				this.persistViews();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.viewTracker.remove(file.path);
				this.video.forgetNote(file.path);
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
			onNoteOpened: this.video.foldOpenedTranscript,
		};
		this.litNoteServer = startLitNoteServer(this.app, this.litNoteServerSettings);

		this.video.registerViews();

		this.registerEditorExtension(perplexityInputStateField(this));

		this.addCommand({
			id: "import-ai-dialog-from-clipboard",
			name: "Import AI dialog from clipboard",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await startImport(this, editor, view);
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

	onunload(): void {
		this.framePendingBody?.removeClass(FRAME_PENDING_CLASS);
		this.video.dispose();
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

	async loadSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const stored: Omit<Partial<PerplexitySaverSettings>, "timestampCopyFormat"> & {
			timestampCopyFormat?: TimestampCopyFormat | "list";
			captionWordTiming?: boolean;
			whisperxEnabled?: boolean;
			whisperxPythonPath?: string;
		} =
			loaded && typeof loaded === "object"
				? loaded
				: {};
		const {
			captionWordTiming: _timing,
			whisperxEnabled: _whisperx,
			whisperxPythonPath: _pythonPath,
			timestampCopyFormat,
			...current
		} = stored;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, current, {
			timestampCopyFormat: timestampCopyFormat === "list"
				? "unordered"
				: timestampCopyFormat ?? DEFAULT_SETTINGS.timestampCopyFormat,
		});
		this.settings.videoPlayback = { ...this.settings.videoPlayback };
		this.settings.videoWorkspaces = {};
		for (const [path, saved] of Object.entries(current.videoWorkspaces ?? {})) {
			if (isSavedVideoWorkspace(saved)) this.settings.videoWorkspaces[path] = saved;
			else {
				console.error("Perplexity Saver: invalid saved video workspace", path);
				new Notice(`Could not restore the saved video workspace for ${path}.`);
			}
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.video.refreshSettings();
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
