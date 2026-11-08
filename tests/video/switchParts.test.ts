import { describe, expect, it } from "vitest";
import { nextPart } from "../../src/video/switchParts";

describe("nextPart", () => {
	it("cycles note → video → transcript → note when all are open", () => {
		expect(nextPart("note")).toBe("video");
		expect(nextPart("video")).toBe("transcript");
		expect(nextPart("transcript")).toBe("note");
	});

	it("cycles backwards", () => {
		expect(nextPart("note", -1)).toBe("transcript");
		expect(nextPart("video", -1)).toBe("note");
	});

	it("opens missing parts in the same order", () => {
		expect(nextPart("note")).toBe("video");
		expect(nextPart("transcript")).toBe("note");
		expect(nextPart("video")).toBe("transcript");
		expect(nextPart("note", -1)).toBe("transcript");
	});

	it("goes to the video (opening it) when only the note is open", () => {
		expect(nextPart("note")).toBe("video");
		expect(nextPart("video")).toBe("transcript");
	});

	it("starts at the note from elsewhere", () => {
		expect(nextPart(null)).toBe("note");
	});
});
