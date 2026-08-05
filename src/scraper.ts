import { requestUrl, Notice } from "obsidian";
import { DialogFile } from "./parsers/types";
import { parseSourceLine } from "./zotero/sourceLinkState";
import { truncateAtWord } from "./normalize/headlines";

function blank(text: string | undefined | null): boolean {
	return text === undefined || text === null || text.trim() === "";
}

function notBlank(text: string | undefined | null): boolean {
	return !blank(text);
}

/**
 * Extract final path segment from a URL as a fallback,
 * matching obsidian-auto-link-title behavior.
 */
export function getUrlFinalSegment(url: string): string {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split("/").filter(Boolean);
		const last = segments.pop();
		return last || parsed.hostname;
	} catch (_) {
		return url;
	}
}

/**
 * Fetch and extract the page title for the given URL.
 */
async function scrape(url: string): Promise<string> {
	try {
		const response = await requestUrl({ url });
		const contentType = response.headers["content-type"] || "";
		if (!contentType.includes("text/html")) {
			return getUrlFinalSegment(url);
		}

		const html = response.text;
		const doc = new DOMParser().parseFromString(html, "text/html");
		const title = doc.querySelector("title");

		if (blank(title?.innerText)) {
			// If site is javascript based and has a no-title attribute when unloaded, use it.
			const noTitle = title?.getAttribute("no-title");
			if (notBlank(noTitle)) {
				return noTitle!;
			}
			return getUrlFinalSegment(url);
		}

		return title!.innerText.trim();
	} catch (ex) {
		console.error("Error scraping URL:", url, ex);
		return getUrlFinalSegment(url);
	}
}

/**
 * Get the webpage title from URL, handle protocol prefix, fallback segment parsing, and truncation.
 */
export async function getPageTitle(
	url: string,
	options: { maxChars?: number } = {}
): Promise<string> {
	let formattedUrl = url.trim();
	if (!(formattedUrl.startsWith("http://") || formattedUrl.startsWith("https://"))) {
		formattedUrl = "https://" + formattedUrl;
	}

	const rawTitle = await scrape(formattedUrl);
	if (options.maxChars !== undefined && options.maxChars > 0) {
		return truncateAtWord(rawTitle, options.maxChars);
	}
	return rawTitle;
}

/**
 * Resolve titles for all unique URLs in a dialog across turns, taking settings into account.
 */
export async function resolveSourceTitles(
	dialog: DialogFile,
	options: {
		existingSourceText?: string;
		autoFetchSourceTitles?: boolean;
		sourceTitleMaxChars?: number;
	} = {}
): Promise<void> {
	const autoFetch = options.autoFetchSourceTitles ?? true;
	const maxChars = options.sourceTitleMaxChars ?? 100;
	const existingSourceText = options.existingSourceText ?? "";

	// 1. Build a cache/map of url -> title from existing source lines so we can reuse them
	const urlToTitle = new Map<string, string>();
	if (existingSourceText) {
		for (const line of existingSourceText.split("\n")) {
			const parsed = parseSourceLine(line);
			if (parsed && parsed.state.kind === "raw" && parsed.state.title) {
				urlToTitle.set(parsed.rawUrl, parsed.state.title);
			}
		}
	}

	// Also build a map of url -> title from the incoming citations if they already have one parsed from the vendor
	for (const turn of dialog.turns) {
		if (turn.citations) {
			for (const citation of turn.citations) {
				if (citation.title && !urlToTitle.has(citation.url)) {
					urlToTitle.set(citation.url, citation.title);
				}
			}
		}
	}

	// 2. Identify all unique URLs across the dialog citations that don't have a resolved title yet
	const uniqueUrlsToFetch = new Set<string>();
	for (const turn of dialog.turns) {
		if (turn.citations) {
			for (const citation of turn.citations) {
				if (!urlToTitle.has(citation.url)) {
					uniqueUrlsToFetch.add(citation.url);
				}
			}
		}
	}

	// 3. Fetch/Scrape titles in parallel
	if (autoFetch && uniqueUrlsToFetch.size > 0) {
		const notice = new Notice("Collecting source link titles...", 0);
		try {
			const fetchList = Array.from(uniqueUrlsToFetch);
			const fetchPromises = fetchList.map(async (url) => {
				try {
					const title = await getPageTitle(url, { maxChars });
					return { url, title };
				} catch (_) {
					return { url, title: "" };
				}
			});

			const results = await Promise.all(fetchPromises);
			for (const res of results) {
				if (res.title) {
					urlToTitle.set(res.url, res.title);
				}
			}
		} finally {
			notice.hide();
		}
	}

	// 4. Update the citation elements in dialog.turns
	for (const turn of dialog.turns) {
		if (turn.citations) {
			for (const citation of turn.citations) {
				const resolvedTitle = urlToTitle.get(citation.url);
				if (resolvedTitle) {
					citation.title = resolvedTitle;
				}
			}
		}
	}
}
