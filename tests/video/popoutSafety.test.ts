import { readdirSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// The viewer may live in a pop-out window, where the bare globals are the MAIN window's.
const files = [
	...readdirSync(path.resolve(__dirname, "../../src/video")).map((f) => `src/video/${f}`),
	"src/main.ts",
	"src/litNote/transcriptView.ts",
	"src/litNote/transcriptFolding.ts",
	"src/litNote/captionTiming.ts",
];
const FORBIDDEN = /(?<![\w.$])(document|window|navigator|activeDocument|activeWindow)\s*\.(?!\s*implementation)/;

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("pop-out safety of the video viewer", () => {
	it.each(files)("%s uses no bare window globals", (file) => {
		const source = stripComments(readFileSync(path.resolve(__dirname, "../..", file), "utf8"));
		const offending = source.split("\n").filter((line) => FORBIDDEN.test(line));
		expect(offending).toEqual([]);
	});
});
