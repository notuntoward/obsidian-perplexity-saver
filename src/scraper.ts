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
 * Extract webpage title using Zotero Translator metadata hierarchy:
 * 1. Highwire Press / Academic Metadata (citation_title)
 * 2. Dublin Core (dc.title)
 * 3. Open Graph (og:title)
 * 4. Twitter Cards (twitter:title)
 * 5. Schema.org JSON-LD (application/ld+json)
 * 6. Fallback HTML <title> element
 */
export function extractZoteroTitleFromDoc(doc: Document): string | null {
	// 1. Highwire Press / Google Scholar / Academic metadata
	const citationTitle =
		doc.querySelector('meta[name="citation_title" i]')?.getAttribute("content") ||
		doc.querySelector('meta[property="citation_title" i]')?.getAttribute("content");
	if (notBlank(citationTitle)) {
		return citationTitle!.trim();
	}

	// 2. Dublin Core: dc.title / DC.title / DC.Title
	const dcTitle =
		doc.querySelector('meta[name="dc.title" i]')?.getAttribute("content") ||
		doc.querySelector('meta[name="DC.title" i]')?.getAttribute("content") ||
		doc.querySelector('meta[name="DC.Title" i]')?.getAttribute("content");
	if (notBlank(dcTitle)) {
		return dcTitle!.trim();
	}

	// 3. Open Graph: og:title
	const ogTitle =
		doc.querySelector('meta[property="og:title" i]')?.getAttribute("content") ||
		doc.querySelector('meta[name="og:title" i]')?.getAttribute("content");
	if (notBlank(ogTitle)) {
		return ogTitle!.trim();
	}

	// 4. Twitter Cards: twitter:title
	const twitterTitle =
		doc.querySelector('meta[name="twitter:title" i]')?.getAttribute("content") ||
		doc.querySelector('meta[property="twitter:title" i]')?.getAttribute("content");
	if (notBlank(twitterTitle)) {
		return twitterTitle!.trim();
	}

	// 5. Schema.org JSON-LD
	try {
		const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
		for (let i = 0; i < jsonLdScripts.length; i++) {
			const script = jsonLdScripts[i];
			if (script.textContent) {
				const data = JSON.parse(script.textContent);
				const item = Array.isArray(data) ? data[0] : data;
				const ldTitle = item?.headline || item?.name;
				if (typeof ldTitle === "string" && notBlank(ldTitle)) {
					return ldTitle.trim();
				}
			}
		}
	} catch {
		// Ignore JSON-LD parsing errors
	}

	// 6. Fallback HTML <title> element
	const titleEl = doc.querySelector("title");
	if (notBlank(titleEl?.innerText)) {
		return titleEl!.innerText.trim();
	}

	const noTitle = titleEl?.getAttribute("no-title");
	if (notBlank(noTitle)) {
		return noTitle!.trim();
	}

	return null;
}

/**
 * Fetch and extract the page title for the given URL using Zotero Connector logic.
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
		const extracted = extractZoteroTitleFromDoc(doc);

		if (extracted) {
			return extracted;
		}

		return getUrlFinalSegment(url);
	} catch (ex) {
		console.error("Error scraping URL:", url, ex);
		return getUrlFinalSegment(url);
	}
}

/**
 * Clean scraped page title by stripping academic/arXiv ID bracket prefixes.
 */
export function cleanScrapedTitle(title: string): string {
	if (!title) return "";
	let cleaned = title.trim();
	// Strip arXiv ID bracket prefixes like [1805.09785] or [math.NT/0203001]
	cleaned = cleaned.replace(/^\[(?:\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]+)?\/\d{7})(?:v\d+)?\]\s*/i, "");
	return cleaned;
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
	const cleanedTitle = cleanScrapedTitle(rawTitle);
	if (options.maxChars !== undefined && options.maxChars > 0) {
		return truncateAtWord(cleanedTitle, options.maxChars);
	}
	return cleanedTitle;
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
