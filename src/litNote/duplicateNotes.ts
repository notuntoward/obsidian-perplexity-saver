import { Notice } from "obsidian";
import type { App, EventRef, TFile } from "obsidian";
import { getLitNoteFiles } from "commons/litnote";
import { openNotesSideBySide } from "./noteComparison";
import { rankKeepers } from "./noteMerge";
import type { KeeperEvidence } from "./noteMerge";
import { mergeNotesInteractively, mergeSummary } from "./noteMergeWorkflow";
import { allReviews, requestReview } from "./pendingReviews";
import type { PendingReview } from "./pendingReviews";

export const DUPLICATE_NOTES_REASON = "Multiple notes match this Zotero item";

export interface DuplicateReviewSettings {
	litNotesFolder: string;
}

function compatible(file: TFile, app: App, item: { itemkey: string; libraryURI: string }): boolean {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!fm && fm.zotero_item_key === item.itemkey && (!fm.zotero_library_uri || fm.zotero_library_uri === item.libraryURI);
}

/** Literature notes whose Zotero identity matches the item (a missing library URI is compatible). */
export function matchingLitNotes(app: App, litNotesFolder: string, item: { itemkey: string; libraryURI: string }): TFile[] {
	return getLitNoteFiles(app, litNotesFolder).filter((file) => compatible(file, app, item));
}

export function isDuplicateReview(entry: PendingReview): boolean {
	return entry.reason === DUPLICATE_NOTES_REASON && !entry.requested && !entry.uncertain && !entry.awaitingAcknowledgement;
}

function nextDuplicate(): PendingReview | undefined {
	return allReviews().find(isDuplicateReview);
}

/** Open the next duplicate set for comparison; returns false when none is waiting. */
export function compareNextDuplicate(app: App, settings: DuplicateReviewSettings): boolean {
	const next = nextDuplicate();
	if (next) void compareDuplicateReview(app, settings, next);
	return !!next;
}

let progress: Notice | undefined;
let choice: Notice | undefined;
// Duplicate reviews being merged; their automatic "fixed" message is replaced by the merge's tidy prompt.
const merging = new Set<string>();

function showProgress(app: App, settings: DuplicateReviewSettings, message: string, tidy?: string): void {
	progress?.hide();
	const next = nextDuplicate();
	const remaining = allReviews().filter(isDuplicateReview).length;
	const notice = new Notice(next
		? `${message}\n\n${tidy ? `Tidy ${tidy} now. ` : ""}${remaining} duplicate ${remaining === 1 ? "set remains" : "sets remain"}. ${tidy ? "When you are finished, click" : "Click"} this message to compare the next one.`
		: `${message}\n\nNo duplicate notes remain.`, next ? 0 : 10000);
	progress = notice;
	if (!next) return;
	notice.messageEl.addEventListener("click", () => {
		notice.hide();
		if (progress === notice) progress = undefined;
		const current = nextDuplicate();
		if (current) void compareDuplicateReview(app, settings, current);
	});
}

/**
 * Show every note matching a duplicate review side by side. Nothing changes until the user picks the
 * note to keep, from this notice or the "Keep this note" button in a pane's header; the others are then
 * merged into it. Deleting or editing notes by hand still works: Saver rechecks the item once only one
 * note keeps the Zotero identity.
 */
export async function compareDuplicateReview(app: App, settings: DuplicateReviewSettings, entry: PendingReview): Promise<void> {
	progress?.hide();
	progress = undefined;
	choice?.hide();
	choice = undefined;
	const files = matchingLitNotes(app, settings.litNotesFolder, entry);
	if (files.length <= 1) {
		await resolveDuplicate(app, settings, entry);
		return;
	}
	const keep = (file: TFile): void => {
		choice?.hide();
		choice = undefined;
		void mergeDuplicate(app, settings, entry, file);
	};
	try {
		await openNotesSideBySide(app, files, keep);
	} catch (error) {
		console.error("Could not open the duplicate notes", error);
		new Notice(`Could not open the duplicate notes: ${error instanceof Error ? error.message : String(error)}`, 10000);
		return;
	}
	let ranked: KeeperEvidence[] | undefined;
	try {
		ranked = await rankKeepers(app, files);
	} catch (error) {
		console.error("Could not suggest a note to keep", error);
	}
	const suggested = ranked?.[0]?.file;
	const notice = new Notice(`Comparing ${files.length} notes for "${entry.title}". Choose the note to keep; the others are merged into it, and you choose which of their text to copy first.`, 0);
	choice = notice;
	const doc = notice.messageEl.ownerDocument;
	const list = notice.messageEl.appendChild(doc.createElement("div"));
	list.className = "perplexity-saver-keeper-list";
	for (const file of ranked?.map((entry) => entry.file) ?? files) {
		const evidence = ranked?.find((entry) => entry.file === file);
		const row = list.appendChild(doc.createElement("div"));
		row.className = "perplexity-saver-keeper-row";
		const info = row.appendChild(doc.createElement("div"));
		info.className = "perplexity-saver-keeper-info";
		if (file === suggested) {
			const badge = info.appendChild(doc.createElement("div"));
			badge.className = "perplexity-saver-keeper-badge";
			badge.textContent = "Suggested";
		}
		const name = info.appendChild(doc.createElement("div"));
		name.className = "perplexity-saver-keeper-name";
		name.textContent = file.basename;
		if (evidence) {
			const detail = info.appendChild(doc.createElement("div"));
			detail.className = "perplexity-saver-keeper-detail";
			const text = evidence.text ? `${evidence.text} characters of your text` : "No text of yours";
			detail.textContent = `${text} · ${evidence.links} linking ${evidence.links === 1 ? "note" : "notes"}`;
		}
		const button = row.appendChild(doc.createElement("button"));
		button.textContent = "Keep";
		button.setAttribute("aria-label", `Keep ${file.basename}`);
		if (file === suggested) row.classList.add("is-suggested");
		// The whole row chooses the note; the button's click bubbles here and keeps keyboard access.
		row.addEventListener("click", (event) => {
			event.stopPropagation();
			keep(file);
		});
	}
	// A click between rows would otherwise dismiss the notice.
	list.addEventListener("click", (event) => event.stopPropagation());
}

