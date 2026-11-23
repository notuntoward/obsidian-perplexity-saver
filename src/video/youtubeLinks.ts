import { timestampLink } from "commons/youtube";

/** Longest note-name part of a screenshot file name, before the date and time. */
export const SCREENSHOT_NAME_MAX = 40;

/** Note name made safe for a file name and shortened at a word boundary to `max` characters. */
export function compactNoteName(base: string, max = SCREENSHOT_NAME_MAX): string {
	const safe = base.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim() || "video";
	if (safe.length <= max) return safe;
	let out = "";
	for (const word of safe.split(" ")) {
		const next = out ? `${out} ${word}` : word;
		if (next.length > max) break;
		out = next;
	}
	if (!out) out = safe.slice(0, max);
	return out.replace(/[\s,;.\-–—_(]+$/, "") || safe.slice(0, max);
}

/** Video position as `12m34s` or `1h02m03s`. */
export function fileTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m${s}s` : `${m}m${s}s`;
}

/** Local calendar date as `YYYY-MM-DD`. */
export function isoDate(date: Date): string {
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** File name for a screenshot: `<short note name> <YYYY-MM-DD> @<12m34s>.png`. */
export function screenshotFileName(base: string, seconds: number, takenAt: Date): string {
	return `${compactNoteName(base)} ${isoDate(takenAt)} @${fileTimestamp(seconds)}.png`;
}

/** Markdown copied after a screenshot: the image embed, then a timestamp link back into the video. */
export function screenshotClipboardText(embedLink: string, videoId: string, seconds: number): string {
	return `${embedLink}\n${timestampLink(videoId, seconds)}`;
}

/** Pan/zoom state of the video picture: scale `zoom` from the top-left, then translate by (x, y) pixels. */
export interface ZoomState {
	zoom: number;
	x: number;
	y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

/** A rectangle in CSS pixels relative to the video stage. */
export interface SnipRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Smallest drag (px, either side) treated as a rectangle; smaller is a click (whole picture). */
export const MIN_SNIP = 4;

/**
 * The stage rectangle spanned by a drag from (x0, y0) to (x1, y1), clamped to
 * the stage; null when the drag is too small, meaning "the whole picture".
 */
export function snipRect(x0: number, y0: number, x1: number, y1: number, width: number, height: number): SnipRect | null {
	const clampX = (v: number): number => Math.min(width, Math.max(0, v));
	const clampY = (v: number): number => Math.min(height, Math.max(0, v));
	const left = Math.min(clampX(x0), clampX(x1));
	const right = Math.max(clampX(x0), clampX(x1));
	const top = Math.min(clampY(y0), clampY(y1));
	const bottom = Math.max(clampY(y0), clampY(y1));
	if (right - left < MIN_SNIP || bottom - top < MIN_SNIP) return null;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Keep the zoomed picture covering the stage (no empty margins). */
export function clampPan(state: ZoomState, width: number, height: number): ZoomState {
	const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom));
	return {
		zoom,
		x: Math.min(0, Math.max(width - width * zoom, state.x)),
		y: Math.min(0, Math.max(height - height * zoom, state.y)),
	};
}

/** Zoom by `factor` keeping the stage point (cx, cy) fixed under the pointer. */
export function zoomAt(
	state: ZoomState,
	factor: number,
	cx: number,
	cy: number,
	width: number,
	height: number
): ZoomState {
	const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom * factor));
	const ratio = zoom / state.zoom;
	return clampPan(
		{ zoom, x: cx - (cx - state.x) * ratio, y: cy - (cy - state.y) * ratio },
		width,
		height
	);
}
