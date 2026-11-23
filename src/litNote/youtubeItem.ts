import { extractYouTubeUrlFromText, isValidYouTubeUrl } from "commons/youtube";
import type { ZoteroItemPayload } from "./types";

/**
 * Detect and return a YouTube URL from a ZoteroItemPayload.
 * Checks item.url first, then any attachments with a YouTube URL.
 */
export function getYouTubeUrlFromItem(item: ZoteroItemPayload): string | null {
	if (item.url) {
		if (isValidYouTubeUrl(item.url)) return item.url.trim();
		const extracted = extractYouTubeUrlFromText(item.url);
		if (extracted) return extracted;
	}

	if (Array.isArray(item.attachments)) {
		for (const att of item.attachments) {
			if (att.url) {
				if (isValidYouTubeUrl(att.url)) return att.url.trim();
				const extracted = extractYouTubeUrlFromText(att.url);
				if (extracted) return extracted;
			}
			if (att.path) {
				const extracted = extractYouTubeUrlFromText(att.path);
				if (extracted) return extracted;
			}
		}
	}

	return null;
}
