import { describe, expect, it } from "vitest";
import { nextPart, type NotePart } from "../../src/video/switchParts";

const open = (...parts: NotePart[]): Set<NotePart> => new Set(parts);

describe("nextPart", () => {
	it("cycles note → video → transcript → note when all are open", () => {
		const all = open("note", "video", "transcript");
		expect(nextPart("note", all)).toBe("video");
		expect(nextPart("video", all)).toBe("transcript");
		expect(nextPart("transcript", all)).toBe("note");
	});

	it("cycles backwards", () => {
		const all = open("note", "video", "transcript");
		expect(nextPart("note", all, -1)).toBe("transcript");
		expect(nextPart("video", all, -1)).toBe("note");
	});

	it("skips parts that are not open", () => {
		expect(nextPart("note", open("note", "transcript"))).toBe("transcript");
		expect(nextPart("transcript", open("note", "transcript"))).toBe("note");
	});

	it("goes to the video (opening it) when only the note is open", () => {
		expect(nextPart("note", open("note"))).toBe("video");
		expect(nextPart("video", open("note"))).toBe("note");
	});

	it("starts at the note from elsewhere", () => {
		expect(nextPart(null, open("note", "video"))).toBe("note");
	});
});
