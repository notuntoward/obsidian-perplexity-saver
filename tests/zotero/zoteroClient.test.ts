import { describe, it, expect, vi } from "vitest";
import { normalizeUrl, extractCitekeyFromExtra, ZoteroClient } from "../../src/zotero/zoteroClient";

describe("zoteroClient - normalizeUrl", () => {
	it("lowercases host and path and strips trailing slash", () => {
		expect(normalizeUrl("HTTPS://Example.COM/Path/To/Page/")).toBe("https://example.com/path/to/page");
	});

	it("preserves query parameters and hashes", () => {
		expect(normalizeUrl("https://example.com/article/?id=123#sec1")).toBe("https://example.com/article?id=123#sec1");
	});
});

describe("zoteroClient - extractCitekeyFromExtra", () => {
	it("extracts Citation Key from extra field", () => {
		const extra = "Citation Key: smith2024\nPublisher: Elsevier";
		expect(extractCitekeyFromExtra(extra)).toBe("smith2024");
	});

	it("extracts citekey insensitive to case", () => {
		const extra = "citekey: jones2025_impact";
		expect(extractCitekeyFromExtra(extra)).toBe("jones2025_impact");
	});

	it("returns null if extra is missing citation key", () => {
		expect(extractCitekeyFromExtra("Publisher: Nature")).toBeNull();
	});
});

describe("zoteroClient - findItemByUrl and findItemByTitle", () => {
	it("extracts citationKey directly from item property if available", async () => {
		const client = new ZoteroClient();
		const rawData = [
			{
				key: "KEY100",
				citationKey: "directKey2026",
				data: {
					title: "Direct Key Paper",
					url: "https://example.com/direct",
				},
			},
		];
		const globalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => rawData,
		});
		try {
			const items = await client.getItems(true);
			expect(items.length).toBe(1);
			expect(items[0].citekey).toBe("directKey2026");
		} finally {
			global.fetch = globalFetch;
		}
	});

	it("finds item by url and fuzzy title", async () => {
		const client = new ZoteroClient();
		// Mock cached items directly
		(client as any).cachedItems = [
			{
				zotkey: "ZOT123",
				citekey: "smith2024",
				title: "Global Climate Warming Analysis",
				url: "https://example.com/climate-study",
				normalizedUrl: "https://example.com/climate-study",
			},
		];
		(client as any).urlMap.set("https://example.com/climate-study", (client as any).cachedItems[0]);

		const byUrl = client.findItemByUrl("https://example.com/climate-study/");
		expect(byUrl).toBeDefined();
		expect(byUrl?.citekey).toBe("smith2024");

		const byTitle = client.findItemByTitle("Global Climate Warming Analysis: Report 2024", 90);
		expect(byTitle).toBeDefined();
		expect(byTitle?.item.zotkey).toBe("ZOT123");
	});
});