async function mergeDuplicate(app: App, settings: DuplicateReviewSettings, entry: PendingReview, keeper: TFile): Promise<void> {
	const sources = matchingLitNotes(app, settings.litNotesFolder, entry).filter((file) => file.path !== keeper.path);
	merging.add(entry.key);
	try {
		const result = await mergeNotesInteractively(app, keeper, sources);
		if (!result) return;
		const summary = mergeSummary(keeper, result);
		if (!result.merged.length || matchingLitNotes(app, settings.litNotesFolder, entry).length > 1) {
			new Notice(summary, 0);
			return;
		}
		await resolveDuplicate(app, settings, entry);
		showProgress(app, settings, summary, keeper.basename);
	} finally {
		merging.delete(entry.key);
	}
}

const resolving = new Map<string, Promise<void>>();

/**
 * The note that remains after a duplicate is resolved may be an older note without zotero_library_uri.
 * Add it as part of the same fix, so the resolved duplicate does not reappear as a missing-library review.
 */
async function completeLibraryIdentity(app: App, settings: DuplicateReviewSettings, entry: PendingReview): Promise<TFile | undefined> {
	const files = matchingLitNotes(app, settings.litNotesFolder, entry);
	if (files.length !== 1 || app.metadataCache.getFileCache(files[0])?.frontmatter?.zotero_library_uri) return undefined;
	await app.fileManager.processFrontMatter(files[0], (fm: Record<string, unknown>) => {
		if (fm.zotero_item_key !== entry.itemkey || (fm.zotero_library_uri && fm.zotero_library_uri !== entry.libraryURI)) {
			throw new Error("The note's Zotero identity changed; it was not updated.");
		}
		fm.zotero_library_uri = entry.libraryURI;
	});
	return files[0];
}

/** Resolve a duplicate once; a second caller waits for the resolution already under way. */
function resolveDuplicate(app: App, settings: DuplicateReviewSettings, entry: PendingReview): Promise<void> {
	let running = resolving.get(entry.key);
	if (!running) {
		running = finishDuplicate(app, settings, entry).finally(() => resolving.delete(entry.key));
		resolving.set(entry.key, running);
	}
	return running;
}

async function finishDuplicate(app: App, settings: DuplicateReviewSettings, entry: PendingReview): Promise<void> {
	let completed = "";
	try {
		const file = await completeLibraryIdentity(app, settings, entry);
		if (file) completed = ` Added its Zotero library identity to ${file.basename}.`;
	} catch (error) {
		console.error("Could not add the Zotero library identity", error);
		completed = ` Could not add its Zotero library identity: ${error instanceof Error ? error.message : String(error)}`;
	}
	const current = allReviews().find((review) => review.key === entry.key);
	if (!current || !isDuplicateReview(current)) return;
	try {
		requestReview(entry.key);
	} catch (error) {
		console.error("Could not request the Zotero recheck", error);
		return;
	}
	if (!merging.has(entry.key)) showProgress(app, settings, `Duplicate fixed for "${entry.title}".${completed} Zotero will recheck it.`);
}

/** Recheck duplicate reviews whenever note identities change, so the user never has to return to the list. */
export function watchDuplicateReviews(app: App, settings: DuplicateReviewSettings): () => void {
	const check = (): void => {
		const reviews = allReviews().filter(isDuplicateReview);
		if (!reviews.length) return;
		const counts = new Map(reviews.map((entry) => [entry.key, 0]));
		for (const file of getLitNoteFiles(app, settings.litNotesFolder)) {
			for (const entry of reviews) {
				if (compatible(file, app, entry)) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
			}
		}
		for (const entry of reviews) {
			if ((counts.get(entry.key) ?? 0) <= 1) void resolveDuplicate(app, settings, entry);
		}
	};
	const metadataRef: EventRef = app.metadataCache.on("changed", check);
	const vaultRefs: EventRef[] = [app.vault.on("delete", check), app.vault.on("rename", check)];
	return () => {
		app.metadataCache.offref(metadataRef);
		for (const ref of vaultRefs) app.vault.offref(ref);
		progress?.hide();
		progress = undefined;
		choice?.hide();
		choice = undefined;
	};
}
