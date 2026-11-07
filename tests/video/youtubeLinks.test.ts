import { describe, expect, it } from "vitest";
import {
	clampPan,
	collectNoteTimestamps,
	embedUrl,
	findNoteVideoId,
	findYouTubeLinks,
	formatClock,
	linkUrlAt,
	parseYouTubeTime,
	parseYouTubeUrl,
	screenshotClipboardText,
	screenshotFileName,
	compactNoteName,
	snipRect,
	timestampLink,
	watchUrl,
	zoomAt,
} from "../../src/video/youtubeLinks";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeTime", () => {
	it.each([
		["90", 90],
		["90s", 90],
		["90.5", 90.5],
		["1h2m3s", 3723],
		["2m", 120],
		["1m30s", 90],
		["1:02:03", 3723],
		["4:05", 245],
	])("%s -> %d", (value, expected) => {
		expect(parseYouTubeTime(value)).toBe(expected);
	});

	it.each([null, "", "abc", "1x", "h"])("rejects %s", (value) => {
		expect(parseYouTubeTime(value)).toBeNull();
	});
});

describe("parseYouTubeUrl", () => {
	it("reads the video id and t / start / #t times", () => {
		expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=75`)).toEqual({ videoId: ID, seconds: 75 });
		expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=1m5s`)).toEqual({ videoId: ID, seconds: 65 });
		expect(parseYouTubeUrl(`https://www.youtube.com/embed/${ID}?start=30`)).toEqual({ videoId: ID, seconds: 30 });
		expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}#t=12`)).toEqual({ videoId: ID, seconds: 12 });
		expect(parseYouTubeUrl(`https://m.youtube.com/watch?v=${ID}`)).toEqual({ videoId: ID, seconds: null });
	});

	it("ignores non-YouTube URLs, including ones that contain a YouTube URL", () => {
		expect(parseYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ&t=5")).toBeNull();
		expect(parseYouTubeUrl(`https://example.com/?u=https://youtu.be/${ID}`)).toBeNull();
		expect(parseYouTubeUrl("https://www.youtube.com/channel/abc")).toBeNull();
	});
});

describe("note timestamps", () => {
	const note = [
		"# Notes",
		`Intro [0:30](https://www.youtube.com/watch?v=${ID}&t=30) and https://youtu.be/${ID}?t=90.`,
		`Duplicate [0:30](https://www.youtube.com/watch?v=${ID}&t=30) and other [x](https://youtu.be/aaaaaaaaaaa?t=5)`,
		`Plain [video](https://www.youtube.com/watch?v=${ID})`,
		"# Transcript",
		`[00:01.000 → 00:02.000](https://www.youtube.com/watch?v=${ID}&t=1) hello`,
	].join("\n");
	const transcriptStart = note.indexOf("# Transcript");

	it("finds links in order and trims trailing punctuation", () => {
		const links = findYouTubeLinks(note);
		expect(links[1].url).toBe(`https://youtu.be/${ID}?t=90`);
		expect(findNoteVideoId(note)).toBe(ID);
	});

	it("collects the user's own times for the video, sorted and unique, outside the transcript", () => {
		expect(collectNoteTimestamps(note, ID, { start: transcriptStart, end: note.length })).toEqual([30, 90]);
		expect(collectNoteTimestamps(note, ID)).toEqual([1, 30, 90]);
	});
});

describe("linkUrlAt", () => {
	const line = `See [1:05](https://youtu.be/${ID}?t=65) or https://youtu.be/${ID}?t=9, done`;

	it("returns the markdown link target under the column", () => {
		expect(linkUrlAt(line, line.indexOf("1:05"))).toBe(`https://youtu.be/${ID}?t=65`);
	});

	it("returns a bare URL under the column", () => {
		expect(linkUrlAt(line, line.indexOf("t=9"))).toBe(`https://youtu.be/${ID}?t=9`);
	});

	it("returns null outside links", () => {
		expect(linkUrlAt(line, 1)).toBeNull();
	});
});

describe("formatting", () => {
	it("formats clocks and links", () => {
		expect(formatClock(65)).toBe("1:05");
		expect(formatClock(3723.9)).toBe("1:02:03");
		expect(watchUrl(ID, 65.7)).toBe(`https://www.youtube.com/watch?v=${ID}&t=65`);
		expect(watchUrl(ID, 0)).toBe(`https://www.youtube.com/watch?v=${ID}`);
		expect(timestampLink(ID, 65)).toBe(`[1:05](https://www.youtube.com/watch?v=${ID}&t=65)`);
	});

	it("builds a controllable embed URL", () => {
		const url = new URL(embedUrl(ID, 42.9));
		expect(url.pathname).toBe(`/embed/${ID}`);
		expect(url.searchParams.get("enablejsapi")).toBe("1");
		expect(url.searchParams.get("controls")).toBe("0");
		expect(url.searchParams.get("start")).toBe("42");
	});

	it("names screenshots safely and pairs the embed with a timestamp link", () => {
		const day = new Date(2026, 10, 6, 12, 30);
		expect(screenshotFileName('Talk: "AI" [part 1]', 65, day)).toBe("Talk AI part 1 2026-11-06 @1m05s.png");
		expect(screenshotFileName("", 5, day)).toBe("video 2026-11-06 @0m05s.png");
		expect(screenshotFileName("Lecture", 3725, new Date(2027, 0, 2))).toBe("Lecture 2027-01-02 @1h02m05s.png");
		expect(
			screenshotFileName("Feynman1964 - The Character of Physical Law, Lecture 1: The Law of Gravitation", 90, day)
		).toBe("Feynman1964 - The Character of Physical 2026-11-06 @1m30s.png");
		expect(compactNoteName("Supercalifragilisticexpialidocious".repeat(2), 20)).toBe("Supercalifragilistic");
		expect(compactNoteName("Alpha beta, gamma delta", 12)).toBe("Alpha beta");
		expect(screenshotClipboardText("![[a.png]]", ID, 65)).toBe(
			`![[a.png]]\n[1:05](https://www.youtube.com/watch?v=${ID}&t=65)`
		);
	});
});

describe("snipRect", () => {
	it("normalizes a drag in any direction and clamps it to the stage", () => {
		expect(snipRect(100, 80, 20, 10, 400, 200)).toEqual({ x: 20, y: 10, width: 80, height: 70 });
		expect(snipRect(350, 150, 500, -20, 400, 200)).toEqual({ x: 350, y: 0, width: 50, height: 150 });
	});

	it("treats a click or a sliver as the whole picture", () => {
		expect(snipRect(50, 50, 51, 52, 400, 200)).toBeNull();
		expect(snipRect(10, 10, 300, 12, 400, 200)).toBeNull();
	});
});

describe("zoom", () => {
	it("keeps the point under the pointer fixed while zooming", () => {
		const z = zoomAt({ zoom: 1, x: 0, y: 0 }, 2, 100, 50, 400, 200);
		expect(z).toEqual({ zoom: 2, x: -100, y: -50 });
		// The stage point (100, 50) maps back to the same picture point.
		expect((100 - z.x) / z.zoom).toBe(100);
	});

	it("clamps zoom and pan so the picture always covers the stage", () => {
		expect(zoomAt({ zoom: 1, x: 0, y: 0 }, 0.5, 10, 10, 400, 200)).toEqual({ zoom: 1, x: 0, y: 0 });
		expect(clampPan({ zoom: 2, x: 50, y: -999 }, 400, 200)).toEqual({ zoom: 2, x: 0, y: -200 });
		expect(zoomAt({ zoom: 5, x: 0, y: 0 }, 10, 0, 0, 400, 200).zoom).toBe(6);
	});
});
