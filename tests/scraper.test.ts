import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUrlFinalSegment, getPageTitle, resolveSourceTitles } from "../src/scraper";
import { DialogFile } from "../src/parsers/types";
import { requestUrlMock } from "./__mocks__/obsidian";

// Mock global DOMParser for node test environment
if (typeof (global as any).DOMParser === "undefined") {
	(global as any).DOMParser = class {
		parseFromString(html: string, mimeType: string) {
			return {
				querySelector(selector: string) {
					// Handle citation_title meta tag
					if (selector.includes("citation_title")) {
						const match = /<meta\s+[^>]*name=["']citation_title["'][^>]*content=["']([^"']*)["']/i.exec(html) ||
							/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']citation_title["']/i.exec(html);
						if (match) return { getAttribute: (name: string) => name === "content" ? match[1] : null };
					}
					// Handle dc.title meta tag
					if (selector.includes("dc.title")) {
						const match = /<meta\s+[^>]*name=["']dc\.title["'][^>]*content=["']([^"']*)["']/i.exec(html);
						if (match) return { getAttribute: (name: string) => name === "content" ? match[1] : null };
					}
					// Handle og:title meta tag
					if (selector.includes("og:title")) {
						const match = /<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html);
						if (match) return { getAttribute: (name: string) => name === "content" ? match[1] : null };
					}
					// Handle twitter:title meta tag
					if (selector.includes("twitter:title")) {
						const match = /<meta\s+[^>]*name=["']twitter:title["'][^>]*content=["']([^"']*)["']/i.exec(html);
						if (match) return { getAttribute: (name: string) => name === "content" ? match[1] : null };
					}
					if (selector === "title") {
						const titleMatch = html.match(/<title([^>]*)>(.*?)<\/title>/i);
						if (titleMatch) {
							const attrs = titleMatch[1];
							const text = titleMatch[2];
							const noTitleMatch = attrs.match(/no-title="([^"]*)"/);
							return {
								innerText: text,
								getAttribute(name: string) {
									if (name === "no-title" && noTitleMatch) return noTitleMatch[1];
									return null;
								},
							};
						}
					}
					return null;
				},
				querySelectorAll(selector: string) {
					return [];
				}
			};
		}
	} as any;
}

vi.mock("obsidian", async () => {
	const actual = await vi.importActual<any>("obsidian");
	class MockNotice {
		message: string;
		timeout?: number;
		constructor(message: string, timeout?: number) {
			this.message = message;
			this.timeout = timeout;
		}
		setMessage(message: string) {
			this.message = message;
			return this;
		}
		hide() {
			(global as any).__mockNoticeHideCalled = true;
		}
	}
	return {
		...actual,
		Notice: MockNotice,
	};
});

describe("getUrlFinalSegment", () => {
	it("extracts the last path segment as expected", () => {
		expect(getUrlFinalSegment("https://ofm.wa.gov/data-research/washington-trends/population-changes")).toBe("population-changes");
	});

	it("handles trailing slashes correctly", () => {
		expect(getUrlFinalSegment("https://ofm.wa.gov/data-research/washington-trends/population-changes/")).toBe("population-changes");
	});

	it("falls back to hostname if no path segment", () => {
		expect(getUrlFinalSegment("https://ofm.wa.gov")).toBe("ofm.wa.gov");
	});

	it("falls back to hostname for homepage with trailing slash", () => {
		expect(getUrlFinalSegment("https://ofm.wa.gov/")).toBe("ofm.wa.gov");
	});

	it("returns original URL string on error", () => {
		expect(getUrlFinalSegment("not_a_valid_url")).toBe("not_a_valid_url");
	});
});

describe("getPageTitle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("successfully fetches title from HTML", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			text: "<html><head><title>Washington Population Trends</title></head></html>",
		});

		const title = await getPageTitle("https://ofm.wa.gov/population-changes");
		expect(title).toBe("Washington Population Trends");
	});

	it("automatically prefixes https:// if protocol is missing", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			text: "<html><head><title>Some Page</title></head></html>",
		});

		await getPageTitle("ofm.wa.gov/path");
		expect(requestUrlMock).toHaveBeenCalledWith({ url: "https://ofm.wa.gov/path" });
	});

	it("uses getUrlFinalSegment if response is not HTML", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "application/pdf" },
			text: "%PDF-1.4...",
		});

		const title = await getPageTitle("https://ofm.wa.gov/report.pdf");
		expect(title).toBe("report.pdf");
	});

	it("extracts no-title attribute on blank js-based pages", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			text: '<html><head><title no-title="My JS Application"></title></head></html>',
		});

		const title = await getPageTitle("https://jsapp.com");
		expect(title).toBe("My JS Application");
	});

	it("falls back to getUrlFinalSegment on fetch rejection/error", async () => {
		requestUrlMock.mockRejectedValueOnce(new Error("Network Error"));

		const title = await getPageTitle("https://ofm.wa.gov/failed-page");
		expect(title).toBe("failed-page");
	});

	it("truncates retrieved title based on maxChars", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			text: "<html><head><title>This is a very long title that should be shortened</title></head></html>",
		});

		const title = await getPageTitle("https://example.com/long", { maxChars: 15 });
		expect(title.length).toBeLessThanOrEqual(15);
		expect(title).toBe("This is a…");
	});
});

