import { detectAndParse } from "../parsers/detect";
import { stripLeadingFrontmatterIfPresent } from "../normalize/frontmatter";

/**
 * Suggest a filename derived from the first prompt of the parsed dialog.
 * Plain truncation, not an AI summary.
 */
export function suggestFilenameFromClipboard(
	clipboardContent: string,
	fallback: string
): string {
	const { body } = stripLeadingFrontmatterIfPresent(clipboardContent);
	const dialog = detectAndParse(body);
	const firstPrompt = dialog.turns.find((t) => t.role === "prompt")?.rawText ?? "";
	if (!firstPrompt.trim()) return fallback;
	const words = firstPrompt.split(/\s+/).slice(0, 8).join(" ");
	return words.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim() || fallback;
}
