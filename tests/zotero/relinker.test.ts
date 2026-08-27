import { describe, it, expect, vi } from "vitest";
import { autoRelinkSourcesInNote, relinkSourcesInNote } from "../../src/zotero/relinker";
import { ZoteroClient } from "../../src/zotero/zoteroClient";
import { requestUrl } from "obsidian";

vi.mock("obsidian", async () => {
	const actual: any = await vi.importActual("../../tests/__mocks__/obsidian");
	return {
		...actual,
		requestUrl: vi.fn().mockImplementation((options: any) => {
			if (options.url.includes("/better-bibtex/json-rpc")) {
				return Promise.resolve({
					status: 200,
					json: {
						result: [
							{
								id: "http://zotero.org/users/1/items/ZOTKEY1",
								key: "ZOTKEY1",
								citekey: "smith2024climate",
								title: "Climate Study Title",
								URL: "https://example.com/climate",
							},
						],
					},
				});
			}
			if (options.url.includes(":23119/api/users/0/items")) {
				return Promise.resolve({
					status: 200,
					json: [
						{
							key: "ZOTKEY1",
							data: {
								title: "Climate Study Title",
								url: "https://example.com/climate",
								extra: "Citation Key: smith2024climate",
							},
						},
					],
				});
			}
			return actual.requestUrl(options);
		}),
	};
});

describe("relinker - relinkSourcesInNote", () => {
	it("relinks raw source to Zotero item link when matched in Zotero", async () => {
		const mockApp: any = {
			vault: {
				getMarkdownFiles: () => [],
			},
		};

		const sampleNote = `
# Dialog

## Prompt (turn 1)
^turn-1
> [!Prompt]+
> Tell me about climate.

### AI response (turn 1)
Climate change is real[^1_1].

# Sources

[^1_1]: [Climate Study Title](https://example.com/climate)
`.trim();

		const result = await relinkSourcesInNote(mockApp, sampleNote, { zoteroPort: 23119 });
		expect(result.relinkedCount).toBe(1);
		expect(result.zoteroCount).toBe(1);
		expect(result.litNoteCount).toBe(0);
		expect(result.updatedText).toContain("[^1_1]: **[Climate Study Title \u2794 ZOTKEY1](zotero://select/library/items/ZOTKEY1)**");
	});

	it("relinks raw source to Literature Note link when vault contains citekey.md", async () => {
		const mockApp: any = {
			vault: {
				getMarkdownFiles: () => [{ basename: "smith2024climate", parent: { path: "lit/lit_notes" } }],
			},
		};

		const sampleNote = `
# Dialog

## Prompt (turn 1)
^turn-1
> [!Prompt]+
> Tell me about climate.

### AI response (turn 1)
Climate change is real[^1_1].

# Sources

[^1_1]: [Climate Study Title](https://example.com/climate)
`.trim();

		const result = await relinkSourcesInNote(mockApp, sampleNote, { zoteroPort: 23119 });
		expect(result.relinkedCount).toBe(1);
		expect(result.zoteroCount).toBe(0);
		expect(result.litNoteCount).toBe(1);
		expect(result.updatedText).toContain("[^1_1]: **[[smith2024climate|Climate Study Title \u2794 smith2024climate]]**");
	});
});

