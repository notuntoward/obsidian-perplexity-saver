// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { onLinkActivation, dispatchLinkActivation, registerNativeLinkActivation } from "commons/links";
import type { App } from "obsidian";
import { keyboardTimestamp, opensInViewer, timestampForEvent } from "../../src/video/timestampLinks";
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

	describe("keyboard timestamp routing without Steady Links", () => {
		it.each([false, true])("claims native checks/activation at the cursor without relying on decorated link DOM (popout=%s)", (popout) => {
			const doc = popout ? document.implementation.createHTMLDocument() : document;
			const host = doc.createElement("div");
			doc.body.append(host);
			const cm = new EditorView({
				parent: host,
				state: EditorState.create({
					doc: `Notes [1:05](https://youtu.be/${ID}?t=65): description`,
					selection: EditorSelection.cursor(9),
				}),
			});
			const open = vi.fn();
			const native = vi.fn((_checking: boolean) => true);
			const command = { checkCallback: native };
			const app = Object.assign({} as App, { commands: { commands: { "editor:follow-link": command } } });
			const cleanup = registerNativeLinkActivation(app, () => cm.contentDOM)!;
			const stop = onLinkActivation(doc, (target, checking) => {
				const request = keyboardTimestamp(target, "viewer");
				if (!request) return false;
				if (!checking) open(request);
				return true;
			});
			try {
				expect(command.checkCallback(true)).toBe(true);
				expect(open).not.toHaveBeenCalled();
				expect(command.checkCallback(false)).toBe(true);
				expect(open).toHaveBeenCalledOnce();
				expect(open).toHaveBeenCalledWith(expect.objectContaining({ videoId: ID, seconds: 65, target: cm.contentDOM }));
				expect(native.mock.calls).toEqual([[true], [true]]);
				expect(cm.state.doc.toString()).toContain(": description");
				expect(keyboardTimestamp(cm.contentDOM, "browser")).toBeNull();
				cm.dispatch({ selection: EditorSelection.range(8, 10) });
				expect(keyboardTimestamp(cm.contentDOM, "viewer")).toBeNull();
				cm.dispatch({ selection: EditorSelection.cursor(1) });
				native.mockClear();
				expect(command.checkCallback(false)).toBe(true);
				expect(native.mock.calls).toEqual([[true], [false]]);
			} finally {
				stop();
				cleanup();
				cm.destroy();
				host.remove();
			}
		});

		it("claims focused anchors but declines ordinary links and missing timestamps", () => {
			const doc = document.implementation.createHTMLDocument();
			const a = doc.createElement("a");
			a.href = `https://youtu.be/${ID}?t=0`;
			expect(keyboardTimestamp(a, "viewer")).toMatchObject({ seconds: 0 });
			a.href = `https://youtu.be/${ID}`;
			expect(keyboardTimestamp(a, "viewer")).toBeNull();
			a.href = "https://example.com/";
			expect(keyboardTimestamp(a, "viewer")).toBeNull();
			expect(dispatchLinkActivation(a)).toBe(false);
		});
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
