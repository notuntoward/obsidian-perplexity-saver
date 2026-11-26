/**
 * Local HTTP server that receives requests from the Zotero companion plugin.
 *
 * Binds to 127.0.0.1 (loopback only) — no external exposure, no auth token
 * required (identical pattern to Zotero's own Local API on port 23119).
 *
 * Supported endpoints:
 *   POST /lit-note   { action: "create", data: ZoteroItemPayload[] }
 *                    → creates lit note(s); if any already exist, prompts in
 *                      Obsidian (Overwrite / Open existing / Skip / Cancel)
 *   POST /lit-note   { action: "open", data: ZoteroItemPayload[] }
 *                    → opens lit note(s); if any are missing, prompts in
 *                      Obsidian (Create / Skip / Cancel)
 *                    Legacy form { action: "open", citekey } opens only.
 *
 * Decisions are always shown as an Obsidian modal, so the prompt is never
 * hidden behind Obsidian or another window and looks the same every time.
 */

import http from "http";
import path from "path";
import { realpath, stat } from "fs/promises";
import { randomUUID } from "crypto";
import { App, FileSystemAdapter, Notice, normalizePath, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import {
	focusLeafAndWindow,
	getActiveLeafInFocusedWindow,
	getMainWindow,
	getWindowForLeaf,
	isLeafAttached,
	openFileInLeaf,
} from "commons/workspace";
import { setTimeoutIn } from "commons/windows";
import { raiseWindow } from "commons/os";
import { askNoteDecision, withNoteDecisionSession, type AttachmentReviewRow, type CitekeyConflictDetails, type DecisionButton, type NoteDecision, type NoteDecisionSession } from "./decisionModal";
import { getLitNoteFiles } from "commons/litnote";
import { finishAttachmentMove, recordRecoveredAutomaticAttachments, syncLitNote, type SyncResult } from "./syncLitNote";
import { acknowledgedUncertainReviews, allReviews, beginInterruptedRecovery, beginReviewOperation, clearReviews, consumeUncertainAcknowledgement, currentInitialReviewScan, endInitialReviewScan, endReviewOperation, failReview, finishAttachmentCorrection, finishInterruptedRecovery, finishUncertainAttachmentRepair, finishLibraryCorrection, finishLibraryRecheck, finishNoteCorrection, isReviewBlocked, markReviewUncertain, pendingRescan, queueReview, removeReview, requestAutomaticAttachment, requestedReviews, resetReviewRequest, reviewKey, ReviewScanCompleteError, startInitialReviewScan } from "./pendingReviews";
import { clearItemTrashRequests, finishItemTrash, itemTrashRequests } from "./zoteroItemTrash";
import type { BulkProposal } from "./pendingReviews";
import { findIdenticalAttachments } from "./attachmentIdentity";
import type { IdenticalAttachment } from "./attachmentIdentity";
import { assertAttachmentsUnshared } from "./attachmentSharing";
import { verifyAttachmentCopy } from "./attachmentMove";
import { findTranscriptRange, headingsFromText, normalizeTranscriptHeading } from "commons/youtube";
import type {
	LitNoteItemResult,
	LitNoteItemStatus,
	LitNoteRequest,
	LitNoteResponse,
	ZoteroItemPayload,
} from "./types";

import type { NameStyle } from "./bibtexName";

export interface LitNoteServerSettings {
	litNotesFolder: string; // vault-relative path, e.g. "lit/lit_notes"
	validateAuthorNameFormat?: boolean;
	authorFormatStyle?: NameStyle;
	authorDropVon?: boolean;
	downloadYoutubeTranscripts?: boolean;
	/** Text of the heading the YouTube transcript is stored under. */
	transcriptHeading?: string;
	/** Called after note loading and final cursor/ephemeral state placement. */
	onNoteOpened?: (file: TFile) => void;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Serialize create/open handling so two requests can't race on the vault. */
let opChain: Promise<unknown> = Promise.resolve();

interface SyncPlan {
	mode: "auto" | "metadata";
	kind: "apply-sync" | "validate-zotero-key";
	input: string;
	snapshot: string;
	notePath?: string;
	identicalAttachments?: IdenticalAttachment[];
	decisions: Array<{ title: string; message: string; buttons: DecisionButton[]; review?: AttachmentReviewRow[]; conflict?: CitekeyConflictDetails; choice: NoteDecision }>;
	expires: number;
	reviewKey?: string;
	bulk?: boolean;
}

class ReviewNeeded extends Error {
	constructor(readonly reason: string, readonly notePath?: string, readonly proposal?: BulkProposal) {
		super(reason);
	}
}

const syncPlans = new Map<string, SyncPlan>();
const reportedAutoErrors = new Map<string, string>();

function missingLibraryNote(app: App, settings: LitNoteServerSettings, item: ZoteroItemPayload): TFile | undefined {
	if (!item.itemkey || !item.libraryURI) return undefined;
	const candidates = getLitNoteFiles(app, settings.litNotesFolder).filter((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		return !!fm && fm.zotero_item_key === item.itemkey && fm.zotero_library_uri === undefined;
	});
	return candidates.length === 1 ? candidates[0] : undefined;
}

let obsidianSession = "";

function queueReconciliation(app: App, settings: LitNoteServerSettings, item: ZoteroItemPayload, reason: string, notePath?: string, proposal?: BulkProposal, attachmentMove?: SyncResult["attachmentMove"]): void {
	queueReview(item, reason, notePath, missingLibraryNote(app, settings, item)?.path, proposal, attachmentMove);
}

function errorKey(item: ZoteroItemPayload): string {
	return JSON.stringify([item.libraryURI, item.itemkey]);
}

async function showReconciliationError(app: App, session: NoteDecisionSession, item: ZoteroItemPayload, entry: SyncResult, notePath?: string, mode?: SyncPlan["mode"]): Promise<void> {
	const key = errorKey(item);
	const fingerprint = JSON.stringify([entry.errorTitle, entry.dialogMessage, entry.error, entry.attachmentProblems, entry.identity, notePath]);
	if (mode === "auto" && item.itemkey && reportedAutoErrors.get(key) === fingerprint) return;
	const identity = entry.identity ?? (item?.itemkey && item.libraryURI ? {
		title: item.title || "(untitled)", itemkey: item.itemkey, libraryURI: item.libraryURI,
		zoteroCitekey: item.citekey || "(not set)", notePath,
	} : undefined);
	const message = entry.attachmentProblems?.length ? "" : entry.dialogMessage ?? entry.error ?? "An unknown reconciliation error occurred.";
	const changed = item.zoteroChanges ? "Your Zotero citation-key change is saved. Check both apps before retrying." : "";
	raiseAndFocus(app, app.workspace.getMostRecentLeaf());
	const decision = await session.ask(entry.errorTitle ?? "Literature note update failed", [message, changed].filter(Boolean).join("\n\n"),
		[{ label: "Close", value: "skip" }], undefined,
		identity ? { ...identity, compact: !identity.notePaths?.length, attachmentProblems: entry.attachmentProblems } : undefined);
	if (mode === "auto" && item.itemkey && decision === "skip") reportedAutoErrors.set(key, fingerprint);
}

function syncInput(item: ZoteroItemPayload, mode: SyncPlan["mode"]): string {
	const common = {
		title: item.title, citekey: item.citekey, itemkey: item.itemkey, libraryURI: item.libraryURI,
		attachments: item.attachments, citationKeyCheck: item.citationKeyCheck,
		linkedAttachmentBaseDirectory: item.linkedAttachmentBaseDirectory,
		libraryName: item.libraryName, zoteroChanges: item.zoteroChanges, automaticAttachments: item.automaticAttachments,
	};
	return JSON.stringify(mode === "auto" ? common : {
		...common, tags: item.tags, collections: item.collections,
		creators: item.creators, date: item.date, itemType: item.itemType, DOI: item.DOI,
		url: item.url, publicationTitle: item.publicationTitle, publisher: item.publisher, ISBN: item.ISBN,
	});
}

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = opChain.then(fn, fn);
	opChain = run.catch(() => undefined);
	return run;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function recoverInterruptedReview(
	app: App, settings: LitNoteServerSettings, item: ZoteroItemPayload,
	automaticAttachmentPaths?: Array<{ itemkey: string; sourcePath: string; destinationPath: string; archivePath?: string; archiveDirectory?: string }>,
): Promise<LitNoteItemResult> {
	return runSerialized(async () => {
		await ensureWorkspaceReady(app);
		const key = reviewKey(item);
		const revision = beginInterruptedRecovery(key);
		beginReviewOperation(key);
		try {
			const matches = getLitNoteFiles(app, settings.litNotesFolder).filter((file) => {
				const fm = app.metadataCache.getFileCache(file)?.frontmatter;
				return fm?.zotero_item_key === item.itemkey && fm?.zotero_library_uri === item.libraryURI;
			});
			if (matches.length !== 1) return { citekey: item.citekey, status: "error", error: "Could not uniquely identify the matching note for the interrupted update." };
			const note = matches[0];
			const before = await app.vault.read(note);
			let result: SyncResult;
			try {
				result = await syncLitNote(app, settings, item, "auto", async (title, message, buttons, _review, conflict, bulkSummary) => {
					throw new ReviewNeeded(title, conflict?.notePath, bulkSummary
						? { summary: bulkSummary, title, message, buttons, conflict } : undefined);
				}, { prepareOnly: true });
			} catch (error) {
				if (!(error instanceof ReviewNeeded)) throw error;
				if (await app.vault.read(note) !== before) throw new Error("The note changed while the interrupted update was checked.");
				queueReconciliation(app, settings, item, error.reason, error.notePath ?? note.path, error.proposal);
				finishInterruptedRecovery(key, revision, false);
				return { citekey: item.citekey, status: "pending-review" };
			}
			if (await app.vault.read(note) !== before) throw new Error("The note changed while the interrupted update was checked.");
			if (result.status === "missing") return { citekey: item.citekey, status: "error", error: "The matching note is missing." };
			if (result.status === "attachment-error") return { citekey: item.citekey, status: result.status, error: result.error };
			let snapshot = before;
			if (item.automaticAttachments && automaticAttachmentPaths &&
				(result.status === "skipped" || result.status === "prepared" || result.attachmentMove?.automatic)) {
				await recordRecoveredAutomaticAttachments(app, note, item, automaticAttachmentPaths);
				snapshot = await app.vault.read(note);
			}
			if (result.attachmentMove?.automatic && result.snapshot !== undefined) {
				queueReconciliation(app, settings, item, "Automatic attachment reconciliation", note.path, undefined, result.attachmentMove);
				finishInterruptedRecovery(key, revision, false);
				requestAutomaticAttachment(key, snapshot);
				return { citekey: item.citekey, status: "pending-review" };
			}
			const fm = app.metadataCache.getFileCache(note)?.frontmatter;
			if (item.automaticAttachments && result.status === "prepared" && fm?.citekey === item.citekey &&
				note.basename === item.citekey && !item.zoteroChanges) {
				const applied = await syncLitNote(app, settings, item, "auto", async () => {
					throw new Error("The note requires a decision before it can be updated.");
				}, { expectedContent: snapshot });
				if (applied.status !== "updated" && applied.status !== "skipped") {
					throw new Error(applied.error ?? "Could not finish the automatic attachment update.");
				}
				finishInterruptedRecovery(key, revision, true);
				return { citekey: item.citekey, status: "skipped" };
			}
			if (result.status === "skipped") {
				finishInterruptedRecovery(key, revision, true);
				return { citekey: item.citekey, status: "skipped" };
			}
			if (result.status !== "error" && result.status !== "prepared" && result.status !== "set-zotero-key") {
				throw new Error("The interrupted update could not be checked without changing the note.");
			}
			queueReconciliation(app, settings, item, result.errorTitle ?? "Note changes need confirmation", result.identity?.notePath ?? result.notePath ?? note.path, undefined, result.attachmentMove);
			finishInterruptedRecovery(key, revision, false);
			return { citekey: item.citekey, status: "pending-review" };
		} finally {
			endReviewOperation(key);
		}
	});
}

function citekeyOf(item: ZoteroItemPayload): string {
	return (item.citekey ?? "").trim();
}

import {
	litNotesFolderError,
	ensureWorkspaceReady,
	existingFile,
	writeNote,
} from "./writeLitNote";
import {
	validateItemAuthorFormats,
	openZoteroItem,
	type AuthorFormatIssue,
} from "./authorFormatValidator";
import {
	askAuthorFormatDecision,
	type AuthorFormatDecision,
} from "./authorFormatModal";


// ---------------------------------------------------------------------------
// Auto-correction helper
// ---------------------------------------------------------------------------

/**
 * Apply parser-suggested corrections to creator name fields in-place.
 *
 * Each issue's `suggestion` is in BibTeX "von Last, Jr, First" form, which is
 * stored directly in the single-field `name` property.  For two-field creators
 * we split on the first comma to restore firstName / lastName fields.
 */
function applyAuthorCorrections(
	items: ZoteroItemPayload[],
	issues: AuthorFormatIssue[]
): void {
	// Build a per-item map: itemCitekey → { creatorIndex → suggestion }
	const correctionMap = new Map<string, Map<number, string>>();
	for (const issue of issues) {
		if (!issue.suggestion) continue;
		if (!correctionMap.has(issue.citekey)) {
			correctionMap.set(issue.citekey, new Map());
		}
		correctionMap.get(issue.citekey)!.set(issue.creatorIndex, issue.suggestion);
	}

	for (const item of items) {
		const citekey = (item.citekey?.trim() || item.itemkey?.trim() || "untitled");
		const byIndex = correctionMap.get(citekey);
		if (!byIndex || !item.creators) continue;

		for (const [idx, suggestion] of byIndex) {
			const creator = item.creators[idx];
			if (!creator) continue;

			if (creator.name !== undefined) {
				// Single-field mode: store the bibtex form directly
				creator.name = suggestion;
			} else {
				// Two-field mode: split "von Last, Jr, First" → lastName + firstName
				const parts = suggestion.split(",").map((s) => s.trim());
				if (parts.length === 3) {
					creator.lastName = parts[0];
					creator.firstName = `${parts[2]} ${parts[1]}`;
				} else if (parts.length === 2) {
					creator.lastName = parts[0];
					creator.firstName = parts[1];
				} else if (parts.length === 1) {
					creator.lastName = parts[0];
					creator.firstName = "";
				}
			}
		}
	}
}

function noticeSummary(results: LitNoteItemResult[], prompted = false): void {
	if (prompted && !results.some((r) => r.status === "error")) {
		return;
	}
	const counts: Record<LitNoteItemStatus, number> = {
		created: 0,
		overwritten: 0,
		opened: 0,
		updated: 0,
		"set-zotero-key": 0,
		prepared: 0,
		"pending-review": 0,
		"attachment-error": 0,
		"waiting-index": 0,
		skipped: 0,
		missing: 0,
		error: 0,
	};
	for (const r of results) counts[r.status] += 1;

	if (results.length === 1) {
		const r = results[0];
		const name = r.citekey ? `@${r.citekey}` : "note";
		if (r.status === "opened") {
			new Notice(`Opened literature note from Zotero: ${name}`, 5000);
			return;
		}
		if (r.status === "created") {
			new Notice(`Created literature note from Zotero: ${name}`, 5000);
			return;
		}
		if (r.status === "overwritten") {
			new Notice(`Updated literature note from Zotero: ${name}`, 5000);
			return;
		}
		if (r.status === "updated") {
			new Notice(`Updated literature note from Zotero: ${name}`, 5000);
			return;
		}
		if (r.status === "missing") {
			new Notice(`Literature note not found in vault: ${name}`, 5000);
			return;
		}
		if (r.status === "skipped") {
			new Notice(`Skipped literature note from Zotero: ${name}`, 4000);
			return;
		}
		if (r.status === "error") {
			new Notice(`Error with Zotero note ${name}: ${r.error || "unknown error"}`, 6000);
			return;
		}
	}

	const parts: string[] = [];
	if (counts.created) parts.push(`${counts.created} created`);
	if (counts.overwritten) parts.push(`${counts.overwritten} overwritten`);
	if (counts.opened) parts.push(`${counts.opened} opened`);
	if (counts.updated) parts.push(`${counts.updated} updated`);
	if (counts.skipped) parts.push(`${counts.skipped} skipped`);
	if (counts.missing) parts.push(`${counts.missing} missing`);
	if (counts.error) parts.push(`${counts.error} failed`);

	if (counts.opened && !counts.created && !counts.overwritten && !counts.error && !counts.missing) {
		new Notice(`Opened ${counts.opened} literature notes from Zotero`, 5000);
	} else if (counts.created && !counts.opened && !counts.overwritten && !counts.error && !counts.missing) {
		new Notice(`Created ${counts.created} literature notes from Zotero`, 5000);
	} else if (parts.length) {
		new Notice(`Zotero literature notes: ${parts.join(", ")}`, 5000);
	}
}

// ---------------------------------------------------------------------------
// Handler: create lit notes
// ---------------------------------------------------------------------------

async function handleCreateBatch(
	app: App,
	settings: LitNoteServerSettings,
	items: ZoteroItemPayload[]
): Promise<LitNoteItemResult[]> {
	const initialWin =
		(typeof activeWindow !== "undefined" ? activeWindow : null) ??
		(typeof window !== "undefined" ? window : null);
	if (initialWin) {
		raiseWindow(initialWin, app);
	}
	await ensureWorkspaceReady(app);
	const folderError = litNotesFolderError(settings.litNotesFolder);
	if (folderError) {
		new Notice(folderError, 15000);
		return items.map((item) => ({ citekey: citekeyOf(item), status: "error", error: folderError }));
	}

	const entries = items.map((item) => ({ item, citekey: citekeyOf(item) }));
	const existingEntries = entries.filter(
		(e) => e.citekey && existingFile(app, settings, e.citekey)
	);

	let decision: NoteDecision = "overwrite";
	let prompted = false;
	if (existingEntries.length) {
		for (const e of existingEntries) {
			const file = existingFile(app, settings, e.citekey);
			if (file) {
				await openFile(app, file, null, { modifyText: false, transcriptHeading: settings.transcriptHeading, onNoteOpened: settings.onNoteOpened });
			}
		}

		const citekeys = existingEntries.map((e) => e.citekey).join("\n");
		const promptWin =
			getWindowForLeaf(app.workspace.getMostRecentLeaf()) ??
			(typeof activeWindow !== "undefined" ? activeWindow : null) ??
			window;
		raiseWindow(promptWin, app);
		prompted = true;
		decision = await askNoteDecision(
			app,
			existingEntries.length === 1
				? "Lit note already exists"
				: `${existingEntries.length} lit notes already exist`,
			`Already in the Obsidian vault:\n\n${citekeys}\n\nOverwrite with the Zotero data, open the existing note, or skip it?`,
			[
				{ label: "Overwrite", value: "overwrite", warning: true },
				{ label: "Open existing", value: "open-existing" },
				{ label: "Skip", value: "skip" },
				{ label: "Cancel", value: "cancel" },
			]
		);
	}

	const results: LitNoteItemResult[] = [];
	if (decision === "cancel") {
		return entries.map((e) => ({
			citekey: e.citekey,
			status: "skipped" as const,
		}));
	}

	const toWriteEntries = entries.filter((entry) => {
		if (!entry.citekey) return false;
		const existing = existingFile(app, settings, entry.citekey);
		if (existing) {
			return decision === "overwrite";
		}
		return true;
	});

	if (settings.validateAuthorNameFormat && toWriteEntries.length > 0) {
		const allIssues: AuthorFormatIssue[] = [];
		for (const e of toWriteEntries) {
			allIssues.push(...validateItemAuthorFormats(e.item));
		}

		if (allIssues.length > 0) {
			const promptWin =
				getWindowForLeaf(app.workspace.getMostRecentLeaf()) ??
				(typeof activeWindow !== "undefined" ? activeWindow : null) ??
				window;
			raiseWindow(promptWin, app);
			prompted = true;
			const formatDecision = await askAuthorFormatDecision(app, allIssues);

			if (formatDecision === "edit") {
				for (const e of toWriteEntries) {
					openZoteroItem(e.item);
				}
				const skippedResults = entries.map((e) => ({
					citekey: e.citekey,
					status: "skipped" as const,
				}));
				if (prompted) noticeSummary(skippedResults, true);
				return skippedResults;
			} else if (formatDecision === "cancel") {
				const skippedResults = entries.map((e) => ({
					citekey: e.citekey,
					status: "skipped" as const,
				}));
				if (prompted) noticeSummary(skippedResults, true);
				return skippedResults;
			} else if (formatDecision === "auto-correct") {
				applyAuthorCorrections(
					toWriteEntries.map((e) => e.item),
					allIssues
				);
			}
			// If "create-anyway", continue to writing notes!
		}
	}

	for (const entry of entries) {
		if (!entry.citekey) {
			results.push({
				citekey: "",
				status: "error",
				error: "Missing citation key. Enter one in Zotero or check Better BibTeX.",
			});
			continue;
		}

		const existing = existingFile(app, settings, entry.citekey);
		try {
			if (existing) {
				if (decision === "skip") {
					results.push({ citekey: entry.citekey, status: "skipped" });
					continue;
				}
				if (decision === "open-existing") {
					await openFile(app, existing, null, { transcriptHeading: settings.transcriptHeading, onNoteOpened: settings.onNoteOpened });
					results.push({ citekey: entry.citekey, status: "opened" });
					continue;
				}
				await writeNote(app, settings, entry.item, existing);
				await openFile(app, existing, null, { transcriptHeading: settings.transcriptHeading, onNoteOpened: settings.onNoteOpened });
				results.push({ citekey: entry.citekey, status: "overwritten" });
			} else {
				const created = await writeNote(app, settings, entry.item, null);
				await openFile(app, created, null, { transcriptHeading: settings.transcriptHeading, onNoteOpened: settings.onNoteOpened });
				results.push({ citekey: entry.citekey, status: "created" });
			}
		} catch (err: unknown) {
			results.push({
				citekey: entry.citekey,
				status: "error",
				error: errorMessage(err),
			});
		}
	}

	noticeSummary(results, prompted);
	return results;
}

// ---------------------------------------------------------------------------
// Handler: open / focus lit notes
// ---------------------------------------------------------------------------

interface CursorEditorLike {
	getValue?: () => string;
	lineCount?: () => number;
	getLine?: (line: number) => string;
	setCursor?: (position: { line: number; ch: number }) => void;
	scrollIntoView?: (
		range: { from: { line: number; ch: number }; to: { line: number; ch: number } },
		center?: boolean
	) => void;
	replaceRange?: (
		replacement: string,
		position: { line: number; ch: number }
	) => void;
	focus?: () => void;
}

function isCursorEditor(value: unknown): value is CursorEditorLike {
	return typeof value === "object" && value !== null;
}

function editorFromLeaf(leaf: WorkspaceLeaf): CursorEditorLike | null {
	const view: unknown = leaf.view;
	if (!view || typeof view !== "object" || !("editor" in view)) return null;
	return isCursorEditor(view.editor) ? view.editor : null;
}

export function positionCursorTwoLinesPastEnd(
	editor: CursorEditorLike | null | undefined,
	modifyText = true,
	transcriptHeading?: string
): number {
	if (!editor) return 0;
	if (typeof editor.getValue !== "function") {
		if (typeof editor.setCursor === "function") {
			editor.setCursor({ line: 99999, ch: 0 });
		}
		return 99999;
	}

	// If the note has a transcript heading (e.g. from YouTube transcript download),
	// place the cursor on the blank line directly above it.
	const headingLine = `# ${normalizeTranscriptHeading(transcriptHeading)}`;
	const totalLines = typeof editor.lineCount === "function" ? editor.lineCount() : 0;
	let transcriptLineIdx = -1;
	for (let i = 0; i < totalLines; i++) {
		const line = typeof editor.getLine === "function" ? editor.getLine(i) : "";
		if (line.startsWith(headingLine)) {
			transcriptLineIdx = i;
			break;
		}
	}

	// The heading may carry a name that is no longer configured; look for the transcript the way the panel does.
	if (transcriptLineIdx < 0) {
		const content = editor.getValue();
		const headings = headingsFromText(content);
		const range = findTranscriptRange(content, headings, transcriptHeading ?? "");
		const found = range && headings.find((h) => h.position.end.offset === range.start);
		if (found) transcriptLineIdx = found.position.start.line;
	}

	if (transcriptLineIdx > 0) {
		const targetLine = transcriptLineIdx - 1;
		if (typeof editor.setCursor === "function") {
			editor.setCursor({ line: targetLine, ch: 0 });
		}
		if (typeof editor.scrollIntoView === "function") {
			editor.scrollIntoView(
				{ from: { line: targetLine, ch: 0 }, to: { line: targetLine, ch: 0 } },
				true
			);
		}
		return targetLine;
	}

	const text = editor.getValue();
	if (modifyText && !text.endsWith("\n\n")) {
		const needed = text.endsWith("\n") ? "\n" : "\n\n";
		const lastLine = typeof editor.lineCount === "function" ? editor.lineCount() - 1 : 0;
		const lastLineLen = typeof editor.getLine === "function" ? editor.getLine(lastLine).length : 0;
		if (typeof editor.replaceRange === "function") {
			editor.replaceRange(needed, { line: lastLine, ch: lastLineLen });
		}
	}
	const targetLine = typeof editor.lineCount === "function" ? editor.lineCount() - 1 : 0;
	if (typeof editor.setCursor === "function") {
		editor.setCursor({ line: targetLine, ch: 0 });
	}
	return targetLine;
}

/**
 * Activates a leaf and raises its owning window to the foreground.
 * Uses commons focusLeafAndWindow with raiseWindow from commons/os so that
 * the Windows foreground lock is bypassed (same as next-tab-group).
 */
export function raiseAndFocus(app: App, leaf: WorkspaceLeaf | null | undefined): void {
	if (!leaf) return;
	focusLeafAndWindow(app, leaf, {
		raiseWindow: (win) => raiseWindow(win, app),
	});
	const win = getWindowForLeaf(leaf) ?? (typeof activeWindow !== "undefined" ? activeWindow : null);
	if (win) {
		raiseWindow(win, app);
	}
}


async function openFile(
	app: App,
	file: TFile,
	preferredLeaf?: WorkspaceLeaf | null,
	options?: { modifyText?: boolean; transcriptHeading?: string; onNoteOpened?: (file: TFile) => void }
): Promise<void> {
	await openFileInLeaf(app, file, {
		preferredLeaf,
		raiseWindow: (win) => raiseWindow(win, app),
		eState: {
			cursor: { from: { line: 99999, ch: 0 }, to: { line: 99999, ch: 0 } },
			line: 99999,
		},
		onReady: (leaf, editor) => {
			if (editor) {
				editor.focus?.();
				const targetLine = positionCursorTwoLinesPastEnd(
					editor,
					options?.modifyText ?? true,
					options?.transcriptHeading
				);
				if (typeof leaf.setEphemeralState === "function") {
					leaf.setEphemeralState({
						cursor: {
							from: { line: targetLine, ch: 0 },
							to: { line: targetLine, ch: 0 },
						},
						line: targetLine,
					});
				}
			}
		},
	});
	options?.onNoteOpened?.(file);
}

async function restorePreviousLeaf(
	app: App,
	leaf: WorkspaceLeaf | null
): Promise<void> {
	if (!leaf) return;
	try {
		const leafWin = getWindowForLeaf(leaf) ??
			getMainWindow(app) ??
			(typeof activeWindow !== "undefined" ? activeWindow : null);
		if (leafWin) await new Promise<void>((resolve) => setTimeoutIn(leafWin, resolve, 10));

		const attached = isLeafAttached(leaf);
		let target: WorkspaceLeaf | null = attached ? leaf : null;
		if (!target && typeof app.workspace.getMostRecentLeaf === "function") {
			target = app.workspace.getMostRecentLeaf();
		}
		if (target) {
			if (typeof app.workspace.revealLeaf === "function") {
				await app.workspace.revealLeaf(target);
			}
			raiseAndFocus(app, target);
			const editor = editorFromLeaf(target);
			editor?.focus?.();
		}
	} catch (err) {
		console.warn("[LitNoteServer] Failed to restore previous leaf:", err);
	}
}

interface OpenEntry {
	citekey: string;
	item?: ZoteroItemPayload;
}

async function handleOpenBatch(
	app: App,
	settings: LitNoteServerSettings,
	entries: OpenEntry[]
): Promise<LitNoteItemResult[]> {
	const initialWin =
		(typeof activeWindow !== "undefined" ? activeWindow : null) ??
		null;
	if (initialWin) {
		raiseWindow(initialWin, app);
	}
	await ensureWorkspaceReady(app);
	const folderError = litNotesFolderError(settings.litNotesFolder);
	if (folderError) {
		new Notice(folderError, 15000);
		return entries.map((entry) => ({ citekey: entry.citekey, status: "error", error: folderError }));
	}
	const results: LitNoteItemResult[] = [];
	const found: OpenEntry[] = [];
	const missing: OpenEntry[] = [];
	let prompted = false;

	for (const entry of entries) {
		if (!entry.citekey) {
			results.push({
				citekey: "",
				status: "error",
				error: "Missing citation key. Enter one in Zotero or check Better BibTeX.",
			});
			continue;
		}
		if (existingFile(app, settings, entry.citekey)) {
			found.push(entry);
		} else {
			missing.push(entry);
		}
	}

	for (const entry of found) {
		const file = existingFile(app, settings, entry.citekey);
		if (!file) {
			missing.push(entry);
			continue;
		}
		try {
			await openFile(app, file, null, { transcriptHeading: settings.transcriptHeading, onNoteOpened: settings.onNoteOpened });
			results.push({ citekey: entry.citekey, status: "opened" });
		} catch (err: unknown) {
			results.push({
				citekey: entry.citekey,
				status: "error",
				error: errorMessage(err),
			});
		}
	}

	if (missing.length) {
		const creatable = missing.filter((e) => e.item);
		let decision: NoteDecision = "skip";
		if (creatable.length) {
			const previousLeaf: WorkspaceLeaf | null =
				(typeof app.workspace.getMostRecentLeaf === "function"
					? app.workspace.getMostRecentLeaf()
					: null) ??
				getActiveLeafInFocusedWindow(app) ??
				null;
			let blankLeaf: WorkspaceLeaf | null = null;
			let blankLeafConsumed = false;
			if (typeof app.workspace.getLeaf === "function") {
				blankLeaf = app.workspace.getLeaf("tab");
				if (typeof app.workspace.revealLeaf === "function") {
					await app.workspace.revealLeaf(blankLeaf);
				}
				raiseAndFocus(app, blankLeaf);
			}

			const citekeys = missing.map((e) => e.citekey).join("\n");
			raiseAndFocus(app, blankLeaf);
			prompted = true;
			try {
				decision = await askNoteDecision(
					app,
					creatable.length === 1
						? "Lit note not found"
						: `${creatable.length} lit notes not found`,
					`Not in the Obsidian vault:\n\n${citekeys}\n\nCreate ${creatable.length === 1 ? "it" : "them"} from the Zotero data?`,
					[
						{ label: "Create", value: "create", cta: true },
						{ label: "Skip", value: "skip" },
						{ label: "Cancel", value: "cancel" },
					]
				);
			} catch (err) {
				if (blankLeaf && typeof blankLeaf.detach === "function") {
					try {
						blankLeaf.detach();
					} catch {
						// Ignore
					}
					await restorePreviousLeaf(app, previousLeaf);
				}
				throw err;
			}

			if (decision === "create") {
				if (settings.validateAuthorNameFormat) {
					const allIssues: AuthorFormatIssue[] = [];
					for (const e of creatable) {
						if (e.item) {
							allIssues.push(...validateItemAuthorFormats(e.item));
						}
					}

					if (allIssues.length > 0) {
						const promptWin =
							getWindowForLeaf(app.workspace.getMostRecentLeaf()) ??
							(typeof activeWindow !== "undefined" ? activeWindow : null) ??
							window;
						raiseWindow(promptWin, app);
						let formatDecision: AuthorFormatDecision = "cancel";
						try {
							formatDecision = await askAuthorFormatDecision(app, allIssues);
						} catch (err) {
							if (blankLeaf && typeof blankLeaf.detach === "function") {
								try {
									blankLeaf.detach();
								} catch {
									// Ignore
								}
								await restorePreviousLeaf(app, previousLeaf);
							}
							throw err;
						}

						if (formatDecision === "edit") {
							for (const e of creatable) {
								if (e.item) openZoteroItem(e.item);
							}
							if (blankLeaf && typeof blankLeaf.detach === "function") {
								try {
									blankLeaf.detach();
								} catch {
									// Ignore
								}
								await restorePreviousLeaf(app, previousLeaf);
							}
							for (const e of missing) {
								results.push({ citekey: e.citekey, status: "skipped" });
							}
							if (prompted) noticeSummary(results, true);
							return results;
						} else if (formatDecision === "cancel") {
							if (blankLeaf && typeof blankLeaf.detach === "function") {
								try {
									blankLeaf.detach();
								} catch {
									// Ignore
								}
								await restorePreviousLeaf(app, previousLeaf);
							}
							for (const e of missing) {
								results.push({ citekey: e.citekey, status: "skipped" });
							}
							if (prompted) noticeSummary(results, true);
							return results;
						} else if (formatDecision === "auto-correct") {
							applyAuthorCorrections(
								creatable.map((e) => e.item!).filter(Boolean),
								allIssues
							);
						}
						// If "create-anyway", proceed with note creation!
					}
				}

				for (let i = 0; i < creatable.length; i++) {
					const entry = creatable[i];
					try {
						const file = await writeNote(app, settings, entry.item!, null);
						if (i === 0 && blankLeaf) {
							blankLeafConsumed = true;
							await openFile(app, file, blankLeaf, { transcriptHeading: settings.transcriptHeading, onNoteOpened: settings.onNoteOpened });
						} else {
							await openFile(app, file, null, { transcriptHeading: settings.transcriptHeading, onNoteOpened: settings.onNoteOpened });
						}
						results.push({ citekey: entry.citekey, status: "created" });
					} catch (err: unknown) {
						results.push({
							citekey: entry.citekey,
							status: "error",
							error: errorMessage(err),
						});
					}
				}
				if (blankLeaf && !blankLeafConsumed && typeof blankLeaf.detach === "function") {
					try {
						blankLeaf.detach();
					} catch {
						// Ignore
					}
					await restorePreviousLeaf(app, previousLeaf);
				}
			} else {
				if (blankLeaf && typeof blankLeaf.detach === "function") {
					try {
						blankLeaf.detach();
					} catch (err: unknown) {
						console.warn("[LitNoteServer] Failed to detach blank leaf:", err);
					}
					await restorePreviousLeaf(app, previousLeaf);
				}
				for (const entry of missing) {
					results.push({ citekey: entry.citekey, status: "missing" });
				}
			}
		} else {
			for (const entry of missing) {
				results.push({ citekey: entry.citekey, status: "missing" });
			}
		}
	}

	noticeSummary(results, prompted);
	return results;
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: LitNoteResponse): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
}

function resultsResponse(results: LitNoteItemResult[]): LitNoteResponse {
	return {
		success: !results.some((r) => r.status === "error" || r.status === "attachment-error"),
		results,
	};
}

async function handleRequest(
	app: App,
	settings: LitNoteServerSettings,
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	if (req.method === "GET" && (req.url === "/lit-note-identities" || req.url === "/lit-notes")) {
		const folderError = litNotesFolderError(settings.litNotesFolder);
		if (folderError) {
			sendJson(res, 200, { success: false, error: folderError });
			return;
		}
	}
	if (req.method === "GET" && req.url === "/lit-note-identities") {
		await ensureWorkspaceReady(app);
		const identities = getLitNoteFiles(app, settings.litNotesFolder).flatMap((file) => {
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (typeof fm?.zotero_item_key !== "string") return [];
			return [{
				itemkey: fm.zotero_item_key,
				notePath: file.path,
				libraryURI: typeof fm.zotero_library_uri === "string" ? fm.zotero_library_uri : undefined,
				citekey: typeof fm.citekey === "string" ? fm.citekey : file.basename,
				modifiedAt: file.stat?.mtime,
				size: file.stat?.size,
			}];
		});
		sendJson(res, 200, { success: true, identities });
		return;
	}
	if (req.method === "GET" && (req.url === "/lit-note-review-requests" || req.url === "/lit-note-review-requests?bulk=1")) {
		const identity = ({ itemkey, libraryURI }: { itemkey: string; libraryURI: string }) => ({ itemkey, libraryURI });
		const supportsBulk = req.url.endsWith("?bulk=1");
		sendJson(res, 200, {
			success: true,
			requests: requestedReviews().filter((entry) => (!entry.uncertain || entry.operation === "attachment-repair") && (supportsBulk || !entry.operation))
				.map((entry) => ({
					...identity(entry),
					...(entry.operation ? { operation: entry.operation } : {}),
					...(entry.operation === "attachment-repair" ? { repairId: entry.repairId } : {}),
					...(entry.automaticAttachment ? { automaticAttachment: true } : {}),
					...(entry.operation === "attachment-move" ? {
						attachmentMove: entry.attachmentMove,
						strategy: entry.attachmentStrategy,
					} : {}),
				})),
			pending: allReviews().map((entry) => ({ ...identity(entry), ...(entry.uncertain ? { uncertain: true } : {}) })),
			acknowledgedUncertain: acknowledgedUncertainReviews(),
			...(supportsBulk ? { obsidianSession } : {}),
			...(supportsBulk && pendingRescan() ? { rescan: pendingRescan() } : {}),
			...(supportsBulk && itemTrashRequests().length ? { itemTrash: itemTrashRequests() } : {}),
		});
		return;
	}
	if (req.method === "GET" && req.url === "/lit-notes") {
		const folderPath = normalizePath(settings.litNotesFolder);
		const folder = app.vault.getAbstractFileByPath(folderPath);
		const citekeys: string[] = [];
		if (folder) {
			const files = app.vault.getFiles();
			for (const f of files) {
				if (f.path.startsWith(folderPath + "/") && f.extension === "md") {
					citekeys.push(f.basename);
				}
			}
		}
		sendJson(res, 200, { success: true, citekeys });
		return;
	}

	// Only accept POST /lit-note
	if (req.method !== "POST" || req.url !== "/lit-note") {
		sendJson(res, 404, { success: false, error: "Not found" });
		return;
	}

	// Read body
	const chunks: Buffer[] = [];
	for await (const rawChunk of req) {
		const chunk = rawChunk as unknown;
		if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
			sendJson(res, 400, { success: false, error: "Invalid request body" });
			return;
		}
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		// approximate length check
		if (chunks.length > 50000) {
			// 5 MB safety cap
			sendJson(res, 413, { success: false, error: "Payload too large" });
			return;
		}
	}
	const rawBody = Buffer.concat(chunks).toString("utf8");

	let parsed: LitNoteRequest;
	try {
		parsed = JSON.parse(rawBody) as LitNoteRequest;
	} catch {
		sendJson(res, 400, { success: false, error: "Invalid JSON" });
		return;
	}
	let activeReviews: string[] = [];
	if (parsed.action === "apply-sync" || parsed.action === "validate-zotero-key" ||
		parsed.action === "sync" || parsed.action === "update" ||
		parsed.action === "review-sync" || parsed.action === "bulk-review-sync" ||
		parsed.action === "review-recheck" || parsed.action === "bulk-library-uri" ||
		parsed.action === "attachment-move-complete" || parsed.action === "attachment-auto-prepare" || parsed.action === "attachment-repair-prepare" ||
		parsed.action === "attachment-repair-complete") {
		activeReviews = Array.isArray(parsed.data) ? [...new Set(parsed.data
			.filter((item) => item?.itemkey && item.libraryURI)
			.map((item) => reviewKey(item)))] : [];
	}
	for (const key of activeReviews) beginReviewOperation(key);
	try {
		if (parsed.action === "initial-review-scan-start") {
			if (typeof parsed.scanId !== "string" || !parsed.scanId.trim() || parsed.scanId.length > 256) {
				sendJson(res, 400, { success: false, error: "scanId must be a non-empty string of at most 256 characters." });
				return;
			}
			try {
				const scan = startInitialReviewScan(parsed.scanId);
				sendJson(res, 200, { success: true, initialReviewScan: scan });
			} catch (error) {
				sendJson(res, 200, { success: false, initialReviewScan: currentInitialReviewScan(), error: errorMessage(error) });
			}
		} else if (parsed.action === "initial-review-scan-end") {
			if (typeof parsed.scanId !== "string" || !parsed.scanId.trim() || parsed.scanId.length > 256 ||
				(parsed.status !== "complete" && parsed.status !== "error") ||
				(parsed.error !== undefined && typeof parsed.error !== "string")) {
				sendJson(res, 400, { success: false, error: "Invalid initial review scan result." });
				return;
			}
			try {
				const scan = endInitialReviewScan(parsed.scanId, parsed.status, parsed.error);
				sendJson(res, 200, { success: true, initialReviewScan: scan });
			} catch (error) {
				sendJson(res, 200, { success: false, initialReviewScan: currentInitialReviewScan(), error: errorMessage(error) });
			}
		} else if (parsed.action === "review-recover") {
			const item = Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : undefined;
			if (!item || typeof item.itemkey !== "string" || !item.itemkey ||
				typeof item.libraryURI !== "string" || !item.libraryURI ||
				typeof item.title !== "string" || typeof item.citekey !== "string" || !Array.isArray(item.attachments) ||
				(parsed.automaticAttachmentPaths !== undefined && (!Array.isArray(parsed.automaticAttachmentPaths) ||
					parsed.automaticAttachmentPaths.some((entry) => !entry || typeof entry.itemkey !== "string" ||
						typeof entry.sourcePath !== "string" || typeof entry.destinationPath !== "string" ||
						(entry.archivePath !== undefined && typeof entry.archivePath !== "string") ||
						(entry.archiveDirectory !== undefined && typeof entry.archiveDirectory !== "string"))))) {
				sendJson(res, 400, { success: false, error: "Invalid interrupted review snapshot." });
				return;
			}
			try {
				sendJson(res, 200, resultsResponse([await recoverInterruptedReview(app, settings, item, parsed.automaticAttachmentPaths)]));
			} catch (error) {
				console.error("Could not recheck an interrupted Zotero review", error);
				sendJson(res, 200, resultsResponse([{ citekey: item.citekey, status: "error", error: errorMessage(error) }]));
			}
		} else if (parsed.action === "review-uncertain" || parsed.action === "review-uncertain-acknowledged") {
			if (typeof parsed.itemkey !== "string" || !parsed.itemkey || typeof parsed.libraryURI !== "string" || !parsed.libraryURI ||
				(parsed.error !== undefined && typeof parsed.error !== "string") ||
				(parsed.operation !== undefined && typeof parsed.operation !== "string") ||
				(parsed.title !== undefined && typeof parsed.title !== "string") ||
				(parsed.attachmentCheckError !== undefined && typeof parsed.attachmentCheckError !== "string") ||
				(parsed.attachments !== undefined && (!Array.isArray(parsed.attachments) || parsed.attachments.some((attachment) =>
					!attachment || typeof attachment !== "object" || typeof attachment.itemkey !== "string" ||
					(attachment.path !== undefined && typeof attachment.path !== "string") ||
					(attachment.title !== undefined && typeof attachment.title !== "string") ||
					(attachment.mode !== undefined && attachment.mode !== "linked" && attachment.mode !== "stored")))) ||
				(parsed.attachmentPaths !== undefined && (!Array.isArray(parsed.attachmentPaths) || parsed.attachmentPaths.some((attachment) =>
					!attachment || typeof attachment !== "object" || typeof attachment.itemkey !== "string" ||
					typeof attachment.sourcePath !== "string" || typeof attachment.destinationPath !== "string")))) {
				sendJson(res, 400, { success: false, error: "Invalid interrupted review identity" });
				return;
			}
			if (parsed.action === "review-uncertain") {
				markReviewUncertain(parsed);
				const entry = allReviews().find((review) => review.key === reviewKey(parsed));
				if (entry && (!entry.notePath || entry.title === entry.itemkey)) {
					try {
						const folderError = litNotesFolderError(settings.litNotesFolder);
						if (folderError) throw new Error(folderError);
						await ensureWorkspaceReady(app);
						const matches = getLitNoteFiles(app, settings.litNotesFolder).filter((file) => {
							const fm = app.metadataCache.getFileCache(file)?.frontmatter;
							return fm?.zotero_item_key === parsed.itemkey && fm?.zotero_library_uri === parsed.libraryURI;
						});
						if (matches.length === 1) {
							const file = matches[0];
							const title: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.title;
							markReviewUncertain({
								...parsed,
								title: typeof title === "string" && title.trim() ? title.trim() : file.basename,
								notePath: file.path,
							});
						}
					} catch (error) {
						console.error("Could not find the note for a Zotero review", error);
					}
				}
			} else consumeUncertainAcknowledgement(parsed);
			sendJson(res, 200, { success: true });
		} else if (parsed.action === "item-trash-complete") {
			if (typeof parsed.id !== "string" || !parsed.id || (parsed.error !== undefined && typeof parsed.error !== "string")) {
				sendJson(res, 400, { success: false, error: "Invalid Zotero trash result" });
				return;
			}
			finishItemTrash(parsed.id, parsed.error);
			sendJson(res, 200, { success: true });
		} else if (parsed.action === "review-failed") {
			if (typeof parsed.itemkey !== "string" || typeof parsed.libraryURI !== "string" || typeof parsed.error !== "string") {
				sendJson(res, 400, { success: false, error: "Invalid review failure" });
				return;
			}
			const repairFailed = requestedReviews().some((review) =>
				review.key === reviewKey(parsed) && review.operation === "attachment-repair");
			const automaticFailed = requestedReviews().some((review) =>
				review.key === reviewKey(parsed) && review.automaticAttachment);
			failReview(parsed, parsed.error);
			if (repairFailed) new Notice(`Could not repair attachment links: ${parsed.error}`, 0);
			if (automaticFailed) console.error("Automatic Zotero attachment reconciliation failed", parsed.error);
			sendJson(res, 200, { success: true });
		} else if (parsed.action === "attachment-auto-prepare") {
			const item = Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : undefined;
			const entry = item && requestedReviews().find((review) => review.key === reviewKey(item) &&
				review.automaticAttachment && review.operation === "attachment-move");
			if (!item || !entry?.attachmentMove || entry.repairSnapshot === undefined) {
				sendJson(res, 400, { success: false, error: "No automatic attachment reconciliation is pending." });
				return;
			}
			try {
				await runSerialized(async () => {
					await ensureWorkspaceReady(app);
					const current = await syncLitNote(app, settings, item, "auto", async () => "cancel", { prepareOnly: true });
					if (current.snapshot !== entry.repairSnapshot || JSON.stringify(current.attachmentMove) !== JSON.stringify(entry.attachmentMove)) {
						throw new Error("The note or attachments changed before automatic reconciliation.");
					}
				});
				sendJson(res, 200, { success: true });
			} catch (error) {
				sendJson(res, 200, { success: false, error: errorMessage(error) });
			}
		} else if (parsed.action === "attachment-repair-prepare") {
			const item = Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : undefined;
			const entry = item && requestedReviews().find((review) => review.key === reviewKey(item) &&
				review.uncertain && review.operation === "attachment-repair" && review.repairId === parsed.repairId);
			if (!item || !entry || !entry.notePath || entry.attachmentMove) {
				sendJson(res, 400, { success: false, error: "No matching attachment repair is pending." });
				return;
			}
			try {
				const candidate = await runSerialized(async () => {
					await ensureWorkspaceReady(app);
					const note = app.vault.getAbstractFileByPath(entry.notePath!);
					if (!(note instanceof TFile)) throw new Error("The matching Obsidian note is unavailable.");
					const fm = app.metadataCache.getFileCache(note)?.frontmatter;
					if (!fm || fm.zotero_item_key !== item.itemkey || fm.zotero_library_uri !== item.libraryURI || fm.citekey !== item.citekey) {
						throw new Error("The note's Zotero identity or citation key changed.");
					}
					const snapshot = await app.vault.read(note);
					const plan = await syncLitNote(app, settings, item, "auto", async () => "cancel", { prepareOnly: true });
					if (!plan.attachmentMove) {
						throw new Error(plan.error || "The current attachments cannot be safely repaired automatically.");
					}
					if (await app.vault.read(note) !== snapshot) throw new Error("The note changed while preparing the repair.");
					const candidate = plan.attachmentMove;
					if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new Error("The vault path is unavailable.");
					const vaultRoot = app.vault.adapter.getBasePath();
					candidate.attachments = candidate.attachments.filter((attachment) => {
						if (attachment.resolution !== "trash") return true;
						const relative = path.relative(vaultRoot, attachment.sourcePath);
						return !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
					});
					const used = new Set(candidate.attachments.filter((attachment) => attachment.resolution !== "trash")
						.map((attachment) => path.resolve(attachment.destinationPath).toLowerCase()));
					for (const attachment of candidate.attachments) {
						const duplicate = attachment.resolution === "trash";
						if (!duplicate && (attachment.destinationMtime === undefined || attachment.identical)) continue;
						const ext = path.extname(attachment.destinationPath);
						const basename = path.basename(attachment.destinationPath);
						const stem = path.join(candidate.baseDirectory, ext ? basename.slice(0, -ext.length) : basename);
						if (attachment.resolution === "newest" && (await stat(attachment.destinationPath)).size > 0) {
							candidate.linkNoteFiles.push(attachment.destinationPath);
							if (app.vault.adapter instanceof FileSystemAdapter) {
								const notePath = path.relative(app.vault.adapter.getBasePath(), attachment.destinationPath).split(path.sep).join("/");
								candidate.extras.push({ path: notePath, origin: "note" });
							}
						}
						let index = 2;
						let destination: string;
						for (;;) {
							destination = `${stem} ${index++}${ext}`;
							if (used.has(path.resolve(destination).toLowerCase())) continue;
							try { await stat(destination); }
							catch (error) {
								if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
								throw error;
							}
						}
						used.add(path.resolve(destination).toLowerCase());
						if (!duplicate) {
							const oldPath = path.relative(vaultRoot, attachment.destinationPath).split(path.sep).join("/");
							const newPath = path.relative(vaultRoot, destination).split(path.sep).join("/");
							for (const extra of candidate.extras) {
								if (extra.origin === "zotero" && extra.path === oldPath) extra.path = newPath;
							}
						}
						attachment.destinationPath = destination;
						attachment.destinationMtime = undefined;
						attachment.resolution = "move";
						attachment.conflict = false;
						attachment.identical = false;
					}
					candidate.trashNoteFiles = [];
					candidate.trashNoteSnapshots = [];
					entry.attachmentMove = candidate;
					entry.repairSnapshot = snapshot;
					return candidate;
				});
				sendJson(res, 200, { success: true, attachmentMove: candidate });
			} catch (error) {
				sendJson(res, 200, { success: false, error: errorMessage(error) });
			}
		} else if (parsed.action === "attachment-move-complete" || parsed.action === "attachment-repair-complete") {
			const item = Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : undefined;
			const repair = parsed.action === "attachment-repair-complete";
			const entry = item && requestedReviews().find((review) =>
				review.key === reviewKey(item) && review.operation === (repair ? "attachment-repair" : "attachment-move") &&
				(!repair || review.uncertain && review.repairId === parsed.repairId && review.repairSnapshot !== undefined));
			const candidate = entry?.attachmentMove;
			const moved = parsed.moved;
			const linked = parsed.linked ?? [];
			if (!item || !entry || !candidate || !Array.isArray(moved) || !Array.isArray(linked) ||
				item.linkedAttachmentBaseDirectoryValidated !== true ||
				item.linkedAttachmentBaseDirectory !== candidate.baseDirectory ||
				item.libraryType !== "user" ||
				moved.length !== candidate.attachments.length) {
				sendJson(res, 400, { success: false, error: "No matching attachment move is pending, or Zotero's base directory changed." });
				return;
			}
			const samePath = (first?: string, second?: string): boolean =>
				!!first && !!second && path.resolve(first).toLocaleLowerCase() === path.resolve(second).toLocaleLowerCase();
			const linkedAt = (key: string | undefined, filePath: string): boolean => !!key && !!item.attachments?.some((current) =>
				current.itemkey === key && current.mode === "linked" && samePath(current.path, filePath));
			const allowedDestination = (attachment: typeof candidate.attachments[number], result: typeof moved[number]): boolean => {
				if (samePath(result.to, attachment.destinationPath)) return true;
				if (repair || !result.referenceCheckFailed || !result.copied ||
					(attachment.resolution !== "move" && attachment.resolution !== "newest") ||
					typeof result.to !== "string" || !samePath(path.dirname(result.to), candidate.baseDirectory)) return false;
				const original = path.parse(attachment.destinationPath);
				const actual = path.parse(result.to);
				const prefix = `${original.name} `;
				const suffix = actual.name.startsWith(prefix) ? actual.name.slice(prefix.length) : "";
				return actual.ext.toLowerCase() === original.ext.toLowerCase() && /^[0-9]+$/.test(suffix) && Number(suffix) >= 2;
			};
			const fallbackNoteFiles = candidate.attachments.flatMap((attachment) => {
				const result = moved.find((move) => move.itemkey === attachment.itemkey);
				return attachment.resolution === "newest" && result && !samePath(result.to, attachment.destinationPath) &&
					allowedDestination(attachment, result) ? [attachment.destinationPath] : [];
			});
			const expectedNoteFiles = [...candidate.linkNoteFiles, ...fallbackNoteFiles];
			const verified = candidate.attachments.every((attachment) => {
				const result = moved.find((move) => move.itemkey === attachment.itemkey);
				if (!result || !samePath(result.from, attachment.sourcePath)) return false;
				if (attachment.sourceMissing) {
					return candidate.automatic === true && !repair && attachment.resolution === "keep-note" &&
						result.sourceMissing === true && !result.preservedSource && !result.copied && !result.trashed &&
						!result.referenceCheckFailed && !result.archivePath &&
						(result.archiveDirectory === undefined || attachment.mode === "stored" &&
							typeof result.archiveDirectory === "string" && path.isAbsolute(result.archiveDirectory) &&
							!samePath(result.archiveDirectory, path.dirname(result.from)) &&
							!samePath(result.archiveDirectory, result.to)) &&
						(attachment.mode === "stored"
							? result.oldKey === attachment.itemkey && !!result.newKey && result.newKey !== attachment.itemkey &&
								!item.attachments?.some((current) => current.itemkey === attachment.itemkey)
							: result.oldKey === undefined && result.newKey === attachment.itemkey) &&
						samePath(result.to, attachment.destinationPath) && linkedAt(result.newKey, result.to);
				}
				if (result.sourceMissing || result.archiveDirectory || ((repair || candidate.automatic) && !result.preservedSource)) return false;
				if (result.referenceCheckFailed && !result.preservedSource) return false;
				if (result.preservedSource) {
					return !result.trashed && allowedDestination(attachment, result) &&
						(result.archivePath
							? attachment.mode === "stored" && typeof result.archivePath === "string" && path.isAbsolute(result.archivePath) &&
								!samePath(result.archivePath, result.from) && !samePath(result.archivePath, result.to) &&
								result.oldKey === attachment.itemkey && !!result.newKey && result.newKey !== attachment.itemkey &&
								!item.attachments?.some((current) => current.itemkey === attachment.itemkey)
							: result.oldKey === undefined && result.newKey === attachment.itemkey) &&
						linkedAt(result.newKey, result.to);
				}
				if (attachment.resolution === "trash") {
					return result.trashed === true &&
						!item.attachments?.some((current) => current.itemkey === attachment.itemkey);
				}
				if (result.trashed || !samePath(result.to, attachment.destinationPath)) return false;
				if (result.copied) return false;
				if (attachment.mode === "stored") {
					return result.oldKey === attachment.itemkey && !!result.newKey && linkedAt(result.newKey, attachment.destinationPath);
				}
				return result.oldKey === undefined && result.newKey === undefined && linkedAt(attachment.itemkey, attachment.destinationPath);
			}) && linked.length === expectedNoteFiles.length && expectedNoteFiles.every((filePath) =>
				linked.some((entry) => samePath(entry.path, filePath) && linkedAt(entry.newKey, filePath)));
			if (!verified) {
				sendJson(res, 400, { success: false, error: "Zotero's attachment list does not match the reviewed files." });
				return;
			}
			const outcome = await runSerialized(async (): Promise<LitNoteItemResult> => {
				try {
					await ensureWorkspaceReady(app);
					for (const move of moved) {
						if (!move.referenceCheckFailed) continue;
						await verifyAttachmentCopy(move.from, move.to);
						const attachment = candidate.attachments.find((current) => current.itemkey === move.itemkey);
						if (attachment && !samePath(attachment.destinationPath, move.to)) {
							if (app.vault.adapter instanceof FileSystemAdapter) {
								const root = app.vault.adapter.getBasePath();
								const previous = path.relative(root, attachment.destinationPath).split(path.sep).join("/");
								const replacement = path.relative(root, move.to).split(path.sep).join("/");
								if (attachment.resolution === "newest") {
									candidate.linkNoteFiles.push(attachment.destinationPath);
									candidate.extras.push({ path: previous, origin: "note" }, { path: replacement, origin: "zotero" });
								}
								for (const extra of candidate.extras) {
									if (extra.origin === "zotero" && extra.path === previous) extra.path = replacement;
								}
							}
							attachment.destinationPath = move.to;
						}
					}
					const preservedSources = moved
						.filter((move) => move.preservedSource || move.archiveDirectory)
						.map((move) => ({
							itemkey: move.itemkey!,
							from: move.from,
							to: move.to,
							...(move.newKey ? { newKey: move.newKey } : {}),
							...(move.archivePath ? { archivePath: move.archivePath } : {}),
							...(move.archiveDirectory ? { archiveDirectory: move.archiveDirectory } : {}),
							...(move.copied ? { copied: true } : {}),
							...(move.referenceCheckFailed ? { referenceCheckFailed: true } : {}),
						}));
					if (repair || candidate.automatic) await finishAttachmentMove(app, settings, item, candidate, preservedSources, entry.repairSnapshot);
					else await finishAttachmentMove(app, settings, item, candidate, preservedSources);
					if (repair) finishUncertainAttachmentRepair(entry.key);
					else finishAttachmentCorrection(entry.key);
					return { citekey: item.citekey, status: "updated" };
				} catch (error) {
					const message = errorMessage(error);
					if (repair) {
						finishUncertainAttachmentRepair(entry.key, message);
						new Notice(`Could not repair attachment links: ${message}`, 0);
					}
					else {
						if (candidate.automatic) console.error("Automatic Zotero attachment reconciliation failed", message);
						finishAttachmentCorrection(entry.key, message);
					}
					return { citekey: item.citekey, status: "error", error: message };
				}
			});
			sendJson(res, 200, resultsResponse([outcome]));
		} else if (parsed.action === "bulk-library-uri") {
			const item = Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : undefined;
			const entry = item && requestedReviews().find((review) => review.key === reviewKey(item) && review.operation === "library-uri");
			if (!item || !entry || !entry.libraryNotePath || !item.itemkey || item.libraryURI !== entry.libraryURI) {
				sendJson(res, 400, { success: false, error: "No matching library correction is pending." });
				return;
			}
			const outcome = await runSerialized(async (): Promise<LitNoteItemResult> => {
				try {
					await ensureWorkspaceReady(app);
					const file = missingLibraryNote(app, settings, item);
					if (!file || file.path !== entry.libraryNotePath) throw new Error("The matching note changed or is ambiguous; review it individually.");
					await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
						if (fm.zotero_item_key !== item.itemkey || fm.zotero_library_uri !== undefined) {
							throw new Error("The note's Zotero identity changed; review it individually.");
						}
						fm.zotero_library_uri = entry.libraryURI;
					});
					finishLibraryCorrection(entry.key);
					return { citekey: item.citekey, status: "updated" };
				} catch (error) {
					const message = errorMessage(error);
					finishLibraryCorrection(entry.key, message);
					return { citekey: item.citekey, status: "error", error: message };
				}
			});
			sendJson(res, 200, resultsResponse([outcome]));
		} else if (parsed.action === "check-attachment-base") {
			if (typeof parsed.baseDirectory !== "string") {
				sendJson(res, 400, { success: false, error: "baseDirectory must be a string" });
				return;
			}
			if (!parsed.baseDirectory) {
				sendJson(res, 200, { success: true, relationship: "unset" });
				return;
			}
			const adapter = app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter) || !path.isAbsolute(parsed.baseDirectory)) {
				sendJson(res, 200, { success: false, error: "Cannot compare the linked attachment base directory with this vault: an absolute directory and a local filesystem vault are required." });
				return;
			}
			try {
				const [base, vault, info] = await Promise.all([
					realpath(parsed.baseDirectory), realpath(adapter.getBasePath()), stat(parsed.baseDirectory),
				]);
				if (!info.isDirectory()) throw new Error("The configured path is not a directory.");
				const relative = path.relative(vault, base);
				const inside = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
				sendJson(res, 200, { success: true, relationship: inside ? "inside" : "outside", vaultPath: vault });
			} catch (error) {
				sendJson(res, 200, { success: false, error: `Cannot check Zotero's linked attachment base directory: ${errorMessage(error)}` });
			}
		} else if (parsed.action === "create") {
			const items = parsed.data;
			if (!Array.isArray(items) || items.length === 0) {
				sendJson(res, 400, { success: false, error: "data array is empty or missing" });
				return;
			}
			const results = await runSerialized(() =>
				handleCreateBatch(app, settings, items)
			);
			sendJson(res, 200, resultsResponse(results));
		} else if (parsed.action === "sync" || parsed.action === "update" || parsed.action === "review-sync" || parsed.action === "bulk-review-sync" || parsed.action === "review-recheck") {
			const items = parsed.data;
			if (!Array.isArray(items) || items.length === 0) {
				sendJson(res, 400, { success: false, error: "data array is empty or missing" });
				return;
			}
			const mode = parsed.action === "update" ? "metadata" : "auto";
			const recheck = parsed.action === "review-recheck";
			const automatic = parsed.action === "sync" || recheck;
			const bulk = parsed.action === "bulk-review-sync";
			const requested = parsed.action === "review-sync" || bulk;
			const bulkEntry = bulk && items.length === 1
				? requestedReviews().find((review) => review.key === reviewKey(items[0]) && review.operation === "note-update")
				: undefined;
			if (bulk && !bulkEntry?.proposal) {
				sendJson(res, 400, { success: false, error: "No matching bulk review is pending." });
				return;
			}
			const recheckEntry = recheck && items.length === 1
				? requestedReviews().find((review) => review.key === reviewKey(items[0]) && review.operation === "library-recheck")
				: undefined;
			if (recheckEntry) {
				await ensureWorkspaceReady(app);
				const file = recheckEntry.notePath && app.vault.getAbstractFileByPath(recheckEntry.notePath);
				const fm = file instanceof TFile ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
				if (!fm || fm.zotero_item_key !== items[0].itemkey || fm.zotero_library_uri !== items[0].libraryURI) {
					const waiting = file instanceof TFile && (!fm || (fm.zotero_item_key === items[0].itemkey && fm.zotero_library_uri === undefined)) &&
						Date.now() - (recheckEntry.recheckStartedAt ?? 0) < 15000;
					if (waiting) {
						sendJson(res, 200, resultsResponse([{ citekey: items[0].citekey, status: "waiting-index" }]));
						return;
					}
					finishLibraryRecheck(recheckEntry.key, false, "The updated note could not be verified in Obsidian's index; review it after indexing.");
					sendJson(res, 200, resultsResponse([{ citekey: items[0].citekey, status: "pending-review" }]));
					return;
				}
			}
			const results = await runSerialized(() => withNoteDecisionSession(app, async (session) => {
				await ensureWorkspaceReady(app);
				for (const [id, plan] of syncPlans) if (plan.expires < Date.now()) syncPlans.delete(id);
				const entries: LitNoteItemResult[] = [];
				let cancelled = false;
				for (const item of items) {
					try {
						if (item.itemkey && item.libraryURI && isReviewBlocked(reviewKey(item))) {
							entries.push(automatic
								? { citekey: item.citekey, status: "pending-review" }
								: { citekey: item.citekey, status: "error", error: "Check the interrupted operation in Obsidian before updating this note." });
							continue;
						}
						const decisions: SyncPlan["decisions"] = [];
						const entry = await syncLitNote(app, settings, item, mode, async (title, message, buttons, review, conflict, bulkSummary) => {
							if (automatic) throw new ReviewNeeded(title, conflict?.notePath, bulkSummary
								? { summary: bulkSummary, title, message, buttons, conflict } : undefined);
							if (bulk) {
								const proposal = { summary: bulkSummary, title, message, buttons, conflict };
								if (review || !bulkEntry?.proposal || JSON.stringify(proposal) !== JSON.stringify(bulkEntry.proposal) ||
									!buttons.some((button) => button.value === "create")) {
									throw new Error("The proposed note changes changed; review this note individually.");
								}
								decisions.push({ title, message, buttons, review, conflict, choice: "create" });
								return "create";
							}
							raiseAndFocus(app, app.workspace.getMostRecentLeaf());
							const choice = await session.ask(title, message, buttons, review, conflict);
							if (choice === "cancel") cancelled = true;
							decisions.push({ title, message, buttons, review, conflict, choice });
							return choice;
						}, { prepareOnly: true });
						if (recheck && (entry.status === "prepared" || entry.status === "set-zotero-key")) {
							queueReconciliation(app, settings, item, "Note changes need confirmation", entry.notePath);
							entries.push({ citekey: entry.citekey, status: "pending-review" });
							continue;
						}
						if (recheck && entry.status === "missing") {
							queueReconciliation(app, settings, item, "The matching note is missing; review its Zotero identity");
							entries.push({ citekey: entry.citekey, status: "pending-review" });
							continue;
						}
						if (bulk && (entry.status !== "prepared" || decisions.length !== 1)) {
							throw new Error(entry.error ?? "The proposed note changes are no longer available; review this note individually.");
						}
						if ((entry.status === "prepared" || entry.status === "set-zotero-key") && entry.snapshot !== undefined) {
							const token = randomUUID();
							syncPlans.set(token, {
								mode, kind: entry.status === "prepared" ? "apply-sync" : "validate-zotero-key",
								input: syncInput(item, mode), snapshot: entry.snapshot,
								notePath: entry.notePath, identicalAttachments: entry.identicalAttachments,
								decisions, expires: Date.now() + 120000, ...(requested ? { reviewKey: reviewKey(item) } : {}), ...(bulk ? { bulk: true } : {}),
							});
							entries.push({
								citekey: entry.citekey, status: entry.status, token,
								noteCitekey: entry.noteCitekey, expectedZoteroKey: entry.expectedZoteroKey,
								...(entry.identicalAttachments?.some((pair) => pair.note.path !== pair.zotero.path)
									? { needsAttachmentCheck: true } : {}),
							});
						} else {
							if (bulk) {
								const message = entry.error ?? "The proposed note changes are no longer available; review this note individually.";
								finishNoteCorrection(reviewKey(item), message);
								entries.push({ citekey: item.citekey, status: "error", error: message });
								continue;
							}
							// A requested review (for example the recheck after a duplicate merge) hands off to the same automatic move as sync.
							if (entry.attachmentMove?.automatic && entry.snapshot !== undefined && (automatic || requested) && item.itemkey && item.libraryURI) {
								queueReconciliation(app, settings, item, "Automatic attachment reconciliation", entry.notePath, undefined, entry.attachmentMove);
								if (requested) resetReviewRequest(reviewKey(item));
								requestAutomaticAttachment(reviewKey(item), entry.snapshot);
								entries.push({ citekey: entry.citekey, status: "pending-review" });
								continue;
							}
							if (entry.status === "error" && automatic && item.itemkey && item.libraryURI) {
								queueReconciliation(app, settings, item, entry.errorTitle ?? "Reconciliation needs attention", entry.identity?.notePath, undefined, entry.attachmentMove);
								entries.push({ citekey: entry.citekey, status: "pending-review" });
								continue;
							}
							if (entry.status === "error" && !automatic) await showReconciliationError(app, session, item, entry, undefined, requested ? undefined : mode);
							else if (mode === "auto") reportedAutoErrors.delete(errorKey(item));
							if (requested && entry.status === "error" && entry.identity?.notePaths?.length &&
								allReviews().some((review) => review.key === reviewKey(item))) {
								resetReviewRequest(reviewKey(item));
								entries.push({ citekey: entry.citekey, status: "pending-review" });
								continue;
							}
							if (automatic && !recheck && entry.status !== "error") removeReview(reviewKey(item));
							if (recheck && entry.status === "skipped" && !requestedReviews().some((review) => review.key === reviewKey(item) && review.operation === "library-recheck")) removeReview(reviewKey(item));
							if (requested && entry.status === "skipped" && !cancelled) removeReview(reviewKey(item));
							const { identity: _identity, attachmentProblems: _attachmentProblems, errorTitle: _errorTitle, dialogMessage: _dialogMessage, ...responseEntry } = entry;
							entries.push(responseEntry);
						}
					} catch (error) {
						if (error instanceof ReviewNeeded) {
							if (item.itemkey && item.libraryURI) {
								queueReconciliation(app, settings, item, error.reason, error.notePath, error.proposal);
								entries.push({ citekey: item.citekey ?? "", status: "pending-review" });
							} else {
								entries.push({ citekey: item.citekey ?? "", status: "error", error: "Cannot queue a review without a Zotero item and library identity." });
							}
							continue;
						}
						const entry: SyncResult = {
							citekey: item?.citekey ?? "",
							status: "error",
							error: `Unable to reconcile note: ${error instanceof Error ? error.message : String(error)}`,
						};
						if (bulk) {
							finishNoteCorrection(reviewKey(item), entry.error);
							entries.push(entry);
							continue;
						}
						if (automatic && item.itemkey && item.libraryURI) {
							queueReconciliation(app, settings, item, entry.error ?? "Reconciliation failed");
							entries.push({ citekey: entry.citekey, status: "pending-review" });
							continue;
						}
						if (!automatic) await showReconciliationError(app, session, item, entry, undefined, requested ? undefined : mode);
						entries.push(entry);
					}
					if (cancelled) break;
				}
				if (requested && !bulk) for (const item of items) {
					if (!allReviews().some((review) => review.key === reviewKey(item) && review.automaticAttachment && review.requested)) resetReviewRequest(reviewKey(item));
				}
				if (cancelled) {
					for (const entry of entries) if (entry.token) syncPlans.delete(entry.token);
					return items.map((item, index) => entries[index]?.status === "error"
						? entries[index]
						: { citekey: item.citekey ?? "", status: "skipped" as const });
				}
				for (const entry of entries) {
					const plan = entry.token ? syncPlans.get(entry.token) : undefined;
					if (plan) plan.expires = Date.now() + 120000;
				}
				return entries;
			}));
			if (recheck) for (let index = 0; index < items.length; index++) {
				finishLibraryRecheck(reviewKey(items[index]), results[index]?.status === "skipped");
			}
			if (!bulk && (mode === "metadata" || results.some((entry) => entry.status === "error"))) {
				const completed = results.filter((entry) => entry.status !== "set-zotero-key" && entry.status !== "prepared");
				if (completed.length) noticeSummary(completed);
			}
			sendJson(res, 200, resultsResponse(results));
		} else if (parsed.action === "apply-sync" || parsed.action === "validate-zotero-key") {
			const plan = syncPlans.get(parsed.token);
			syncPlans.delete(parsed.token);
			const item = Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : undefined;
			if (item?.itemkey && item.libraryURI && isReviewBlocked(reviewKey(item))) {
				sendJson(res, 200, resultsResponse([{
					citekey: item.citekey, status: "error", error: "Check the interrupted operation in Obsidian before updating this note.",
				}]));
				return;
			}
			const reportFailure = async (failure: SyncResult): Promise<LitNoteItemResult> => {
				if (item && (plan?.bulk || requestedReviews().some((review) => review.key === reviewKey(item) && review.operation === "note-update"))) {
					finishNoteCorrection(reviewKey(item), failure.error ?? "The update failed; review this note individually.");
					return { citekey: failure.citekey, status: "error", error: failure.error };
				}
				if (item && (!plan || (plan.mode === "auto" && !plan.reviewKey))) {
					if (item.itemkey && item.libraryURI) {
						queueReconciliation(app, settings, item, failure.errorTitle ?? failure.error ?? "Reconciliation failed", plan?.notePath);
						return { citekey: failure.citekey, status: "error", error: failure.error };
					}
				} else if (item) {
					await runSerialized(() => withNoteDecisionSession(app, (session) =>
						showReconciliationError(app, session, item, failure, plan?.notePath)));
				}
				return { citekey: failure.citekey, status: "error", error: failure.error };
			};
			if (!plan || plan.kind !== parsed.action || plan.expires < Date.now() || !item || syncInput(item, plan.mode) !== plan.input) {
				const failure: SyncResult = {
					citekey: item?.citekey ?? "", status: "error",
					error: "The Zotero item or update plan changed or expired; retry the update.",
					errorTitle: "Zotero item or update plan changed or expired",
					dialogMessage: "Retry the update.",
				};
				sendJson(res, 200, resultsResponse([await reportFailure(failure)]));
				return;
			}
			const duplicatePairs = (plan.identicalAttachments ?? []).filter((pair) => pair.note.path !== pair.zotero.path);
			const zoteroPaths = parsed.zoteroAttachmentPaths;
			if (duplicatePairs.length && (!plan.notePath || !Array.isArray(zoteroPaths) ||
				zoteroPaths.some((attachmentPath) => typeof attachmentPath !== "string" || !attachmentPath))) {
				const failure: SyncResult = {
					citekey: item.citekey ?? "", status: "error",
					error: "Zotero attachment references could not be verified; duplicate files were not removed.",
					errorTitle: "Zotero attachment references could not be verified",
					dialogMessage: "Retry the update. Duplicate files were not removed.",
				};
				sendJson(res, 200, resultsResponse([await reportFailure(failure)]));
				return;
			}
			const entry = await runSerialized(() => withNoteDecisionSession(app, async (session) => {
				try {
					await ensureWorkspaceReady(app);
					let index = 0;
					const result = await syncLitNote(app, settings, item, plan.mode, async (title, message, buttons, review, conflict) => {
						const decision = plan.decisions[index++];
						if (!decision || decision.title !== title || decision.message !== message ||
							JSON.stringify(decision.buttons) !== JSON.stringify(buttons) ||
							JSON.stringify(decision.review) !== JSON.stringify(review) ||
							JSON.stringify(decision.conflict) !== JSON.stringify(conflict)) {
							throw new Error("The note or its links changed after the decision; retry the update.");
						}
						return decision.choice;
					}, {
						expectedContent: plan.snapshot,
						expectedIdenticalAttachments: plan.identicalAttachments,
						prepareOnly: parsed.action === "validate-zotero-key",
						beforeApply: async () => {
							if (index !== plan.decisions.length) throw new Error("The note or its links changed after the decision; retry the update.");
							if (duplicatePairs.length && plan.notePath && zoteroPaths) {
								await assertAttachmentsUnshared(app, plan.notePath, duplicatePairs, zoteroPaths);
							}
						},
						trashIdenticalAttachments: async (pairs, notePath) => {
							if (!duplicatePairs.length) return;
							if (!zoteroPaths) throw new Error("Zotero attachment references are unavailable.");
							await assertAttachmentsUnshared(app, notePath, duplicatePairs, zoteroPaths, plan.notePath);
							const noteFiles: TFile[] = [];
							const zoteroFiles: TFile[] = [];
							for (const pair of pairs) {
								const noteFile = app.vault.getAbstractFileByPath(pair.note.path);
								const zoteroFile = app.vault.getAbstractFileByPath(pair.zotero.path);
								if (!(noteFile instanceof TFile) || !(zoteroFile instanceof TFile)) {
									throw new Error("An attachment disappeared before duplicate cleanup.");
								}
								noteFiles.push(noteFile);
								zoteroFiles.push(zoteroFile);
							}
							const verified = await findIdenticalAttachments(app, noteFiles, zoteroFiles);
							if (JSON.stringify(verified) !== JSON.stringify(pairs)) {
								throw new Error("Attachments changed before duplicate cleanup.");
							}
							for (const pair of duplicatePairs) {
								const file = app.vault.getAbstractFileByPath(pair.note.path);
								if (!(file instanceof TFile)) throw new Error(`Attachment disappeared: ${pair.note.path}`);
								await app.fileManager.trashFile(file);
								if (await app.vault.adapter.exists(pair.note.path)) {
									throw new Error(`Attachment was not moved to Trash: ${pair.note.path}`);
								}
							}
						},
					});
					if (parsed.action === "validate-zotero-key") {
						if (result.status !== "set-zotero-key" || index !== plan.decisions.length) {
							const failure: SyncResult = { citekey: item.citekey, status: "error", error: result.error ?? "The note changed after the decision; retry the update.", errorTitle: result.errorTitle ?? "Note changed after decision", dialogMessage: result.dialogMessage, identity: result.identity, attachmentProblems: result.attachmentProblems };
							await showReconciliationError(app, session, item, failure, plan.notePath, plan.mode);
							const { identity: _identity, attachmentProblems: _attachmentProblems, errorTitle: _errorTitle, dialogMessage: _dialogMessage, ...responseEntry } = failure;
							return responseEntry;
						}
						return { citekey: item.citekey, status: "skipped" as const, noteCitekey: result.noteCitekey };
					}
					if (result.status === "error" && plan.mode === "auto" && !plan.reviewKey && item.itemkey && item.libraryURI) {
						queueReconciliation(app, settings, item, result.errorTitle ?? result.error ?? "Reconciliation failed", plan.notePath);
						return { citekey: item.citekey, status: "error" as const, error: result.error };
					}
					if (plan.bulk && plan.reviewKey) {
						if (result.status === "updated") finishNoteCorrection(plan.reviewKey);
						else finishNoteCorrection(plan.reviewKey, result.error ?? "The update was not completed; review this note individually.");
						const { identity: _identity, attachmentProblems: _attachmentProblems, errorTitle: _errorTitle, dialogMessage: _dialogMessage, ...responseEntry } = result;
						return responseEntry;
					}
					if (result.status === "error") await showReconciliationError(app, session, item, result, plan.notePath);
					else if (plan.mode === "auto") reportedAutoErrors.delete(errorKey(item));
					if (result.status === "updated" && (plan.reviewKey || plan.mode === "metadata")) {
						removeReview(plan.reviewKey ?? reviewKey(item));
					}
					const { identity: _identity, attachmentProblems: _attachmentProblems, errorTitle: _errorTitle, dialogMessage: _dialogMessage, ...responseEntry } = result;
					return responseEntry;
				} catch (error) {
					const failure: SyncResult = { citekey: item.citekey, status: "error", error: errorMessage(error) };
					if (plan.bulk && plan.reviewKey) {
						finishNoteCorrection(plan.reviewKey, failure.error);
						return failure;
					}
					if (plan.mode === "auto" && !plan.reviewKey && item.itemkey && item.libraryURI) {
						queueReconciliation(app, settings, item, failure.error ?? "Reconciliation failed", plan.notePath);
						return failure;
					}
					await showReconciliationError(app, session, item, failure, plan.notePath);
					return failure;
				}
			}));
			sendJson(res, 200, resultsResponse([entry]));
		} else if (parsed.action === "open") {
			const openRequest = parsed;
			const data = Array.isArray(openRequest.data) ? openRequest.data : [];
			const entries: OpenEntry[] = data.length
				? data.map((item) => ({ item, citekey: citekeyOf(item) }))
				: openRequest.citekey
					? [{ citekey: openRequest.citekey.trim() }]
					: [];
			if (!entries.length) {
				sendJson(res, 400, {
					success: false,
					error: "data array or citekey is required for open action",
				});
				return;
			}
			const results = await runSerialized(() =>
				handleOpenBatch(app, settings, entries)
			);
			sendJson(res, 200, resultsResponse(results));
		} else {
			sendJson(res, 400, {
				success: false,
				error: `Unknown action: ${(parsed as { action: string }).action}`,
			});
		}
	} catch (err: unknown) {
		const msg = errorMessage(err);
		if (err instanceof ReviewScanCompleteError) {
			console.error("[LitNoteServer] A new Zotero review could not be added:", err);
			new Notice(msg, 0);
			sendJson(res, 200, { success: false, error: msg });
			return;
		}
		console.error("[LitNoteServer] Unhandled error:", err);
		sendJson(res, 500, { success: false, error: msg });
	} finally {
		for (const key of activeReviews) endReviewOperation(key);
	}
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the lit-note HTTP server.
 * Returns the server instance so the caller can call `stopLitNoteServer` in
 * `onunload()`.
 */
