import { describe, it, expect, vi } from "vitest";
import { getDefaultDownloadsFolder, expandTilde } from "../src/watcher";
import * as os from "os";
import * as path from "path";

vi.mock("obsidian", () => ({
	Platform: {
		isMobile: false,
	},
	Notice: class {},
}));

describe("watcher core functions", () => {
	it("returns standard downloads folder", () => {
		const folder = getDefaultDownloadsFolder();
		const expected = path.join(os.homedir(), "Downloads");
		expect(folder).toBe(expected);
	});

	it("expands tilde paths correctly", () => {
		const expanded = expandTilde("~/SomeFolder");
		const expected = path.join(os.homedir(), "SomeFolder");
		expect(expanded).toBe(expected);
	});

	it("handles exact tilde parameter correctly", () => {
		const expanded = expandTilde("~");
		const expected = os.homedir();
		expect(expanded).toBe(expected);
	});

	it("does not change absolute/relative paths without tilde", () => {
		const inputPath = "/usr/bin/somepath";
		const expanded = expandTilde(inputPath);
		expect(expanded).toBe(inputPath);
	});
});
