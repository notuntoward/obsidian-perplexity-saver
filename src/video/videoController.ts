import {
	MarkdownView,
	Notice,
	Platform,
	TFile,
	debounce,
	type WorkspaceLeaf,
} from "obsidian";
import { hasLiteratureNoteCategory } from "commons/litnote";
import {
	findNoteVideoId,
	linkUrlAt,
	parseYouTubeUrl,
} from "commons/youtube";
import { notifyNoTranscript, renameStrandedTranscriptHeadings } from "../litNote/transcriptHeadingRecovery";
import { registerTranscriptFolding } from "../litNote/transcriptFolding";
import { registerTranscriptProtection } from "../litNote/transcriptProtection";
import { registerCaptionTimingRepair, runCaptionTiming } from "../litNote/captionTiming";
import { createOrUpdateTranscript } from "../litNote/transcriptCreation";
import {
	TRANSCRIPT_VIEW_TYPE,
	TranscriptView,
	hideTranscriptPanels,
	showTranscriptPanel,
	TRANSCRIPT_LOCATIONS,
	visibleTranscriptLeaves,
	loadTranscriptLines,
	currentRowIndex,
	hiddenTranscriptNavigationRows,
	transcriptSearchCommands,
	type TranscriptPanelLocation,
	type TranscriptPlacement,
} from "../litNote/transcriptView";
import {
	VIDEO_VIEW_TYPE,
	VideoView,
	getVideoLeaf,
	noteVideoId,
	openVideoViewer,
	type TimestampInsertionTime,
} from "./videoView";
import {
	createNoteInsertionAnchor,
	copyInsertionFallback,
	flashInsertedLine,
	insertionMessage,
	insertPlaybackTimestamp,
	noteInsertionAnchors,
	releaseNoteInsertionAnchor,
	resolveNoteInsertionEditor,
	timestampInsertionClipboardText,
	type NoteInsertionTarget,
	type PlacedInsertion,
	type UnavailableInsertionTarget,
} from "./noteInsertion";
import { registerTimestampLinks, type TimestampRequest } from "./timestampLinks";
import { nextPart, PART_ORDER, type NotePart } from "./switchParts";
import { VideoWorkspaceModal, type PreferredVideoWorkspace, type VideoWorkspaceLayout } from "./workspaceLayout";
import { BackgroundPlayback, type NotePlayback } from "./backgroundPlayback";
import { openGoToTime } from "./goToTime";
import { registerVideoNoteFocusIndicator } from "./focusIndicator";
import { registerInsertionTargetMarker } from "./insertionMarker";
import { openVideoLeaf, registerNoteVideoActions } from "./noteVideoAction";
import { isVisiblePart, loadedPlayers, mediaWindowFor, playerForNote, primaryPlayer, transcriptsForNote, visiblePlayers, type VisiblePart } from "./session";
import { buildNavigationModel, capturePaneArrangement, restorePaneArrangement, closePopoutWindowIfEmpty, getGroupForLeaf, isSidebarLeaf, findLeafForFile, getActiveLeafInFocusedWindow, getLeafFileKey, getMainWindow, getWindowForLeaf, loadLeafIfDeferred, openFileInLeaf, revealAndFocusLeaf } from "commons/workspace";
import { setTimeoutIn, type CancelTimer } from "commons/windows";
import { raiseWindow } from "commons/os";
import { getCommandHotkeyLabel } from "commons/modal";
import type PerplexitySaverPlugin from "../main";

/** How long a timestamp click waits for the YouTube embed to answer before revealing the transcript instead. */
const TRANSCRIPT_FALLBACK_DELAY_MS = 3000;

/** Video viewer, transcript panel and video workspace behavior for notes with YouTube videos. */
export class VideoController {
	constructor(private readonly plugin: PerplexitySaverPlugin) {}

	get app() {
		return this.plugin.app;
	}

	get settings() {
		return this.plugin.settings;
	}

	private refreshVideoNoteFocusIndicator: (() => void) | null = null;
	private refreshInsertionTargetMarker: (() => void) | null = null;
	private refreshNoteVideoActions: (() => void) | null = null;
	private readonly openingVideos = new Map<string, Promise<void>>();
	private transcriptLocations = new Map<string, TranscriptPanelLocation>();
	private readonly paragraphWarnings = new Set<string>();
	/** Pending "open the transcript if the video cannot start" checks, keyed by note path. */
	private transcriptFallbacks = new Map<string, CancelTimer>();
	/** Next/previous unit for notes whose transcript panel is closed, keyed by note path; filled asynchronously. */
	private readonly hiddenTranscriptUnits = new Map<string, "sentence" | "caption" | "pending">();
	foldOpenedTranscript: (file: TFile) => void = () => {};

	registerEditorFeatures(): void {
		this.refreshVideoNoteFocusIndicator = registerVideoNoteFocusIndicator(this.plugin, () => this.settings.videoNoteFocusIndicator);
		this.plugin.registerEditorExtension(noteInsertionAnchors);
		registerTranscriptProtection(this.plugin, () => this.settings.transcriptHeading);
		this.refreshInsertionTargetMarker = registerInsertionTargetMarker(this.plugin, () => this.settings);
		this.foldOpenedTranscript = registerTranscriptFolding(this.plugin, () => this.settings);
		registerCaptionTimingRepair(this.plugin, () => this.settings.transcriptHeading, (file) => this.timeTranscriptFromCaptions(file));
	}

