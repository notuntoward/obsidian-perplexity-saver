import http from "http";
import { requestUrl } from "obsidian";
import { matchTitles } from "./matcher";
import { normalizeUrl } from "../utils";

export interface ZoteroItemData {
	zotkey: string;
	citekey: string;
	title: string;
	url?: string;
	normalizedUrl?: string;
	dateModified?: string;
	version?: number;
}

/**
 * Perform a direct TCP HTTP request using Node's http module.
 * Bypasses Obsidian's requestUrl automatic Origin: app://obsidian.md header injection
 * which causes local Zotero / Better BibTeX servers to reject local requests.
 */
function nodeRequest(
	urlStr: string,
	options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
	return new Promise((resolve, reject) => {
		try {
			const u = new URL(urlStr);
			const defaultHeaders: Record<string, string> = {
				"Zotero-Allowed-Request": "true",
				"Zotero-API-Version": "3",
				...(options.headers || {}),
			};
			const req = http.request(
				{
					hostname: u.hostname,
					port: u.port ? parseInt(u.port, 10) : 80,
					path: u.pathname + u.search,
					method: options.method || "GET",
					headers: defaultHeaders,
				},
				(res) => {
					let data = "";
					res.setEncoding("utf-8");
					res.on("data", (chunk) => {
						data += chunk;
					});
					res.on("end", () => {
						const hdrs: Record<string, string> = {};
						for (const [k, v] of Object.entries(res.headers)) {
							if (v) hdrs[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
						}
						resolve({ status: res.statusCode || 200, headers: hdrs, text: data });
					});
				}
			);
			const timeout = options.timeoutMs ?? 6000;
			req.setTimeout(timeout, () => {
				req.destroy(new Error(`Connection timeout after ${timeout}ms`));
			});
			req.on("error", (err) => reject(err));
			if (options.body) {
				req.write(options.body);
			}
			req.end();
		} catch (err) {
			reject(err);
		}
	});
}

/**
 * Extract Better BibTeX / Zotero Citation Key from an item's extra field.
 */
export function extractCitekeyFromExtra(extra?: string): string | null {
	if (!extra) return null;
	const match = /(?:Citation Key|citekey|bibtex):\s*(\S+)/i.exec(extra);
	return match ? match[1].trim() : null;
}

export interface GetItemsOptions {
	forceRefresh?: boolean;
	ttlMs?: number;
	onProgress?: (message: string) => void;
}

export class ZoteroClient {
	private port: number;
	private host: string;
	private cachedItems: ZoteroItemData[] | null = null;
	private lastFetchTime = 0;
	private lastLibraryVersion: number | null = null;
	private urlMap: Map<string, ZoteroItemData> = new Map();

	constructor(options: { port?: number; host?: string } = {}) {
		this.port = options.port ?? 23119;
		this.host = options.host ?? "127.0.0.1";
	}

	clearCache(): void {
		this.cachedItems = null;
		this.lastFetchTime = 0;
		this.lastLibraryVersion = null;
		this.urlMap.clear();
	}

	isCacheValid(ttlMs = 10 * 60 * 1000): boolean {
		if (!this.cachedItems || this.lastFetchTime === 0) return false;
		return Date.now() - this.lastFetchTime < ttlMs;
	}

	private async postJson(endpointPath: string, payload: any, timeoutMs = 3000): Promise<any> {
		const hostsToTry = [this.host, "127.0.0.1", "localhost"];
		const uniqueHosts = [...new Set(hostsToTry)];
		const jsonString = JSON.stringify(payload);

		let lastError: any = null;
		for (const host of uniqueHosts) {
			const url = `http://${host}:${this.port}${endpointPath}`;

			// 1. In Electron / Node runtime: use direct Node http request (bypasses browser CORS)
			if (typeof process === "undefined" || !process.env?.VITEST) {
				try {
					const res = await nodeRequest(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": String(Buffer.byteLength(jsonString)),
						},
						body: jsonString,
						timeoutMs,
					});
					if (res.status >= 200 && res.status < 300 && res.text) {
						return JSON.parse(res.text);
					}
					if (res.status === 403) {
						throw new Error("HTTP 403: Forbidden - Local API access was rejected by Zotero");
					}
					lastError = new Error(`HTTP ${res.status}: ${res.text || "Request failed"}`);
				} catch (err: any) {
					if (err?.message?.includes("403") || err?.message?.toLowerCase()?.includes("forbidden")) {
						throw err;
					}
					lastError = err;
				}
				continue;
			}

			// 2. Vitest test fallback
			try {
				const response = await requestUrl({
					url,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Zotero-API-Version": "3",
						"Zotero-Allowed-Request": "true",
					},
					body: jsonString,
				});
				let parsed: any;
				if (response.json) {
					parsed = response.json;
				} else if (response.text) {
					parsed = JSON.parse(response.text);
				}
				if (parsed) return parsed;
			} catch (err: any) {
				lastError = err;
				if (typeof fetch !== "undefined") {
					try {
						const res = await fetch(url, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"Zotero-API-Version": "3",
								"Zotero-Allowed-Request": "true",
							},
							body: jsonString,
						});
						if (res.ok) {
							return await res.json();
						}
						lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
					} catch (fetchErr) {
						lastError = fetchErr;
					}
				}
			}
		}
		throw lastError || new Error("Failed to connect to local Zotero HTTP API.");
	}

	private async fetchJsonWithHeaders(
		endpointPath: string,
		timeoutMs = 6000
	): Promise<{ data: any; headers: Record<string, string> }> {
		const hostsToTry = [this.host, "127.0.0.1", "localhost"];
		const uniqueHosts = [...new Set(hostsToTry)];

		let lastError: any = null;
		for (const host of uniqueHosts) {
			const url = `http://${host}:${this.port}${endpointPath}`;

			// 1. In Electron / Node runtime: use direct Node http request (bypasses browser CORS)
			if (typeof process === "undefined" || !process.env?.VITEST) {
				try {
					const res = await nodeRequest(url, { method: "GET", timeoutMs });
					if (res.status >= 200 && res.status < 300 && res.text) {
						return { data: JSON.parse(res.text), headers: res.headers };
					}
					if (res.status === 403) {
						throw new Error("HTTP 403: Forbidden - Local API access was rejected by Zotero");
					}
					lastError = new Error(`HTTP ${res.status}: ${res.text || "Request failed"}`);
				} catch (err: any) {
					if (err?.message?.includes("403") || err?.message?.toLowerCase()?.includes("forbidden")) {
						throw err;
					}
					lastError = err;
				}
				continue;
			}

			// 2. Vitest test fallback
			try {
				const response = await requestUrl({
					url,
					method: "GET",
					headers: {
						"Zotero-API-Version": "3",
						"Zotero-Allowed-Request": "true",
					},
				});
				const hdrs: Record<string, string> = {};
				if (response.headers) {
					for (const [k, v] of Object.entries(response.headers)) {
						if (v) hdrs[k.toLowerCase()] = String(v);
					}
				}
				let parsed: any;
				if (response.json) {
					parsed = response.json;
				} else if (response.text) {
					parsed = JSON.parse(response.text);
				}
				if (parsed) return { data: parsed, headers: hdrs };
			} catch (err: any) {
				lastError = err;
				if (typeof fetch !== "undefined") {
					try {
						const res = await fetch(url, {
							headers: {
								"Zotero-API-Version": "3",
								"Zotero-Allowed-Request": "true",
							},
						});
						if (res.ok) {
							const json = await res.json();
							return { data: json, headers: {} };
						}
						lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
					} catch (fetchErr) {
						lastError = fetchErr;
					}
				}
			}
		}
		throw lastError || new Error("Failed to connect to local Zotero HTTP API.");
	}

	private async fetchJson(endpointPath: string, timeoutMs = 6000): Promise<any> {
		const res = await this.fetchJsonWithHeaders(endpointPath, timeoutMs);
		return res.data;
	}

	/**
	 * Query Zotero's Last-Modified-Version header via a lightweight check.
	 */
	async getLibraryVersion(): Promise<number | null> {
		try {
			const res = await this.fetchJsonWithHeaders("/api/users/0/items?v=3&format=json&limit=1", 2500);
			const verStr = res.headers["last-modified-version"];
			if (verStr) {
				const ver = parseInt(verStr, 10);
				if (!isNaN(ver)) return ver;
			}
		} catch {
			// Version header check unavailable
		}
		return null;
	}

	/**
	 * Resolves citekeys in batch using Better BibTeX RPC for any items missing a citekey.
	 */
	private async resolveBbtCitekeys(zotkeys: string[]): Promise<Map<string, string>> {
		const keyToCitekey = new Map<string, string>();
		if (!zotkeys || zotkeys.length === 0) return keyToCitekey;

		try {
			const res = await this.postJson(
				"/better-bibtex/json-rpc",
				{
					jsonrpc: "2.0",
					method: "item.citationkey",
					params: [zotkeys],
				},
				2000
			);
			const obj = res?.result;
			if (obj && typeof obj === "object") {
				for (const [k, v] of Object.entries(obj)) {
					if (typeof v === "string" && v.trim()) {
						keyToCitekey.set(k, v.trim());
					}
				}
			}
		} catch {
			// Fail gracefully if BBT RPC is not installed or enabled
		}
		return keyToCitekey;
	}

	/**
	 * Fetch top-level items from local Zotero using fast parallel pagination and smart version caching.
	 */
	async getItems(options: boolean | GetItemsOptions = {}): Promise<ZoteroItemData[]> {
		const opts: GetItemsOptions =
			typeof options === "boolean" ? { forceRefresh: options } : options;

		const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
		const forceRefresh = opts.forceRefresh ?? false;

		// 1. Smart Version Validation (<50ms header check)
		if (!forceRefresh && this.cachedItems && this.lastLibraryVersion !== null) {
			opts.onProgress?.("Checking Zotero library version...");
			const currentVersion = await this.getLibraryVersion();

			if (currentVersion !== null && currentVersion === this.lastLibraryVersion) {
				opts.onProgress?.(
					`Zotero library unchanged (v${currentVersion}). Using cached ${this.cachedItems.length} items...`
				);
				return this.cachedItems;
			}

			if (currentVersion !== null && currentVersion > this.lastLibraryVersion) {
				opts.onProgress?.(
					`Zotero library updated (v${this.lastLibraryVersion} → v${currentVersion}). Updating cache...`
				);
			}
		} else if (!forceRefresh && this.isCacheValid(ttlMs)) {
			opts.onProgress?.(`Using cached Zotero library (${this.cachedItems!.length} items)...`);
			return this.cachedItems!;
		}

		opts.onProgress?.(`Connecting to Zotero API (port ${this.port})...`);

		// 2. Fetch top-level items using fast paginated native API
		const pageSize = 100;
		const initialRes = await this.fetchJsonWithHeaders(
			`/api/users/0/items/top?v=3&format=json&limit=${pageSize}&start=0`
		);
		const totalResults = parseInt(initialRes.headers["total-results"] || "0", 10);
		const initialData = Array.isArray(initialRes.data) ? initialRes.data : [];

		const allRawItems: any[] = [...initialData];

		if (totalResults > pageSize) {
			opts.onProgress?.(`Loading Zotero items (0/${totalResults})...`);
			const starts: number[] = [];
			for (let start = pageSize; start < totalResults; start += pageSize) {
				starts.push(start);
			}

			const concurrency = 4;
			for (let i = 0; i < starts.length; i += concurrency) {
				const chunk = starts.slice(i, i + concurrency);
				const chunkPages = await Promise.all(
					chunk.map((start) =>
						this.fetchJson(`/api/users/0/items/top?v=3&format=json&limit=${pageSize}&start=${start}`)
							.then((pageData) => (Array.isArray(pageData) ? pageData : []))
							.catch((err) => {
								console.warn(`Failed to fetch Zotero items page at start=${start}:`, err);
								return [];
							})
					)
				);
				for (const page of chunkPages) {
					allRawItems.push(...page);
				}
				opts.onProgress?.(`Loading Zotero items (${Math.min(allRawItems.length, totalResults)}/${totalResults})...`);
			}
		}

		const items: ZoteroItemData[] = [];
		this.urlMap.clear();
		const missingCitekeyZotkeys: string[] = [];

		for (const rawItem of allRawItems) {
			const itemData = rawItem.data || rawItem;
			const zotkey = rawItem.key || itemData.key;
			const title = itemData.title || itemData.shortTitle || itemData.caseName || itemData.name || "";
			if (!title || !zotkey) continue;

			const citekey =
				rawItem.citationKey ||
				itemData.citationKey ||
				itemData.citekey ||
				itemData["citation-key"] ||
				itemData.citation_key ||
				extractCitekeyFromExtra(itemData.extra);

			if (!citekey) {
				missingCitekeyZotkeys.push(zotkey);
			}

			const itemUrl = itemData.url ? String(itemData.url).trim() : undefined;
			const normUrl = itemUrl ? normalizeUrl(itemUrl) : undefined;

			const zotItem: ZoteroItemData = {
				zotkey,
				citekey: citekey || zotkey,
				title,
				url: itemUrl,
				normalizedUrl: normUrl,
				dateModified: itemData.dateModified,
				version: itemData.version,
			};

			items.push(zotItem);
			if (normUrl && !this.urlMap.has(normUrl)) {
				this.urlMap.set(normUrl, zotItem);
			}
		}

		// 3. For any items still lacking a citekey, query Better BibTeX in a single targeted batch
		if (missingCitekeyZotkeys.length > 0) {
			try {
				const bbtMap = await this.resolveBbtCitekeys(missingCitekeyZotkeys);
				if (bbtMap.size > 0) {
					for (const item of items) {
						const resolved = bbtMap.get(item.zotkey);
						if (resolved) {
							item.citekey = resolved;
						}
					}
				}
			} catch {
				// Continue with fallback keys
			}
		}

		opts.onProgress?.(`Loaded ${items.length} Zotero items. Matching sources...`);
		this.cachedItems = items;
		this.lastFetchTime = Date.now();
		try {
			this.lastLibraryVersion = await this.getLibraryVersion();
		} catch {
			// Version check failure
		}

		return items;
	}

	/**
	 * Find a Zotero item by normalized URL.
	 */
	findItemByUrl(url: string): ZoteroItemData | undefined {
		if (!url) return undefined;
		const norm = normalizeUrl(url);
		return this.urlMap.get(norm);
	}

	/**
	 * Find the best Zotero item match by fuzzy title scoring.
	 */
	findItemByTitle(
		targetTitle: string,
		minScore = 95
	): { item: ZoteroItemData; score: number } | undefined {
		if (!targetTitle || !this.cachedItems || this.cachedItems.length === 0) {
			return undefined;
		}

		let bestMatch: ZoteroItemData | undefined = undefined;
		let bestScore = 0;

		for (const item of this.cachedItems) {
			const score = matchTitles(targetTitle, item.title);
			if (score > bestScore && score >= minScore) {
				bestScore = score;
				bestMatch = item;
			}
		}

		return bestMatch ? { item: bestMatch, score: bestScore } : undefined;
	}
}
