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
	options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
	return new Promise((resolve, reject) => {
		try {
			const u = new URL(urlStr);
			const defaultHeaders: Record<string, string> = {
				"Zotero-Allowed-Request": "true",
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
			req.setTimeout(10000, () => {
				req.destroy(new Error("Connection timeout"));
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

	private async postJson(endpointPath: string, payload: any): Promise<any> {
		const hostsToTry = [this.host, "127.0.0.1", "localhost"];
		const uniqueHosts = [...new Set(hostsToTry)];
		const jsonString = JSON.stringify(payload);

		let lastError: any = null;
		for (const host of uniqueHosts) {
			const url = `http://${host}:${this.port}${endpointPath}`;

			// 1. Try Node's native http module first in live runtime (prevents Origin: app://obsidian.md CORS block)
			if (typeof process === "undefined" || !process.env?.VITEST) {
				try {
					const res = await nodeRequest(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": String(Buffer.byteLength(jsonString)),
						},
						body: jsonString,
					});
					if (res.status >= 200 && res.status < 300 && res.text) {
						return JSON.parse(res.text);
					}
				} catch (err) {
					lastError = err;
				}
			}

			// 2. Fallback to Obsidian requestUrl / fetch
			try {
				const response = await requestUrl({
					url,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
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
			} catch (err) {
				lastError = err;
				if (typeof fetch !== "undefined") {
					try {
						const res = await fetch(url, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: jsonString,
						});
						if (res.ok) {
							return await res.json();
						}
					} catch (fetchErr) {
						lastError = fetchErr;
					}
				}
			}
		}
		throw lastError || new Error("Failed to connect to local Zotero HTTP API.");
	}

	private async fetchJsonWithHeaders(
		endpointPath: string
	): Promise<{ data: any; headers: Record<string, string> }> {
		const hostsToTry = [this.host, "127.0.0.1", "localhost"];
		const uniqueHosts = [...new Set(hostsToTry)];

		let lastError: any = null;
		for (const host of uniqueHosts) {
			const url = `http://${host}:${this.port}${endpointPath}`;

			// 1. Try Node's native http module first in live runtime
			if (typeof process === "undefined" || !process.env?.VITEST) {
				try {
					const res = await nodeRequest(url, { method: "GET" });
					if (res.status >= 200 && res.status < 300 && res.text) {
						return { data: JSON.parse(res.text), headers: res.headers };
					}
				} catch (err) {
					lastError = err;
				}
			}

			// 2. Fallback to Obsidian requestUrl / fetch
			try {
				const response = await requestUrl({ url, method: "GET" });
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
			} catch (err) {
				lastError = err;
				if (typeof fetch !== "undefined") {
					try {
						const res = await fetch(url);
						if (res.ok) {
							const json = await res.json();
							return { data: json, headers: {} };
						}
					} catch (fetchErr) {
						lastError = fetchErr;
					}
				}
			}
		}
		throw lastError || new Error("Failed to connect to local Zotero HTTP API.");
	}

	private async fetchJson(endpointPath: string): Promise<any> {
		const res = await this.fetchJsonWithHeaders(endpointPath);
		return res.data;
	}

	/**
	 * Query Zotero's Last-Modified-Version header via a 2ms lightweight check.
	 */
	async getLibraryVersion(): Promise<number | null> {
		try {
			const res = await this.fetchJsonWithHeaders("/api/users/0/items?v=3&format=json&limit=1");
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

	private async getBbtCitekeyMap(zotkeys: string[]): Promise<Map<string, string>> {
		const keyToCitekey = new Map<string, string>();
		if (!zotkeys || zotkeys.length === 0) return keyToCitekey;

		try {
			const res = await this.postJson("/better-bibtex/json-rpc", {
				jsonrpc: "2.0",
				method: "item.citationkey",
				params: [zotkeys],
			});
			const obj = res?.result;
			if (obj && typeof obj === "object") {
				for (const [k, v] of Object.entries(obj)) {
					if (typeof v === "string" && v.trim()) {
						keyToCitekey.set(k, v.trim());
					}
				}
			}
		} catch {
			// Ignore if item.citationkey is unsupported
		}
		return keyToCitekey;
	}

	private async getNativeCitekeyMap(): Promise<Map<string, string>> {
		const keyToCitekey = new Map<string, string>();
		try {
			let start = 0;
			const limit = 500;
			while (start < 10000) {
				const rawData = await this.fetchJson(
					`/api/users/0/items?v=3&format=json&limit=${limit}&start=${start}`
				);
				if (!Array.isArray(rawData) || rawData.length === 0) break;

				for (const rawItem of rawData) {
					const itemData = rawItem.data || rawItem;
					const zotkey = rawItem.key || itemData.key;
					if (!zotkey) continue;
					const citekey =
						rawItem.citationKey ||
						itemData.citationKey ||
						itemData.citekey ||
						itemData["citation-key"] ||
						itemData.citation_key ||
						extractCitekeyFromExtra(itemData.extra);
					if (citekey) {
						keyToCitekey.set(zotkey, citekey);
					}
				}
				if (rawData.length < limit) break;
				start += rawData.length;
			}
		} catch {
			// Fail quietly if native API citekey map query is unavailable
		}
		return keyToCitekey;
	}

	/**
	 * Fetch top-level items from local Zotero (via Better BibTeX JSON-RPC or standard local API).
	 * Uses Zotero's Last-Modified-Version header for 100% reliable smart cache validation.
	 */
	async getItems(options: boolean | GetItemsOptions = {}): Promise<ZoteroItemData[]> {
		const opts: GetItemsOptions =
			typeof options === "boolean" ? { forceRefresh: options } : options;

		const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
		const forceRefresh = opts.forceRefresh ?? false;

		// 1. Smart Version Validation (2ms header check)
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

		const items: ZoteroItemData[] = [];
		this.urlMap.clear();

		// Query native API citekey map to ensure all items have their true BibTeX citekeys
		const nativeCitekeyMap = await this.getNativeCitekeyMap();

		// Primary Method: Query Better BibTeX JSON-RPC API (supported in Zotero 7/8/9)
		try {
			opts.onProgress?.("Fetching Zotero library items via Better BibTeX...");
			let rpcResult = await this.postJson("/better-bibtex/json-rpc", {
				jsonrpc: "2.0",
				method: "item.search",
				params: ["e"],
			});

			if (!rpcResult?.result || rpcResult.result.length === 0) {
				rpcResult = await this.postJson("/better-bibtex/json-rpc", {
					jsonrpc: "2.0",
					method: "item.search",
					params: [""],
				});
			}

			const rpcItems = rpcResult?.result;
			if (Array.isArray(rpcItems) && rpcItems.length > 0) {
				const rpcZotkeys: string[] = [];
				for (const item of rpcItems) {
					let zotkey = item.key || item.zotkey;
					if (!zotkey && typeof item.id === "string") {
						const keyMatch = /\/items\/([A-Za-z0-9]+)/.exec(item.id);
						if (keyMatch) zotkey = keyMatch[1];
					}
					if (zotkey) rpcZotkeys.push(zotkey);
				}

				const bbtCitekeyMap = await this.getBbtCitekeyMap(rpcZotkeys);

				for (const item of rpcItems) {
					// Extract zotkey from "http://zotero.org/users/.../items/KEY" or item.key/zotkey
					let zotkey = item.key || item.zotkey;
					if (!zotkey && typeof item.id === "string") {
						const keyMatch = /\/items\/([A-Za-z0-9]+)/.exec(item.id);
						if (keyMatch) zotkey = keyMatch[1];
					}
					const title = item.title || item.shortTitle || "";
					if (!zotkey || !title) continue;

					const citekey =
						item.citekey ||
						item["citation-key"] ||
						item.citationKey ||
						bbtCitekeyMap.get(zotkey) ||
						nativeCitekeyMap.get(zotkey) ||
						extractCitekeyFromExtra(item.extra) ||
						zotkey;
					const itemUrl = item.URL || item.url ? String(item.URL || item.url).trim() : undefined;
					const normUrl = itemUrl ? normalizeUrl(itemUrl) : undefined;

					const zotItem: ZoteroItemData = {
						zotkey,
						citekey,
						title,
						url: itemUrl,
						normalizedUrl: normUrl,
					};

					items.push(zotItem);
					if (normUrl && !this.urlMap.has(normUrl)) {
						this.urlMap.set(normUrl, zotItem);
					}
				}

				opts.onProgress?.(`Loaded ${items.length} Zotero items. Matching sources...`);
				this.cachedItems = items;
				this.lastFetchTime = Date.now();
				try {
					this.lastLibraryVersion = await this.getLibraryVersion();
				} catch {
					// Ignore version header check failure
				}
				return items;
			}
		} catch (rpcErr) {
			console.debug("Better BibTeX RPC search failed or unavailable, falling back to standard local API:", rpcErr);
		}

		// Fallback Method: Query standard local API endpoints
		let rawData: any[] = [];
		try {
			rawData = await this.fetchJson("/api/users/0/items?v=3&format=json");
		} catch (err) {
			try {
				rawData = await this.fetchJson("/api/users/0/items/top?v=3&format=json");
			} catch {
				throw err;
			}
		}

		if (!Array.isArray(rawData)) {
			this.cachedItems = [];
			return [];
		}

		for (const rawItem of rawData) {
			const itemData = rawItem.data || rawItem;
			const zotkey = rawItem.key || itemData.key;
			const title = itemData.title || itemData.shortTitle || itemData.caseName || "";
			if (!title || !zotkey) continue;

			const citekey =
				rawItem.citationKey ||
				itemData.citationKey ||
				itemData.citekey ||
				itemData["citation-key"] ||
				itemData.citation_key ||
				extractCitekeyFromExtra(itemData.extra) ||
				zotkey;
			const itemUrl = itemData.url ? String(itemData.url).trim() : undefined;
			const normUrl = itemUrl ? normalizeUrl(itemUrl) : undefined;

			const zotItem: ZoteroItemData = {
				zotkey,
				citekey,
				title,
				url: itemUrl,
				normalizedUrl: normUrl,
			};

			items.push(zotItem);
			if (normUrl && !this.urlMap.has(normUrl)) {
				this.urlMap.set(normUrl, zotItem);
			}
		}

		opts.onProgress?.(`Loaded ${items.length} Zotero items. Matching sources...`);
		this.cachedItems = items;
		this.lastFetchTime = Date.now();
		try {
			this.lastLibraryVersion = await this.getLibraryVersion();
		} catch {
			// Ignore version header check failure
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
