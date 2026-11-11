/** The three places a YouTube literature note is worked on. */
export type NotePart = "note" | "video" | "transcript";

export const PART_ORDER: readonly NotePart[] = ["note", "video", "transcript"];

/**
 * The next visible part in note → video → transcript order.
 */
export function nextPart(current: NotePart | null, direction: 1 | -1 = 1, visible: readonly NotePart[] = PART_ORDER): NotePart | null {
	const order = PART_ORDER.filter((part) => visible.includes(part));
	if (!order.length) return null;
	const at = current ? order.indexOf(current) : -1;
	if (at < 0) return direction > 0 ? order[0] : order[order.length - 1];
	return order[(at + direction + order.length) % order.length];
}
