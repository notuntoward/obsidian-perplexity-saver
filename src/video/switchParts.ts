/** The three places a YouTube literature note is worked on. */
export type NotePart = "note" | "video" | "transcript";

export const PART_ORDER: readonly NotePart[] = ["note", "video", "transcript"];

/**
 * The part the cycle command goes to from `current`: the next open part in
 * note → video → transcript order. When only the note is open, the video
 * (opened on demand) comes next, so the cycle always goes somewhere.
 */
export function nextPart(current: NotePart | null, open: ReadonlySet<NotePart>, direction: 1 | -1 = 1): NotePart {
	const parts = PART_ORDER.filter((p) => p === "note" || open.has(p));
	if (parts.length === 1) parts.push("video");
	const at = current ? parts.indexOf(current) : -1;
	if (at < 0) return direction > 0 ? parts[0] : parts[parts.length - 1];
	return parts[(at + direction + parts.length) % parts.length];
}