describe("autoRelinkSourcesInNote", () => {
	const SAMPLE_NOTE = `# Dialog

## Prompt (turn 1)
^turn-1
> [!Prompt]+
> Tell me about climate.

### AI response (turn 1)
Climate change is real[^1_1].

# Sources

[^1_1]: [Climate Study Title](https://example.com/climate)`;

	const RELINK_SETTINGS = {
		autoRelinkSources: true,
		zoteroPort: 23119,
		litNotesFolder: "lit/lit_notes",
		minTitleMatchScore: 95,
	};

	it("returns the text unchanged when autoRelinkSources is off", async () => {
		const mockApp: any = { vault: { getMarkdownFiles: () => [] } };
		const result = await autoRelinkSourcesInNote(mockApp, SAMPLE_NOTE, {
			...RELINK_SETTINGS,
			autoRelinkSources: false,
		});
		expect(result).toBe(SAMPLE_NOTE);
	});

	it("relinks sources when enabled and Zotero returns a match", async () => {
		const mockApp: any = { vault: { getMarkdownFiles: () => [] } };
		const client = new ZoteroClient({ port: 23119 });
		const item = {
			zotkey: "ZOTKEY1",
			citekey: "smith2024climate",
			title: "Climate Study Title",
			url: "https://example.com/climate",
			normalizedUrl: "https://example.com/climate",
		};
		(client as any).cachedItems = [item];
		(client as any).urlMap.set("https://example.com/climate", item);
		(client as any).lastFetchTime = Date.now();

		const result = await autoRelinkSourcesInNote(mockApp, SAMPLE_NOTE, RELINK_SETTINGS, client);
		expect(result).toContain("[^1_1]: **[Climate Study Title \u2794 ZOTKEY1](zotero://select/library/items/ZOTKEY1)**");
	});

	it("returns the original text without throwing when Zotero is unreachable", async () => {
		const mockApp: any = { vault: { getMarkdownFiles: () => [] } };
		const failingClient: any = { getItems: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };

		const result = await autoRelinkSourcesInNote(mockApp, SAMPLE_NOTE, RELINK_SETTINGS, failingClient);
		expect(result).toBe(SAMPLE_NOTE);
	});

	it("handles HTTP 403 Local API disabled errors gracefully", async () => {
		const mockApp: any = { vault: { getMarkdownFiles: () => [] } };
		const forbiddenClient: any = { getItems: vi.fn().mockRejectedValue(new Error("HTTP 403: Forbidden")) };

		const result = await autoRelinkSourcesInNote(mockApp, SAMPLE_NOTE, RELINK_SETTINGS, forbiddenClient);
		expect(result).toBe(SAMPLE_NOTE);
	});

	it("forwards live status messages via onProgress instead of dropping them", async () => {
		const mockApp: any = { vault: { getMarkdownFiles: () => [] } };
		const client = new ZoteroClient({ port: 23119 });
		const item = {
			zotkey: "ZOTKEY1",
			citekey: "smith2024climate",
			title: "Climate Study Title",
			url: "https://example.com/climate",
			normalizedUrl: "https://example.com/climate",
		};
		(client as any).cachedItems = [item];
		(client as any).urlMap.set("https://example.com/climate", item);
		(client as any).lastFetchTime = Date.now();

		const progressMessages: string[] = [];
		await autoRelinkSourcesInNote(mockApp, SAMPLE_NOTE, RELINK_SETTINGS, client, (msg) =>
			progressMessages.push(msg)
		);

		expect(progressMessages.length).toBeGreaterThan(0);
		expect(progressMessages.some((m) => m.toLowerCase().includes("cached"))).toBe(true);
	});

	it("saves the note unlinked instead of hanging when Zotero never responds", async () => {
		vi.useFakeTimers();
		try {
			const mockApp: any = { vault: { getMarkdownFiles: () => [] } };
			// A client whose getItems() never settles, simulating an
			// unresponsive Zotero (e.g. a cold-cache fetch that stalls).
			const neverRespondingClient: any = {
				getItems: vi.fn(() => new Promise(() => {})),
			};

			const resultPromise = autoRelinkSourcesInNote(
				mockApp,
				SAMPLE_NOTE,
				RELINK_SETTINGS,
				neverRespondingClient
			);

			// Advance past the auto-relink timeout guard; without it this
			// would hang the test (and, in the plugin, the user's save).
			await vi.advanceTimersByTimeAsync(10100);

			const result = await resultPromise;
			expect(result).toBe(SAMPLE_NOTE);
		} finally {
			vi.useRealTimers();
		}
	});
});