export function startLitNoteServer(app: App, settings: LitNoteServerSettings): http.Server {
	// Reviews live only in memory; a new ID tells Zotero they were lost and must be checked again.
	obsidianSession = randomUUID();
	const server = http.createServer((req, res) => {
		handleRequest(app, settings, req, res).catch((err) => {
			console.error("[LitNoteServer] Fatal request error:", err);
			if (!res.headersSent) {
				sendJson(res, 500, { success: false, error: "Internal server error" });
			}
		});
	});

	const HTTP_PORT = 27124;

	server.on("error", (e: NodeJS.ErrnoException) => {
		if (e.code === "EADDRINUSE") {
			console.error(`[LitNoteServer] Port ${HTTP_PORT} is in use.`);
			new Notice(
				`Zotero lit-note listener: port ${HTTP_PORT} is already in use. ` +
					`Is there more than one Obsidian vault running with the perplexity saver plugin enabled?`
			);
		} else {
			console.error("[LitNoteServer] error", e);
		}
	});

	server.listen(HTTP_PORT, "127.0.0.1", () => {
	});

	return server;
}

/**
 * Gracefully stop the server. Call from `Plugin.onunload()`.
 */
export function stopLitNoteServer(server: http.Server): void {
	syncPlans.clear();
	clearReviews();
	clearItemTrashRequests();
	server.close((err) => {
		if (err) {
			console.warn("[LitNoteServer] Error on close:", err);
		}
	});
}