	registerViews(): void {
		this.plugin.registerEvent(
			this.app.vault.on("modify", (changed) => {
				if (!this.hiddenTranscriptUnits.delete(changed.path)) return;
				const file = this.app.vault.getFileByPath(changed.path);
				const view = file ? this.partLeaves(file).video?.view : null;
				if (view instanceof VideoView) view.refreshTranscriptControls();
			})
		);

		this.plugin.registerView(
			TRANSCRIPT_VIEW_TYPE,
			(leaf) =>
				new TranscriptView(leaf, {
					getHeadingName: () => this.settings.transcriptHeading,
					getTimestampCopyFormat: () => this.settings.timestampCopyFormat,
					getPausePlaybackOnMediaActions: () => this.settings.pausePlaybackOnMediaActions,
					pausePlaybackForMediaAction: (filePath) => this.pausePlaybackForNote(filePath),
					getTimestampInsertionTime: (filePath, videoId, seconds) =>
						this.timestampInsertionTime(filePath, videoId, seconds),
					paragraphWarnings: this.paragraphWarnings,
					insertTimestampAt: (filePath, url, seconds) => this.insertTranscriptTimestamp(filePath, url, seconds),
					onSelectionChanged: (filePath) => {
						for (const { view } of loadedPlayers(this.app)) {
							if (view.getFilePath() === filePath) view.refreshTranscriptControls();
						}
					},
					alignTranscript: async (filePath) => {
						const file = this.app.vault.getFileByPath(filePath);
						if (!file) throw new Error("Transcript note not found.");
						await this.timeTranscriptFromCaptions(file);
					},
					cancelAlignment: () => this.stopCaptionTiming(),
					getSearchSettings: () => ({
						keyboard: this.settings.transcriptSearchBehavior,
						matching: this.settings.transcriptSearchMatching,
						highlights: this.settings.transcriptSearchHighlights,
					}),
					playAt: (filePath, url, seconds, play) => void this.playTranscriptAt(filePath, url, seconds, play),
					hasPlayerFor: (filePath) => {
						const file = this.app.vault.getFileByPath(filePath);
						return !!file && !!playerForNote(this.app, file);
					},
					isVideoVisible: (filePath, leaf) => {
						const file = this.app.vault.getFileByPath(filePath);
						const player = file ? playerForNote(this.app, file) : null;
						return !!player && !!leaf.view && isVisiblePart(this.app, player.leaf) &&
							getWindowForLeaf(player.leaf) === getWindowForLeaf(leaf);
					},
					isPlaybackPlaying: (filePath) => {
						const file = this.app.vault.getFileByPath(filePath);
						if (!file) return false;
						const video = this.partLeaves(file).video?.view;
						if (video instanceof VideoView && video.getVideoId()) return video.isPlaying();
						return this.existingBackgroundPlayback(filePath)?.isPlaying() ?? false;
					},
					onPlaybackSessionChanged: (filePath, videoId) => {
						this.forMatchingTranscripts(videoId, filePath, (view) => view.refreshPlaybackControls());
					},
					runPlaybackControl: (filePath, action) => {
						const file = this.app.vault.getFileByPath(filePath);
						if (!file) return;
						void this.runTranscriptControl(file, action).catch((error: unknown) => {
							console.error("Perplexity Saver: could not run transcript playback control", error);
							new Notice("Could not run transcript playback control.");
						});
					},
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
					getOrientation: (filePath) => {
						const file = this.app.vault.getFileByPath(filePath);
						return file && this.transcriptLocation(file, this.partLeaves(file).video) === "viewer" ? "below" : "beside";
					},
					onFormatChanged: (filePath) => {
						const file = this.app.vault.getFileByPath(filePath);
						const view = file ? this.partLeaves(file).video?.view : null;
						if (view instanceof VideoView) view.refreshTranscriptControls();
					},
					closeMedia: (filePath) => {
						void this.closeVideoWorkspace(filePath);
					},
				})
		);
		this.registerTranscriptCommands();
		this.registerVideoWorkspaceCommands();
		const rememberGeometry = debounce(() => {
			if (this.changingVideoWorkspace) return;
			this.rememberOpenVideoWorkspaces();
			void this.plugin.saveData(this.settings).catch((error: unknown) => {
				console.error("Perplexity Saver: could not save video workspace geometry", error);
				new Notice("Could not save video workspace geometry.");
			});
		}, 300, true);
		this.plugin.registerEvent(this.app.workspace.on("layout-change", rememberGeometry));
		this.plugin.registerEvent(this.app.workspace.on("resize", rememberGeometry));
		this.app.workspace.onLayoutReady(rememberGeometry);

		this.plugin.registerView(
			VIDEO_VIEW_TYPE,
			(leaf) =>
				new VideoView(leaf, {
					getTranscriptHeading: () => this.settings.transcriptHeading,
					getTimestampCopyFormat: () => this.settings.timestampCopyFormat,
					getTimestampListStyle: () => this.settings.timestampListStyle,
					getPausePlaybackOnMediaActions: () => this.settings.pausePlaybackOnMediaActions,
					getTimestampInsertionTime: (view) => this.timestampInsertionTime(view.getFilePath(), view.getVideoId(), view.getPlaybackSeconds()),
					getToolbarCaptureAction: () => this.settings.videoToolbarCaptureAction,
					getShowYoutubeCaptions: () => this.settings.showYoutubeCaptions,
					getTranscriptUnit: (filePath) => {
						const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
						const view = file ? this.partLeaves(file).transcript?.view : null;
						return view instanceof TranscriptView ? view.getNavigationUnit() : file ? this.hiddenTranscriptUnit(file) : "sentence";
					},
					insertTimestamp: (view) => this.insertTimestampIntoNote(view),
					insertScreenshot: (view, whole) => this.insertScreenshotIntoNote(view, whole),
					isTranscriptShown: (viewer) => visibleTranscriptLeaves(this.app, null,
						viewer.view instanceof VideoView ? viewer.view.getFilePath() : null).length > 0,
					toggleTranscript: (file, viewer) => this.toggleTranscript(file, viewer),
					closeMedia: (filePath) => {
						void this.closeVideoWorkspace(filePath);
					},
					jumpToTranscriptTimestamp: (view, direction) => {
						void this.jumpToTranscriptTimestamp(view, direction).catch((error: unknown) => {
							console.error("Perplexity Saver: could not navigate transcript timestamps", error);
							new Notice("Could not navigate transcript timestamps.");
						});
					},
					onPlayback: (videoId, filePath, seconds, stateChanged) => {
						if (filePath) this.stopBackgroundPlayback(filePath);
						if (leaf.view instanceof VideoView && leaf.view.isPlaying()) this.stopBackgroundPlaybackIn(getWindowForLeaf(leaf));
						this.showPlayback(videoId, filePath, seconds, stateChanged);
					},
					rememberPlayback: (videoId, filePath, seconds) => {
						if (!filePath || !Number.isFinite(seconds) || seconds < 0) return;
						this.settings.videoPlayback[filePath] = { videoId, seconds };
						void this.plugin.saveData(this.settings).catch((error: unknown) => {
							console.error("Perplexity Saver: could not save video position", error);
							new Notice("Could not save video playback position.");
						});
					},
					onVideoChanged: () => this.refreshNoteVideoActions?.(),
					focusNote: (target) => this.focusNoteInsertionTarget(target),
				})
		);
		this.refreshNoteVideoActions = registerNoteVideoActions(this.plugin, {
			getState: (file) => {
				const parts = this.partLeaves(file);
				return { player: !!parts.video, transcript: !!parts.transcript };
			},
			open: (file, videoId) => this.reopenVideoWorkspace(file, videoId),
			close: (file) => this.closeVideoWorkspace(file.path),
			bringForward: async (file) => {
				const { video, transcript } = this.partLeaves(file);
				if (video) await this.activatePartLeaf(video, null);
				if (transcript) await this.activatePartLeaf(transcript, video);
			},
			togglePart: async (file, videoId, part) => {
				const parts = this.partLeaves(file);
				const player = part === "player" ? !parts.video : !!parts.video;
				const transcript = part === "transcript" ? !parts.transcript : !!parts.transcript;
				const layout = player ? transcript ? "both" : "video" : transcript ? "transcript" : "note";
				await this.applyVideoWorkspace(file, layout, false, false, videoId);
			},
		});
		this.registerVideoCommands();
		registerTimestampLinks(
			this.plugin,
			() => this.settings.timestampClickAction,
			(request) => void this.openTimestamp(request).catch((error: unknown) => {
				console.error("Perplexity Saver: could not open timestamp", error);
				new Notice("Could not open timestamp in video viewer.");
			})
		);
	}

	/** Carry per-note video state over to a renamed note. */
	renameNote(oldPath: string, newPath: string): void {
		this.hiddenTranscriptUnits.delete(oldPath);
		const playback = this.settings.videoPlayback[oldPath];
		if (playback) {
			this.settings.videoPlayback[newPath] = playback;
			delete this.settings.videoPlayback[oldPath];
		}
		const workspace = this.settings.videoWorkspaces[oldPath];
		if (workspace) {
			this.settings.videoWorkspaces[newPath] = workspace;
			delete this.settings.videoWorkspaces[oldPath];
		}
	}

	/** Forget per-note video state for a deleted note. */
	forgetNote(path: string): void {
		delete this.settings.videoPlayback[path];
		delete this.settings.videoWorkspaces[path];
		this.hiddenTranscriptUnits.delete(path);
	}

	/** Apply changed settings to open video views and editor decorations. */
	refreshSettings(): void {
		this.refreshVideoNoteFocusIndicator?.();
		this.refreshInsertionTargetMarker?.();
		for (const leaf of this.app.workspace?.getLeavesOfType?.(VIDEO_VIEW_TYPE) ?? []) {
			if (leaf.view instanceof VideoView) {
				leaf.view.updateToolbarCaptureLabels();
				leaf.view.updateYoutubeCaptions();
			}
		}
	}

