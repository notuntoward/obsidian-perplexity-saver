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

	it.each([1, -1] as const)("skips absent panes in direction %s", (direction) => {
		expect(nextPart("note", direction, ["note", "video"])).toBe("video");
		expect(nextPart("video", direction, ["note", "video"])).toBe("note");
		expect(nextPart("note", direction, ["note", "transcript"])).toBe("transcript");
		expect(nextPart("transcript", direction, ["note", "transcript"])).toBe("note");
		expect(nextPart("note", direction, ["note"])).toBe("note");
		expect(nextPart("video", direction, ["video"])).toBe("video");
		expect(nextPart(null, direction, [])).toBeNull();
	});

	it("starts at the note from elsewhere", () => {
		expect(nextPart(null)).toBe("note");
	});
});
