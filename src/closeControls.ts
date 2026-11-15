import { setIcon } from "obsidian";

export type ClosePart = "player" | "transcript";

const PART_ICON: Record<ClosePart, string> = { player: "square-play", transcript: "file-text" };

export interface CloseControlsOptions {
	/** Which view hosts the controls; its glyph is the one on the "close this only" button. */
	part: ClosePart;
	thisLabel: string;
	closeThis: () => void;
	/** Omit when there is no linked note to close the other view for. */
	closeBoth?: () => void;
	/** Extra class on the "close this only" button, for host-specific visibility rules. */
	thisClass?: string;
}

export interface CloseControls {
	/** Shows the "close both" button only while the player and the transcript are both open. */
	update(bothOpen: boolean): void;
}

function chip(parent: HTMLElement, label: string, icons: string[], onClick: () => void, cls?: string): HTMLElement {
	const btn = parent.createEl("button", { cls: ["clickable-icon", "perplexity-saver-close-chip", cls].filter(Boolean).join(" "), attr: { "aria-label": label } });
	for (const icon of icons) {
		const glyph = btn.createEl("span", { cls: icon === "x" ? "perplexity-saver-close-chip-x" : "perplexity-saver-close-chip-glyph" });
		setIcon(glyph, icon);
	}
	btn.addEventListener("click", onClick);
	return btn;
}

/** "Close this view" then "close both" (rightmost, easiest to hit), each showing the glyphs of what it closes plus an X. */
export function createCloseControls(parent: HTMLElement, options: CloseControlsOptions): CloseControls {
	chip(parent, options.thisLabel, [PART_ICON[options.part], "x"], options.closeThis, options.thisClass);
	const both = options.closeBoth
		? chip(parent, "Close player and transcript", [PART_ICON.player, PART_ICON.transcript, "x"], options.closeBoth)
		: null;
	if (both) both.hidden = true;
	return { update: (bothOpen) => { if (both) both.hidden = !bothOpen; } };
}
