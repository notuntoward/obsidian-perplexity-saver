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
		expect(result.updatedText).toContain("[^1_1]: **[Climate Study Title -> ZOTKEY1](zotero://select/library/items/ZOTKEY1)**");
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
		expect(result.updatedText).toContain("[^1_1]: **[[smith2024climate|Climate Study Title -> smith2024climate]]**");
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
		expect(result).toContain("[^1_1]: **[Climate Study Title -> ZOTKEY1](zotero://select/library/items/ZOTKEY1)**");
	});

	it("returns the original text without throwing when Zotero is unreachable", async () => {
		const mockApp: any = { vault: { getMarkdownFiles: () => [] } };
		const failingClient: any = { getItems: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };

		const result = await autoRelinkSourcesInNote(mockApp, SAMPLE_NOTE, RELINK_SETTINGS, failingClient);
		expect(result).toBe(SAMPLE_NOTE);
	});
});
