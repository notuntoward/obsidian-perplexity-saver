import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createdNotices } from "../__mocks__/obsidian";
import { allReviews, clearReviews, failReview, finishAttachmentCorrection, finishLibraryCorrection, finishLibraryRecheck, markReviewUncertain, queueReview, removeReview, requestedReviews, reviewKey, setReviewListener } from "../../src/litNote/pendingReviews";
import { setupReviewStatus } from "../../src/litNote/reviewStatus";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import type { App } from "obsidian";

const state = vi.hoisted(() => ({ groups: [] as Array<{ kind: string; uri?: string }>, select: undefined as ((group: unknown) => void) | undefined }));
vi.mock("commons/modal", () => ({
	ItemSuggestModal: class {
		constructor(_app: unknown, items: typeof state.groups, select: (group: unknown) => void) {
			state.groups = items;
			state.select = select;
		}
		open(): void {}
	},
}));
vi.mock("commons/workspace", () => ({ getMainWindow: () => undefined }));
vi.mock("commons/os", () => ({ raiseWindow: vi.fn() }));
vi.mock("../../src/litNote/decisionModal", () => ({ askNoteDecision: vi.fn() }));

const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };

function setup() {
	const button = { setText: vi.fn(), title: "", onclick: undefined as (() => void) | undefined };
	const status = { hidden: false, createEl: () => button };
	setupReviewStatus({} as App, status as unknown as HTMLElement);
	return { status, button };
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

	it("requires an explicit check before clearing an interrupted operation", async () => {
		const { button } = setup();
		queueReview(item, "Attachment links differ", "lit/note.md");
		markReviewUncertain({ ...item, error: "Could not relink paper.pdf" });
		button.onclick?.();
		expect(state.groups.map((group) => group.kind)).toEqual(["uncertain"]);
		state.select?.(state.groups[0]);
		vi.mocked(askNoteDecision).mockResolvedValueOnce("cancel");
		state.select?.(allReviews()[0]);
		await settle();
		expect(allReviews()).toHaveLength(1);
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("The operation may have changed files or links");
		expect(vi.mocked(askNoteDecision).mock.calls[0][2]).toContain("Error: Could not relink paper.pdf");
		expect(vi.mocked(askNoteDecision).mock.calls[0][4]).toEqual({
			title: "Work",
			itemkey: "ABC",
			libraryURI: "library",
			notePath: "lit/note.md",
		});
		vi.mocked(askNoteDecision).mockResolvedValueOnce("create");
		state.select?.(allReviews()[0]);
		await settle();
		expect(allReviews()).toMatchObject([{ awaitingAcknowledgement: true }]);
		expect(createdNotices.at(-1)?.message).toContain("Waiting for Zotero to acknowledge");
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
		expect(createdNotices.at(-1)?.message).toContain("Moved Zotero attachment files");
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
		expect(button.title).toBe("0/1 checked, 1 interrupted");
		expect(createdNotices.at(-1)?.message).toContain("Check 1 interrupted operation");
		expect(createdNotices.at(-1)?.message).toContain("Zotero reviews in the status bar");
	});
});
