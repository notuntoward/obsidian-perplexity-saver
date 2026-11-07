import { describe, expect, it, vi } from "vitest";
import PerplexitySaverPlugin, { PerplexitySaverSettingTab } from "../src/main";
import type { App, SettingDefinitionGroup } from "obsidian";
import { HeadlineMethod } from "../src/normalize/headlines";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	debounce: (callback: () => void) => callback,
}));

describe("PerplexitySaverSettingTab declarative settings API (Obsidian 1.13)", () => {
	it("defaults existing installations to list copies while retaining an explicit link-only choice", async () => {
		const plugin = new PerplexitySaverPlugin({} as App, {
			id: "perplexity-saver", name: "Perplexity Saver", version: "1.0.0",
			minAppVersion: "1.14.0", author: "", description: "",
		});
		vi.spyOn(plugin, "loadData").mockResolvedValue({});
		await plugin.loadSettings();
		expect(plugin.settings.timestampCopyFormat).toBe("list");
		vi.mocked(plugin.loadData).mockResolvedValue({ timestampCopyFormat: "link" });
		await plugin.loadSettings();
		expect(plugin.settings.timestampCopyFormat).toBe("link");
	});

	const createMockPlugin = () => ({
		settings: {
			timestampCopyFormat: "list",
			searchesFolder: "ai-searches",
			generatedTag: "ai-generated",
			collapseBlankLines: true,
			collapsePromptCallouts: true,
			headlineMethod: "lead" as HeadlineMethod,
			headlineMaxChars: 100,
			headlineLeadBias: 0.2,
			autoFetchSourceTitles: true,
			sourceTitleMaxChars: 100,
			zoteroPort: 23119,
			litNotesFolder: "lit/lit_notes",
			minTitleMatchScore: 95,
			autoRelinkSources: false,
			validateAuthorNameFormat: false,
			authorFormatStyle: "last-first",
			authorDropVon: false,
			downloadYoutubeTranscripts: true,
		},
		zoteroClient: {
			clearCache: vi.fn(),
		},
		litNoteServerSettings: null as any,
		saveSettings: vi.fn().mockResolvedValue(undefined),
	});

	it("getSettingDefinitions returns all expected top-level settings and groups", () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);

		const definitions = tab.getSettingDefinitions();
		expect(Array.isArray(definitions)).toBe(true);
		expect(definitions.length).toBeGreaterThan(0);

		// Verify top level setting names
		const names = definitions.map((d: any) => d.name || (d.type === "group" ? d.heading : ""));
		expect(names).toContain("AI save folder");
		expect(names).toContain("AI generated tag");
		expect(names).toContain("Collapse blank lines");
		expect(names).toContain("Collapse prompt callouts");
		expect(names).toContain("Prompt heading");
		expect(names).toContain("Source link title fetching");
		expect(names).toContain("Zotero & Literature Note Relinking");
		expect(names).toContain("Literature note formatting");
	});

	it("headlineLeadBias disabled predicate evaluates based on headlineMethod", () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);

		const definitions = tab.getSettingDefinitions();
		const promptGroup: any = definitions.find((d: any) => d.heading === "Prompt heading");
		expect(promptGroup).toBeDefined();

		const leadBiasSetting = promptGroup.items.find((item: any) => item.name === "Heading lead bias");
		expect(leadBiasSetting).toBeDefined();
		expect(typeof leadBiasSetting.control.disabled).toBe("function");

		// When headlineMethod is "lead", leadBias is disabled
		plugin.settings.headlineMethod = "lead";
		expect(leadBiasSetting.control.disabled()).toBe(true);

		// When headlineMethod is "tf-idf", leadBias is enabled
		plugin.settings.headlineMethod = "tf-idf";
		expect(leadBiasSetting.control.disabled()).toBe(false);
	});

	it("sourceTitleMaxChars disabled predicate evaluates based on autoFetchSourceTitles", () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);

		const definitions = tab.getSettingDefinitions();
		const sourceGroup: any = definitions.find((d: any) => d.heading === "Source link title fetching");
		expect(sourceGroup).toBeDefined();

		const maxCharsSetting = sourceGroup.items.find((item: any) => item.name === "Source title max characters");
		expect(maxCharsSetting).toBeDefined();

		// When autoFetchSourceTitles is true, maxChars is enabled
		plugin.settings.autoFetchSourceTitles = true;
		expect(maxCharsSetting.control.disabled()).toBe(false);

		// When autoFetchSourceTitles is false, maxChars is disabled
		plugin.settings.autoFetchSourceTitles = false;
		expect(maxCharsSetting.control.disabled()).toBe(true);
	});

	it("setControlValue updates settings, triggers saveSettings and refreshes DOM state", async () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);
		const refreshSpy = vi.spyOn(tab, "refreshDomState");

		await tab.setControlValue("searchesFolder", "custom-folder");

		expect(plugin.settings.searchesFolder).toBe("custom-folder");
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("offers and saves both timestamp copy formats in the video viewer settings", async () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);
		const group = tab.getSettingDefinitions().find((item): item is SettingDefinitionGroup =>
			"type" in item && item.type === "group" && item.heading === "Video viewer");
		expect(group?.type).toBe("group");
		if (!group?.items) throw new Error("Missing Video viewer settings");
		const format = group.items.find((item) => "name" in item && item.name === "Copied timestamp format");
		expect(format && "control" in format ? format.control : undefined).toMatchObject({
			type: "dropdown", key: "timestampCopyFormat",
			options: { list: expect.any(String), link: expect.any(String) },
		});
		await tab.setControlValue("timestampCopyFormat", "link");
		expect(plugin.settings.timestampCopyFormat).toBe("link");
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it("authorDropVon disabled predicate evaluates based on authorFormatStyle", () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);

		const definitions = tab.getSettingDefinitions();
		const listenerGroup: any = definitions.find((d: any) => d.heading === "Literature note formatting");
		expect(listenerGroup).toBeDefined();

		const dropVonSetting = listenerGroup.items.find((item: any) => item.name === "Drop 'von' particle");
		expect(dropVonSetting).toBeDefined();
		expect(typeof dropVonSetting.control.disabled).toBe("function");

		// When authorFormatStyle is "last-first", dropVon is enabled (disabled() is false)
		plugin.settings.authorFormatStyle = "last-first";
		expect(dropVonSetting.control.disabled()).toBe(false);

		// When authorFormatStyle is "bibtex", dropVon is disabled (disabled() is true)
		plugin.settings.authorFormatStyle = "bibtex";
		expect(dropVonSetting.control.disabled()).toBe(true);
	});

	it("setControlValue updates authorFormatStyle and authorDropVon", async () => {
		const plugin = createMockPlugin();
		(plugin as any).litNoteServerSettings = {
			litNotesFolder: "lit/lit_notes",
			validateAuthorNameFormat: false,
			authorFormatStyle: "last-first",
			authorDropVon: false,
		};
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);

		await tab.setControlValue("authorFormatStyle", "bibtex");
		expect(plugin.settings.authorFormatStyle).toBe("bibtex");
		expect(plugin.litNoteServerSettings.authorFormatStyle).toBe("bibtex");

		await tab.setControlValue("authorDropVon", true);
		expect(plugin.settings.authorDropVon).toBe(true);
		expect(plugin.litNoteServerSettings.authorDropVon).toBe(true);
	});

	it("setControlValue updates downloadYoutubeTranscripts", async () => {
		const plugin = createMockPlugin();
		(plugin as any).litNoteServerSettings = {
			litNotesFolder: "lit/lit_notes",
			downloadYoutubeTranscripts: true,
		};
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);

		await tab.setControlValue("downloadYoutubeTranscripts", false);
		expect(plugin.settings.downloadYoutubeTranscripts).toBe(false);
		expect(plugin.litNoteServerSettings.downloadYoutubeTranscripts).toBe(false);
	});
});