	dispose(): void {
		this.captionTimingAbort.abort();
		this.rememberOpenVideoWorkspaces();
		for (const cancel of this.transcriptFallbacks.values()) cancel();
		this.transcriptFallbacks.clear();
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (leaf.view instanceof TranscriptView) leaf.view.stopBackgroundPlayback();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE)) this.rememberVideoPlayback(leaf);
		void this.plugin.saveData(this.settings).catch((error: unknown) => {
			console.error("Perplexity Saver: could not save video positions on unload", error);
			new Notice("Could not save video playback positions.");
		});
	}

	private registerVideoCommands(): void {
		const audioCommands: [id: string, name: string, run: (view: NotePlayback) => unknown][] = [
			["video-viewer-play-pause", "Video: play or pause", (v) => v.togglePlay()],
			["video-seek-backward-10-seconds", "Video: back 10 seconds", (v) => v.seekTo(v.getPlaybackSeconds() - 10)],
			["video-seek-forward-10-seconds", "Video: forward 10 seconds", (v) => v.seekTo(v.getPlaybackSeconds() + 10)],
			["video-go-to-time", "Video: go to time...", (v) => openGoToTime(this.app, v)],
			["video-viewer-faster", "Video viewer: faster playback", (v) => v.stepRate(1)],
			["video-viewer-slower", "Video viewer: slower playback", (v) => v.stepRate(-1)],
			["video-viewer-normal-speed", "Video viewer: normal speed", (v) => v.setRate(1)],
			["video-viewer-next-note-timestamp", "Video: next transcript timestamp", (v) => this.jumpToTranscriptTimestamp(v, 1)],
			["video-viewer-previous-note-timestamp", "Video: previous transcript timestamp", (v) => this.jumpToTranscriptTimestamp(v, -1)],
			["video-viewer-copy-timestamp", "Video: copy timestamp", (v) => v.copyTimestampLink()],
			["video-viewer-insert-timestamp", "Video: insert timestamp", (v) => this.insertTimestampIntoNote(v)],
			["video-viewer-open-in-browser", "Video viewer: open in browser at the current time", (v) => v.openInBrowser()],
		];
		const backgroundCommands = new Map(audioCommands.map(([id, , run]) => [id, run]));
		const viewerCommands: [id: string, name: string, run: (view: VideoView) => unknown][] = [
			...audioCommands,
			["video-viewer-screenshot", "Video viewer: screenshot (drag an area)", (v) => v.screenshot()],
			["video-viewer-screenshot-whole", "Video viewer: screenshot of the whole picture", (v) => v.screenshot(true)],
			["video-viewer-insert-screenshot", "Video viewer: insert screenshot (drag an area)", (v) => this.insertScreenshotIntoNote(v, false)],
			["video-viewer-insert-screenshot-whole", "Video viewer: insert screenshot of the whole picture", (v) => this.insertScreenshotIntoNote(v, true)],
			["video-viewer-toggle-transcript", "Toggle YouTube transcript panel (legacy viewer shortcut)", (v) => v.toggleTranscript()],
		];
		for (const [id, name, run] of viewerCommands) {
			const command = {
				id,
				name,
				checkCallback: (checking: boolean) => {
					const candidate = this.videoViewForActivePart();
					const view = candidate?.getVideoId() ? candidate : null;
					const file = this.activePart().file;
					const background = backgroundCommands.get(id);
					const transcript = file && !view ? this.visiblePartLeaves(file).transcript : null;
					if ((!view && !(background && transcript)) || (id.includes("screenshot") && !Platform.isDesktopApp)) return false;
					if (!checking) void Promise.resolve().then(async () => {
						if (view) {
							if (id.startsWith("video-viewer-screenshot") && !isVisiblePart(this.app, view.leaf)) await this.activatePartLeaf(view.leaf, null);
							return run(view);
						}
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
			};
			if (id === "video-viewer-toggle-transcript") {
				this.addBoundAlias(command);
			} else {
				this.plugin.addCommand(command);
			}
		}
	}

	private addBoundAlias(command: import("obsidian").Command): void {
		if (getCommandHotkeyLabel(this.app, `${this.plugin.manifest.id}:${command.id}`)) this.plugin.addCommand(command);
	}

	private registerVideoWorkspaceCommands(): void {
		const choose = (file: TFile): void => {
			void this.chooseVideoWorkspace(file).catch((error: unknown) => {
				console.error("Perplexity Saver: could not open video workspace picker", error);
				new Notice("Could not open video workspace picker.");
			});
		};
		this.plugin.addCommand({
			id: "video-workspace",
			name: "Video: open or change workspace...",
			checkCallback: (checking) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) choose(file);
				return true;
			},
		});
		this.plugin.addCommand({
			id: "cycle-note-video-transcript",
			name: "Video: cycle panes",
			checkCallback: (checking) => {
				const { file, part } = this.activePart();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.cycleVisibleParts(file, part).catch((error: unknown) => {
					console.error("Perplexity Saver: could not cycle visible note panes", error);
					new Notice("Could not cycle visible literature-note panes.");
				});
				return true;
			},
		});
		this.plugin.addCommand({
			id: "video-close-media",
			name: "Video: close player and transcript",
			checkCallback: (checking) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				const { video, transcript } = this.partLeaves(file);
				if (!video && !transcript) return false;
				if (!checking) void this.closeVideoWorkspace(file.path);
				return true;
			},
		});
		this.plugin.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFile && file.extension === "md") {
				menu.addItem((item) => item.setTitle("Reopen or change video workspace...").setIcon("youtube").onClick(() => choose(file)));
			}
		}));
	}

	private visiblePartLeaves(file: TFile): Record<NotePart, WorkspaceLeaf | null> {
		const leaves: Record<NotePart, WorkspaceLeaf | null> = { note: null, video: null, transcript: null };
		// Prefer a visible duplicate over a hidden tab for the same file.
		for (const part of PART_ORDER) {
			const type = part === "note" ? "markdown" : part === "video" ? VIDEO_VIEW_TYPE : TRANSCRIPT_VIEW_TYPE;
			leaves[part] = this.app.workspace.getLeavesOfType(type).find((leaf) =>
				this.partFileKey(leaf) === file.path && isVisiblePart(this.app, leaf)) ?? null;
		}
		return leaves;
	}

	private async cycleVisibleParts(file: TFile, current: NotePart | null): Promise<void> {
		const leaves = this.visiblePartLeaves(file);
		const part = nextPart(current, PART_ORDER.filter((key) => leaves[key]));
		const leaf = part ? leaves[part] : null;
		if (leaf) await this.activatePartLeaf(leaf, leaves.video);
	}

	private async chooseVideoWorkspace(file: TFile): Promise<void> {
		const parts = this.partLeaves(file);
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true })?.view;
		const videoId = active instanceof MarkdownView && active.file === file && active.getMode() === "source"
			? findNoteVideoId(active.editor.getValue()) : await noteVideoId(this.app, file);
		if (!parts.video && !parts.transcript && !videoId) {
			new Notice(`No YouTube link in ${file.basename}.`);
			return;
		}
		const visible = this.visiblePartLeaves(file);
		const current = visible.video ? (visible.transcript ? "both" : "video") : visible.transcript ? "transcript" : "note";
		const saved = this.settings.videoWorkspaces[file.path];
		const remembered = saved?.videoId === videoId ? saved.layout : undefined;
		new VideoWorkspaceModal(this.app, current, this.settings.preferredVideoWorkspace, (layout, restore) => {
			void this.applyVideoWorkspace(file, layout, true, restore, videoId ?? undefined).catch((error: unknown) => {
				console.error("Perplexity Saver: could not apply video workspace", error);
				new Notice("Could not apply video workspace.");
			});
		}, remembered, videoId ? {
			title: openVideoLeaf(this.plugin, videoId) ? "Show open video" : "Open video",
			run: () => {
				void this.openOrShowVideo(file, videoId).catch((error: unknown) => {
					console.error("Perplexity Saver: could not open or show video", error);
					new Notice("Could not open or show video.");
				});
			},
		} : undefined).open();
	}

	private async openOrShowVideo(file: TFile, videoId: string): Promise<void> {
		const pending = this.openingVideos.get(videoId);
		if (pending) return pending;
		const operation = this.openOrShowVideoOnce(file, videoId);
		this.openingVideos.set(videoId, operation);
		try {
			await operation;
		} finally {
			this.openingVideos.delete(videoId);
			this.refreshNoteVideoActions?.();
		}
	}

	private async openOrShowVideoOnce(file: TFile, videoId: string): Promise<void> {
		const existing = openVideoLeaf(this.plugin, videoId);
		if (existing) {
			await this.activatePartLeaf(existing, null);
			return;
		}
		const parts = this.partLeaves(file);
		if (parts.video || parts.transcript) {
			const leaf = await this.openViewerForNote(file, false, true, videoId);
			if (!leaf) throw new Error("Could not open the video player.");
			await this.activatePartLeaf(leaf, null);
			return;
		}
		await this.reopenVideoWorkspace(file, videoId, true);
	}

	private async reopenVideoWorkspace(file: TFile, videoId: string, requirePlayer = false): Promise<void> {
		const saved = this.settings.videoWorkspaces[file.path];
		const remembered = saved?.videoId === videoId ? saved : undefined;
		const requested = remembered?.layout ?? this.settings.preferredVideoWorkspace;
		const hasTranscript = requested !== "video" && !!(await loadTranscriptLines(this.app, file, this.settings.transcriptHeading))?.length;
		const layout = hasTranscript ? requested === "transcript" && !requirePlayer ? "transcript" : "both" : "video";
		const opened = await this.applyVideoWorkspace(file, layout, true, !!remembered && remembered.layout === layout, videoId);
		if (!opened) throw new Error("The requested video workspace could not be opened.");
		if (requested !== "video" && !hasTranscript) new Notice("No transcript found; opened the video only.");
	}

	private async closeVideoWorkspace(filePath: string): Promise<void> {
		const file = this.app.vault.getFileByPath(filePath);
		if (!file) {
			new Notice("The literature note is no longer available.");
			return;
		}
		await this.applyVideoWorkspace(file, "note", false).catch((error: unknown) => {
			console.error("Perplexity Saver: could not close player and transcript", error);
			new Notice("Could not close player and transcript.");
		});
	}

	private changingVideoWorkspace = false;

	private async applyVideoWorkspace(file: TFile, layout: VideoWorkspaceLayout, openNote = true, restore = false, selectedVideoId?: string): Promise<boolean> {
		if (this.changingVideoWorkspace) {
			new Notice("A video workspace change is already in progress.");
			return false;
		}
		this.changingVideoWorkspace = true;
		try {
			if (layout === "note") this.rememberVideoWorkspace(file);
			const wantsVideo = layout === "video" || layout === "both";
			const wantsTranscript = layout === "transcript" || layout === "both";
			const requestedVideoId = wantsVideo || wantsTranscript ? selectedVideoId ?? await noteVideoId(this.app, file) : null;
			const leaves = this.partLeaves(file);
			// Validate missing content before closing any existing panes.
			if (wantsVideo && !leaves.video && !requestedVideoId) {
				new Notice(`No YouTube link in ${file.basename}.`);
				return false;
			}
			if (wantsTranscript && !leaves.transcript && !(await loadTranscriptLines(this.app, file, this.settings.transcriptHeading))?.length) {
				void notifyNoTranscript(
					this.app,
					file,
					this.settings.transcriptHeading,
					() => this.createOrUpdateTranscriptFromYoutube(file)
				);
				return false;
			}
			const needsNote = openNote || wantsVideo || wantsTranscript;
			if (!leaves.note && needsNote) {
				await openFileInLeaf(this.app, file, { raiseWindow: Platform.isDesktopApp ? raiseWindow : undefined });
				leaves.note = this.partLeaves(file).note;
			}
			if (!leaves.note && needsNote) throw new Error("Could not open the literature note.");
			const saved = restore ? this.settings.videoWorkspaces[file.path] : undefined;
			if (saved?.geometry && leaves.note && !leaves.video && !leaves.transcript) {
				const restored = await restorePaneArrangement(this.app, saved.geometry, "note", leaves.note, async (key, leaf) => {
					if (key === "video") {
						const bookmark = this.settings.videoPlayback[file.path];
						const resumeAt = bookmark?.videoId === saved.videoId && Number.isFinite(bookmark.seconds) && bookmark.seconds > 0
							? bookmark.seconds : undefined;
						await leaf.setViewState({ type: VIDEO_VIEW_TYPE, active: false, state: {
							videoId: saved.videoId, time: 0, file: file.path, autoplay: false,
							...(resumeAt !== undefined ? { resumeAt } : {}),
						} });
					} else if (key === "transcript") {
						await leaf.setViewState({ type: TRANSCRIPT_VIEW_TYPE, active: false, state: { file: file.path, pinned: true } });
					} else throw new Error("Unexpected pane in saved video workspace.");
				});
				leaves.video = restored.video ?? null;
				leaves.transcript = restored.transcript ?? null;
			}
			if (wantsVideo) {
				if (!leaves.video) leaves.video = await this.openViewerForNote(file, false, true, selectedVideoId);
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
			await this.plugin.saveData(this.settings);
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
			if (leaves.note) await this.activatePartLeaf(leaves.note, wantsVideo ? leaves.video : null);
			for (const win of closedWindows) closePopoutWindowIfEmpty(this.app, win);
			if (layout !== "note") this.rememberVideoWorkspace(file, layout, requestedVideoId);
			await this.plugin.saveData(this.settings);
			return true;
		} finally {
			this.changingVideoWorkspace = false;
		}
	}

	private rememberVideoWorkspace(file: TFile, requested?: PreferredVideoWorkspace, requestedVideoId?: string | null): void {
		const leaves = this.partLeaves(file);
		const layout = leaves.video ? (leaves.transcript ? "both" : "video") : leaves.transcript ? "transcript" : null;
		if (!layout) return;
		const previous = this.settings.videoWorkspaces[file.path];
		// Closing panes one by one must not replace the last full configuration
		// with an intermediate teardown layout. Explicit picker choices do replace it.
		if (!requested && previous && ((previous.layout !== "transcript" && !leaves.video) ||
			(previous.layout !== "video" && !leaves.transcript))) return;
		const player = leaves.video?.view;
		const transcript = leaves.transcript?.view;
		const videoId = player instanceof VideoView ? player.getVideoId() : transcript instanceof TranscriptView
			? transcript.getBackgroundPlayback()?.getVideoId() ?? requestedVideoId ?? previous?.videoId ?? this.settings.videoPlayback[file.path]?.videoId : null;
		if (!videoId) return;
		const geometry = capturePaneArrangement(this.app, leaves);
		const chosen = requested ?? layout;
		this.settings.videoWorkspaces[file.path] = {
			videoId, layout: chosen,
			...(geometry ? { geometry } : previous?.videoId === videoId && previous.layout === chosen && previous.geometry ? { geometry: previous.geometry } : {}),
		};
	}

	private rememberOpenVideoWorkspaces(): void {
		const paths = new Set([...this.app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE), ...this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)]
			.map(leaf => this.partFileKey(leaf)).filter((path): path is string => !!path));
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path);
			if (file) this.rememberVideoWorkspace(file);
		}
	}

	private async ensureVideoWorkspace(file: TFile, videoId: string): Promise<boolean> {
		const parts = this.partLeaves(file);
		if (parts.video || parts.transcript) return false;
		const saved = this.settings.videoWorkspaces[file.path];
		const opened = saved?.videoId === videoId
			? await this.applyVideoWorkspace(file, saved.layout, true, true)
			: await this.applyVideoWorkspace(file, this.settings.preferredVideoWorkspace);
		if (opened === false) throw new Error("The requested video workspace could not be opened.");
		return true;
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
		const seconds = view.getBookmarkSeconds();
		if (file && videoId && Number.isFinite(seconds) && seconds >= 0) {
			this.settings.videoPlayback[file] = { videoId, seconds };
		}
	}

	private registerTranscriptCommands(): void {
		this.plugin.addCommand({
			id: "transcript-create-or-update-youtube",
			name: "Transcript: create or update from YouTube",
			checkCallback: (checking: boolean) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.createOrUpdateTranscriptFromYoutube(file).catch((error: unknown) => {
					console.error("Perplexity Saver: could not create or update transcript", error);
					new Notice("Could not create or update the transcript.");
				});
				return true;
			},
		});
		this.plugin.addCommand({
			id: "whisperx-align-transcript",
			name: "Transcript: time sentences from YouTube captions",
			checkCallback: (checking: boolean) => {
				const file = this.activePart().file;
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.timeTranscriptFromCaptions(file).catch((error: unknown) => {
					console.error("Perplexity Saver: caption timing failed", error);
					new Notice(error instanceof Error ? error.message : "Caption timing failed.");
				});
				return true;
			},
		});
		this.plugin.addCommand({
			id: "whisperx-cancel-alignment",
			name: "Transcript: cancel caption timing",
			callback: () => this.stopCaptionTiming(),
		});
		this.plugin.addCommand({
			id: "transcript-rename-headings",
			name: "Transcript: rename other transcript headings to the current name",
			callback: () => {
				void renameStrandedTranscriptHeadings(this.app, this.settings.transcriptHeading).catch((error: unknown) => {
					console.error("Perplexity Saver: could not rename transcript headings", error);
					new Notice("Could not rename transcript headings.");
				});
			},
		});
		this.plugin.addCommand({
			id: "show-youtube-transcript",
			name: "Video: show or hide transcript",
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
		this.plugin.addCommand({
			id: "search-youtube-transcript",
			name: "Video: search transcript",
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
		for (const command of transcriptSearchCommands(this.app)) this.plugin.addCommand(command);
		this.plugin.addCommand({
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

	private captionTimingAbort = new AbortController();

	stopCaptionTiming(): void {
		this.captionTimingAbort.abort();
		this.captionTimingAbort = new AbortController();
	}

	private async timeTranscriptFromCaptions(file: TFile): Promise<void> {
		const timings = await runCaptionTiming(this.app, file, this.settings.transcriptHeading, {
			signal: this.captionTimingAbort.signal,
		});
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (leaf.view instanceof TranscriptView && leaf.view.getFilePath() === file.path) {
				await leaf.view.reload({ showWordTimedSentences: timings !== null });
			}
		}
	}

	private preferredTranscriptVideoId(file: TFile): string | null {
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true })?.view;
		if (active instanceof MarkdownView && active.file === file && active.getMode() === "source") {
			const cursor = active.editor.getCursor();
			const url = linkUrlAt(active.editor.getLine(cursor.line), cursor.ch);
			const cursorVideoId = url ? parseYouTubeUrl(url)?.videoId : null;
			if (cursorVideoId) return cursorVideoId;
		}
		const player = this.partLeaves(file).video?.view;
		return player instanceof VideoView ? player.getVideoId() : null;
	}

	private async createOrUpdateTranscriptFromYoutube(file: TFile): Promise<void> {
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true })?.view;
		const noteText = active instanceof MarkdownView && active.file === file
			? active.editor.getValue()
			: undefined;
		const result = await createOrUpdateTranscript(this.app, file, this.settings.transcriptHeading, {
			preferredVideoId: this.preferredTranscriptVideoId(file),
			noteText,
		});
		if (result) this.foldOpenedTranscript(file);
	}

	/** Mark the playing line in transcript panels showing this video (scrolling them if the setting is on). */
	private showPlayback(videoId: string, filePath: string | null, seconds: number, stateChanged = true, reveal = false): void {
		this.forMatchingTranscripts(videoId, filePath, (view) => view.showPlayback(seconds, this.settings.followTranscript, stateChanged, reveal));
	}

	private forMatchingTranscripts(videoId: string, filePath: string | null, update: (view: TranscriptView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TranscriptView) {
				if (view.showsVideo(filePath, videoId)) update(view);
				continue;
			}
			// A deferred view has no TranscriptView yet, but its saved state names the
			// note. Load it so a timestamp click still centers the right row offline.
			if (!filePath || getLeafFileKey(leaf) !== filePath) continue;
			void loadLeafIfDeferred(leaf).then(() => {
				if (!this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).includes(leaf)) return;
				const loaded = leaf.view;
				if (loaded instanceof TranscriptView && loaded.showsVideo(filePath, videoId)) update(loaded);
			}).catch((error: unknown) => {
				console.error("Perplexity Saver: could not load the transcript pane", error);
			});
		}
	}

	/** Transcript panel: show the video from a line in the video viewer, starting playback with `play`. */
	private async playTranscriptAt(filePath: string, url: string, seconds: number, play: boolean): Promise<void> {
		const file = this.app.vault.getFileByPath(filePath);
		let videoId = url ? parseYouTubeUrl(url)?.videoId ?? null : null;
		if (!videoId) videoId = file ? await noteVideoId(this.app, file) : null;
		if (!videoId) {
			new Notice("No YouTube link for this transcript.");
			return;
		}
		if (!file) {
			await openVideoViewer(this.app, { videoId, seconds, sourcePath: filePath, autoplay: play }, this.settings.videoViewerLocation);
			return;
		}
		await this.playSession(file, videoId, seconds, play);
	}

	/**
	 * Play a note in its session, wherever that session lives: use the note's own
	 * player, retarget a player in the transcript's window, use background audio
	 * when the note has a visible transcript, or open a player. One audio source
	 * survives per note and per window.
	 */
	private async playSession(file: TFile, videoId: string, seconds: number, play: boolean, preserveWorkspace = false): Promise<void> {
		const origin = mediaWindowFor(this.app, file);
		const own = playerForNote(this.app, file);
		if (own) {
			await this.switchPlayer(own, file, videoId, seconds, play);
			return;
		}
		const transcript = transcriptsForNote(this.app, file, origin)[0] ?? null;
		if (transcript) {
			const win = getWindowForLeaf(transcript.leaf);
			const rival = visiblePlayers(this.app, win).find((part) => part.view.getFilePath() !== file.path);
			if (rival && !preserveWorkspace) {
				await this.switchPlayer(rival, file, videoId, seconds, play);
				return;
			}
			this.stopBackgroundPlaybackIn(win, file.path);
			const background = await this.backgroundPlaybackFor(file, { videoId, seconds }, win, preserveWorkspace);
			if (background) {
				background.seekTo(seconds);
				if (play) background.play();
			}
			return;
		}
		const fallback = primaryPlayer(this.app, origin);
		if (fallback) {
			await this.switchPlayer(fallback, file, videoId, seconds, play);
			return;
		}
		this.stopBackgroundPlayback(file.path);
		this.stopBackgroundPlaybackIn(origin);
		await openVideoViewer(this.app, { videoId, seconds, sourcePath: file.path, autoplay: play, preferWindow: origin }, this.settings.videoViewerLocation);
	}

	/** Retarget a player and move every transcript of its previous note to the new note. */
	private async switchPlayer(player: VisiblePart<VideoView>, file: TFile, videoId: string, seconds: number, play: boolean, resumeAt?: number): Promise<void> {
		const previousPath = player.view.getFilePath();
		this.stopBackgroundPlayback(file.path);
		this.stopBackgroundPlaybackIn(getWindowForLeaf(player.leaf));
		await openVideoViewer(this.app, {
			videoId, seconds, sourcePath: file.path, autoplay: play, resumeAt, preferLeaf: player.leaf,
		}, this.settings.videoViewerLocation);
		await this.alignTranscripts(previousPath, file.path);
	}

	/** Keep every transcript of the old note on the player's new note, in any window. */
	private async alignTranscripts(previousPath: string | null, nextPath: string | null): Promise<void> {
		if (!previousPath || !nextPath || nextPath === previousPath) return;
		const moves: Promise<void>[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (leaf.view instanceof TranscriptView && leaf.view.getFilePath() === previousPath) {
				moves.push(leaf.view.showFile(nextPath));
			}
		}
		await Promise.all(moves);
	}

	/** Stop hidden playback in one window, so a visible player is the only audio source. */
	private stopBackgroundPlaybackIn(win: Window | null | undefined, exceptPath?: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (!(leaf.view instanceof TranscriptView) || (win && getWindowForLeaf(leaf) !== win)) continue;
			if (exceptPath && leaf.view.getFilePath() === exceptPath) continue;
			leaf.view.stopBackgroundPlayback();
		}
	}

	/** Toolbar play/previous/next/insert: drive the session's player, never start a second one. */
	private async runTranscriptControl(file: TFile, action: "play" | "previous" | "next" | "insert" | "go-to-time"): Promise<void> {
		const origin = mediaWindowFor(this.app, file);
		const attached = playerForNote(this.app, file)?.view ?? null;
		if (action === "go-to-time") {
			const playback = attached ?? await this.backgroundPlaybackFor(file, undefined, origin);
			if (playback) openGoToTime(this.app, playback);
			return;
		}
		if (action === "play") {
			if (attached) {
				attached.togglePlay();
				return;
			}
			const transcript = transcriptsForNote(this.app, file, origin)[0] ?? null;
			const win = transcript ? getWindowForLeaf(transcript.leaf) : null;
			const rival = win ? visiblePlayers(this.app, win).find((part) => part.view.getFilePath() !== file.path) : null;
			if (rival) {
				const videoId = await noteVideoId(this.app, file) ?? rival.view.getVideoId();
				if (!videoId) return;
				const saved = this.settings.videoPlayback[file.path];
				const resumeAt = saved?.videoId === videoId && Number.isFinite(saved.seconds) && saved.seconds > 0
					? saved.seconds : undefined;
				await this.switchPlayer(rival, file, videoId, 0, resumeAt === undefined, resumeAt);
				if (resumeAt !== undefined) rival.view.togglePlay();
				return;
			}
			(await this.backgroundPlaybackFor(file, undefined, win))?.togglePlay();
			return;
		}
		const target = attached ?? this.existingBackgroundPlayback(file.path);
		if (!target) return;
		if (action === "insert") await this.insertTimestampIntoNote(target);
		else await this.jumpToTranscriptTimestamp(target, action === "next" ? 1 : -1);
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
		if (!file) {
			await openVideoViewer(
				this.app,
				{ videoId: request.videoId, seconds: request.seconds, sourcePath: filePath, autoplay: true },
				this.settings.videoViewerLocation
			);
			return;
		}
		let playbackError: unknown;
		try {
			const reopened = await this.ensureVideoWorkspace(file, request.videoId);
			if (reopened && !this.partLeaves(file).video) await this.playSession(file, request.videoId, request.seconds, true, true);
			else await this.playSession(file, request.videoId, request.seconds, true);
		} catch (error) {
			playbackError = error;
		}
		// Revealing the transcript must never depend on YouTube being reachable.
		// Clicking a link is explicit navigation: reveal the chunk even if the user
		// recently scrolled the panel or keyboard focus is still on a transcript row.
		this.showPlayback(request.videoId, file.path, request.seconds, false, true);
		await this.revealTranscriptIfVideoUnavailable(file, request).catch((error: unknown) => {
			console.error("Perplexity Saver: could not reveal the transcript", error);
		});
		if (playbackError !== undefined) {
			throw playbackError instanceof Error
				? playbackError
				: new Error(typeof playbackError === "string" ? playbackError : "Video playback failed.");
		}
	}

	/**
	 * Offline, the video pane cannot play anything, so make the stored transcript the
	 * visible fallback. When the player merely has not answered yet, wait briefly so
	 * a normal online load does not open a transcript pane unnecessarily.
	 */
	private async revealTranscriptIfVideoUnavailable(file: TFile, request: TimestampRequest): Promise<void> {
		if (this.hasTranscriptPanel(file.path)) return;
		const win = request.target.ownerDocument.defaultView ?? getMainWindow(this.app);
		const offline = win?.navigator.onLine === false;
		// Online with a visible player means the user chose to watch, not read: a
		// timestamp click must not reopen a transcript pane they deliberately closed.
		if (!offline && this.hasVisiblePlayer(file)) return;
		if (!offline && this.notePlaybackReady(file)) return;
		const lines = await loadTranscriptLines(this.app, file, this.settings.transcriptHeading);
		if (!lines?.length) return;
		if (offline) {
			await this.showTimestampTranscript(file, request);
			return;
		}
		if (!win) return;
		const existing = this.transcriptFallbacks.get(file.path);
		existing?.();
		this.transcriptFallbacks.set(file.path, setTimeoutIn(win, () => {
			this.transcriptFallbacks.delete(file.path);
			if (this.hasTranscriptPanel(file.path) || this.hasVisiblePlayer(file) || this.notePlaybackReady(file)) return;
			void this.showTimestampTranscript(file, request).catch((error: unknown) => {
				console.error("Perplexity Saver: could not open the transcript", error);
			});
		}, TRANSCRIPT_FALLBACK_DELAY_MS));
	}

	private hasVisiblePlayer(file: TFile): boolean {
		return visiblePlayers(this.app).some((part) => part.view.getFilePath() === file.path);
	}

	private hasTranscriptPanel(filePath: string): boolean {
		return this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).some((leaf) =>
			leaf.view instanceof TranscriptView ? leaf.view.getFilePath() === filePath : getLeafFileKey(leaf) === filePath);
	}

	private notePlaybackReady(file: TFile): boolean {
		const player = playerForNote(this.app, file);
		if (player?.view.isReady()) return true;
		return this.existingBackgroundPlayback(file.path)?.isReady() ?? false;
	}

	/** Show the note's transcript at the clicked timestamp without taking keyboard focus from the note. */
	private async showTimestampTranscript(file: TFile, request: TimestampRequest): Promise<void> {
		if (this.app.vault.getFileByPath(file.path) !== file) return;
		await this.showTranscript(file, this.partLeaves(file).video, undefined, false, false);
		this.showPlayback(request.videoId, file.path, request.seconds, false, true);
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
		const playable = videos.filter((leaf) => leaf.view instanceof VideoView && !!leaf.view.getVideoId());
		const candidates = playable.length ? playable : videos;
		const activeWin = getWindowForLeaf(getActiveLeafInFocusedWindow(this.app, { includeSidebars: true }) ?? note);
		const video = candidates.find((leaf) => getWindowForLeaf(leaf) === activeWin)
			?? candidates.find((leaf) => getWindowForLeaf(leaf) === noteWin) ?? candidates[0] ?? null;
		const transcripts = ws.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).filter((leaf) => this.partFileKey(leaf) === file.path);
		const transcript = transcripts.find((leaf) => getWindowForLeaf(leaf) === activeWin) ?? transcripts[0] ?? null;
		return { note, video, transcript };
	}

	/** Prefer the video associated with the focused note/transcript over another viewer in the same window. */
	private videoViewForActivePart(): VideoView | null {
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true })?.view;
		if (active instanceof VideoView && active.getVideoId()) return active;
		const { file } = this.activePart();
		if (file) {
			const related = this.partLeaves(file).video?.view;
			return related instanceof VideoView ? related : null;
		}
		return null;
	}

	/**
	 * What the video's next/previous controls step by when no transcript panel is open: sentences, or captions
	 * for a transcript with no sentence boundaries. Answers "sentence" until the note is read, then refreshes the label.
	 */
	private hiddenTranscriptUnit(file: TFile): "sentence" | "caption" {
		const known = this.hiddenTranscriptUnits.get(file.path);
		if (known === "sentence" || known === "caption") return known;
		if (known === undefined) {
			this.hiddenTranscriptUnits.set(file.path, "pending");
			void loadTranscriptLines(this.app, file, this.settings.transcriptHeading).then((lines) => {
				if (this.hiddenTranscriptUnits.get(file.path) !== "pending") return;
				const captions = hiddenTranscriptNavigationRows(this.app, file, lines ?? [])[0]?.captionFallback;
				this.hiddenTranscriptUnits.set(file.path, captions ? "caption" : "sentence");
				const view = this.partLeaves(file).video?.view;
				if (captions && view instanceof VideoView) view.refreshTranscriptControls();
			}, () => this.hiddenTranscriptUnits.delete(file.path));
		}
		return "sentence";
	}

	private async jumpToTranscriptTimestamp(playback: NotePlayback, direction: 1 | -1): Promise<void> {
		const token = playback.getPlaybackToken();
		const filePath = playback.getFilePath();
		const videoId = playback.getVideoId();
		if (!token || !videoId) return;
		const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
		if (!file) {
			new Notice("No transcript note is associated with this video.");
			return;
		}
		const lines = await loadTranscriptLines(this.app, file, this.settings.transcriptHeading);
		const current = playback.getPlaybackToken();
		if (!current || current.player !== token.player || current.revision !== token.revision ||
			playback.getFilePath() !== filePath || playback.getVideoId() !== videoId ||
			this.app.vault.getFileByPath(file.path) !== file) return;
		if (playback instanceof VideoView && !this.app.workspace.getLeavesOfType(VIDEO_VIEW_TYPE)
			.some((leaf) => leaf.view === playback)) return;
		if (playback instanceof BackgroundPlayback && !this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)
			.some((leaf) => leaf.view instanceof TranscriptView && leaf.view.getBackgroundPlayback() === playback)) return;
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true })?.view;
		const transcript = active instanceof TranscriptView && active.getFilePath() === filePath
			? active : this.partLeaves(file).transcript?.view;
		const rows = transcript instanceof TranscriptView ? transcript.getRows(lines ?? []) : hiddenTranscriptNavigationRows(this.app, file, lines ?? []);
		const timestamps = [...new Set(rows
			.filter((row) => {
				const rowVideo = parseYouTubeUrl(row.url)?.videoId;
				return Number.isFinite(row.startSec) && (!rowVideo || rowVideo === videoId);
			})
			.map((row) => row.startSec))].sort((a, b) => a - b);
		if (!timestamps.length) {
			new Notice("No transcript timestamps for this video.");
			return;
		}
		const currentIndex = currentRowIndex(timestamps, playback.getPlaybackSeconds());
		const target = timestamps[currentIndex + direction];
		if (target === undefined) new Notice(direction > 0 ? "No later transcript timestamp." : "No previous transcript timestamp.");
		else playback.seekTo(target);
	}

	private existingBackgroundPlayback(filePath: string, win: Window | null = null): BackgroundPlayback | null {
		for (const leaf of this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE)) {
			if (!(leaf.view instanceof TranscriptView) || (win && getWindowForLeaf(leaf) !== win)) continue;
			const playback = leaf.view.getBackgroundPlayback();
			if (playback?.getFilePath() === filePath) return playback;
		}
		return null;
	}

	private async backgroundPlaybackFor(
		file: TFile,
		request?: { videoId: string; seconds: number; autoplay?: boolean; playbackRate?: number },
		preferWindow?: Window | null,
		pauseOtherPlayers = false
	): Promise<BackgroundPlayback | null> {
		const panel = transcriptsForNote(this.app, file, preferWindow)[0] ?? null;
		if (!panel) {
			new Notice("Open the transcript before playing audio in the background.");
			return null;
		}
		const leaf = panel.leaf;
		const transcript = panel.view;
		const videoId = request?.videoId ?? transcript.getBackgroundPlayback()?.getVideoId() ?? await noteVideoId(this.app, file);
		if (!videoId) {
			new Notice(`No YouTube link in ${file.basename}.`);
			return null;
		}
		// Metadata reads may finish after a layout change or another command.
		if (!this.app.workspace.getLeavesOfType(TRANSCRIPT_VIEW_TYPE).includes(leaf) ||
			transcript.getFilePath() !== file.path || !isVisiblePart(this.app, leaf)) {
			new Notice("The transcript workspace changed before playback could start.");
			return null;
		}
		const win = getWindowForLeaf(leaf);
		const otherPlayers = loadedPlayers(this.app, win);
		if (playerForNote(this.app, file) || (!pauseOtherPlayers && otherPlayers.length)) {
			new Notice("A video pane is open; use its playback controls.");
			return null;
		}
		if (pauseOtherPlayers) for (const player of otherPlayers) {
			if (player.view.isPlaying()) player.view.pausePlayback();
		}
		const existing = this.existingBackgroundPlayback(file.path);
		if (existing?.getVideoId() === videoId) return existing;
		if (existing) this.stopBackgroundPlayback(file.path);
		const saved = this.settings.videoPlayback[file.path];
		const playback = new BackgroundPlayback(this.app, transcript.containerEl, file.path, videoId,
			request?.seconds ?? (saved?.videoId === videoId ? saved.seconds : 0), {
				getTimestampCopyFormat: () => this.settings.timestampCopyFormat,
				getTimestampListStyle: () => this.settings.timestampListStyle,
				getPausePlaybackOnMediaActions: () => this.settings.pausePlaybackOnMediaActions,
				getTimestampInsertionTime: (playback) => this.timestampInsertionTime(
					playback.getFilePath(), playback.getVideoId(), playback.getPlaybackSeconds()
				),
				onPlayback: (id, path, seconds, stateChanged) => this.showPlayback(id, path, seconds, stateChanged),
				remember: (id, path, seconds) => {
					this.settings.videoPlayback[path] = { videoId: id, seconds };
					void this.plugin.saveData(this.settings).catch((error: unknown) => {
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

	private createNoteInsertionTarget(view: Pick<NotePlayback, "getFilePath">): NoteInsertionTarget | UnavailableInsertionTarget {
		const filePath = view.getFilePath();
		const destination = resolveNoteInsertionEditor(this.app, filePath);
		if ("unavailable" in destination) return destination;
		const { leaf, view: editorView } = destination;
		const anchor = createNoteInsertionAnchor(editorView);
		if (!anchor) return { unavailable: "The note insertion point could not be tracked." };
		const targetPath = destination.filePath;
		const file = this.app.vault.getFileByPath(targetPath);
		return {
			leaf,
			filePath: targetPath,
			anchor,
			literatureNote: !!file && hasLiteratureNoteCategory(this.app.metadataCache.getFileCache(file)?.frontmatter),
			isValid: () =>
				leaf.view instanceof MarkdownView &&
				leaf.view.file?.path === targetPath &&
				leaf.view.getMode() === "source" &&
				editorView.dom.isConnected && !editorView.state.readOnly,
		};
	}

	private timestampInsertionTime(filePath: string | null, videoId: string | null, seconds: number): TimestampInsertionTime {
		if (!videoId) return { error: "The video for timestamp insertion is no longer available." };
		const file = filePath ? this.app.vault.getFileByPath(filePath) : null;
		const selections = new Set<number>();
		for (const { view } of file ? transcriptsForNote(this.app, file) : []) {
			const row = view.getSelectedTimestamp();
			if (row && parseYouTubeUrl(row.url)?.videoId === videoId) selections.add(row.startSec);
		}
		if (selections.size > 1) return { error: "Conflicting transcript selections. Clear one selection before inserting a timestamp." };
		const selected = selections.size === 1;
		const resolved = selected ? [...selections][0] : seconds;
		if (!Number.isFinite(resolved) || resolved < 0) return { error: "The timestamp insertion time is not available." };
		return { seconds: resolved, selected };
	}

	private insertionClipboardWindow(): Window | null {
		const active = getActiveLeafInFocusedWindow(this.app, { includeSidebars: true });
		return (active ? getWindowForLeaf(active) : getMainWindow(this.app)) ?? null;
	}

	private pausePlaybackForNote(filePath: string): void {
		const file = this.app.vault.getFileByPath(filePath);
		const playback = (file ? playerForNote(this.app, file)?.view : null) ?? this.existingBackgroundPlayback(filePath);
		playback?.pausePlayback();
	}

	private async insertTimestampIntoNote(view: NotePlayback): Promise<void> {
		const time = this.timestampInsertionTime(view.getFilePath(), view.getVideoId(), view.getPlaybackSeconds());
		if ("error" in time) {
			new Notice(time.error);
			return;
		}
		const videoId = view.getVideoId();
		if (!videoId || !Number.isFinite(time.seconds) || time.seconds < 0) {
			new Notice("The timestamp insertion time is not available.");
			return;
		}
		const fallback = async (reason: string): Promise<void> => {
			if (this.settings.pausePlaybackOnMediaActions) view.pausePlayback();
			await copyInsertionFallback(this.insertionClipboardWindow(),
				timestampInsertionClipboardText(videoId, time.seconds, this.settings.timestampListStyle), "Timestamp", reason);
		};
		const target = this.createNoteInsertionTarget(view);
		if ("unavailable" in target) {
			await fallback(target.unavailable);
			return;
		}
		const before = target.anchor.view.state.doc;
		try {
			if (!await view.insertTimestampBullet(target, time.seconds)) await fallback("The note insertion point is no longer available.");
		} catch (error) {
			console.error("Perplexity Saver: could not insert timestamp", error);
			if (target.anchor.view.state.doc !== before) new Notice("The note changed while completing timestamp insertion. Check it before retrying; nothing was copied.");
			else await fallback("A safe insertion into the note could not be completed.");
		} finally {
			releaseNoteInsertionAnchor(target.anchor);
		}
	}

	private async insertTranscriptTimestamp(filePath: string, url: string, seconds: number): Promise<void> {
		const videoId = parseYouTubeUrl(url)?.videoId;
		const file = this.app.vault.getFileByPath(filePath);
		if (!videoId || !Number.isFinite(seconds) || seconds < 0) throw new Error("The selected transcript timestamp is no longer available.");
		const time = this.timestampInsertionTime(filePath, videoId, seconds);
		if ("error" in time) {
			new Notice(time.error);
			return;
		}
		const target = this.createNoteInsertionTarget({ getFilePath: () => filePath });
		const playback = (file ? playerForNote(this.app, file)?.view : null) ?? this.existingBackgroundPlayback(filePath);
		const fallback = async (reason: string): Promise<void> => {
			if (this.settings.pausePlaybackOnMediaActions) playback?.pausePlayback();
			await copyInsertionFallback(this.insertionClipboardWindow(),
				timestampInsertionClipboardText(videoId, time.seconds, this.settings.timestampListStyle), "Timestamp", reason);
		};
		if ("unavailable" in target) {
			await fallback(target.unavailable);
			return;
		}
		const before = target.anchor.view.state.doc;
		try {
			let insertion: PlacedInsertion | null;
			try {
				insertion = insertPlaybackTimestamp(target, videoId, time.seconds,
					() => {
						if (this.settings.pausePlaybackOnMediaActions) playback?.pausePlayback();
					},
					this.settings.timestampListStyle);
			} catch (error) {
				console.error("Perplexity Saver: could not insert transcript timestamp", error);
				if (target.anchor.view.state.doc !== before) new Notice("The note changed while completing timestamp insertion. Check it before retrying; nothing was copied.");
				else await fallback("A safe insertion into the note could not be completed.");
				return;
			}
			if (insertion) {
				await this.focusNoteInsertionTarget(target);
				// A transcript-row insert stays quiet unless it landed somewhere other than the cursor.
				if (insertion.moved) new Notice(insertionMessage("Timestamp", insertion));
			} else await fallback("The note insertion point is no longer available.");
		} finally {
			releaseNoteInsertionAnchor(target.anchor);
		}
	}

	private async insertScreenshotIntoNote(view: VideoView, whole: boolean): Promise<void> {
		const target = this.createNoteInsertionTarget(view);
		try {
			await this.activatePartLeaf(view.leaf, null);
			if ("unavailable" in target) await view.insertScreenshotForNote(undefined, whole, target.unavailable);
			else await view.insertScreenshotForNote(target, whole);
		} catch (error) {
			if (!("unavailable" in target)) releaseNoteInsertionAnchor(target.anchor);
			console.error("Perplexity Saver: could not start screenshot insertion", error);
			new Notice("Could not start screenshot insertion.");
		}
	}

	private async focusNoteInsertionTarget(target: NoteInsertionTarget): Promise<void> {
		if (!target.isValid()) throw new Error("The note insertion target is no longer available.");
		await revealAndFocusLeaf(this.app, target.leaf, {
			raiseWindow: Platform.isDesktopApp ? raiseWindow : undefined,
			onFocus: () => {
				if (!target.isValid()) throw new Error("The note insertion target changed before focus.");
				target.anchor.view.focus();
				flashInsertedLine(target.anchor.view, {
					mode: this.settings.insertFlashMode,
					durationMs: this.settings.insertFlashDuration,
					sizeChars: this.settings.insertFlashSize,
					useThemeColors: this.settings.insertFlashUseThemeColors,
					lightColor: this.settings.insertFlashColorLight,
					darkColor: this.settings.insertFlashColorDark,
				});
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
	private async openViewerForNote(file: TFile, autoplay = false, associatedOnly = false, selectedVideoId?: string): Promise<WorkspaceLeaf | null> {
		const videoId = selectedVideoId ?? await noteVideoId(this.app, file);
		if (!videoId) {
			new Notice(`No YouTube link in ${file.basename}.`);
			return null;
		}
		const saved = this.settings.videoPlayback[file.path];
		const background = this.partLeaves(file).transcript?.view;
		const playback = background instanceof TranscriptView ? background.getBackgroundPlayback() : null;
		const sameVideo = playback?.getVideoId() === videoId;
		const seconds = sameVideo ? playback.getPlaybackSeconds() : 0;
		const resumeAt = !sameVideo && saved?.videoId === videoId && Number.isFinite(saved.seconds) && saved.seconds > 0
			? saved.seconds : undefined;
		const playing = sameVideo ? playback.isPlaying() : autoplay;
		const rate = sameVideo ? playback.getPlaybackRate() : null;
		this.stopBackgroundPlayback(file.path);
		const origin = mediaWindowFor(this.app, file);
		const target = playerForNote(this.app, file) ?? (associatedOnly ? null : primaryPlayer(this.app, origin));
		const previousPath = target?.view.getFilePath() ?? null;
		const leaf = await openVideoViewer(
			this.app,
			{ videoId, seconds, sourcePath: file.path, autoplay: playing, resumeAt, associatedOnly, preferLeaf: target?.leaf ?? null, preferWindow: origin },
			this.settings.videoViewerLocation
		);
		if (leaf.view) this.stopBackgroundPlaybackIn(getWindowForLeaf(leaf));
		if (!associatedOnly) await this.alignTranscripts(previousPath, file.path);
		if (rate !== null && leaf.view instanceof VideoView) leaf.view.setRate(rate);
		return leaf;
	}

	/**
	 * Show a note's transcript using its session placement or the saved default.
	 * The sidebar default maps to beside a pop-out viewer; explicit moves can use
	 * the main sidebar, below or beside without changing the saved default.
	 */
	async showTranscript(file: TFile, preferredViewer?: WorkspaceLeaf | null, location?: TranscriptPanelLocation, workspaceOnly = false, focus = true): Promise<void> {
		let viewer = preferredViewer ?? getVideoLeaf(this.app);
		if (!(viewer?.view instanceof VideoView) || viewer.view.getFilePath() !== file.path) viewer = this.partLeaves(file).video;
		let placement: TranscriptPlacement | null = null;
		const selected = location ?? this.transcriptLocations.get(file.path) ?? this.settings.transcriptPanelLocation;
		if (!location && !this.transcriptLocations.has(file.path) && selected === "sidebar" && viewer && this.viewerInPopout(viewer)) {
			placement = { nextTo: viewer, direction: "vertical" };
		} else if (selected !== "sidebar") {
			if (!viewer && !workspaceOnly && !(await loadTranscriptLines(this.app, file, this.settings.transcriptHeading))?.length) {
				void notifyNoTranscript(
					this.app,
					file,
					this.settings.transcriptHeading,
					() => this.createOrUpdateTranscriptFromYoutube(file)
				);
				return;
			}
			const nextTo = viewer ?? (workspaceOnly ? this.partLeaves(file).note : await this.openViewerForNote(file, false));
			if (!nextTo) return;
			placement = { nextTo, direction: selected === "viewer" ? "horizontal" : "vertical" };
		}
		const replaceLeaf = location ? this.partLeaves(file).transcript : null;
		const leaf = await showTranscriptPanel(
			this.app,
			file,
			this.settings.transcriptHeading,
			placement,
			replaceLeaf,
			workspaceOnly,
			() => this.createOrUpdateTranscriptFromYoutube(file)
		);
		if (leaf) {
			if (location) this.transcriptLocations.set(file.path, location);
			if (focus) await this.activatePartLeaf(leaf, viewer ?? placement?.nextTo ?? null);
		}
	}

	private viewerInPopout(viewer: WorkspaceLeaf): boolean {
		const win = getWindowForLeaf(viewer);
		return !!win && win !== getMainWindow(this.app);
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

	private transcriptLocation(file: TFile, viewer: WorkspaceLeaf | null): TranscriptPanelLocation {
		let current = this.transcriptLocations.get(file.path) ?? this.settings.transcriptPanelLocation;
		const panel = this.partLeaves(file).transcript;
		if (panel && isSidebarLeaf(this.app, panel)) current = "sidebar";
		else if (panel && viewer) {
			const direction = getGroupForLeaf(buildNavigationModel(this.app, viewer), panel)?.direction;
			if (direction === "below" || direction === "above") current = "viewer";
			else if (direction === "left" || direction === "right") current = "beside";
		}
		return current;
	}

	async toggleTranscriptOrientation(file: TFile, viewer: WorkspaceLeaf | null): Promise<void> {
		const current = this.transcriptLocation(file, viewer);
		await this.showTranscript(file, viewer, current === "viewer" ? "beside" : "viewer");
	}
}