describe("resolveSourceTitles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(global as any).__mockNoticeHideCalled = false;
	});

	it("resolves titles in parallel and populates citations in dialog turns", async () => {
		requestUrlMock
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "text/html" },
				text: "<html><head><title>Page A</title></head></html>",
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "text/html" },
				text: "<html><head><title>Page B</title></head></html>",
			});

		const dialog: DialogFile = {
			sourceVendor: "perplexity",
			turns: [
				{
					role: "ai",
					rawText: "Test response [1] [2]",
					citations: [
						{ origNum: "1", url: "https://siteA.com" },
						{ origNum: "2", url: "https://siteB.com" },
					],
				},
			],
		};

		await resolveSourceTitles(dialog);

		expect(dialog.turns[0].citations[0].title).toBe("Page A");
		expect(dialog.turns[0].citations[1].title).toBe("Page B");

		// Verify Notice hide was called
		expect((global as any).__mockNoticeHideCalled).toBe(true);
	});

	it("deduplicates redundant URLs to prevent multiple network requests", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			text: "<html><head><title>Page Shared</title></head></html>",
		});

		const dialog: DialogFile = {
			sourceVendor: "perplexity",
			turns: [
				{
					role: "ai",
					rawText: "Response [1]",
					citations: [{ origNum: "1", url: "https://shared.com" }],
				},
				{
					role: "ai",
					rawText: "Another response [1]",
					citations: [{ origNum: "1", url: "https://shared.com" }],
				},
			],
		};

		await resolveSourceTitles(dialog);

		expect(dialog.turns[0].citations[0].title).toBe("Page Shared");
		expect(dialog.turns[1].citations[0].title).toBe("Page Shared");
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	it("reuses titles extracted from existing sources section without fetching them", async () => {
		const existingSources = "[^1_1]: [Existing Resolved Title](https://siteA.com)\n";

		// siteB.com needs to be fetched, but siteA.com should be reused
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			text: "<html><head><title>Fetched Title B</title></head></html>",
		});

		const dialog: DialogFile = {
			sourceVendor: "perplexity",
			turns: [
				{
					role: "ai",
					rawText: "Response [1] [2]",
					citations: [
						{ origNum: "1", url: "https://siteA.com" },
						{ origNum: "2", url: "https://siteB.com" },
					],
				},
			],
		};

		await resolveSourceTitles(dialog, { existingSourceText: existingSources });

		expect(dialog.turns[0].citations[0].title).toBe("Existing Resolved Title");
		expect(dialog.turns[0].citations[1].title).toBe("Fetched Title B");
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	it("does not fetch titles if autoFetchSourceTitles is disabled", async () => {
		const dialog: DialogFile = {
			sourceVendor: "perplexity",
			turns: [
				{
					role: "ai",
					rawText: "Test response [1]",
					citations: [{ origNum: "1", url: "https://siteA.com" }],
				},
			],
		};

		await resolveSourceTitles(dialog, { autoFetchSourceTitles: false });

		expect(dialog.turns[0].citations[0].title).toBeUndefined();
		expect(requestUrlMock).not.toHaveBeenCalled();
	});
});
