// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { opensInViewer, timestampForEvent } from "../../src/video/timestampLinks";
import { PLAYER_STATE, applyPlayerMessage, type PlayerInfo } from "../../src/video/youtubePlayer";

const ID = "dQw4w9WgXcQ";

function clickOn(target: Element, init: MouseEventInit = {}): MouseEvent {
	const evt = new MouseEvent("click", { bubbles: true, button: 0, ...init });
	Object.defineProperty(evt, "target", { value: target });
	return evt;
}

describe("opensInViewer", () => {
	it("uses the setting for plain clicks and the other action with Ctrl/Cmd", () => {
		expect(opensInViewer("viewer", false)).toBe(true);
		expect(opensInViewer("viewer", true)).toBe(false);
		expect(opensInViewer("browser", false)).toBe(false);
		expect(opensInViewer("browser", true)).toBe(true);
	});
});

describe("timestampForEvent", () => {
	const doc = document.implementation.createHTMLDocument("pop-out");
	const anchor = (href: string): HTMLElement => {
		const a = doc.createElement("a");
		a.className = "external-link";
		a.setAttribute("href", href);
		a.appendChild(doc.createElement("span"));
		doc.body.appendChild(a);
		return a;
	};

	it("opens a timestamp link (also from a child element, in another document)", () => {
		const a = anchor(`https://www.youtube.com/watch?v=${ID}&t=65`);
		const request = timestampForEvent(clickOn(a.firstElementChild as Element), "viewer");
		expect(request).toMatchObject({ videoId: ID, seconds: 65 });
	});

	it("leaves links without a time, other sites, modified and non-primary clicks alone", () => {
		expect(timestampForEvent(clickOn(anchor(`https://youtu.be/${ID}`)), "viewer")).toBeNull();
		expect(timestampForEvent(clickOn(anchor("https://example.com/?t=5")), "viewer")).toBeNull();
		const a = anchor(`https://youtu.be/${ID}?t=5`);
		expect(timestampForEvent(clickOn(a, { ctrlKey: true }), "viewer")).toBeNull();
		expect(timestampForEvent(clickOn(a, { button: 1 }), "viewer")).toBeNull();
		expect(timestampForEvent(clickOn(a, { ctrlKey: true }), "browser")).toMatchObject({ seconds: 5 });
		expect(timestampForEvent(clickOn(a), "browser")).toBeNull();
	});
});

describe("applyPlayerMessage", () => {
	const fresh = (): PlayerInfo => ({ currentTime: 0, duration: 0, playerState: PLAYER_STATE.unstarted, playbackRate: 1 });

	it("merges infoDelivery JSON into the player info", () => {
		const info = fresh();
		const changed = applyPlayerMessage(
			info,
			JSON.stringify({ event: "infoDelivery", info: { currentTime: 12.5, duration: 300, playerState: 1, volume: 50 } })
		);
		expect(changed).toBe(true);
		expect(info).toEqual({ currentTime: 12.5, duration: 300, playerState: 1, playbackRate: 1 });
	});

	it("ignores unrelated or malformed messages", () => {
		const info = fresh();
		expect(applyPlayerMessage(info, "not json")).toBe(false);
		expect(applyPlayerMessage(info, { event: "onReady" })).toBe(false);
		expect(applyPlayerMessage(info, { info: { currentTime: "x" } })).toBe(false);
		expect(info).toEqual(fresh());
	});
});
