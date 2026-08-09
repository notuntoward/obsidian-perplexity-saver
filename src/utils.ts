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

export function normalizeUrl(url: string): string {
	if (!url) return "";
	try {
		let cleaned = url.toLowerCase().trim();
		// Normalize protocol: http:// -> https://
		if (cleaned.startsWith("http://")) {
			cleaned = "https://" + cleaned.substring(7);
		}
		const parsed = new URL(cleaned);
		let path = parsed.pathname;
		while (path.length > 1 && path.endsWith("/")) {
			path = path.slice(0, -1);
		}

		// ArXiv URL canonicalization: /pdf/1805.09785.pdf, /html/1805.09785v1 -> /abs/1805.09785
		const arxivMatch =
			/^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]+)?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i.exec(
				path
			);
		if (parsed.hostname.includes("arxiv.org") && arxivMatch) {
			path = "/abs/" + arxivMatch[1];
		}

		return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
	} catch {
		// Fallback for non-standard URLs
		let cleaned = url.toLowerCase().trim();
		if (cleaned.startsWith("http://")) {
			cleaned = "https://" + cleaned.substring(7);
		}
		return cleaned;
	}
}
