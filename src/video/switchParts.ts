/** The three places a YouTube literature note is worked on. */
export type NotePart = "note" | "video" | "transcript";

export const PART_ORDER: readonly NotePart[] = ["note", "video", "transcript"];

/**
 * The next part in note → video → transcript order, opened on demand.
 */
export function nextPart(current: NotePart | null, direction: 1 | -1 = 1): NotePart {
	const at = current ? PART_ORDER.indexOf(current) : -1;
	if (at < 0) return direction > 0 ? PART_ORDER[0] : PART_ORDER[PART_ORDER.length - 1];
	return PART_ORDER[(at + direction + PART_ORDER.length) % PART_ORDER.length];
}
