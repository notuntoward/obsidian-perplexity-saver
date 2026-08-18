import { describe, expect, it, vi } from "vitest";
import { startLitNoteServer } from "../../src/litNote/litNoteServer";
import * as http from "http";

vi.mock("http", () => {
	const mockServer = {
		listen: vi.fn(),
		on: vi.fn(),
		close: vi.fn((cb) => cb && cb()),
	};
	return {
		createServer: vi.fn(() => mockServer),
        default: { createServer: vi.fn(() => mockServer) }
	};
});

describe("Lit Note Server", () => {
	it("starts server on configured port", () => {
		const mockApp = {} as any;
		const mockSettings = { litNotePort: 27124 } as any;

		const server = startLitNoteServer(mockApp, mockSettings);

		expect(server.listen).toHaveBeenCalledWith(27124, "127.0.0.1", expect.any(Function));
	});

	it("handles server close", () => {
		const mockApp = {} as any;
		const mockSettings = { litNotePort: 27124 } as any;

		const server = startLitNoteServer(mockApp, mockSettings);
		server.close();

		expect(server.close).toHaveBeenCalled();
	});
});
