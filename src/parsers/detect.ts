import { DialogFile } from "./types";
import { parsePerplexityDialog, isPerplexityContent } from "./perplexity";
import { parseGeminiDialog, isGeminiContent } from "./gemini";

/**
 * Detect the source vendor of a raw pasted AI dialog and dispatch to the
 * matching parser.
 *
 * Detection priority:
 *   1. Save My Chatbot Perplexity (`**You**` AND `**AI answer**`) - both
 *      markers together are unique to Perplexity's SMC extension.
 *   2. Stock Perplexity (URL line, Citations block, or centered divider).
 *   3. Gemini (URL line or `**Gemini**` speaker header).
 *   4. Default: Perplexity (preserves the plugin's original single-vendor
 *      behavior for unknown pastes).
 */
export function detectAndParse(rawText: string): DialogFile {
	const hasYou = /\*\*You\*\*/.test(rawText);
	const hasAiAnswer = /\*\*AI answer\*\*/.test(rawText);
	if (hasYou && hasAiAnswer) {
		return parsePerplexityDialog(rawText);
	}
	if (isGeminiContent(rawText)) {
		return parseGeminiDialog(rawText);
	}
	if (isPerplexityContent(rawText)) {
		return parsePerplexityDialog(rawText);
	}
	return parsePerplexityDialog(rawText);
}
