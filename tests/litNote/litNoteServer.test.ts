import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	startLitNoteServer,
	focusObsidianWindow,
} from "../../src/litNote/litNoteServer";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import { TFile } from "obsidian";

vi.mock("../../src/litNote/decisionModal", () => ({
	askNoteDecision: vi.fn(),
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

	const app: any = {
		vault: {
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
		},
		fileManager: {
			processFrontMatter: vi.fn(async (_file: any, cb: (fm: any) => void) => cb({})),
		},
		workspace: {
			layoutReady: true,
			getLeaf: vi.fn(() => ({
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: { editor: { focus: vi.fn() } },
			})),
			revealLeaf: vi.fn(),
			setActiveLeaf: vi.fn(),
			iterateAllLeaves: vi.fn(() => {}),
			...workspaceOverrides,
		},
	};

	return { app, files, created, modified };
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

async function post(app: any, bodyObj: any) {
	startLitNoteServer(app, { litNotesFolder: FOLDER } as any);
	const req = createMockReq("POST", "/lit-note", bodyObj);
	const { res, endPromise } = createMockRes();
	requestHandler(req, res);
	await endPromise;
	return JSON.parse((res.end as any).mock.calls[0][0]);
}

describe("Lit Note Server", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(askNoteDecision).mockResolvedValue("overwrite");
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

	describe("create action", () => {
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

		it("focusObsidianWindow restores, shows, and focuses window when Electron remote is present", () => {
			const mockWin = {
				isMinimized: vi.fn(() => true),
				restore: vi.fn(),
				show: vi.fn(),
				focus: vi.fn(),
			};
			(globalThis as any).__electronRemote = { getCurrentWindow: () => mockWin };

			focusObsidianWindow();

			expect(mockWin.isMinimized).toHaveBeenCalled();
			expect(mockWin.restore).toHaveBeenCalled();
			expect(mockWin.show).toHaveBeenCalled();
			expect(mockWin.focus).toHaveBeenCalled();

			delete (globalThis as any).__electronRemote;
		});

		it("focusObsidianWindow falls back to window.focus when Electron remote is not present", () => {
			const mockWindowFocus = vi.fn();
			(window as any).focus = mockWindowFocus;

			expect(() => focusObsidianWindow()).not.toThrow();
			expect(mockWindowFocus).toHaveBeenCalled();
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
	});
});
