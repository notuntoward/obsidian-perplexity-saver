import {
	Editor,
	MarkdownView,
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
import { notifyTranscriptNoteOpened } from "commons/youtube";
import { getMainWindow } from "commons/workspace";
import { setTimeoutIn } from "commons/windows";
import { setReviewListener } from "./litNote/pendingReviews";
import { setupReviewStatus } from "./litNote/reviewStatus";
import { DEFAULT_SETTINGS, type PerplexitySaverSettings } from "./settings";
import { PerplexitySaverSettingTab } from "./settingsTab";
import { perplexityInputStateField, startImport } from "./dialog/inlineInput";

export type { PerplexitySaverSettings };

export default class PerplexitySaverPlugin extends Plugin {
	settings!: PerplexitySaverSettings;
	zoteroClient!: ZoteroClient;
	viewTracker!: ViewTracker;
	litNoteServerSettings: LitNoteServerSettings | null = null;
	private litNoteServer: http.Server | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
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
				this.persistViews();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.viewTracker.remove(file.path);
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
			onNoteOpened: (file) => notifyTranscriptNoteOpened(this.app, file),
		};
		this.litNoteServer = startLitNoteServer(this.app, this.litNoteServerSettings);
		this.register(setupReviewStatus(this.app, this.addStatusBarItem()));

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
		setReviewListener();
		if (this.litNoteServer) {
			stopLitNoteServer(this.litNoteServer);
			this.litNoteServer = null;
		}
	}

	private persistViews = debounce(() => {
		this.settings.litNoteLastViewed = this.viewTracker.toRecord();
		void this.saveSettings();
	}, 5000, true);

	/** Propagate a changed transcript heading to literature-note creation. */
	applyTranscriptHeading(): void {
		if (this.litNoteServerSettings) {
			this.litNoteServerSettings.transcriptHeading = this.settings.transcriptHeading;
		}
	}

	async loadSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const stored: Partial<PerplexitySaverSettings> =
			loaded && typeof loaded === "object"
				? loaded
				: {};
		// Retain older video preferences in data.json for Watchword's explicit import.
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
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
