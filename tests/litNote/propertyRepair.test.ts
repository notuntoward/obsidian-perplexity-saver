import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_LIT_NOTES_FOLDER } from "../../src/litNote/constants";
import { repairCollectionBaselines, repairLitNoteFrontmatter, runLitNoteRepair } from "../../src/litNote/propertyRepair";

describe("one-time literature note property repair", () => {
	it("uses Saver's default literature folder when saved settings omit it", async () => {
		const app = {
			vault: {
				configDir: ".obsidian",
				adapter: { exists: async () => true, read: async () => "{}" },
				getMarkdownFiles: () => [],
			},
			plugins: { manifests: { "perplexity-saver": { dir: ".obsidian/plugins/obsidian-perplexity-saver" } } },
			metadataCache: { resolvedLinks: {} },
		} as unknown as App;
		expect((await runLitNoteRepair(app)).litNotesFolder).toBe(DEFAULT_LIT_NOTES_FOLDER);
	});

	it("backs up and migrates baselines in the registered directory, not the plugin ID directory", async () => {
		const directory = ".obsidian/plugins/obsidian-perplexity-saver";
		const text = JSON.stringify({ collectionAdoptions: { item: { status: "managed", baseline: ["hot_takes"] } }, other: "preserved" });
		const adapter = { exists: vi.fn(async (path: string) => path === `${directory}/data.json`), read: vi.fn(async () => text), write: vi.fn(async (_path: string, _text: string) => {}) };
		const app = {
			plugins: { manifests: { "perplexity-saver": { dir: directory } }, enabledPlugins: new Set() },
			vault: { adapter, getMarkdownFiles: () => [] },
			metadataCache: { resolvedLinks: {} },
		} as unknown as App;
		const dryRun = await runLitNoteRepair(app);
		expect(dryRun.collectionBaselinesChanged).toBe(1);
		expect(adapter.write).not.toHaveBeenCalled();
		const report = await runLitNoteRepair(app, { apply: true });
		expect(adapter.read).toHaveBeenCalledWith(`${directory}/data.json`);
		expect(report.settingsBackup).toMatch(`${directory}/data.json.before-lit-note-repair-`);
		expect(adapter.write.mock.calls[0]).toEqual([report.settingsBackup, text]);
		expect(adapter.write.mock.calls[1][0]).toBe(`${directory}/data.json`);
		expect(JSON.parse(adapter.write.mock.calls[1][1])).toEqual({ collectionAdoptions: { item: { status: "managed", baseline: ["hot-takes"] } }, other: "preserved" });
	});

	it.each([
		[undefined, true, "{}", "registered installation directory"],
		[".obsidian/plugins/obsidian-perplexity-saver", false, "{}", "settings are missing"],
		[".obsidian/plugins/obsidian-perplexity-saver", true, "null", "must be an object"],
		[".obsidian/plugins/obsidian-perplexity-saver", true, '{"collectionAdoptions":{"item":{"status":"managed","baseline":null}}}', "baselines are invalid"],
	])("stops before repairing notes when settings are unsafe: %s %s %s", async (directory, exists, text, message) => {
		const getMarkdownFiles = vi.fn(() => []);
		const app = {
			plugins: { manifests: { "perplexity-saver": { dir: directory } }, enabledPlugins: new Set() },
			vault: { adapter: { exists: async () => exists, read: async () => text }, getMarkdownFiles },
		} as unknown as App;
		await expect(runLitNoteRepair(app, { apply: true })).rejects.toThrow(message);
		expect(getMarkdownFiles).not.toHaveBeenCalled();
	});

	it("refuses application while Saver is enabled", async () => {
		const read = vi.fn();
		const app = {
			plugins: { manifests: { "perplexity-saver": { dir: ".obsidian/plugins/obsidian-perplexity-saver" } }, enabledPlugins: new Set(["perplexity-saver"]) },
			vault: { adapter: { read } },
		} as unknown as App;
		await expect(runLitNoteRepair(app, { apply: true })).rejects.toThrow("Disable Perplexity Saver");
		expect(read).not.toHaveBeenCalled();
	});

	it("repairs old status, tag, and collection properties in canonical order", () => {
		const fm: Record<string, unknown> = {
			category: ["literaturenote"],
			status: "read",
			dateread: "2024-05-01",
			aliases: ["Title"],
			citekey: "key",
			ZoteroTags: ["['democratic party', 'joe biden', 'obsLitNote']"],
			zotero_collections: "['hot_takes_us_elect_2024', 'Morality In Politics']",
		};
		const changes = repairLitNoteFrontmatter(fm, { hasBacklinks: true });
		expect(Object.keys(fm)).toEqual([
			"category", "tags", "read", "in_progress", "linked", "aliases", "citekey", "zotero_tags", "zotero_collections",
		]);
		expect(fm).toMatchObject({
			tags: [], read: true, in_progress: false, linked: true,
			zotero_tags: ["democratic-party", "joe-biden"],
			zotero_collections: ["hot-takes-us-elect-2024", "morality-in-politics"],
		});
		expect(changes).toEqual(expect.arrayContaining([
			"added empty tags", "renamed ZoteroTags to zotero_tags", "repaired zotero_tags", "repaired zotero_collections",
			"removed status/dateread", "set read from dateread", "set linked from backlinks",
		]));
	});

	it("keeps personal values and leaves a repaired note unchanged", () => {
		const fm: Record<string, unknown> = {
			category: ["literaturenote"], tags: ["personal"], read: false, in_progress: true, linked: false,
			aliases: ["Title"], zotero_tags: ["fund-raisers"], zotero_collections: [],
		};
		const before = JSON.stringify(fm);
		expect(repairLitNoteFrontmatter(fm, { hasBacklinks: false })).toEqual([]);
		expect(JSON.stringify(fm)).toBe(before);
	});

	it("keeps empty Zotero lists and adds either missing list", () => {
		const fm: Record<string, unknown> = { category: ["literaturenote"], tags: [], zotero_tags: ["obsLitNote"] };
		expect(repairLitNoteFrontmatter(fm, { hasBacklinks: false })).toContain("repaired zotero_tags");
		expect(fm).toMatchObject({ zotero_tags: [], zotero_collections: [] });
	});

	it("renormalizes managed collection baselines without touching notes managed in Obsidian", () => {
		const { adoptions, changed } = repairCollectionBaselines({
			a: { status: "managed", baseline: ["hot_takes", "bike"] },
			b: { status: "obsidian" },
		});
		expect(changed).toBe(1);
		expect(adoptions).toEqual({ a: { status: "managed", baseline: ["hot-takes", "bike"] }, b: { status: "obsidian" } });
	});
});
