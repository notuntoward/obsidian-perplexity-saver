import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	startLitNoteServer,
	raiseAndFocus,
	positionCursorTwoLinesPastEnd,
} from "../../src/litNote/litNoteServer";
import { askNoteDecision, withNoteDecisionSession } from "../../src/litNote/decisionModal";
import { askAuthorFormatDecision } from "../../src/litNote/authorFormatModal";
import { syncLitNote } from "../../src/litNote/syncLitNote";
import { findIdenticalAttachments } from "../../src/litNote/attachmentIdentity";
import { assertAttachmentsUnshared } from "../../src/litNote/attachmentSharing";
import { acknowledgeUncertainReview, allReviews, clearReviews, queueReview, requestAttachmentBatch, requestLibraryBatch, requestNoteBatch, requestReview, requestedReviews, reviewKey, setReviewListener } from "../../src/litNote/pendingReviews";
import { TFile } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import path from "path";
import type { ZoteroItemPayload } from "../../src/litNote/types";
import * as Obsidian from "obsidian";

const createdNotices = (
	Obsidian as unknown as {
		createdNotices: Array<{ message: string; timeout?: number }>;
	}
).createdNotices;



vi.mock("../../src/litNote/decisionModal", () => ({
	askNoteDecision: vi.fn(),
	withNoteDecisionSession: vi.fn(async (_app, run) => run({ ask: vi.fn() })),
}));

vi.mock("../../src/litNote/authorFormatModal", () => ({
	askAuthorFormatDecision: vi.fn(),
}));

vi.mock("../../src/litNote/syncLitNote", () => ({
	syncLitNote: vi.fn(),
	finishAttachmentMove: vi.fn(),
}));

vi.mock("../../src/litNote/attachmentIdentity", () => ({
	findIdenticalAttachments: vi.fn(),
}));

vi.mock("../../src/litNote/attachmentSharing", () => ({
	assertAttachmentsUnshared: vi.fn(),
}));

let requestHandler: (req: any, res: any) => Promise<void>;

vi.mock("http", () => {
	const mockServer = {
		listen: vi.fn(),
		on: vi.fn(),
		close: vi.fn((cb) => cb && cb()),
	};
	return {
		createServer: vi.fn((handler) => {
			requestHandler = handler;
			return mockServer;
		}),
		default: {
			createServer: vi.fn((handler) => {
				requestHandler = handler;
				return mockServer;
			}),
		},
	};
});

const FOLDER = "lit/lit_notes";

function makeApp(existingPaths: string[] = [], workspaceOverrides: any = {}) {
	const files = new Map<string, any>();
	for (const p of existingPaths) {
		files.set(p, Object.assign(Object.create(TFile.prototype), { path: p }));
	}
	const created: Array<{ path: string; body: string }> = [];
	const modified: Array<{ path: string; body: string }> = [];
	const writtenFrontmatter = new Map<string, any>();

	const app: any = {
		vault: {
			adapter: { exists: vi.fn(async () => false) },
			getAbstractFileByPath: vi.fn((path: string) =>
				path === FOLDER ? { path } : (files.get(path) ?? null)
			),
			create: vi.fn(async (path: string, body: string) => {
				const file = Object.assign(Object.create(TFile.prototype), { path });
				files.set(path, file);
				created.push({ path, body });
				return file;
			}),
			createFolder: vi.fn(async () => {}),
			modify: vi.fn(async (file: any, body: string) => {
				modified.push({ path: file.path, body });
			}),
			getFiles: vi.fn(() => Array.from(files.values())),
			getMarkdownFiles: vi.fn(() => Array.from(files.values())),
			getName: vi.fn(() => "TestVault"),
		},
		metadataCache: { getFileCache: vi.fn(() => undefined) },
		fileManager: {
			trashFile: vi.fn(async () => {}),
			processFrontMatter: vi.fn(async (file: any, cb: (fm: any) => void) => {
				const fm: any = {};
				cb(fm);
				writtenFrontmatter.set(file.path, fm);
			}),
		},
		workspace: {
			trigger: vi.fn(),
			layoutReady: true,
			getLeaf: vi.fn(() => ({
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: { editor: { focus: vi.fn() } },
				detach: vi.fn(),
			})),
			revealLeaf: vi.fn(),
			setActiveLeaf: vi.fn(),
			iterateAllLeaves: vi.fn(() => {}),
			getMostRecentLeaf: vi.fn(() => null),
			...workspaceOverrides,
		},
	};

	return { app, files, created, modified, writtenFrontmatter };
}

const createMockRes = () => {
	let resolveEnd: () => void;
	const endPromise = new Promise<void>((r) => (resolveEnd = r));
	const res = {
		writeHead: vi.fn(),
		end: vi.fn((_chunk?: string) => resolveEnd()),
		headersSent: false,
	};
	return { res, endPromise };
};

const createMockReq = (method: string, url: string, bodyObj: any) => {
	const bodyStr = JSON.stringify(bodyObj);
	return {
		method,
		url,
		[Symbol.asyncIterator]: async function* () {
			yield bodyStr;
		},
	};
};

async function post(app: any, bodyObj: any, settings: any = { litNotesFolder: FOLDER }) {
	startLitNoteServer(app, settings);
	const req = createMockReq("POST", "/lit-note", bodyObj);
	const { res, endPromise } = createMockRes();
	requestHandler(req, res);
	await endPromise;
	return JSON.parse((res.end as any).mock.calls[0][0]);
}

async function getReviews(app: any) {
	startLitNoteServer(app, { litNotesFolder: FOLDER });
	const { res, endPromise } = createMockRes();
	requestHandler(createMockReq("GET", "/lit-note-review-requests?bulk=1", {}), res);
	await endPromise;
	return JSON.parse((res.end as any).mock.calls[0][0]);
}

