import { extractYouTubeVideoId, formatShortTimestamp } from "../litNote/youtubeTranscript";

/** A YouTube link found in note text. `seconds` is null when the link has no start time. */
export interface YouTubeLink {
	url: string;
	videoId: string;
	seconds: number | null;
	/** Character offset of the link in the scanned text. */
	start: number;
	end: number;
}

/**
 * Parse a YouTube time value: plain or fractional seconds (`90`, `90.5`, `90s`),
 * unit form (`1h2m3s`, `2m`), or clock form (`1:02:03`). Returns null when invalid.
 */
export function parseYouTubeTime(value: string | null | undefined): number | null {
	const v = (value ?? "").trim().toLowerCase();
	if (!v) return null;
	if (/^\d+(?:\.\d+)?s?$/.test(v)) return parseFloat(v);
	const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(v);
	if (units && (units[1] || units[2] || units[3])) {
		return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
	}
	if (/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(v)) {
		return v.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
	}
	return null;
}

/** Video id and start time of a YouTube URL; null when it is not a YouTube video URL. */
export function parseYouTubeUrl(url: string): { videoId: string; seconds: number | null } | null {
	if (!/^https?:\/\/(?:[\w-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\//i.test(url)) {
		return null;
	}
	const videoId = extractYouTubeVideoId(url);
	if (!videoId) return null;
	let seconds: number | null = null;
	try {
		const parsed = new URL(url);
		seconds =
			parseYouTubeTime(parsed.searchParams.get("t")) ??
			parseYouTubeTime(parsed.searchParams.get("start"));
		if (seconds === null && parsed.hash) {
			const hash = new URLSearchParams(parsed.hash.slice(1));
			seconds = parseYouTubeTime(hash.get("t"));
		}
	} catch {
		seconds = null;
	}
	return { videoId, seconds };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"'`]+/g;

function trimUrl(url: string): string {
	return url.replace(/[.,;:!?]+$/, "");
}

/** Every YouTube video URL in `text`, in order (markdown link targets and bare URLs). */
export function findYouTubeLinks(text: string): YouTubeLink[] {
	const links: YouTubeLink[] = [];
	for (const match of text.matchAll(URL_IN_TEXT)) {
		const url = trimUrl(match[0]);
		const parsed = parseYouTubeUrl(url);
		if (!parsed) continue;
		const start = match.index ?? 0;
		links.push({ url, ...parsed, start, end: start + url.length });
	}
	return links;
}

/** The video a note is about: the first YouTube video linked in it. */
export function findNoteVideoId(text: string): string | null {
	return findYouTubeLinks(text)[0]?.videoId ?? null;
}

/**
 * Times (seconds, sorted, unique) of the timestamp links to `videoId` that the
 * user wrote in the note, ignoring links inside `exclude` (the transcript section).
 */
export function collectNoteTimestamps(
	text: string,
	videoId: string,
	exclude?: { start: number; end: number } | null
): number[] {
	const times = new Set<number>();
	for (const link of findYouTubeLinks(text)) {
		if (link.videoId !== videoId || link.seconds === null) continue;
		if (exclude && link.start >= exclude.start && link.start < exclude.end) continue;
		times.add(link.seconds);
	}
	return [...times].sort((a, b) => a - b);
}

const MARKDOWN_LINK = /\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * The URL of the markdown link or bare URL covering column `ch` of `line`, or null.
 * Used to find which link was clicked in the editor.
 */
export function linkUrlAt(line: string, ch: number): string | null {
	for (const m of line.matchAll(MARKDOWN_LINK)) {
		const start = m.index ?? 0;
		if (ch >= start && ch <= start + m[0].length) return m[1];
	}
	for (const m of line.matchAll(URL_IN_TEXT)) {
		const start = m.index ?? 0;
		if (ch >= start && ch <= start + m[0].length) return trimUrl(m[0]);
	}
	return null;
}

/** Canonical watch URL with a whole-second `t` parameter. */
export function watchUrl(videoId: string, seconds = 0): string {
	const t = Math.max(0, Math.floor(seconds));
	return `https://www.youtube.com/watch?v=${videoId}` + (t > 0 ? `&t=${t}` : "");
}

/** Embed URL controlled through postMessage (`enablejsapi`), without YouTube's own controls. */
export function embedUrl(videoId: string, startSeconds = 0): string {
	const params = new URLSearchParams({
		enablejsapi: "1",
		controls: "0",
		disablekb: "1",
		rel: "0",
		iv_load_policy: "3",
		playsinline: "1",
		fs: "0",
	});
	const start = Math.max(0, Math.floor(startSeconds));
	if (start > 0) params.set("start", String(start));
	return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

/** `m:ss` or `h:mm:ss` for a video position. */
export function formatClock(seconds: number): string {
	return formatShortTimestamp(Math.floor(Number.isFinite(seconds) ? seconds : 0) * 1000);
}

/** Markdown timestamp link for a video position: `[m:ss](watch-url&t=N)`. */
export function timestampLink(videoId: string, seconds: number): string {
	return `[${formatClock(seconds)}](${watchUrl(videoId, seconds)})`;
}

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
