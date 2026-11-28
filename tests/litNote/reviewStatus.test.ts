import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMainWindow, openFileInLeaf } from "commons/workspace";
import { TFile } from "obsidian";
import { createdNotices } from "../__mocks__/obsidian";
import { acknowledgeUncertainReview, allReviews, clearReviews, consumeUncertainAcknowledgement, endInitialReviewScan, failReview, finishAttachmentCorrection, finishNoteCorrection, finishLibraryCorrection, finishLibraryRecheck, finishUncertainAttachmentRepair, markReviewUncertain, pendingRescan, queueReview, removeReview, replaceMissingItemKeyReviews, requestedReviews, requestNoteBatch, requestReview, requestRescan, reviewKey, setReviewListener, startInitialReviewScan } from "../../src/litNote/pendingReviews";
import { setupReviewStatus } from "../../src/litNote/reviewStatus";
import { startRescan } from "../../src/litNote/noteMergeCommands";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import { compareDuplicateReview, DUPLICATE_NOTES_REASON, watchDuplicateReviews } from "../../src/litNote/duplicateNotes";
import type { App } from "obsidian";

const state = vi.hoisted(() => ({
	groups: [] as Array<{ kind: string; title: string; uri?: string; itemkey?: string }>,
	select: undefined as ((group: unknown) => void) | undefined,
	selectItem: undefined as ((group: unknown, item: unknown) => void) | undefined,
}));
vi.mock("../../src/litNote/reviewOverviewModal", () => ({
	ReviewOverviewModal: class {
		constructor(_app: unknown, private select: (group: unknown) => void, selectItem: (group: unknown, item: unknown) => void, private dismiss: () => void) {
			state.selectItem = selectItem;
		}
		update(groups: typeof state.groups): void {
			state.groups = groups;
			state.select = this.select;
		}
		open(): void {}
		close(): void { this.dismiss(); }
	},
}));
vi.mock("commons/workspace", () => ({ getMainWindow: vi.fn((): Window | undefined => undefined), openFileInLeaf: vi.fn(async () => undefined) }));
vi.mock("commons/os", () => ({ raiseWindow: vi.fn() }));
vi.mock("../../src/litNote/decisionModal", () => ({ askNoteDecision: vi.fn() }));
vi.mock("../../src/litNote/duplicateNotes", async (original) => ({
	...await original<typeof import("../../src/litNote/duplicateNotes")>(),
	compareDuplicateReview: vi.fn(async () => undefined),
	watchDuplicateReviews: vi.fn(() => vi.fn()),
}));
vi.mock("../../src/litNote/uncertainAttachments", () => ({
	inspectUncertainAttachments: vi.fn(async () => ({
		message: "Current attachment state",
		paths: [{ label: "Zotero attachment: PDF", path: "C:\\storage\\paper.pdf", status: "File exists." }],
	})),
}));

const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };

