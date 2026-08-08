export function sanitizeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]/g, "");
}

/**
 * Unwraps fenced code blocks surrounding prompts, especially when they start with a heading.
 * Handles variants such as language-tagged fences, trailing newlines, or text following
 * the code block.
 */
export function unwrapFencedHeading(text: string): string {
	let trimmed = text.trim();
	if (trimmed.startsWith("```")) {
		// 1. Try matching with closing backticks at the very end of the string (to safely support nested code blocks)
		let match = trimmed.match(/^```(\S*)\n([\s\S]*?)\n```$/);
		if (match) {
			const inside = match[2].trim();
			if (inside.startsWith("#")) {
				const rest = trimmed.slice(match[0].length).trim();
				return rest ? `${inside}\n\n${rest}` : inside;
			}
		}

		// 2. Fallback: match without closing backticks (the whole remaining text is the inside)
		match = trimmed.match(/^```(\S*)\n([\s\S]*)$/);
		if (match) {
			const inside = match[2].trim();
			if (inside.startsWith("#")) {
				return inside;
			}
		}
	}
	return trimmed;
}
