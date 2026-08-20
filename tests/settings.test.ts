import { describe, expect, it, vi } from "vitest";
import { PerplexitySaverSettingTab } from "../src/main";
import { HeadlineMethod } from "../src/normalize/headlines";

describe("PerplexitySaverSettingTab declarative settings API (Obsidian 1.13)", () => {
	const createMockPlugin = () => ({
		settings: {
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
		},
		zoteroClient: {
			clearCache: vi.fn(),
		},
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

	it("setControlValue updates zoteroClient when zoteroPort changes", async () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);

		await tab.setControlValue("zoteroPort", 24000);

		expect(plugin.settings.zoteroPort).toBe(24000);
		expect(plugin.zoteroClient).toBeDefined();
		expect((plugin.zoteroClient as any).port).toBe(24000);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});
});
