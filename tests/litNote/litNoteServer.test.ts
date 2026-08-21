import { describe, expect, it, vi, beforeEach } from "vitest";
import { startLitNoteServer } from "../../src/litNote/litNoteServer";
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
						if (path.includes("existing")) return new TFile(path, "lit/lit_notes"); // file exists
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
	});
});
