/**
 * YouTube transcript downloader and formatter for literature notes.
 *
 * Implements transcript retrieval using YouTube's public InnerTube player API,
 * parsing timedtext XML, and formatting timestamped transcript blocks.
 *
 * Reference implementation: https://github.com/lstrzepek/obsidian-yt-transcript
 */

import { requestUrl } from "obsidian";
import type { ZoteroItemPayload } from "./types";

export interface TranscriptLine {
	text: string;
	duration: number;
	offset: number;
}

export interface TranscriptBlock {
	quote: string;
	quoteTimeOffset: number;
}

export interface TranscriptResponse {
	title: string;
	lines: TranscriptLine[];
}

const YOUTUBE_DOMAINS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"mobile.youtube.com",
	"music.youtube.com",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
	"youtu.be",
	"www.youtu.be",
]);

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}`;
const IOS_USER_AGENT =
	"com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)";

/**
 * Check if a URL points to YouTube.
 */
export function isValidYouTubeUrl(url: string | null | undefined): boolean {
	if (!url || typeof url !== "string") return false;

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	const hostname = parsed.hostname.toLowerCase();
	if (!YOUTUBE_DOMAINS.has(hostname)) return false;

	if (hostname.endsWith("youtu.be")) {
		const [, videoId] = parsed.pathname.split("/");
		return VIDEO_ID_PATTERN.test(videoId ?? "");
	}

	if (parsed.pathname === "/watch") {
		return VIDEO_ID_PATTERN.test(parsed.searchParams.get("v") ?? "");
	}

	const pathMatch = parsed.pathname.match(
		/^\/(?:embed|shorts|v|live)\/([a-zA-Z0-9_-]{11})(?:\/|$)/
	);
	return pathMatch !== null;
}

/**
 * Extract YouTube URL from a string.
 */
export function extractYouTubeUrlFromText(text: string | null | undefined): string | null {
	if (!text || typeof text !== "string") return null;

	const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
	const matches = text.match(urlRegex);
	if (!matches) return null;

	for (const match of matches) {
		if (isValidYouTubeUrl(match)) return match;
	}
	return null;
}

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

/**
 * Extract the 11-character video ID from a YouTube URL.
 */
export function extractYouTubeVideoId(url: string): string | null {
	if (!url || typeof url !== "string") return null;

	const patterns = [
		/(?:(?:youtube|youtube-nocookie)\.com\/(?:watch\?.*?v=|embed\/|shorts\/|v\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
		/^([a-zA-Z0-9_-]{11})$/,
	];

	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match) {
			return match[1];
		}
	}
	return null;
}

/**
 * Build a video URL with a timestamp parameter (?t=X or &t=X).
 */
export function buildTimestampUrl(url: string, offsetMs: number): string {
	if (!url || typeof url !== "string") return "";

	const seconds = Math.max(0, Math.floor(offsetMs / 1000));
	try {
		const parsed = new URL(url);
		parsed.searchParams.set("t", seconds.toString());
		return parsed.toString();
	} catch {
		const separator = url.includes("?") ? "&" : "?";
		return `${url}${separator}t=${seconds}`;
	}
}

/**
 * Format milliseconds into [hh:]mm:ss timestamp string.
 */
export function formatTimestamp(offsetMs: number): string {
	if (offsetMs < 0) return "00:00";
	const fnum = (n: number): string => `${Math.floor(n)}`.padStart(2, "0");
	const s = 1000;
	const m = 60 * s;
	const h = 60 * m;
	const hours = Math.floor(offsetMs / h);
	const minutes = Math.floor((offsetMs - hours * h) / m);
	const seconds = Math.floor((offsetMs - hours * h - minutes * m) / s);
	const time = hours ? [hours, minutes, seconds] : [minutes, seconds];
	return time.map(fnum).join(":");
}

/**
 * Decode common HTML entities from caption XML text.
 */
export function decodeHtmlEntities(text: string): string {
	let decoded = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
		.replace(/&#x([a-fA-F0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
		.replace(/\n/g, " ")
		.trim();

	// Handle double-encoded entities like &amp;#39;
	if (decoded.includes("&#") || decoded.includes("&quot;") || decoded.includes("&amp;")) {
		decoded = decoded
			.replace(/&amp;/g, "&")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
			.replace(/&#x([a-fA-F0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
			.trim();
	}

	return decoded;
}

const TEXT_TAG_PATTERN = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
const P_TAG_PATTERN = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;

/**
 * Parse caption lines from YouTube timedtext XML content.
 */
export function parseCaptionXml(xmlContent: string): TranscriptLine[] {
	const lines: TranscriptLine[] = [];

	for (const match of xmlContent.matchAll(TEXT_TAG_PATTERN)) {
		const startSeconds = parseFloat(match[1]);
		const durationSeconds = parseFloat(match[2]);
		const text = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, ""));

		if (text) {
			lines.push({
				text,
				offset: Math.round(startSeconds * 1000),
				duration: Math.round(durationSeconds * 1000),
			});
		}
	}

	if (lines.length === 0) {
		for (const match of xmlContent.matchAll(P_TAG_PATTERN)) {
			const offset = parseInt(match[1], 10);
			const duration = parseInt(match[2], 10);
			const text = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, ""));

			if (text) {
				lines.push({ text, offset, duration });
			}
		}
	}

	return lines;
}

/**
 * Group transcript lines into timestamped blocks every `timestampMod` lines.
 */
export function getTranscriptBlocks(
	lines: TranscriptLine[],
	timestampMod = 5
): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	const mod = Math.max(1, Math.floor(timestampMod));

	let quote = "";
	let quoteTimeOffset = 0;
	lines.forEach((line, i) => {
		if (i === 0) {
			quoteTimeOffset = line.offset;
			quote += line.text + " ";
			return;
		}
		if (i % mod === 0) {
			blocks.push({ quote: quote.trim(), quoteTimeOffset });
			quote = "";
			quoteTimeOffset = line.offset;
		}
		quote += line.text + " ";
	});

	if (quote !== "") {
		blocks.push({ quote: quote.trim(), quoteTimeOffset });
	}
	return blocks;
}

/**
 * Format transcript lines into markdown with clickable timestamps.
 */
export function formatTranscript(
	lines: TranscriptLine[],
	url: string,
	timestampMod = 5
): string {
	const blocks = getTranscriptBlocks(lines, timestampMod);
	if (blocks.length === 0) return "";

	return blocks
		.map(({ quote, quoteTimeOffset }) => {
			const timestamp = formatTimestamp(quoteTimeOffset);
			const href = url ? buildTimestampUrl(url, quoteTimeOffset) : "#";
			return `[${timestamp}](${href}) ${quote.trim()}`;
		})
		.join("\n");
}

function findCaptionTrack(captionTracks: any[], langCode = "en"): any {
	let track = captionTracks.find((t: any) => t.languageCode === langCode);
	if (track) return track;

	track = captionTracks.find((t: any) => t.languageCode?.startsWith(langCode + "-"));
	if (track) return track;

	track = captionTracks.find((t: any) => langCode.startsWith(t.languageCode + "-"));
	if (track) return track;

	if (captionTracks.length > 0) {
		return captionTracks[0];
	}

	return null;
}

/**
 * Fetch YouTube transcript for a video URL and return formatted markdown.
 * Returns null if the URL is invalid or no captions are available.
 */
export async function downloadYouTubeTranscript(
	url: string,
	options: { lang?: string; country?: string; timestampMod?: number } = {}
): Promise<string | null> {
	const videoId = extractYouTubeVideoId(url);
	if (!videoId) return null;

	const context = {
		client: {
			clientName: "IOS",
			clientVersion: "20.10.38",
			hl: options.lang || "en",
			gl: options.country || "US",
		},
	};

	const body = JSON.stringify({ context, videoId });

	const playerResponse = await requestUrl({
		url: INNERTUBE_PLAYER_URL,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": IOS_USER_AGENT,
		},
		body,
	});

	const playerData = typeof playerResponse.json === "object" && playerResponse.json !== null
		? playerResponse.json
		: JSON.parse(playerResponse.text);

	const playabilityStatus = playerData.playabilityStatus;
	if (playabilityStatus) {
		if (
			playabilityStatus.status === "ERROR" ||
			playabilityStatus.status === "LOGIN_REQUIRED" ||
			playabilityStatus.status === "UNPLAYABLE"
		) {
			console.warn(`[LitNote] YouTube video ${videoId} is not playable:`, playabilityStatus.reason);
			return null;
		}
	}

	const captionsData = playerData.captions?.playerCaptionsTracklistRenderer;
	if (!captionsData || !Array.isArray(captionsData.captionTracks) || captionsData.captionTracks.length === 0) {
		console.warn(`[LitNote] No caption tracks available for YouTube video ${videoId}`);
		return null;
	}

	const captionTrack = findCaptionTrack(captionsData.captionTracks, options.lang || "en");
	if (!captionTrack || !captionTrack.baseUrl) {
		console.warn(`[LitNote] No matching caption track found for YouTube video ${videoId}`);
		return null;
	}

	const captionResponse = await requestUrl({
		url: captionTrack.baseUrl,
		method: "GET",
		headers: {
			"Accept-Language": "en-US,en;q=0.9",
		},
	});

	const xml = captionResponse.text;
	if (!xml || xml.trim().length === 0) {
		return null;
	}

	const lines = parseCaptionXml(xml);
	if (lines.length === 0) {
		return null;
	}

	return formatTranscript(lines, url, options.timestampMod ?? 5);
}