function setup() {
	const button = { setText: vi.fn(), title: "", onclick: undefined as (() => void) | undefined };
	const status = { hidden: false, createEl: () => button };
	const workspace = { on: vi.fn((_event: string, _callback: () => void) => ({})), offref: vi.fn() };
	const metadataCache = { on: vi.fn(), offref: vi.fn() };
	const vault = { getAbstractFileByPath: vi.fn() };
	const app = { workspace, metadataCache, vault } as unknown as App;
	setupReviewStatus(app, status as unknown as HTMLElement);
	return { status, button, workspace, metadataCache, vault, app };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("review status", () => {
	beforeEach(() => {
		setReviewListener();
		clearReviews();
		createdNotices.length = 0;
		vi.clearAllMocks();
	});
	afterEach(() => { setReviewListener(); clearReviews(); });

	it("opens a missing-key note locally and removes its review after the key is added", async () => {
		const { button, vault, metadataCache, app } = setup();
		const notePath = "lit/legacy.md";
		const file = Object.assign(Object.create(TFile.prototype), { path: notePath });
		vault.getAbstractFileByPath.mockReturnValue(file);
		replaceMissingItemKeyReviews([notePath]);
		button.onclick?.();
		expect(state.groups[0].title).toBe("Add missing Zotero item key (1)");
		state.selectItem?.(state.groups[0], allReviews()[0]);
		await settle();
		expect(openFileInLeaf).toHaveBeenCalledWith(app, file);
		expect(requestedReviews()).toEqual([]);
		expect(() => requestReview(allReviews()[0].key)).toThrow("add its Zotero item key");
		const changed = metadataCache.on.mock.calls[0][1] as (file: unknown, data: unknown, cache: unknown) => void;
		changed(file, "", { frontmatter: { category: "literaturenote", zotero_item_key: "  " } });
		expect(allReviews()).toHaveLength(1);
		changed(file, "", { frontmatter: { category: "literaturenote", zotero_item_key: "ABC" } });
		expect(allReviews()).toEqual([]);
		expect(createdNotices.at(-1)?.message).toContain("verify the association");
	});

	it("announces the end of a requested check, including one that finds nothing", () => {
		setup();
		requestRescan();
		startInitialReviewScan("first");
		endInitialReviewScan("first", "complete");
		expect(createdNotices.at(-1)?.message).toBe("Zotero finished checking all literature notes. Nothing needs review.");
		requestRescan();
		startInitialReviewScan("second");
		queueReview(item, "Attachment links differ");
		createdNotices.length = 0;
		endInitialReviewScan("second", "complete");
		expect(createdNotices.at(-1)?.message).toContain("Zotero reviews need attention");
		createdNotices.length = 0;
		startInitialReviewScan("startup");
		endInitialReviewScan("startup", "complete");
		expect(createdNotices.some((notice) => notice.message.includes("Nothing needs review"))).toBe(false);
	});

	it("announces a requested check after a failed attempt is retried", () => {
		setup();
		requestRescan();
		startInitialReviewScan("manual");
		endInitialReviewScan("manual", "error", "Unavailable");
		startInitialReviewScan("manual");
		endInitialReviewScan("manual", "paused");
		expect(createdNotices.at(-1)?.message).toContain("Nothing needs review");
	});

	it("announces the status bar once and announces completion when the last review is removed", () => {
		const { status } = setup();
		expect(status.hidden).toBe(true);
		queueReview(item, "Attachment links differ");
		expect(status.hidden).toBe(false);
		expect(createdNotices[0].message).toContain("status bar");
		expect(createdNotices[0].message).toContain("Zotero reviews");
		expect(createdNotices[0].timeout).toBe(0);
		removeReview(reviewKey(item));
		expect(status.hidden).toBe(true);
		expect(createdNotices.at(-1)?.message).toContain("All Zotero reviews are complete");
	});

	it("shows interrupted and other reviews together after the initial scan and counts down", () => {
		const { status, button } = setup();
		const other = { ...item, itemkey: "OTHER" };
		startInitialReviewScan("startup");
		markReviewUncertain({ ...item, operation: "attachment-move" });
		queueReview(other, "Attachment links differ");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Checking Zotero/Obsidian match...");
		button.onclick?.();
		expect(createdNotices.at(-1)?.message).toContain("full list will appear");
		endInitialReviewScan("startup", "complete");
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 2");
		button.onclick?.();
		expect(state.groups.map((group) => group.kind)).toEqual(["uncertain", "reason"]);
		removeReview(reviewKey(other));
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
		acknowledgeUncertainReview(reviewKey(item));
		consumeUncertainAcknowledgement(item);
		expect(status.hidden).toBe(true);
	});

	it("hides the count during the initial scan and exposes errors until a same-id retry completes", () => {
		const { status, button } = setup();
		queueReview(item, "Attachment links differ");
		expect(status.hidden).toBe(false);

		startInitialReviewScan("startup-1");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Checking Zotero/Obsidian match...");
		endInitialReviewScan("startup-1", "error", "Zotero unavailable");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Zotero/Obsidian check failed");
		expect(button.title).toContain("Zotero unavailable");
		button.onclick?.();
		expect(createdNotices.at(-1)?.message).toContain("Keep both apps open while Zotero retries");

		startInitialReviewScan("startup-1");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Checking Zotero/Obsidian match...");
		endInitialReviewScan("startup-1", "complete");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
	});

	it("hides paused checks and recovery-only startup while retaining access to reviews", () => {
		const { status, button } = setup();
		startInitialReviewScan("paused", true);
		expect(status.hidden).toBe(true);
		markReviewUncertain({ ...item, operation: "attachment-move" });
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
		endInitialReviewScan("paused", "paused");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
		button.onclick?.();
		expect(state.groups.map((group) => group.kind)).toEqual(["uncertain"]);
		acknowledgeUncertainReview(reviewKey(item));
		consumeUncertainAcknowledgement(item);
		expect(status.hidden).toBe(true);
	});

	it("allows a manual check during paused recovery and hides the status after a clean check", () => {
		const { status, button } = setup();
		startInitialReviewScan("recovery", true);
		startRescan({} as App);
		expect(pendingRescan()).toEqual(expect.any(String));
		expect(createdNotices.at(-1)?.message).toContain("Interrupted recovery finishes first");
		endInitialReviewScan("recovery", "paused");
		expect(status.hidden).toBe(true);
		startInitialReviewScan("manual");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Checking Zotero/Obsidian match...");
		endInitialReviewScan("manual", "paused");
		expect(status.hidden).toBe(true);
		expect(createdNotices.at(-1)?.message).toContain("Nothing needs review");
	});

	it("warns when a manual check cannot reach Zotero without showing an empty status", () => {
		vi.useFakeTimers();
		vi.mocked(getMainWindow).mockReturnValue(window);
		try {
			const { status } = setup();
			startRescan({} as App);
			expect(status.hidden).toBe(true);
			vi.advanceTimersByTime(20000);
			expect(createdNotices.at(-1)?.message).toContain("Zotero has not started the check");
			expect(status.hidden).toBe(true);
		} finally {
			vi.mocked(getMainWindow).mockReturnValue(undefined);
			vi.useRealTimers();
		}
	});

	it("keeps a failed recovery visible even while automatic checks are paused", () => {
		const { status, button } = setup();
		startInitialReviewScan("recovery", true);
		endInitialReviewScan("recovery", "error", "Recovery failed");
		expect(status.hidden).toBe(false);
		expect(button.setText).toHaveBeenLastCalledWith("Zotero/Obsidian check failed");
		startInitialReviewScan("recovery", true);
		expect(status.hidden).toBe(true);
		endInitialReviewScan("recovery", "paused");
		expect(status.hidden).toBe(true);
	});

	it("explains why multiple updates need checking without acknowledging them", () => {
		const { button } = setup();
		for (const itemkey of ["ABC", "DEF", "GHI"]) {
			const entry = { ...item, itemkey };
			queueReview(entry, "Attachment links differ");
			markReviewUncertain(entry);
		}
		button.onclick?.();
		expect(state.groups[0].title).toBe("Check Zotero items (3)");
		expect(allReviews()).toHaveLength(3);
		expect(allReviews().every((entry) => entry.uncertain && !entry.awaitingAcknowledgement)).toBe(true);
	});

	it("walks through interrupted reviews without reopening the list and stops on cancel", async () => {
		const { button } = setup();
		for (const itemkey of ["ABC", "DEF", "GHI"]) markReviewUncertain({ ...item, itemkey });
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("cancel");
		button.onclick?.();
		state.select?.(state.groups[0]);
		await settle();
		expect(askNoteDecision).toHaveBeenCalledTimes(2);
		expect(vi.mocked(askNoteDecision).mock.calls.map((call) => call[4]?.itemkey)).toEqual(["ABC", "DEF"]);
		expect(allReviews()).toMatchObject([
			{ itemkey: "ABC", awaitingAcknowledgement: true },
			{ itemkey: "DEF", uncertain: true },
			{ itemkey: "GHI", uncertain: true },
		]);
	});

	it("labels a missing title and explains how to find the Zotero item", async () => {
		const { button } = setup();
		markReviewUncertain({ itemkey: "ABC", libraryURI: "library" });
		button.onclick?.();
		vi.mocked(askNoteDecision).mockResolvedValueOnce("cancel");
		state.selectItem?.(state.groups[0], allReviews()[0]);
		await settle();
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Obsidian could not identify a matching note");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).not.toContain("ABC");
		expect(vi.mocked(askNoteDecision).mock.calls[0][4]).toMatchObject({ title: "Open item in Zotero", itemkey: "ABC" });
		expect(allReviews()[0].uncertain).toBe(true);
	});

	it("compares duplicate notes locally instead of asking Zotero, and stops watching on cleanup", () => {
		const button = { setText: vi.fn(), title: "", onclick: undefined as (() => void) | undefined };
		const status = { hidden: false, createEl: () => button };
		const app = { workspace: { on: vi.fn(() => ({})), offref: vi.fn() }, metadataCache: { on: vi.fn(() => ({})), offref: vi.fn() } } as unknown as App;
		const settings = { litNotesFolder: "lit" };
		const cleanup = setupReviewStatus(app, status as unknown as HTMLElement, settings);
		queueReview(item, DUPLICATE_NOTES_REASON);
		button.onclick?.();
		state.selectItem?.(state.groups[0], allReviews()[0]);
		expect(compareDuplicateReview).toHaveBeenCalledWith(app, settings, allReviews()[0]);
		expect(requestedReviews()).toEqual([]);
		cleanup();
		expect(vi.mocked(watchDuplicateReviews).mock.results[0].value).toHaveBeenCalled();
	});

	it("requires an explicit check before clearing an interrupted operation", async () => {
		const { button } = setup();
		queueReview(item, "Attachment links differ", "lit/note.md");
		markReviewUncertain({ ...item, error: "Could not relink paper.pdf" });
		button.onclick?.();
		expect(state.groups.map((group) => group.kind)).toEqual(["uncertain"]);
		expect(state.groups[0].title).toBe("Check Zotero items (1)");
		vi.mocked(askNoteDecision).mockResolvedValueOnce("cancel");
		state.selectItem?.(state.groups[0], allReviews()[0]);
		await settle();
		expect(allReviews()).toHaveLength(1);
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Zotero could not confirm that an update finished");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Check that the files open");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Check that the links open the correct files");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Opening the note closes this dialog; return to Zotero reviews afterward.");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Confirming does not fix files or links; it allows normal updates to resume.");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Error details: Could not relink paper.pdf");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).not.toContain("Zotero item key:");
		expect(vi.mocked(askNoteDecision).mock.calls[0][4]).toEqual({
			title: "Work",
			itemkey: "ABC",
			libraryURI: "library",
			notePath: "lit/note.md",
			noteOpenFollowUp: "Return to Zotero reviews after checking the note.",
		});
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create");
		state.selectItem?.(state.groups[0], allReviews()[0]);
		await settle();
		expect(allReviews()).toMatchObject([{ awaitingAcknowledgement: true }]);
		expect(createdNotices.at(-1)?.message).toContain("Waiting for Zotero to acknowledge");
	});

	it("explains an unconfirmed attachment move and the checks before confirmation", async () => {
		const { button } = setup();
		queueReview(item, "Attachment links differ", "lit/note.md");
		markReviewUncertain({ ...item, operation: "attachment-move" });
		button.onclick?.();
		expect(state.groups[0].title).toBe("Check attachment repairs (1)");
		vi.mocked(askNoteDecision).mockResolvedValueOnce("cancel");
		state.selectItem?.(state.groups[0], allReviews()[0]);
		await settle();
		const [, title, message, buttons] = vi.mocked(askNoteDecision).mock.calls[0];
		expect(title).toBe("Check the attachment move");
		expect(message).toContain("Zotero tried to move attachments to the vault");
		expect(message).toContain("Current attachment state");
		expect(message).toContain("Check that the files open");
		expect(message).toContain("Check that the links open the correct files");
		expect(message).toContain("copies the attachment into the vault and links the copy in Zotero and Obsidian");
		expect(message).toContain("original stays in its current location");
		expect(message).toContain("delete it yourself after checking that the copy opens in both apps");
		expect(message).not.toContain("Confirming does not fix files or links");
		expect(message).not.toContain("Zotero item key:");
		expect(buttons.map((button) => button.label)).toContain("I've checked the item and note");
		expect(buttons.map((button) => button.label)).toContain("Copy and repair attachment links");
		expect(vi.mocked(askNoteDecision).mock.calls[0][4]?.recoveryPaths).toEqual([
			{ label: "Zotero attachment: PDF", path: "C:\\storage\\paper.pdf", status: "File exists." },
		]);
		expect(allReviews()[0].uncertain).toBe(true);
		vi.mocked(askNoteDecision).mockResolvedValueOnce("repair-attachments");
		state.selectItem?.(state.groups[0], allReviews()[0]);
		await settle();
		expect(requestedReviews()).toMatchObject([{ operation: "attachment-repair", uncertain: true, repairId: expect.any(String) }]);
	});

	it("starts all interrupted attachment repairs together and retains failed ones", async () => {
		const { button } = setup();
		const other = { ...item, itemkey: "DEF" };
		markReviewUncertain({ ...item, operation: "attachment-move" });
		markReviewUncertain({ ...other, operation: "attachment-move" });
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create");
		button.onclick?.();
		state.select?.(state.groups[0]);
		await settle();
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("original files remain");
		expect(requestedReviews()).toMatchObject([
			{ itemkey: "ABC", operation: "attachment-repair", repairId: expect.any(String) },
			{ itemkey: "DEF", operation: "attachment-repair", repairId: expect.any(String) },
		]);
		finishUncertainAttachmentRepair(reviewKey(item));
		failReview(other, "Could not copy");
		expect(allReviews()).toMatchObject([
			{ itemkey: "ABC", awaitingAcknowledgement: true },
			{ itemkey: "DEF", uncertain: true, uncertainReason: "Could not copy" },
		]);
		consumeUncertainAcknowledgement(item);
		expect(allReviews()).toMatchObject([{ itemkey: "DEF", uncertain: true }]);
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
	});

	it("starts an individual interrupted repair directly from the persistent overview", async () => {
		const { button } = setup();
		markReviewUncertain({ ...item, operation: "attachment-move" });
		button.onclick?.();
		vi.mocked(askNoteDecision).mockResolvedValueOnce("repair-attachments");
		state.selectItem?.(state.groups[0], allReviews()[0]);
		await settle();
		expect(requestedReviews()).toMatchObject([{ itemkey: "ABC", operation: "attachment-repair" }]);
	});

	it("allows an opened note to be edited and the overview to be reopened", () => {
		const { button, workspace } = setup();
		queueReview(item, "Attachment links differ");
		button.onclick?.();
		const first = state.selectItem;
		workspace.on.mock.calls[0][1]();
		button.onclick?.();
		expect(state.selectItem).not.toBe(first);
	});

	it("requires both library approval and backup confirmation before requesting corrections", async () => {
		const { button } = setup();
		queueReview(item, "Attachment links differ", "lit/note.md", "lit/note.md");
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("cancel");
		button.onclick?.();
		state.select?.(state.groups.find((group) => group.kind === "library"));
		await settle();
		expect(askNoteDecision).toHaveBeenCalledTimes(2);
		expect(requestedReviews()).toEqual([]);
		button.onclick?.();
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("create");
		state.select?.(state.groups.find((group) => group.kind === "library"));
		await settle();
		expect(requestedReviews()).toMatchObject([{ operation: "library-uri" }]);
		expect(createdNotices.at(-1)?.message).toContain("Correcting 1 note:");
		finishLibraryCorrection(reviewKey(item));
		expect(allReviews()).toHaveLength(1);
		expect(requestedReviews()).toMatchObject([{ operation: "library-recheck" }]);
		expect(createdNotices.at(-1)?.message).toContain("awaiting recheck");
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
		expect(button.title).toBe("1/1 checked, 1 rechecking");
		finishLibraryRecheck(reviewKey(item), false);
		expect(createdNotices.at(-1)?.message).toContain("Added zotero_library_uri library to 1 of 1 notes");
		expect(createdNotices.at(-1)?.message).toContain("1 review remains");
		expect(createdNotices.at(-1)?.message).toContain("status bar");
		expect(createdNotices.at(-1)?.timeout).toBe(0);
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
	});

	it("hides the status bar when rechecking resolves the last review", async () => {
		const { status, button } = setup();
		queueReview(item, "Add library", "lit/note.md", "lit/note.md");
		vi.mocked(askNoteDecision).mockResolvedValue("create");
		button.onclick?.();
		state.select?.(state.groups.find((group) => group.kind === "library"));
		await settle();
		finishLibraryCorrection(reviewKey(item));
		finishLibraryRecheck(reviewKey(item), true);
		expect(status.hidden).toBe(true);
		expect(createdNotices.at(-1)?.message).toContain("All Zotero reviews are complete.");
	});

	it("reports a failed recheck without claiming the URI correction failed", async () => {
		const { button } = setup();
		queueReview(item, "Add library", "lit/note.md", "lit/note.md");
		vi.mocked(askNoteDecision).mockResolvedValue("create");
		button.onclick?.();
		state.select?.(state.groups.find((group) => group.kind === "library"));
		await settle();
		finishLibraryCorrection(reviewKey(item));
		failReview(item, "The Zotero item is missing");
		expect(allReviews()).toMatchObject([{ reason: "The Zotero item is missing", requested: false }]);
		expect(createdNotices.at(-1)?.message).toContain("Added zotero_library_uri library to 1 of 1 notes");
		expect(createdNotices.at(-1)?.message).toContain("1 recheck failed");
	});



	it("shows the actions in a bulk note review before asking for a backup", async () => {
		const { button } = setup();
		queueReview(item, "Confirm attachment link changes", "lit/note.md", undefined, {
			summary: "Update attachment links; Move duplicate files to Trash after shared-reference checks",
			title: "Confirm attachment link changes", message: "Update the note.",
			buttons: [{ label: "Apply", value: "create" }, { label: "Cancel", value: "cancel" }],
		});
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("create");
		button.onclick?.();
		state.select?.(state.groups.find((group) => group.kind === "bulk-update"));
		await settle();
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Move duplicate files to Trash");
		expect(vi.mocked(askNoteDecision).mock.calls[1][1]).toContain("Back up the vault");
		expect(requestedReviews()).toMatchObject([{ operation: "note-update" }]);
	});

	it("asks how to resolve attachment conflicts, recommends newest, and confirms backup first", async () => {
		const { button } = setup();
		const attachmentMove = {
			baseDirectory: "C:\\vault\\attachments",
			attachments: [{
				itemkey: "ATT1", mode: "stored" as const, basename: "paper.html",
				sourcePath: "C:\\zotero\\paper.html", destinationPath: "C:\\vault\\attachments\\paper.html",
				resolution: "move" as const, conflict: true, identical: false,
				sourceMtime: 10, destinationMtime: 20,
			}],
			linkNoteFiles: [], trashNoteFiles: [], extras: [],
		};
		queueReview(item, "Stored Zotero attachment has not been moved into the vault", "lit/note.md", undefined, undefined, attachmentMove);
		vi.mocked(askNoteDecision).mockResolvedValueOnce("keep-zotero").mockResolvedValueOnce("cancel");
		button.onclick?.();
		const group = state.groups.find((entry) => entry.kind === "attachment-move");
		state.select?.(group);
		await settle();
		expect(vi.mocked(askNoteDecision).mock.calls[0][1]).toBe("Choose which attachment files to keep");
		expect(vi.mocked(askNoteDecision).mock.calls[0][3][0].label).toContain("Keep newest (recommended)");
		expect(vi.mocked(askNoteDecision).mock.calls[0][3][2].label).toContain("Skip; fix manually");
		expect(vi.mocked(askNoteDecision).mock.calls[1][2]).toContain("Back up your vault");
		expect(requestedReviews()).toEqual([]);

		vi.mocked(askNoteDecision).mockReset();
		vi.mocked(askNoteDecision).mockResolvedValueOnce("keep-zotero").mockResolvedValueOnce("create");
		button.onclick?.();
		state.select?.(state.groups.find((entry) => entry.kind === "attachment-move"));
		await settle();
		expect(requestedReviews()).toMatchObject([{
			operation: "attachment-move",
			attachmentStrategy: "zotero",
		}]);
		finishAttachmentCorrection(reviewKey(item));
		expect(createdNotices.at(-1)?.message).toContain("Linked Zotero attachments and Obsidian notes");
	});

	it("explains the move and starts it only after the backup confirmation", async () => {
		const { button } = setup();
		const attachmentMove = {
			baseDirectory: "C:\\vault\\attachments",
			attachments: [{
				itemkey: "ATT1", mode: "stored" as const, basename: "paper.pdf",
				sourcePath: "C:\\zotero\\paper.pdf", destinationPath: "C:\\vault\\attachments\\paper.pdf",
				resolution: "move" as const, conflict: false, identical: false, sourceMtime: 10,
			}],
			linkNoteFiles: [], trashNoteFiles: ["attachments/duplicate.pdf"],
			extras: [{ path: "attachments/extra.pdf", origin: "note" as const }],
		};
		queueReview(item, "Stored Zotero attachment", "lit/note.md", undefined, undefined, attachmentMove);
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("cancel");
		button.onclick?.();
		state.select?.(state.groups.find((entry) => entry.kind === "attachment-move"));
		await settle();
		const first = vi.mocked(askNoteDecision).mock.calls[0];
		expect(first[2]).toContain("Move 1 attachment for 1 note");
		expect(first[2]).toContain("Destination: C:\\vault\\attachments");
		expect(first[2]).toContain("- Move up to 1 duplicate or replaced empty file to Trash after safety checks.");
		expect(first[2]).toContain("No files will move yet.");
		expect(first[3][0].label).toBe("Continue to backup");
		expect(vi.mocked(askNoteDecision).mock.calls[1][3][0].label).toBe("Move attachments now");
		expect(requestedReviews()).toEqual([]);
		vi.mocked(askNoteDecision).mockReset();
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create").mockResolvedValueOnce("create");
		button.onclick?.();
		state.select?.(state.groups.find((entry) => entry.kind === "attachment-move"));
		await settle();
		expect(requestedReviews()).toMatchObject([{ operation: "attachment-move" }]);
		markReviewUncertain({ ...item, error: "Could not relink paper.pdf" });
		expect(button.setText).toHaveBeenLastCalledWith("Zotero reviews: 1");
		expect(button.title).toBe("0/1 checked, 1 needs checking");
		expect(createdNotices.at(-1)?.message).toContain("1 update may be incomplete");
		expect(createdNotices.at(-1)?.message).toContain("Zotero reviews in the status bar");
	});
});
