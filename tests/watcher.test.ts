import { describe, it, expect, vi } from "vitest";
import { getDefaultDownloadsFolder, expandTilde } from "../src/watcher";

vi.mock("obsidian", () => ({
	Platform: {
		isMobile: false,
	},
	Notice: class {},
}));

describe("watcher core functions", () => {
	it("returns standard downloads folder", () => {
		const folder = getDefaultDownloadsFolder();
		expect(folder).toContain("Downloads");
	});

	it("expands tilde paths correctly", () => {
		const expanded = expandTilde("~/SomeFolder");
		expect(expanded).not.toContain("~/");
		expect(expanded).toContain("SomeFolder");
	});
});