describe("Lit Note Server", () => {
	beforeEach(() => {
		setReviewListener();
		clearReviews();
		vi.clearAllMocks();
		vi.mocked(askNoteDecision).mockResolvedValue("overwrite");
		vi.mocked(askAuthorFormatDecision).mockResolvedValue("create-anyway");
		createdNotices.length = 0;
	});

	it("queues automatic decisions and opens only the selected review", async () => {
		const { app } = makeApp();
		const items = ["ONE", "TWO"].map((itemkey) => ({ title: itemkey, citekey: itemkey, itemkey, libraryURI: "library" }));
		const ask = vi.fn().mockResolvedValue("cancel");
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }))
			.mockImplementationOnce(async (_app, run) => run({ ask }));
		const reconcile: typeof syncLitNote = async (_app, _settings, item, _mode, prompt) => {
			await prompt("Fix attachment", "Fix its path.", [{ label: "Cancel", value: "cancel" }]);
			return { citekey: item.citekey, status: "skipped" };
		};
		vi.mocked(syncLitNote).mockImplementationOnce(reconcile).mockImplementationOnce(reconcile).mockImplementationOnce(reconcile);
		const queued = await post(app, { action: "sync", data: items });
		expect(queued.results.map((entry: { status: string }) => entry.status)).toEqual(["pending-review", "pending-review"]);
		expect(ask).not.toHaveBeenCalled();
		requestReview(reviewKey(items[0]));
		expect(requestedReviews().map((entry) => entry.itemkey)).toEqual(["ONE"]);
		await post(app, { action: "review-sync", data: [items[0]] });
		expect(ask).toHaveBeenCalledTimes(1);
		expect(requestedReviews()).toEqual([]);
		const reviews: string[] = [];
		setReviewListener((entries) => reviews.splice(0, reviews.length, ...entries.map((entry) => entry.itemkey)));
		expect(reviews).toEqual(["ONE", "TWO"]);
	});

	it("holds an interrupted review until the running request finishes and the user checks both apps", async () => {
		const { app } = makeApp();
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Attachment links differ");
		requestReview(reviewKey(item));
		let release!: () => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => { release = resolve; });
		const startedPromise = new Promise<void>((resolve) => { started = resolve; });
		vi.mocked(syncLitNote).mockImplementationOnce(async () => {
			started();
			await running;
			return { citekey: item.citekey, status: "skipped" };
		});
		const original = post(app, { action: "review-sync", data: [item] });
		await startedPromise;
		await post(app, { action: "review-uncertain", itemkey: item.itemkey, libraryURI: item.libraryURI });
		expect((await getReviews(app)).requests).toEqual([]);
		expect((await getReviews(app)).pending).toMatchObject([{ itemkey: "ABC", uncertain: true }]);
		const listener = vi.fn();
		setReviewListener(listener);
		await post(app, { action: "review-uncertain", itemkey: item.itemkey, libraryURI: item.libraryURI });
		expect(listener).toHaveBeenCalledTimes(1);
		await post(app, { action: "review-failed", itemkey: item.itemkey, libraryURI: item.libraryURI, error: "Request timed out after 120000 ms" });
		expect(allReviews()[0].reason).toBe("Attachment links differ");
		expect(() => acknowledgeUncertainReview(reviewKey(item))).toThrow("still processing");
		release();
		await original;
		expect(allReviews()).toMatchObject([{ itemkey: "ABC", uncertain: true }]);
		const blockedSync = await post(app, { action: "sync", data: [item] });
		const blockedUpdate = await post(app, { action: "update", data: [item] });
		expect(blockedSync.results[0].status).toBe("pending-review");
		expect(blockedUpdate.results[0].error).toContain("Check the interrupted operation");
		expect(syncLitNote).toHaveBeenCalledTimes(1);
		acknowledgeUncertainReview(reviewKey(item));
		expect((await getReviews(app)).acknowledgedUncertain).toEqual([{ itemkey: "ABC", libraryURI: "library" }]);
		await post(app, { action: "review-uncertain", itemkey: item.itemkey, libraryURI: item.libraryURI });
		expect(allReviews()).toMatchObject([{ itemkey: "ABC", awaitingAcknowledgement: true }]);
		expect(() => requestReview(reviewKey(item))).toThrow("Wait for Zotero");
		expect((await post(app, { action: "sync", data: [item] })).results[0].status).toBe("pending-review");
		await post(app, { action: "review-uncertain-acknowledged", itemkey: item.itemkey, libraryURI: item.libraryURI });
		expect(allReviews()).toEqual([]);
		queueReview(item, "Attachment links differ");
		requestReview(reviewKey(item));
		await post(app, { action: "review-uncertain", itemkey: item.itemkey, libraryURI: item.libraryURI });
		expect(allReviews()).toMatchObject([{ itemkey: "ABC", uncertain: true }]);
	});

	it("recreates an interrupted review reported after Obsidian restarts", async () => {
		const { app } = makeApp();
		const identity = { itemkey: "ABC", libraryURI: "library" };
		await post(app, { action: "review-uncertain", ...identity, error: "Could not relink paper.pdf" });
		clearReviews();
		await post(app, { action: "review-uncertain", ...identity, error: "Could not relink paper.pdf" });
		const state = await getReviews(app);
		expect(state.pending).toEqual([{ ...identity, uncertain: true }]);
		expect(state.requests).toEqual([]);
		expect(allReviews()[0].uncertainReason).toBe("Could not relink paper.pdf");
	});

	it("restores the title and note link for an unknown outcome using its Zotero identity", async () => {
		const notePath = `${FOLDER}/paper.md`;
		const { app } = makeApp([notePath]);
		app.metadataCache.getFileCache.mockReturnValue({ frontmatter: {
			category: ["literaturenote"], title: "A useful paper", zotero_item_key: "ABC", zotero_library_uri: "library",
		} });
		await post(app, { action: "review-uncertain", itemkey: "ABC", libraryURI: "library" });
		expect(allReviews()).toMatchObject([{
			itemkey: "ABC", title: "A useful paper", notePath, uncertain: true,
		}]);
		expect(requestedReviews()).toEqual([]);
		clearReviews();
		await post(app, { action: "review-uncertain", itemkey: "ABC", libraryURI: "library" });
		expect(allReviews()).toMatchObject([{ title: "A useful paper", notePath, uncertain: true }]);
	});

	it("does not associate a note from another library or an ambiguous match", async () => {
		const first = `${FOLDER}/first.md`;
		const second = `${FOLDER}/second.md`;
		const { app } = makeApp([first, second]);
		const frontmatter = new Map([
			[first, { category: ["literaturenote"], title: "First", zotero_item_key: "ABC", zotero_library_uri: "other" }],
			[second, { category: ["literaturenote"], title: "Second", zotero_item_key: "ABC", zotero_library_uri: "other" }],
		]);
		app.metadataCache.getFileCache.mockImplementation((file: TFile) => ({ frontmatter: frontmatter.get(file.path) }));
		await post(app, { action: "review-uncertain", itemkey: "ABC", libraryURI: "library" });
		expect(allReviews()).toMatchObject([{ title: "ABC", notePath: undefined, uncertain: true }]);
		frontmatter.get(first)!.zotero_library_uri = "library";
		frontmatter.get(second)!.zotero_library_uri = "library";
		await post(app, { action: "review-uncertain", itemkey: "ABC", libraryURI: "library" });
		expect(allReviews()).toMatchObject([{ title: "ABC", notePath: undefined, uncertain: true }]);
	});

	it("updates a blocked review when Zotero supplies its title and attempted action later", async () => {
		const { app } = makeApp();
		const identity = { itemkey: "ABC", libraryURI: "library" };
		await post(app, { action: "review-uncertain", ...identity });
		await post(app, { action: "review-uncertain", ...identity, title: "A useful paper", operation: "attachment-move" });
		expect(allReviews()).toMatchObject([{
			title: "A useful paper", uncertainOperation: "attachment-move", uncertain: true,
		}]);
		expect(requestedReviews()).toEqual([]);
	});

	it("refreshes attachment evidence without unblocking an uncertain review", async () => {
		const { app } = makeApp();
		const identity = { itemkey: "ABC", libraryURI: "library" };
		const attachmentPaths = [{ itemkey: "A", sourcePath: "C:\\storage\\a.pdf", destinationPath: "C:\\vault\\a.pdf" }];
		const attachments = [{ itemkey: "A", mode: "stored", isFile: true, path: "C:\\storage\\a.pdf" }];
		await post(app, { action: "review-uncertain", ...identity, operation: "attachment-move", attachments, attachmentPaths });
		expect(allReviews()).toMatchObject([{ uncertain: true, uncertainAttachments: attachments, uncertainAttachmentPaths: attachmentPaths }]);
		await post(app, { action: "review-uncertain", ...identity, operation: "attachment-move", attachmentCheckError: "Zotero unavailable" });
		expect(allReviews()).toMatchObject([{ uncertain: true, uncertainAttachments: undefined, uncertainAttachmentCheckError: "Zotero unavailable", uncertainAttachmentPaths: attachmentPaths }]);
		expect(requestedReviews()).toEqual([]);
	});

	it("keeps other requested reviews available while one outcome is unknown", async () => {
		const { app } = makeApp();
		const first = { title: "First", citekey: "first", itemkey: "FIRST", libraryURI: "library" };
		const second = { title: "Second", citekey: "second", itemkey: "SECOND", libraryURI: "library" };
		queueReview(first, "Review first");
		queueReview(second, "Review second");
		requestReview(reviewKey(first));
		requestReview(reviewKey(second));
		await post(app, { action: "review-uncertain", itemkey: first.itemkey, libraryURI: first.libraryURI });
		expect((await getReviews(app)).requests).toEqual([{ itemkey: "SECOND", libraryURI: "library" }]);
	});

	it("does not apply an earlier prepared plan while the item has an unknown outcome", async () => {
		const { app } = makeApp();
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "note" });
		const prepared = await post(app, { action: "sync", data: [item] });
		await post(app, { action: "review-uncertain", itemkey: item.itemkey, libraryURI: item.libraryURI });
		const applied = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [item] });
		expect(applied.results[0]).toMatchObject({
			status: "error", error: expect.stringContaining("Check the interrupted operation"),
		});
		expect(syncLitNote).toHaveBeenCalledTimes(1);
	});

	it("reports an automatic apply failure without opening a dialog", async () => {
		const { app } = makeApp();
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const ask = vi.fn();
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }))
			.mockImplementationOnce(async (_app, run) => run({ ask }));
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "note" })
			.mockRejectedValueOnce(new Error("Cannot update the note"));
		const prepared = await post(app, { action: "sync", data: [item] });
		const applied = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [item] });
		expect(applied.results[0]).toMatchObject({ status: "error", error: "Cannot update the note" });
		expect(ask).not.toHaveBeenCalled();
		const reasons: string[] = [];
		setReviewListener((entries) => reasons.splice(0, reasons.length, ...entries.map((entry) => entry.reason)));
		expect(reasons).toEqual(["Cannot update the note"]);
	});

	it("adds only the approved library URI and leaves other review work pending", async () => {
		const notePath = `${FOLDER}/note.md`;
		const { app } = makeApp([notePath]);
		const frontmatter = { category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC", personal: "keep" };
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => ({ frontmatter }) };
		app.fileManager.processFrontMatter.mockImplementation(async (_file: unknown, fn: (fm: typeof frontmatter) => void) => fn(frontmatter));
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Attachment links differ", notePath, notePath);
		requestLibraryBatch("library", [{ key: reviewKey(item), notePath }]);
		const result = await post(app, { action: "bulk-library-uri", data: [item] });
		expect(result.results[0].status).toBe("updated");
		expect(frontmatter).toEqual({ category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC", personal: "keep", zotero_library_uri: "library" });
		expect(app.fileManager.trashFile).not.toHaveBeenCalled();
		expect(app.vault.modify).not.toHaveBeenCalled();
		expect(allReviews()).toMatchObject([{ reason: "Attachment links differ", requested: true, operation: "library-recheck", libraryNotePath: undefined }]);
	});

	it("finishes a confirmed attachment move only when Zotero's result matches every planned operation", async () => {
		const { app } = makeApp();
		const base = path.resolve("vault", "attachments");
		const candidate = {
			baseDirectory: base,
			attachments: [
				{ itemkey: "S1", mode: "stored" as const, basename: "a.pdf", sourcePath: path.resolve("zotero", "a.pdf"), destinationPath: path.join(base, "a.pdf"), resolution: "move" as const, conflict: false, identical: false, sourceMtime: 1 },
				{ itemkey: "L2", mode: "linked" as const, basename: "copy.pdf", sourcePath: path.resolve("zotero", "copy.pdf"), destinationPath: path.join(base, "a.pdf"), resolution: "trash" as const, conflict: false, identical: true, sourceMtime: 1 },
			],
			linkNoteFiles: [path.join(base, "notes.txt")],
			trashNoteFiles: [],
			extras: [{ path: "attachments/notes.txt", origin: "note" as const }],
		};
		const item: ZoteroItemPayload = {
			title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library", libraryType: "user",
			linkedAttachmentBaseDirectory: base, linkedAttachmentBaseDirectoryValidated: true,
			attachments: [
				{ itemkey: "NEW1", mode: "linked", path: path.join(base, "a.pdf") },
				{ itemkey: "NEW3", mode: "linked", path: path.join(base, "notes.txt") },
			],
		};
		const moved = [
			{ itemkey: "S1", from: candidate.attachments[0].sourcePath, to: path.join(base, "a.pdf"), oldKey: "S1", newKey: "NEW1" },
			{ itemkey: "L2", from: candidate.attachments[1].sourcePath, to: path.join(base, "a.pdf"), trashed: true },
		];
		const linked = [{ path: path.join(base, "notes.txt"), newKey: "NEW3" }];
		const { finishAttachmentMove } = await import("../../src/litNote/syncLitNote");
		vi.mocked(finishAttachmentMove).mockClear();

		queueReview(item, "Zotero attachment is outside the Obsidian vault", "lit/note.md", undefined, undefined, candidate);
		requestAttachmentBatch([{ key: reviewKey(item), candidate }], "newest");
		const stillAttached = { ...item, attachments: [...(item.attachments ?? []), { itemkey: "L2", mode: "linked", path: candidate.attachments[1].sourcePath }] };
		expect((await post(app, { action: "attachment-move-complete", data: [stillAttached], moved, linked })).success).toBe(false);
		expect((await post(app, { action: "attachment-move-complete", data: [item], moved, linked: [] })).success).toBe(false);
		expect(finishAttachmentMove).not.toHaveBeenCalled();

		const result = await post(app, { action: "attachment-move-complete", data: [item], moved, linked });
		expect(result.results[0].status).toBe("updated");
		expect(finishAttachmentMove).toHaveBeenCalledWith(
			app,
			{ litNotesFolder: "lit/lit_notes" },
			item,
			candidate,
			[],
		);
		expect(allReviews()).toEqual([]);
	});

	it("verifies and accepts preserved originals for both move and duplicate operations", async () => {
		const { app } = makeApp();
		const base = path.resolve("vault", "attachments");
		const destination = path.join(base, "a.pdf");
		const candidate = {
			baseDirectory: base,
			attachments: [
				{ itemkey: "S1", mode: "stored" as const, basename: "a.pdf", sourcePath: path.resolve("zotero", "a.pdf"), destinationPath: destination, resolution: "move" as const, conflict: false, identical: false, sourceMtime: 1 },
				{ itemkey: "L2", mode: "linked" as const, basename: "copy.pdf", sourcePath: path.resolve("zotero", "copy.pdf"), destinationPath: destination, resolution: "trash" as const, conflict: false, identical: true, sourceMtime: 1 },
			],
			linkNoteFiles: [], trashNoteFiles: [], extras: [],
		};
		const item: ZoteroItemPayload = {
			title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library", libraryType: "user",
			linkedAttachmentBaseDirectory: base, linkedAttachmentBaseDirectoryValidated: true,
			attachments: [
				{ itemkey: "S1", mode: "stored", path: candidate.attachments[0].sourcePath },
				{ itemkey: "L2", mode: "linked", path: candidate.attachments[1].sourcePath },
				{ itemkey: "NEW1", mode: "linked", path: destination },
				{ itemkey: "NEW2", mode: "linked", path: destination },
			],
		};
		const moved = candidate.attachments.map((entry, index) => ({
			itemkey: entry.itemkey, from: entry.sourcePath, to: destination, newKey: `NEW${index + 1}`,
			preservedSource: true, referenceCheckFailed: true, ...(index === 0 ? { copied: true } : {}),
		}));
		const { finishAttachmentMove } = await import("../../src/litNote/syncLitNote");
		vi.mocked(finishAttachmentMove).mockClear();
		queueReview(item, "Zotero attachment is outside the Obsidian vault", "lit/note.md", undefined, undefined, candidate);
		requestAttachmentBatch([{ key: reviewKey(item), candidate }], "newest");

		const missingOriginal = { ...item, attachments: item.attachments?.filter((attachment) => attachment.itemkey !== "L2") };
		expect((await post(app, { action: "attachment-move-complete", data: [missingOriginal], moved, linked: [] })).success).toBe(false);
		expect(finishAttachmentMove).not.toHaveBeenCalled();
		const result = await post(app, { action: "attachment-move-complete", data: [item], moved, linked: [] });
		expect(result.results[0].status).toBe("updated");
		expect(finishAttachmentMove).toHaveBeenCalledWith(app, { litNotesFolder: "lit/lit_notes" }, item, candidate,
			moved.map(({ itemkey, from, to, copied, referenceCheckFailed }) => ({
				itemkey, from, to, ...(copied ? { copied: true } : {}), referenceCheckFailed,
			})));
	});

	it("does not send bulk operations to an older companion", async () => {
		const { app } = makeApp();
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Attachment links differ", "note.md", "note.md");
		requestLibraryBatch("library", [{ key: reviewKey(item), notePath: "note.md" }]);
		startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
		const getRequests = async (url: string) => {
			const { res, endPromise } = createMockRes();
			void requestHandler(createMockReq("GET", url, {}), res);
			await endPromise;
			return JSON.parse(res.end.mock.calls[0][0] as string);
		};
		expect((await getRequests("/lit-note-review-requests")).requests).toEqual([]);
		expect((await getRequests("/lit-note-review-requests?bulk=1")).requests).toEqual([
			{ itemkey: "ABC", libraryURI: "library", operation: "library-uri" },
		]);
	});

	it("offers the URI group for an automatic attachment review with a missing library", async () => {
		const notePath = `${FOLDER}/note.md`;
		const { app } = makeApp([notePath]);
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => ({ frontmatter: { category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC" } }) };
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		vi.mocked(syncLitNote).mockImplementationOnce(async (_app, _settings, current, _mode, prompt) => {
			await prompt("Attachment links differ", "Choose links.", [{ label: "Cancel", value: "cancel" }]);
			return { citekey: current.citekey, status: "skipped" };
		});
		await post(app, { action: "sync", data: [item] });
		expect(allReviews()).toMatchObject([{ reason: "Attachment links differ", libraryNotePath: notePath }]);
	});

	it("finishes a URI batch only after rechecking the remaining review", async () => {
		const notePath = `${FOLDER}/note.md`;
		const { app } = makeApp([notePath]);
		const fm = { category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC" };
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => ({ frontmatter: fm }) };
		app.fileManager.processFrontMatter.mockImplementation(async (_file: unknown, fn: (value: typeof fm) => void) => fn(fm));
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Add library", notePath, notePath);
		requestLibraryBatch("library", [{ key: reviewKey(item), notePath }]);
		await post(app, { action: "bulk-library-uri", data: [item] });
		expect(requestedReviews()).toMatchObject([{ operation: "library-recheck" }]);
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "skipped" });
		await post(app, { action: "review-recheck", data: [item] });
		expect(allReviews()).toEqual([]);
		expect(requestedReviews()).toEqual([]);
	});

	it("keeps the refreshed remaining review after a URI batch", async () => {
		const notePath = `${FOLDER}/note.md`;
		const { app } = makeApp([notePath]);
		const fm = { category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC" };
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => ({ frontmatter: fm }) };
		app.fileManager.processFrontMatter.mockImplementation(async (_file: unknown, fn: (value: typeof fm) => void) => fn(fm));
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Add library", notePath, notePath);
		requestLibraryBatch("library", [{ key: reviewKey(item), notePath }]);
		await post(app, { action: "bulk-library-uri", data: [item] });
		vi.mocked(syncLitNote).mockImplementationOnce(async (_app, _settings, current, _mode, prompt) => {
			await prompt("Attachment links differ", "Choose links.", [{ label: "Cancel", value: "cancel" }]);
			return { citekey: current.citekey, status: "skipped" };
		});
		await post(app, { action: "review-recheck", data: [item] });
		expect(allReviews()).toMatchObject([{ reason: "Attachment links differ", requested: false, libraryNotePath: undefined }]);
		expect(requestedReviews()).toEqual([]);
	});

	it("waits for the corrected URI to be indexed before rechecking", async () => {
		const notePath = `${FOLDER}/note.md`;
		const { app } = makeApp([notePath]);
		const original = { category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC" };
		let indexed: Record<string, unknown> = original;
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => ({ frontmatter: indexed }) };
		app.fileManager.processFrontMatter.mockImplementation(async (_file: unknown, fn: (value: Record<string, unknown>) => void) => fn({ ...original }));
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Add library", notePath, notePath);
		requestLibraryBatch("library", [{ key: reviewKey(item), notePath }]);
		await post(app, { action: "bulk-library-uri", data: [item] });
		const waiting = await post(app, { action: "review-recheck", data: [item] });
		expect(waiting.results[0].status).toBe("waiting-index");
		expect(syncLitNote).not.toHaveBeenCalled();
		expect(requestedReviews()).toMatchObject([{ operation: "library-recheck" }]);
		indexed = { ...original, zotero_library_uri: "library" };
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "skipped" });
		await post(app, { action: "review-recheck", data: [item] });
		expect(allReviews()).toEqual([]);
	});

	it("leaves a review when the corrected URI never appears in the index", async () => {
		const notePath = `${FOLDER}/note.md`;
		const { app } = makeApp([notePath]);
		const fm = { category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC" };
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => ({ frontmatter: fm }) };
		app.fileManager.processFrontMatter.mockImplementation(async (_file: unknown, fn: (value: Record<string, unknown>) => void) => fn({ ...fm }));
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Add library", notePath, notePath);
		requestLibraryBatch("library", [{ key: reviewKey(item), notePath }]);
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			await post(app, { action: "bulk-library-uri", data: [item] });
			clock.mockReturnValue(17000);
			await post(app, { action: "review-recheck", data: [item] });
			expect(allReviews()).toMatchObject([{ requested: false, reason: expect.stringContaining("could not be verified") }]);
			expect(requestedReviews()).toEqual([]);
			expect(syncLitNote).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	it("clears a completed URI-only review after a read-only recheck", async () => {
		const { app } = makeApp();
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Add the Zotero library and update the note");
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "skipped" });
		const result = await post(app, { action: "review-recheck", data: [item] });
		expect(result.results[0].status).toBe("skipped");
		expect(allReviews()).toEqual([]);
		expect(app.vault.modify).not.toHaveBeenCalled();
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});

	it("keeps a review when a read-only recheck finds other changes", async () => {
		const { app } = makeApp();
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => undefined };
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Add the Zotero library and update the note");
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "unchanged" });
		const result = await post(app, { action: "review-recheck", data: [item] });
		expect(result.results[0].status).toBe("pending-review");
		expect(allReviews()).toMatchObject([{ reason: "Note changes need confirmation" }]);
		expect(app.vault.modify).not.toHaveBeenCalled();
	});

	it("does not overwrite a library URI added after approval", async () => {
		const notePath = `${FOLDER}/note.md`;
		const { app } = makeApp([notePath]);
		const indexed = { category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC" };
		const current = { ...indexed, zotero_library_uri: "other-library" };
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = { getFileCache: () => ({ frontmatter: indexed }) };
		app.fileManager.processFrontMatter.mockImplementation(async (_file: unknown, fn: (fm: typeof current) => void) => fn(current));
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		queueReview(item, "Attachment links differ", notePath, notePath);
		requestLibraryBatch("library", [{ key: reviewKey(item), notePath }]);
		const result = await post(app, { action: "bulk-library-uri", data: [item] });
		expect(result.results[0].status).toBe("error");
		expect(current.zotero_library_uri).toBe("other-library");
		expect(allReviews()[0]).toMatchObject({ requested: false, reason: expect.stringContaining("identity changed") });
	});

	it("revalidates and applies a selected yes-or-no bulk update without opening a dialog", async () => {
		const { app } = makeApp();
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const summary = "Update attachment links; Move duplicate files to Trash after shared-reference checks";
		const buttons = [{ label: "Apply", value: "create" as const }, { label: "Cancel", value: "cancel" as const }];
		const reconcile: typeof syncLitNote = async (_app, _settings, current, _mode, prompt, options) => {
			await prompt("Confirm attachment link changes", "Update the note.", buttons, undefined, undefined, summary);
			if (options?.prepareOnly) return { citekey: current.citekey, status: "prepared", snapshot: "note" };
			await options?.beforeApply?.();
			return { citekey: current.citekey, status: "updated" };
		};
		vi.mocked(syncLitNote).mockImplementationOnce(reconcile).mockImplementationOnce(reconcile).mockImplementationOnce(reconcile);
		const ask = vi.fn();
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }))
			.mockImplementationOnce(async (_app, run) => run({ ask }))
			.mockImplementationOnce(async (_app, run) => run({ ask }));
		await post(app, { action: "sync", data: [item] });
		expect(allReviews()[0].proposal?.summary).toBe(summary);
		requestNoteBatch(summary, [{ key: reviewKey(item), proposal: allReviews()[0].proposal! }]);
		const prepared = await post(app, { action: "bulk-review-sync", data: [item] });
		expect(prepared.results[0].status).toBe("prepared");
		expect(requestedReviews()).toHaveLength(1);
		const applied = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [item] });
		expect(applied.results[0].status).toBe("updated");
		expect(allReviews()).toEqual([]);
		expect(ask).not.toHaveBeenCalled();
	});

	it("does not apply a bulk update when its proposal has changed", async () => {
		const { app } = makeApp();
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const summary = "Update attachment links";
		const buttons = [{ label: "Apply", value: "create" as const }, { label: "Cancel", value: "cancel" as const }];
		vi.mocked(syncLitNote)
			.mockImplementationOnce(async (_app, _settings, current, _mode, prompt) => {
				await prompt("Confirm attachment link changes", "Original.", buttons, undefined, undefined, summary);
				return { citekey: current.citekey, status: "prepared", snapshot: "note" };
			})
			.mockImplementationOnce(async (_app, _settings, current, _mode, prompt) => {
				await prompt("Confirm attachment link changes", "Changed.", buttons, undefined, undefined, summary);
				return { citekey: current.citekey, status: "prepared", snapshot: "note" };
			});
		await post(app, { action: "sync", data: [item] });
		requestNoteBatch(summary, [{ key: reviewKey(item), proposal: allReviews()[0].proposal! }]);
		const result = await post(app, { action: "bulk-review-sync", data: [item] });
		expect(result.results[0]).toMatchObject({ status: "error", error: expect.stringContaining("proposed note changes changed") });
		expect(allReviews()[0]).toMatchObject({ requested: false, proposal: undefined });
	});

	it("starts server on configured port 27124", () => {
		const { app } = makeApp();
		const server = startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
		expect(server.listen).toHaveBeenCalledWith(27124, "127.0.0.1", expect.any(Function));
	});

	it("handles server close", () => {
		const { app } = makeApp();
		const server = startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
		server.close();
		expect(server.close).toHaveBeenCalled();
	});

	it.each(["create", "open"])("reports an invalid notes folder per item for %s", async (action) => {
		const { app } = makeApp();
		const json = await post(app, { action, data: [{ title: "Paper", citekey: "key" }] }, { litNotesFolder: "../outside" });
		expect(json.success).toBe(false);
		expect(json.results).toEqual([expect.objectContaining({
			citekey: "key",
			status: "error",
			error: expect.stringContaining("Perplexity Saver literature notes folder"),
		})]);
		expect(app.vault.create).not.toHaveBeenCalled();
		expect(app.vault.createFolder).not.toHaveBeenCalled();
	});

	it("reports a notes folder creation failure for each affected item", async () => {
		const { app } = makeApp();
		app.vault.createFolder.mockRejectedValue(new Error("Access denied"));
		const json = await post(app, { action: "create", data: [{ title: "Paper", citekey: "key" }] }, { litNotesFolder: "missing/folder" });
		expect(json.results[0]).toEqual(expect.objectContaining({
			status: "error",
			error: expect.stringContaining("Cannot create literature notes folder"),
		}));
		expect(json.results[0].error).toContain("Access denied");
		expect(app.vault.create).not.toHaveBeenCalled();
	});

	it("reports a note write failure with the target path and reason", async () => {
		const { app } = makeApp();
		app.vault.create.mockRejectedValue(new Error("Access denied"));
		const json = await post(app, { action: "create", data: [{ title: "Paper", citekey: "key" }] });
		expect(json.results[0].status).toBe("error");
		expect(json.results[0].error).toContain(`${FOLDER}/key.md`);
		expect(json.results[0].error).toContain("Access denied");
		expect(json.results[0].error).toContain("Perplexity Saver");
	});

	it("creates the note and explains an unresolved Zotero attachment", async () => {
		const { app, created } = makeApp();
		const json = await post(app, {
			action: "create",
			data: [{ title: "Paper", citekey: "key", attachments: [{ title: "Source PDF", isFile: true }] }],
		});
		expect(json.results[0].status).toBe("created");
		expect(created[0].body).toContain("Attachment unavailable in vault");
		expect(createdNotices.some((notice) =>
			notice.message.includes("Source PDF: Zotero could not resolve a file path")
		)).toBe(true);
	});

	it("checks attachments after choosing to create a missing note", async () => {
		const { app, created } = makeApp();
		vi.mocked(askNoteDecision).mockResolvedValue("create");
		const json = await post(app, {
			action: "open",
			data: [{ title: "Paper", citekey: "key", attachments: [{ title: "Stored PDF", isFile: true, mode: "stored" }] }],
		});
		expect(json.results[0].status).toBe("created");
		expect(created[0].body).toContain("Attachment unavailable in vault");
		expect(createdNotices.some((notice) => notice.message.includes("does not apply to stored files"))).toBe(true);
	});

	it("compares the linked base directory with the actual vault and reports failures", async () => {
		const { app } = makeApp();
		const root = process.cwd();
		app.vault.adapter = Object.assign(new FileSystemAdapter(), { getBasePath: () => root });
		expect(await post(app, { action: "check-attachment-base", baseDirectory: "" })).toMatchObject({ success: true, relationship: "unset" });
		expect(await post(app, { action: "check-attachment-base", baseDirectory: path.join(root, "src") })).toMatchObject({ success: true, relationship: "inside" });
		expect(await post(app, { action: "check-attachment-base", baseDirectory: path.dirname(root) })).toMatchObject({ success: true, relationship: "outside" });
		expect(await post(app, { action: "check-attachment-base", baseDirectory: path.join(root, "not-a-real-attachment-directory") })).toMatchObject({ success: false, error: expect.stringContaining("Cannot check") });
	});

	it.each(["sync", "update"])("routes %s batches to the reconciliation engine", async (action) => {
		const { app } = makeApp();
		vi.mocked(syncLitNote).mockResolvedValue({ citekey: "key", status: "updated" });
		const data = [{ citekey: "key", itemkey: "ABC", libraryURI: "library" }];
		const json = await post(app, { action, data });
		expect(json.results).toEqual([{ citekey: "key", status: "updated" }]);
		expect(syncLitNote).toHaveBeenCalledWith(
			app, expect.anything(), data[0], action === "sync" ? "auto" : "metadata",
			expect.any(Function), { prepareOnly: true }
		);
	});

	it("requires an unchanged Zotero payload and consumes the prepared plan once", async () => {
		const { app } = makeApp();
		vi.mocked(syncLitNote)
			.mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "original note" })
			.mockResolvedValueOnce({ citekey: "key", status: "updated" });
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const prepared = await post(app, { action: "sync", data: [item] });
		const token = prepared.results[0].token;
		expect(prepared.results[0].status).toBe("prepared");
		const applied = await post(app, { action: "apply-sync", token, data: [item] });
		expect(applied.results[0].status).toBe("updated");
		const reused = await post(app, { action: "apply-sync", token, data: [item] });
		expect(reused.results[0].status).toBe("error");
	});

	it("rejects a changed Zotero attachment without applying the plan", async () => {
		const { app } = makeApp();
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "original" });
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library", attachments: [{ path: "old.pdf" }] };
		const prepared = await post(app, { action: "sync", data: [item] });
		const changed = { ...item, attachments: [{ path: "new.pdf" }] };
		const applied = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [changed] });
		expect(applied.results[0].status).toBe("error");
		expect(syncLitNote).toHaveBeenCalledTimes(1);
	});

	it("requires an inventory of Zotero references before removing identical copies", async () => {
		const { app } = makeApp();
		const snapshot = (path: string) => ({ path, size: 4, mtime: 1, ctime: 1, sha256: "hash" });
		vi.mocked(syncLitNote).mockResolvedValueOnce({
			citekey: "key", status: "prepared", snapshot: "original", notePath: "lit/note.md",
			identicalAttachments: [{ note: snapshot("old.pdf"), zotero: snapshot("new.pdf") }],
		});
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const prepared = await post(app, { action: "sync", data: [item] });
		expect(prepared.results[0].needsAttachmentCheck).toBe(true);
		const applied = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [item] });
		expect(applied.results[0].status).toBe("error");
		expect(applied.results[0].error).toContain("references could not be verified");
		expect(syncLitNote).toHaveBeenCalledTimes(1);
	});

	it("rechecks file sharing and bytes before trashing an identical copy", async () => {
		const { app, files } = makeApp(["old.pdf", "new.pdf"]);
		const snapshot = (path: string) => ({ path, size: 4, mtime: 1, ctime: 1, sha256: "hash" });
		const pairs = [{ note: snapshot("old.pdf"), zotero: snapshot("new.pdf") }];
		vi.mocked(assertAttachmentsUnshared).mockResolvedValue(undefined);
		vi.mocked(findIdenticalAttachments).mockResolvedValue(pairs);
		vi.mocked(syncLitNote)
			.mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "original", notePath: "lit/note.md", identicalAttachments: pairs })
			.mockImplementationOnce(async (_app, _settings, item, _mode, _prompt, options) => {
				await options?.beforeApply?.();
				await options?.trashIdenticalAttachments?.(pairs, "lit/note.md");
				return { citekey: item.citekey, status: "updated" };
			});
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const prepared = await post(app, { action: "sync", data: [item] });
		const applied = await post(app, {
			action: "apply-sync", token: prepared.results[0].token, data: [item],
			zoteroAttachmentPaths: ["C:\\vault\\new.pdf"],
		});
		expect(applied.results[0].status).toBe("updated");
		expect(assertAttachmentsUnshared).toHaveBeenCalledTimes(2);
		expect(findIdenticalAttachments).toHaveBeenCalledWith(app, [files.get("old.pdf")], [files.get("new.pdf")]);
		expect(app.fileManager.trashFile).toHaveBeenCalledWith(files.get("old.pdf"));
	});

	it("does not trash a duplicate when the final content check changes", async () => {
		const { app } = makeApp(["old.pdf", "new.pdf"]);
		const snapshot = (path: string) => ({ path, size: 4, mtime: 1, ctime: 1, sha256: "hash" });
		const pairs = [{ note: snapshot("old.pdf"), zotero: snapshot("new.pdf") }];
		vi.mocked(assertAttachmentsUnshared).mockResolvedValue(undefined);
		vi.mocked(findIdenticalAttachments).mockResolvedValue([]);
		vi.mocked(syncLitNote)
			.mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "original", notePath: "lit/note.md", identicalAttachments: pairs })
			.mockImplementationOnce(async (_app, _settings, item, _mode, _prompt, options) => {
				await options?.beforeApply?.();
				await options?.trashIdenticalAttachments?.(pairs, "lit/note.md");
				return { citekey: item.citekey, status: "updated" };
			});
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const prepared = await post(app, { action: "sync", data: [item] });
		const applied = await post(app, {
			action: "apply-sync", token: prepared.results[0].token, data: [item],
			zoteroAttachmentPaths: ["C:\\vault\\new.pdf"],
		});
		expect(applied.results[0].status).toBe("error");
		expect(applied.results[0].error).toContain("changed before duplicate cleanup");
		expect(app.fileManager.trashFile).not.toHaveBeenCalled();
	});

	it("does not report success when the duplicate remains after trashing", async () => {
		const { app } = makeApp(["old.pdf", "new.pdf"]);
		const snapshot = (path: string) => ({ path, size: 4, mtime: 1, ctime: 1, sha256: "hash" });
		const pairs = [{ note: snapshot("old.pdf"), zotero: snapshot("new.pdf") }];
		vi.mocked(assertAttachmentsUnshared).mockResolvedValue(undefined);
		vi.mocked(findIdenticalAttachments).mockResolvedValue(pairs);
		app.vault.adapter.exists.mockResolvedValue(true);
		vi.mocked(syncLitNote)
			.mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "original", notePath: "lit/note.md", identicalAttachments: pairs })
			.mockImplementationOnce(async (_app, _settings, item, _mode, _prompt, options) => {
				await options?.beforeApply?.();
				await options?.trashIdenticalAttachments?.(pairs, "lit/note.md");
				return { citekey: item.citekey, status: "updated" };
			});
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const prepared = await post(app, { action: "sync", data: [item] });
		const applied = await post(app, {
			action: "apply-sync", token: prepared.results[0].token, data: [item],
			zoteroAttachmentPaths: ["C:\\vault\\new.pdf"],
		});
		expect(applied.results[0].status).toBe("error");
		expect(applied.results[0].error).toContain("was not moved to Trash");
	});

	it("rejects a changed Zotero change summary without applying the plan", async () => {
		const { app } = makeApp();
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "prepared", snapshot: "original" });
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library",
			zoteroChanges: { previousCitekey: "old", attachmentMoves: [{ itemkey: "ATT", from: "before", to: "after" }] } };
		const prepared = await post(app, { action: "sync", data: [item] });
		const changed = { ...item, zoteroChanges: { ...item.zoteroChanges, attachmentMoves: [] } };
		const applied = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [changed] });
		expect(applied.results[0].status).toBe("error");
		expect(syncLitNote).toHaveBeenCalledTimes(1);
	});

	it("rejects changed clickable citekey details during replay", async () => {
		const { app } = makeApp();
		const conflict = { title: "Work", itemkey: "ABC", libraryURI: "library", notePath: "lit/note.md", noteCitekey: "note", zoteroCitekey: "key" };
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) =>
			run({ ask: vi.fn().mockResolvedValue("use-zotero") }));
		vi.mocked(syncLitNote)
			.mockImplementationOnce(async (_app, _settings, item, _mode, prompt) => {
				await prompt("Citekeys differ", "Choose.", [{ label: "Use Zotero", value: "use-zotero" }], undefined, conflict);
				return { citekey: item.citekey, status: "prepared", snapshot: "original" };
			})
			.mockImplementationOnce(async (_app, _settings, item, _mode, prompt) => {
				await prompt("Citekeys differ", "Choose.", [{ label: "Use Zotero", value: "use-zotero" }], undefined, { ...conflict, notePath: "lit/other.md" });
				return { citekey: item.citekey, status: "updated" };
			});
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const prepared = await post(app, { action: "review-sync", data: [item] });
		const applied = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [item] });
		expect(applied.results[0].status).toBe("error");
		expect(applied.results[0].error).toContain("changed after the decision");
	});

	it("rejects changed citation-key check results before applying a decision", async () => {
		const { app } = makeApp();
		vi.mocked(syncLitNote).mockResolvedValueOnce({
			citekey: "key", status: "set-zotero-key", noteCitekey: "note",
			expectedZoteroKey: "key", snapshot: "original",
		});
		const item = { citekey: "key", itemkey: "ABC", libraryURI: "library",
			citationKeyCheck: { citekey: "note", matches: [] } };
		const prepared = await post(app, { action: "sync", data: [item] });
		const changed = { ...item, citationKeyCheck: { citekey: "note", matches: [
			{ title: "Other", citekey: "note", libraryURI: "library", itemkey: "OTHER" },
		] } };
		const verified = await post(app, { action: "validate-zotero-key", token: prepared.results[0].token, data: [changed] });
		expect(verified.results[0].status).toBe("error");
		expect(syncLitNote).toHaveBeenCalledTimes(1);
	});

	it("cancels the whole reconciliation batch without applying earlier plans", async () => {
		const { app } = makeApp();
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) =>
			run({ ask: vi.fn().mockResolvedValue("cancel") }));
		vi.mocked(syncLitNote)
			.mockResolvedValueOnce({ citekey: "first", status: "prepared", snapshot: "first note" })
			.mockImplementationOnce(async (_app, _settings, item, _mode, prompt) => {
				await prompt("Confirm", "Continue?", [{ label: "Cancel", value: "cancel" }]);
				return { citekey: item.citekey, status: "skipped" };
			});
		const result = await post(app, {
			action: "review-sync",
			data: [{ citekey: "first" }, { citekey: "second" }, { citekey: "third" }],
		});
		expect(result.results.map((entry: { status: string }) => entry.status)).toEqual(["skipped", "skipped", "skipped"]);
		expect(syncLitNote).toHaveBeenCalledTimes(2);
	});

	it("validates the note-key choice with a single-use token before Zotero changes", async () => {
		const { app } = makeApp();
		vi.mocked(syncLitNote)
			.mockResolvedValueOnce({ citekey: "zotero", status: "set-zotero-key", noteCitekey: "note", expectedZoteroKey: "zotero", snapshot: "note content" })
			.mockResolvedValueOnce({ citekey: "zotero", status: "set-zotero-key", noteCitekey: "note", expectedZoteroKey: "zotero", snapshot: "note content" });
		const item = { citekey: "zotero", itemkey: "ABC", libraryURI: "library" };
		const initial = await post(app, { action: "sync", data: [item] });
		const token = initial.results[0].token;
		const checked = await post(app, { action: "validate-zotero-key", token, data: [item] });
		expect(checked.results[0]).toMatchObject({ status: "skipped", noteCitekey: "note" });
		const reused = await post(app, { action: "validate-zotero-key", token, data: [item] });
		expect(reused.results[0].status).toBe("error");
	});

	it("reports an unexpected per-note failure without aborting the batch", async () => {
		const { app } = makeApp();
		vi.mocked(syncLitNote)
			.mockRejectedValueOnce(new Error("read failed"))
			.mockResolvedValueOnce({ citekey: "second", status: "updated" });
		const json = await post(app, {
			action: "sync",
			data: [{ citekey: "first" }, { citekey: "second" }],
		});
		expect(json.results).toEqual([
			{ citekey: "first", status: "error", error: "Unable to reconcile note: read failed" },
			{ citekey: "second", status: "updated" },
		]);
	});

	it("shows reconciliation errors with the item and note identity and preserves the response", async () => {
		const { app } = makeApp();
		const ask = vi.fn().mockResolvedValue("skip");
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }));
		const identity = { title: "Work", itemkey: "ABC", libraryURI: "library", notePath: "lit/note.md", noteCitekey: "key", zoteroCitekey: "key" };
		vi.mocked(syncLitNote).mockResolvedValueOnce({
			citekey: "key", status: "error", error: "The attachment is outside the open vault.", errorTitle: "Zotero attachment is outside the Obsidian vault", identity,
		});
		const json = await post(app, {
			action: "review-sync",
			data: [{ title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library", attachments: [{ path: "C:\\outside\\paper.pdf" }] }],
		});
		expect(ask).toHaveBeenCalledWith("Zotero attachment is outside the Obsidian vault", "The attachment is outside the open vault.",
			expect.any(Array), undefined, { ...identity, compact: true, attachmentProblems: undefined });
		expect(json.results).toEqual([{ citekey: "key", status: "error", error: "The attachment is outside the open vault." }]);
	});

	it("warns when Zotero changed before an attachment error", async () => {
		const { app } = makeApp();
		const ask = vi.fn().mockResolvedValue("skip");
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }));
		vi.mocked(syncLitNote).mockResolvedValueOnce({
			citekey: "key", status: "error", error: "Attachment is outside the vault.",
			attachmentProblems: [{ path: "C:\\outside\\paper.pdf", title: "Outside vault", problem: "Outside vault.", action: "Relink inside vault." }],
		});
		await post(app, {
			action: "review-sync",
			data: [{ title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library",
				zoteroChanges: { previousCitekey: "old", attachmentMoves: [] } }],
		});
		expect(ask).toHaveBeenCalledWith(expect.any(String), "Zotero's citation key has already changed. Check both apps before retrying.",
			expect.any(Array), undefined, expect.objectContaining({ attachmentProblems: expect.any(Array) }));
	});

	it("does not interrupt automatic retries with error dialogs", async () => {
		const { app } = makeApp();
		const ask = vi.fn().mockResolvedValue("skip");
		for (let i = 0; i < 4; i++) {
			vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }));
		}
		const item = { title: "Work", citekey: "key", itemkey: "DEDUP", libraryURI: "library" };
		const failure = { citekey: "key", status: "error" as const, error: "Attachment is missing." };
		vi.mocked(syncLitNote).mockResolvedValueOnce(failure).mockResolvedValueOnce(failure)
			.mockResolvedValueOnce({ citekey: "key", status: "skipped" }).mockResolvedValueOnce(failure);
		for (let i = 0; i < 4; i++) await post(app, { action: "sync", data: [item] });
		expect(ask).not.toHaveBeenCalled();
	});

	it("shows only the problematic attachment once and keeps details out of the protocol response", async () => {
		const { app } = makeApp();
		const ask = vi.fn().mockResolvedValue("skip");
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }));
		const identity = { title: "Work", itemkey: "ABC", libraryURI: "library", notePath: "lit/note.md", zoteroCitekey: "key" };
		const attachmentProblems = [{ path: "C:\\outside\\paper.pdf", title: "Zotero attachment is outside the Obsidian vault", problem: "Outside vault.", action: "Relink inside vault." }];
		vi.mocked(syncLitNote).mockResolvedValueOnce({ citekey: "key", status: "error", error: "Detailed error", errorTitle: attachmentProblems[0].title, identity, attachmentProblems });
		const json = await post(app, {
			action: "review-sync",
			data: [{ ...identity, citekey: "key", attachments: [{ path: "C:\\outside\\paper.pdf" }, { path: "C:\\vault\\good.pdf" }] }],
		});
		expect(ask).toHaveBeenCalledWith("Zotero attachment is outside the Obsidian vault",
			"",
			expect.any(Array), undefined, { ...identity, compact: true, attachmentProblems });
		expect(json.results).toEqual([{ citekey: "key", status: "error", error: "Detailed error" }]);
	});

	it("shows replay errors with the planned note when the plan has expired or changed", async () => {
		const { app } = makeApp();
		vi.mocked(syncLitNote).mockResolvedValueOnce({
			citekey: "key", status: "prepared", snapshot: "original", notePath: "lit/note.md",
		});
		const item = { title: "Work", citekey: "key", itemkey: "ABC", libraryURI: "library" };
		const prepared = await post(app, { action: "review-sync", data: [item] });
		const ask = vi.fn().mockResolvedValue("skip");
		vi.mocked(withNoteDecisionSession).mockImplementationOnce(async (_app, run) => run({ ask }));
		const result = await post(app, { action: "apply-sync", token: prepared.results[0].token, data: [{ ...item, title: "Changed" }] });
		expect(result.results[0].status).toBe("error");
		expect(ask).toHaveBeenCalledWith("Zotero item or update plan changed or expired", "Retry the update.",
			expect.any(Array), undefined, expect.objectContaining({ itemkey: "ABC", notePath: "lit/note.md" }));
	});

	it("returns indexed Zotero identities for literature notes", async () => {
		const { app } = makeApp([`${FOLDER}/note.md`]);
		app.vault.getMarkdownFiles = app.vault.getFiles;
		app.metadataCache = {
			getFileCache: () => ({ frontmatter: {
				category: ["literaturenote"], citekey: "key", zotero_item_key: "ABC", zotero_library_uri: "library",
			} }),
		};
		startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
		const { res, endPromise } = createMockRes();
		requestHandler(createMockReq("GET", "/lit-note-identities", null), res);
		await endPromise;
		expect(JSON.parse(res.end.mock.calls[0][0] as string).identities).toEqual([
			{ citekey: "key", itemkey: "ABC", libraryURI: "library", notePath: `${FOLDER}/note.md` },
		]);
	});

	it.each(["create", "open"])("explains how to resolve a missing citation key for %s", async (action) => {
		const { app, created } = makeApp();
		const json = await post(app, {
			action, data: [{ citekey: "", title: "Missing key" }],
		});
		expect(json.results).toEqual([{
			citekey: "",
			status: "error",
			error: "Missing citation key. Enter one in Zotero or check Better BibTeX.",
		}]);
		expect(created).toHaveLength(0);
	});

	describe("create action", () => {
		it.each(["create", "open"])("signals transcript folding after final cursor placement for %s", async (action) => {
			const { app } = makeApp();
			const setEphemeralState = vi.fn();
			const leaf = {
				openFile: vi.fn(), setEphemeralState,
				view: { editor: { focus: vi.fn(), setCursor: vi.fn() } },
				detach: vi.fn(),
			};
			app.workspace.getLeaf.mockReturnValue(leaf);
			vi.mocked(askNoteDecision).mockResolvedValue("create");
			const onNoteOpened = vi.fn(() => {
				expect(setEphemeralState).toHaveBeenLastCalledWith({
					cursor: { from: { line: 99999, ch: 0 }, to: { line: 99999, ch: 0 } },
					line: 99999,
				});
				expect(leaf.view.editor.setCursor).toHaveBeenCalled();
			});
			const json = await post(app, {
				action, data: [{ citekey: "new-note", title: "New Note" }],
			}, { litNotesFolder: FOLDER, onNoteOpened });
			expect(json.success).toBe(true);
			expect(onNoteOpened).toHaveBeenCalledWith(expect.objectContaining({ path: `${FOLDER}/new-note.md` }));
		});

		it("creates new notes and opens them", async () => {
			const { app, created } = makeApp();
			const json = await post(app, {
				action: "create",
				data: [{ citekey: "new-note", title: "New Note" }],
			});

			expect(json.success).toBe(true);
			expect(json.results).toEqual([{ citekey: "new-note", status: "created" }]);
			expect(created.map((c) => c.path)).toEqual([`${FOLDER}/new-note.md`]);
			expect(askNoteDecision).not.toHaveBeenCalled();
		});

		it("prompts in Obsidian and overwrites when the note exists", async () => {
			vi.mocked(askNoteDecision).mockResolvedValue("overwrite");
			const { app, created, modified } = makeApp([`${FOLDER}/existing.md`]);
			const json = await post(app, {
				action: "create",
				data: [{ citekey: "existing", title: "Existing" }],
			});

			expect(askNoteDecision).toHaveBeenCalledTimes(1);
			expect(json.results).toEqual([{ citekey: "existing", status: "overwritten" }]);
			expect(modified.map((m) => m.path)).toEqual([`${FOLDER}/existing.md`]);
			expect(created).toHaveLength(0);
		});

		it("opens the existing note without modifying it when the user chooses Open existing", async () => {
			vi.mocked(askNoteDecision).mockResolvedValue("open-existing");
			const { app, modified } = makeApp([`${FOLDER}/existing.md`]);
			const json = await post(app, {
				action: "create",
				data: [{ citekey: "existing", title: "Existing" }],
			});

			expect(json.results).toEqual([{ citekey: "existing", status: "opened" }]);
			expect(modified).toHaveLength(0);
		});

		it("skips existing notes but still creates the new ones when the user chooses Skip", async () => {
			vi.mocked(askNoteDecision).mockResolvedValue("skip");
			const { app, created } = makeApp([`${FOLDER}/existing.md`]);
			const json = await post(app, {
				action: "create",
				data: [
					{ citekey: "existing", title: "Existing" },
					{ citekey: "brand-new", title: "Brand New" },
				],
			});

			expect(json.results).toEqual([
				{ citekey: "existing", status: "skipped" },
				{ citekey: "brand-new", status: "created" },
			]);
			expect(created.map((c) => c.path)).toEqual([`${FOLDER}/brand-new.md`]);
		});

		it("cancels the whole batch when the user chooses Cancel", async () => {
			vi.mocked(askNoteDecision).mockResolvedValue("cancel");
			const { app, created, modified } = makeApp([`${FOLDER}/existing.md`]);
			const json = await post(app, {
				action: "create",
				data: [
					{ citekey: "existing", title: "Existing" },
					{ citekey: "brand-new", title: "Brand New" },
				],
			});

			expect(json.results).toEqual([
				{ citekey: "existing", status: "skipped" },
				{ citekey: "brand-new", status: "skipped" },
			]);
			expect(created).toHaveLength(0);
			expect(modified).toHaveLength(0);
		});

		it("focuses the existing note tab before prompting when note already exists", async () => {
			let openedBeforePrompt = false;
			const { app } = makeApp([`${FOLDER}/existing.md`], {
				getLeaf: vi.fn(() => ({
					openFile: vi.fn(() => {
						openedBeforePrompt = true;
					}),
					setEphemeralState: vi.fn(),
					view: { editor: { focus: vi.fn() } },
					detach: vi.fn(),
				})),
			});
			vi.mocked(askNoteDecision).mockImplementation(async () => {
				expect(openedBeforePrompt).toBe(true);
				return "open-existing";
			});

			const json = await post(app, {
				action: "create",
				data: [{ citekey: "existing", title: "Existing" }],
			});

			expect(askNoteDecision).toHaveBeenCalledTimes(1);
			expect(json.results).toEqual([{ citekey: "existing", status: "opened" }]);
		});

		it("returns HTTP 400 for an empty data array", async () => {
			const { app } = makeApp();
			startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
			const req = createMockReq("POST", "/lit-note", { action: "create", data: [] });
			const { res, endPromise } = createMockRes();
			requestHandler(req, res);
			await endPromise;
			expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
		});
	});

	describe("open action", () => {
		it("opens found notes without prompting", async () => {
			const { app } = makeApp([`${FOLDER}/found.md`]);
			const json = await post(app, {
				action: "open",
				data: [{ citekey: "found", title: "Found" }],
			});

			expect(askNoteDecision).not.toHaveBeenCalled();
			expect(json.results).toEqual([{ citekey: "found", status: "opened" }]);
		});

		it("prompts and creates missing notes when the user chooses Create", async () => {
			vi.mocked(askNoteDecision).mockResolvedValue("create");
			const { app, created } = makeApp();
			const json = await post(app, {
				action: "open",
				data: [{ citekey: "missing", title: "Missing" }],
			});

			expect(askNoteDecision).toHaveBeenCalledTimes(1);
			expect(json.results).toEqual([{ citekey: "missing", status: "created" }]);
			expect(created.map((c) => c.path)).toEqual([`${FOLDER}/missing.md`]);
		});

		it("reports missing (without creating) when the user chooses Skip", async () => {
			vi.mocked(askNoteDecision).mockResolvedValue("skip");
			const { app, created } = makeApp();
			const json = await post(app, {
				action: "open",
				data: [{ citekey: "missing", title: "Missing" }],
			});

			expect(json.results).toEqual([{ citekey: "missing", status: "missing" }]);
			expect(created).toHaveLength(0);
		});

		it("creates a blank tab for prompt and populates it when user chooses Create", async () => {
			const mockLeaf = {
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: { editor: { focus: vi.fn() } },
				detach: vi.fn(),
			};
			const { app } = makeApp([], {
				getLeaf: vi.fn(() => mockLeaf),
			});
			vi.mocked(askNoteDecision).mockResolvedValue("create");

			const json = await post(app, {
				action: "open",
				data: [{ citekey: "missing", title: "Missing" }],
			});

			expect(app.workspace.getLeaf).toHaveBeenCalledWith("tab");
			expect(app.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
			expect(mockLeaf.openFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: `${FOLDER}/missing.md` }),
				expect.anything()
			);
			expect(mockLeaf.detach).not.toHaveBeenCalled();
			expect(json.results).toEqual([{ citekey: "missing", status: "created" }]);
		});

		it("detaches the blank tab when user chooses Skip or Cancel", async () => {
			const mockLeaf = {
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: { editor: { focus: vi.fn() } },
				detach: vi.fn(),
			};
			const { app } = makeApp([], {
				getLeaf: vi.fn(() => mockLeaf),
			});
			vi.mocked(askNoteDecision).mockResolvedValue("skip");

			const json = await post(app, {
				action: "open",
				data: [{ citekey: "missing", title: "Missing" }],
			});

			expect(app.workspace.getLeaf).toHaveBeenCalledWith("tab");
			expect(mockLeaf.detach).toHaveBeenCalledTimes(1);
			expect(json.results).toEqual([{ citekey: "missing", status: "missing" }]);
		});

		it("restores the previously active leaf when a blank tab is cancelled", async () => {
			const previousEditor = { focus: vi.fn() };
			const previousLeaf = {
				view: { editor: previousEditor },
				parent: {},
			};
			const mockLeaf = {
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: { editor: { focus: vi.fn() } },
				detach: vi.fn(),
			};
			const { app } = makeApp([], {
				getMostRecentLeaf: vi.fn(() => previousLeaf),
				getLeaf: vi.fn(() => mockLeaf),
				iterateAllLeaves: vi.fn((cb: any) => {
					cb(previousLeaf);
				}),
			});
			vi.mocked(askNoteDecision).mockResolvedValue("cancel");

			const json = await post(app, {
				action: "open",
				data: [{ citekey: "missing", title: "Missing" }],
			});

			expect(mockLeaf.detach).toHaveBeenCalledTimes(1);
			expect(app.workspace.revealLeaf).toHaveBeenCalledWith(previousLeaf);
			expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(previousLeaf, { focus: true });
			expect(previousEditor.focus).toHaveBeenCalled();
			expect(json.results).toEqual([{ citekey: "missing", status: "missing" }]);
		});

		it("returns 200 and reports missing for the legacy citekey form", async () => {
			const { app } = makeApp();
			startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
			const req = createMockReq("POST", "/lit-note", {
				action: "open",
				citekey: "missing-key",
			});
			const { res, endPromise } = createMockRes();
			requestHandler(req, res);
			await endPromise;

			expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
			const json = JSON.parse((res.end as any).mock.calls[0][0]);
			expect(json.results).toEqual([{ citekey: "missing-key", status: "missing" }]);
			// Legacy requests carry no payload, so no prompt is shown.
			expect(askNoteDecision).not.toHaveBeenCalled();
		});

		it("returns HTTP 400 when neither data nor citekey is provided", async () => {
			const { app } = makeApp();
			startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
			const req = createMockReq("POST", "/lit-note", { action: "open" });
			const { res, endPromise } = createMockRes();
			requestHandler(req, res);
			await endPromise;
			expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
		});
	});

	describe("routing and window behaviour", () => {
		it("returns genuine HTTP 404 for invalid endpoints", async () => {
			const { app } = makeApp();
			startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
			const req = createMockReq("GET", "/wrong-endpoint", {});
			const { res, endPromise } = createMockRes();
			requestHandler(req, res);
			await endPromise;
			expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
		});

		it("activates, reveals, positions cursor, and focuses when opening a lit note", async () => {
			const mockLeaf = {
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: { editor: { focus: vi.fn() } },
			};
			const { app } = makeApp([`${FOLDER}/test-note.md`], {
				getLeaf: vi.fn(() => mockLeaf),
			});
			await post(app, { action: "open", data: [{ citekey: "test-note", title: "T" }] });

			expect(app.workspace.getLeaf).toHaveBeenCalledWith("tab");
			expect(mockLeaf.openFile).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ active: true })
			);
			expect(app.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
			expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(mockLeaf, { focus: true });
			expect(mockLeaf.setEphemeralState).toHaveBeenCalledWith(
				expect.objectContaining({
					cursor: { from: { line: 99999, ch: 0 }, to: { line: 99999, ch: 0 } },
					line: 99999,
				})
			);
		});

		it("handles deferred leaves by awaiting loadIfDeferred and positions cursor two blank lines below", async () => {
			let docText = "# Note Title\n> citation text";
			const mockEditor = {
				focus: vi.fn(),
				getValue: vi.fn(() => docText),
				lineCount: vi.fn(() => docText.split("\n").length),
				getLine: vi.fn((l: number) => docText.split("\n")[l] || ""),
				replaceRange: vi.fn((insert: string) => {
					docText += insert;
				}),
				setCursor: vi.fn(),
			};
			const mockLeaf: any = {
				isDeferred: true,
				loadIfDeferred: vi.fn(async () => {
					mockLeaf.isDeferred = false;
				}),
				getViewState: vi.fn(() => ({ state: { file: `${FOLDER}/deferred-note.md` } })),
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: { editor: mockEditor },
			};
			const { app } = makeApp([`${FOLDER}/deferred-note.md`], {
				iterateAllLeaves: vi.fn((cb: any) => cb(mockLeaf)),
				getLeaf: vi.fn(() => mockLeaf),
				revealLeaf: vi.fn(async () => {}),
			});
			await post(app, {
				action: "open",
				data: [{ citekey: "deferred-note", title: "D" }],
			});

			expect(mockLeaf.loadIfDeferred).toHaveBeenCalled();
			expect(app.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
			expect(mockEditor.replaceRange).toHaveBeenCalledWith("\n\n", expect.anything());
			expect(mockEditor.setCursor).toHaveBeenCalledWith({ line: 3, ch: 0 });
		});

		it("raiseAndFocus activates leaf and delegates to commons focusLeafAndWindow with raiseWindow", () => {
			const mockLeaf = {
				view: { containerEl: { ownerDocument: { defaultView: window } } },
			} as any;
			const mockApp = {
				workspace: {
					setActiveLeaf: vi.fn(),
				},
			} as any;

			raiseAndFocus(mockApp, mockLeaf);
			expect(mockApp.workspace.setActiveLeaf).toHaveBeenCalledWith(mockLeaf, { focus: true });
		});

		it("raiseAndFocus does nothing when leaf is null or undefined", () => {
			const mockApp = {
				workspace: {
					setActiveLeaf: vi.fn(),
				},
			} as any;

			expect(() => raiseAndFocus(mockApp, null)).not.toThrow();
			expect(() => raiseAndFocus(mockApp, undefined)).not.toThrow();
			expect(mockApp.workspace.setActiveLeaf).not.toHaveBeenCalled();
		});

		it("waits for onLayoutReady when layoutReady is false before opening file", async () => {
			let layoutReadyCallback: (() => void) | null = null;
			let fileOpened = false;
			const mockLeaf = {
				openFile: vi.fn(async () => {
					fileOpened = true;
				}),
				setEphemeralState: vi.fn(),
				view: { editor: { focus: vi.fn() } },
			};
			const { app } = makeApp([`${FOLDER}/layout-test.md`], {
				layoutReady: false,
				onLayoutReady: vi.fn((cb: () => void) => {
					layoutReadyCallback = cb;
				}),
				getLeaf: vi.fn(() => mockLeaf),
				revealLeaf: vi.fn(),
				setActiveLeaf: vi.fn(),
			});

			startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
			const req = createMockReq("POST", "/lit-note", {
				action: "open",
				data: [{ citekey: "layout-test", title: "L" }],
			});
			const { res, endPromise } = createMockRes();
			requestHandler(req, res);

			// Give event loop a cycle
			await new Promise((r) => setTimeout(r, 20));

			expect(app.workspace.onLayoutReady).toHaveBeenCalled();
			expect(fileOpened).toBe(false);

			// Now simulate Obsidian finishing layout initialization
			app.workspace.layoutReady = true;
			if (layoutReadyCallback) (layoutReadyCallback as () => void)();

			await endPromise;

			expect(fileOpened).toBe(true);
			expect(mockLeaf.openFile).toHaveBeenCalled();
			expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(mockLeaf, { focus: true });
		});
	});

	describe("cold start / vault-index races", () => {
		it("waits for the workspace, then detects an existing note instead of recreating it", async () => {
			vi.mocked(askNoteDecision).mockResolvedValue("overwrite");
			let layoutReadyCb: (() => void) | null = null;
			const { app, created, modified } = makeApp([`${FOLDER}/existing.md`], {
				layoutReady: false,
				onLayoutReady: vi.fn((cb: () => void) => {
					layoutReadyCb = cb;
				}),
			});

			startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
			const req = createMockReq("POST", "/lit-note", {
				action: "create",
				data: [{ citekey: "existing", title: "Existing" }],
			});
			const { res, endPromise } = createMockRes();
			requestHandler(req, res);

			// Nothing should be decided while the workspace is still loading.
			await new Promise((r) => setTimeout(r, 10));
			expect(askNoteDecision).not.toHaveBeenCalled();

			app.workspace.layoutReady = true;
			if (layoutReadyCb) (layoutReadyCb as () => void)();
			await endPromise;

			const json = JSON.parse((res.end as any).mock.calls[0][0]);
			expect(json.results).toEqual([{ citekey: "existing", status: "overwritten" }]);
			expect(modified.map((m) => m.path)).toEqual([`${FOLDER}/existing.md`]);
			// Regression: the existing note must NOT be recreated as a new file.
			expect(created).toHaveLength(0);
		});

		it("re-resolves the created file when vault.create resolves before the index updates", async () => {
			const { app, files } = makeApp();
			app.vault.create = vi.fn(async (path: string) => {
				// Simulate the vault index lagging: the file lands on disk but
				// create() returns null until the index catches up.
				files.set(path, Object.assign(Object.create(TFile.prototype), { path }));
				return null;
			});

			const json = await post(app, {
				action: "create",
				data: [{ citekey: "lagged", title: "Lagged" }],
			});

			expect(json.results).toEqual([{ citekey: "lagged", status: "created" }]);
		});

		it("reports a clear error (not a null 'path' TypeError) when a written note cannot be resolved", async () => {
			const { app } = makeApp();
			app.vault.create = vi.fn(async () => null);

			const json = await post(app, {
				action: "create",
				data: [{ citekey: "ghost", title: "Ghost" }],
			});

			expect(json.results[0].status).toBe("error");
			expect(json.results[0].error).toContain("could not be resolved");
			expect(json.results[0].error).not.toContain("reading 'path'");
		});

		describe("visual feedback notices and window focus", () => {
			it("shows a descriptive notice when a note is opened", async () => {
				const { app } = makeApp([`${FOLDER}/existing.md`]);
				await post(app, {
					action: "open",
					data: [{ citekey: "existing" }],
				});

				expect(
					createdNotices.some((n) =>
						n.message.includes("Opened literature note from Zotero: @existing")
					)
				).toBe(true);
			});

			it("shows a descriptive notice when a note is created", async () => {
				const { app } = makeApp();
				await post(app, {
					action: "create",
					data: [{ citekey: "brand-new", title: "Brand New" }],
				});

				expect(
					createdNotices.some((n) =>
						n.message.includes("Created literature note from Zotero: @brand-new")
					)
				).toBe(true);
			});

			it("shows batch notice when multiple notes are opened", async () => {
				const { app } = makeApp([`${FOLDER}/n1.md`, `${FOLDER}/n2.md`]);
				await post(app, {
					action: "open",
					data: [{ citekey: "n1" }, { citekey: "n2" }],
				});

				expect(
					createdNotices.some((n) =>
						n.message.includes("Opened 2 literature notes from Zotero")
					)
				).toBe(true);
			});

			it("does not show toast notice when user is prompted with an overwrite decision modal", async () => {
				const { app } = makeApp([`${FOLDER}/existing.md`]);
				await post(app, {
					action: "create",
					data: [{ citekey: "existing", title: "Existing", creators: [{ firstName: "John", lastName: "Doe" }] }],
				});

				expect(askNoteDecision).toHaveBeenCalled();
				expect(createdNotices).toHaveLength(0);
			});

			it("does not show toast notice when user is prompted with a create missing note modal", async () => {
				vi.mocked(askNoteDecision).mockResolvedValue("create");
				const { app } = makeApp();
				await post(app, {
					action: "open",
					data: [{ citekey: "missing-key", title: "Missing", creators: [{ firstName: "John", lastName: "Doe" }] }],
				});

				expect(askNoteDecision).toHaveBeenCalled();
				expect(createdNotices).toHaveLength(0);
			});

		});

		describe("validateAuthorNameFormat setting", () => {
			it("does not validate author formats when setting is false", async () => {
				const { app, created } = makeApp();
				const res = await post(
					app,
					{
						action: "create",
						data: [
							{
								citekey: "unformatted",
								title: "Unformatted Author",
								creators: [{ creatorType: "author", name: "Single Field No Comma" }],
							},
						],
					},
					{ litNotesFolder: FOLDER, validateAuthorNameFormat: false }
				);

				expect(askAuthorFormatDecision).not.toHaveBeenCalled();
				expect(res.success).toBe(true);
				expect(created).toHaveLength(1);
			});

			it("prompts author format decision on create batch when invalid author format found", async () => {
				const { app, created } = makeApp();
				vi.mocked(askAuthorFormatDecision).mockResolvedValue("create-anyway");

				const res = await post(
					app,
					{
						action: "create",
						data: [
							{
								citekey: "unformatted",
								title: "Unformatted Author",
								creators: [{ creatorType: "author", name: "John Doe" }],
							},
						],
					},
					{ litNotesFolder: FOLDER, validateAuthorNameFormat: true }
				);

				expect(askAuthorFormatDecision).toHaveBeenCalled();
				expect(res.results[0].status).toBe("created");
				expect(created).toHaveLength(1);
			});

			it("skips note creation when user chooses edit in Zotero", async () => {
				const { app, created } = makeApp();
				vi.mocked(askAuthorFormatDecision).mockResolvedValue("edit");

				const res = await post(
					app,
					{
						action: "create",
						data: [
							{
								citekey: "unformatted",
								title: "Unformatted Author",
								itemkey: "ZOT123",
								creators: [{ creatorType: "author", name: "John Doe" }],
							},
						],
					},
					{ litNotesFolder: FOLDER, validateAuthorNameFormat: true }
				);

				expect(askAuthorFormatDecision).toHaveBeenCalled();
				expect(res.results[0].status).toBe("skipped");
				expect(created).toHaveLength(0);
			});

			it("skips note creation when user chooses cancel", async () => {
				const { app, created } = makeApp();
				vi.mocked(askAuthorFormatDecision).mockResolvedValue("cancel");

				const res = await post(
					app,
					{
						action: "create",
						data: [
							{
								citekey: "unformatted",
								title: "Unformatted Author",
								creators: [{ creatorType: "author", name: "John Doe" }],
							},
						],
					},
					{ litNotesFolder: FOLDER, validateAuthorNameFormat: true }
				);

				expect(askAuthorFormatDecision).toHaveBeenCalled();
				expect(res.results[0].status).toBe("skipped");
				expect(created).toHaveLength(0);
			});

			it("validates author format during open batch when missing note is chosen for creation", async () => {
				const { app, created } = makeApp();
				vi.mocked(askNoteDecision).mockResolvedValue("create");
				vi.mocked(askAuthorFormatDecision).mockResolvedValue("cancel");

				const res = await post(
					app,
					{
						action: "open",
						data: [
							{
								citekey: "missing-key",
								title: "Missing Key",
								creators: [{ creatorType: "author", name: "Invalid Author" }],
							},
						],
					},
					{ litNotesFolder: FOLDER, validateAuthorNameFormat: true }
				);

				expect(askAuthorFormatDecision).toHaveBeenCalled();
				expect(res.results[0].status).toBe("skipped");
				expect(created).toHaveLength(0);
			});

			it("auto-corrects author name and creates note when user chooses auto-correct", async () => {
				const { app, created, writtenFrontmatter } = makeApp();
				vi.mocked(askAuthorFormatDecision).mockResolvedValue("auto-correct");

				const res = await post(
					app,
					{
						action: "create",
						data: [
							{
								citekey: "unformatted",
								title: "Unformatted Author",
								creators: [{ creatorType: "author", name: "John Doe" }],
							},
						],
					},
					{ litNotesFolder: FOLDER, validateAuthorNameFormat: true }
				);

				expect(askAuthorFormatDecision).toHaveBeenCalled();
				expect(res.results[0].status).toBe("created");
				expect(created).toHaveLength(1);
				const fm = writtenFrontmatter.get("lit/lit_notes/unformatted.md");
				expect(fm?.authors).toEqual(["Doe, John"]);
			});

			it("creates note as-is when user chooses create-anyway", async () => {
				const { app, created, writtenFrontmatter } = makeApp();
				vi.mocked(askAuthorFormatDecision).mockResolvedValue("create-anyway");

				const res = await post(
					app,
					{
						action: "create",
						data: [
							{
								citekey: "unformatted",
								title: "Unformatted Author",
								creators: [{ creatorType: "author", name: "John Doe" }],
							},
						],
					},
					{ litNotesFolder: FOLDER, validateAuthorNameFormat: true }
				);

				expect(askAuthorFormatDecision).toHaveBeenCalled();
				expect(res.results[0].status).toBe("created");
				expect(created).toHaveLength(1);
				const fm = writtenFrontmatter.get("lit/lit_notes/unformatted.md");
				expect(fm?.authors).toEqual(["John Doe"]);
			});
		});
	});

	describe("positionCursorTwoLinesPastEnd", () => {
		it("positions cursor on the blank line directly above # Transcript", () => {
			const noteText = [
				"> [!info]- &nbsp;[**Zotero**](zotero://select/items/123)",
				">",
				"> Smith (2024). YouTube Video.",
				"",
				"",
				"# Transcript",
				"",
				"[00:00](https://youtube.com/watch?v=123&t=0) Hello world",
			].join("\n");

			const lines = noteText.split("\n");
			const mockEditor = {
				getValue: () => noteText,
				lineCount: () => lines.length,
				getLine: (i: number) => lines[i] ?? "",
				setCursor: vi.fn(),
				scrollIntoView: vi.fn(),
				replaceRange: vi.fn(),
			};

			const targetLine = positionCursorTwoLinesPastEnd(mockEditor);

			// Line 5 is "# Transcript", so line 4 is the blank line directly above it
			expect(targetLine).toBe(4);
			expect(lines[4]).toBe("");
			expect(mockEditor.setCursor).toHaveBeenCalledWith({ line: 4, ch: 0 });
			expect(mockEditor.scrollIntoView).toHaveBeenCalledWith(
				{ from: { line: 4, ch: 0 }, to: { line: 4, ch: 0 } },
				true
			);
		});

		it("positions cursor at end of note when # Transcript is not present", () => {
			const noteText = [
				"> [!info]- &nbsp;[**Zotero**](zotero://select/items/123)",
				">",
				"> Smith (2024). Some Paper.",
				"",
				"",
			].join("\n");

			const lines = noteText.split("\n");
			const mockEditor = {
				getValue: () => noteText,
				lineCount: () => lines.length,
				getLine: (i: number) => lines[i] ?? "",
				setCursor: vi.fn(),
				scrollIntoView: vi.fn(),
				replaceRange: vi.fn(),
			};

			const targetLine = positionCursorTwoLinesPastEnd(mockEditor);
			expect(targetLine).toBe(lines.length - 1);
			expect(mockEditor.setCursor).toHaveBeenCalledWith({ line: lines.length - 1, ch: 0 });
		});

		it("positions cursor above the configured transcript heading", () => {
			const lines = ["> [!info]- links", "", "", "# Captions", "", "[00:00](u) Hello", "# Transcript"];
			const mockEditor = {
				getValue: () => lines.join("\n"),
				lineCount: () => lines.length,
				getLine: (i: number) => lines[i] ?? "",
				setCursor: vi.fn(),
				scrollIntoView: vi.fn(),
				replaceRange: vi.fn(),
			};

			expect(positionCursorTwoLinesPastEnd(mockEditor, true, "Captions")).toBe(2);
			expect(mockEditor.replaceRange).not.toHaveBeenCalled();
		});

		it("finds a transcript whose heading is no longer the configured name", () => {
			const cues = Array.from({ length: 5 }, (_, i) => `[0:0${i}](https://youtu.be/dQw4w9WgXcQ?t=${i} "${i}–${i + 1}") caption`);
			const lines = ["> [!info]- links", "", "", "## Old captions", ...cues];
			const mockEditor = {
				getValue: () => lines.join("\n"),
				lineCount: () => lines.length,
				getLine: (i: number) => lines[i] ?? "",
				setCursor: vi.fn(),
				scrollIntoView: vi.fn(),
				replaceRange: vi.fn(),
			};

			expect(positionCursorTwoLinesPastEnd(mockEditor, true, "Subtitles")).toBe(2);
		});
	});
});
