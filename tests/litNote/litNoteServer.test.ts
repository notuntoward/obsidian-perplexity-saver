import { describe, expect, it, vi, beforeEach } from "vitest";
import { startLitNoteServer, focusObsidianWindow } from "../../src/litNote/litNoteServer";
import * as http from "http";
import { TFile } from "obsidian";

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

describe("Lit Note Server", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("starts server on configured port 27124", () => {
		const mockApp = {} as any;
		const mockSettings = { litNotesFolder: "lit/lit_notes" } as any;

		const server = startLitNoteServer(mockApp, mockSettings);

		expect(server.listen).toHaveBeenCalledWith(27124, "127.0.0.1", expect.any(Function));
	});

	it("handles server close", () => {
		const mockApp = {} as any;
		const mockSettings = { litNotesFolder: "lit/lit_notes" } as any;

		const server = startLitNoteServer(mockApp, mockSettings);
		server.close();

		expect(server.close).toHaveBeenCalled();
	});

	describe("Request Handler Regressions", () => {
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

		it("should return HTTP 200 (not 500) for application-level 'exists' errors to prevent Zotero client crashes", async () => {
			const mockApp = {
				vault: {
					getAbstractFileByPath: vi.fn((path) => {
						if (path === "lit/lit_notes") return { path }; // folder exists
						if (path.includes("existing")) return Object.assign(Object.create(TFile.prototype), { path }); // file exists
						return null;
					}),
					create: vi.fn(),
					createFolder: vi.fn(),
				},
				workspace: {
					getLeavesOfType: vi.fn(() => []),
					getLeaf: vi.fn(() => ({ openFile: vi.fn() })),
				}
			} as any;
			const mockSettings = { litNotesFolder: "lit/lit_notes" } as any;
			startLitNoteServer(mockApp, mockSettings);

			const req = createMockReq("POST", "/lit-note", {
				action: "create",
				data: [{ citekey: "existing" }],
			});
			const { res, endPromise } = createMockRes();

			requestHandler(req, res); // synchronous call
			await endPromise; // wait for response to finish

			// The regression: we should return 200 OK so the Zotero plugin parses the JSON correctly
			expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
			const responseJson = JSON.parse((res.end as any).mock.calls[0][0]);
			expect(responseJson).toEqual({ success: false, error: "exists" });
		});

		it("should return HTTP 200 (not 404) for application-level 'missing file' errors during open action", async () => {
			const mockApp = {
				vault: {
					getAbstractFileByPath: vi.fn((path) => {
						if (path === "lit/lit_notes") return { path }; // folder exists
						return null; // file missing
					}),
				},
			} as any;
			const mockSettings = { litNotesFolder: "lit/lit_notes" } as any;
			startLitNoteServer(mockApp, mockSettings);

			const req = createMockReq("POST", "/lit-note", {
				action: "open",
				citekey: "missing-key",
			});
			const { res, endPromise } = createMockRes();

			requestHandler(req, res);
			await endPromise;

			// The regression: we should return 200 OK so the Zotero plugin parses the JSON correctly,
			// instead of getting intercepted by a generic 404 HTTP handler
			expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
			const responseJson = JSON.parse((res.end as any).mock.calls[0][0]);
			expect(responseJson.success).toBe(false);
			expect(responseJson.error).toContain("Lit note not found");
		});

		it("should still return genuine HTTP 404 for invalid endpoints", async () => {
			const mockApp = {} as any;
			const mockSettings = {} as any;
			startLitNoteServer(mockApp, mockSettings);

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
				view: {
					editor: {
						focus: vi.fn(),
					},
				},
			};
			// Make view an instance of MarkdownView-like object or mock
			const mockApp = {
				vault: {
					getAbstractFileByPath: vi.fn((path) => {
						if (path === "lit/lit_notes") return { path };
						if (path.includes("test-note")) return Object.assign(Object.create(TFile.prototype), { path });
						return null;
					}),
				},
				workspace: {
					getLeavesOfType: vi.fn(() => []),
					getLeaf: vi.fn(() => mockLeaf),
					revealLeaf: vi.fn(),
					setActiveLeaf: vi.fn(),
				},
			} as any;
			const mockSettings = { litNotesFolder: "lit/lit_notes" } as any;
			startLitNoteServer(mockApp, mockSettings);

			const req = createMockReq("POST", "/lit-note", {
				action: "open",
				citekey: "test-note",
			});
			const { res, endPromise } = createMockRes();

			requestHandler(req, res);
			await endPromise;

			expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith("tab");
			expect(mockLeaf.openFile).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					active: true,
					eState: expect.objectContaining({
						cursor: { from: { line: 99999, ch: 0 }, to: { line: 99999, ch: 0 } },
						line: 99999,
					}),
				})
			);
			expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
			expect(mockApp.workspace.setActiveLeaf).toHaveBeenCalledWith(mockLeaf, { focus: true });
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

			const mockLeaf = {
				isDeferred: true,
				loadIfDeferred: vi.fn(async () => {
					mockLeaf.isDeferred = false;
				}),
				getViewState: vi.fn(() => ({ state: { file: "lit/lit_notes/deferred-note.md" } })),
				openFile: vi.fn(),
				setEphemeralState: vi.fn(),
				view: {
					editor: mockEditor,
				},
			};

			const mockApp = {
				vault: {
					getAbstractFileByPath: vi.fn((path) => {
						if (path === "lit/lit_notes") return { path };
						if (path.includes("deferred-note")) return Object.assign(Object.create(TFile.prototype), { path });
						return null;
					}),
				},
				workspace: {
					iterateAllLeaves: vi.fn((cb) => cb(mockLeaf)),
					getLeavesOfType: vi.fn(() => [mockLeaf]),
					getLeaf: vi.fn(() => mockLeaf),
					revealLeaf: vi.fn(async () => {}),
					setActiveLeaf: vi.fn(),
				},
			} as any;
			const mockSettings = { litNotesFolder: "lit/lit_notes" } as any;
			startLitNoteServer(mockApp, mockSettings);

			const req = createMockReq("POST", "/lit-note", {
				action: "open",
				citekey: "deferred-note",
			});
			const { res, endPromise } = createMockRes();

			requestHandler(req, res);
			await endPromise;

			expect(mockLeaf.loadIfDeferred).toHaveBeenCalled();
			expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
			expect(mockApp.workspace.setActiveLeaf).toHaveBeenCalledWith(mockLeaf, { focus: true });
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
	});
});