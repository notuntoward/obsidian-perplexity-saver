import { describe, expect, it } from "vitest";
import { nextPart } from "../../src/video/switchParts";

describe("nextPart", () => {
	it("cycles note → video → transcript → note when all are open", () => {
		expect(nextPart("note")).toBe("video");
		expect(nextPart("video")).toBe("transcript");
		expect(nextPart("transcript")).toBe("note");
	});

	it("skips absent panes", () => {
		expect(nextPart("note", ["note", "video"])).toBe("video");
		expect(nextPart("video", ["note", "video"])).toBe("note");
		expect(nextPart("note", ["note", "transcript"])).toBe("transcript");
		expect(nextPart("transcript", ["note", "transcript"])).toBe("note");
		expect(nextPart("note", ["note"])).toBe("note");
		expect(nextPart("video", ["video"])).toBe("video");
		expect(nextPart(null, [])).toBeNull();
	});

	it("starts at the note from elsewhere", () => {
		expect(nextPart(null)).toBe("note");
	});
});
