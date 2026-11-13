import { describe, expect, it, vi } from "vitest";
import PerplexitySaverPlugin, { PerplexitySaverSettingTab } from "../src/main";
import type { App, SettingDefinitionGroup } from "obsidian";
import { HeadlineMethod } from "../src/normalize/headlines";

vi.mock("obsidian", async (original) => ({
	...await original<Record<string, unknown>>(),
	debounce: (callback: () => void) => callback,
}));

describe("PerplexitySaverSettingTab declarative settings API (Obsidian 1.13)", () => {
	it("keeps Jev opt-in, stores only a secret reference and rejects invalid thresholds", async () => {
		const app = { workspace: { getLeavesOfType: () => [] } } as unknown as App;
		const plugin = new PerplexitySaverPlugin(app, {
			id: "perplexity-saver", name: "Perplexity Saver", version: "1.0.0",
			minAppVersion: "1.14.0", author: "", description: "",
		});
		vi.spyOn(plugin, "loadData").mockResolvedValue({});
		await plugin.loadSettings();
		expect(plugin.settings.jevExperimentEnabled).toBe(false);
		expect(plugin.settings.jevApiKeySecret).toBe("");
		const tab = new PerplexitySaverSettingTab(app, plugin);
		const group = tab.getSettingDefinitions().find((item): item is SettingDefinitionGroup =>
			"type" in item && item.type === "group" && item.heading === "YouTube transcripts");
		expect(group?.items).toContainEqual(expect.objectContaining({
			name: "TypeSafe API key", control: expect.objectContaining({ type: "secret", key: "jevApiKeySecret" }),
		}));
		vi.spyOn(plugin, "saveSettings").mockResolvedValue();
		vi.spyOn(tab, "refreshDomState").mockImplementation(() => {});
		await tab.setControlValue("jevApiKeySecret", "typesafe");
		expect(plugin.settings.jevApiKeySecret).toBe("typesafe");
		await tab.setControlValue("jevSentenceThreshold", 0.95);
		await tab.setControlValue("jevSentenceThreshold", Number.NaN);
		expect(plugin.settings.jevSentenceThreshold).toBe(0.95);
		await tab.setControlValue("jevExperimentEnabled", true);
		await tab.setControlValue("jevExperimentEnabled", false);
		expect(plugin.settings.jevExperimentEnabled).toBe(false);
	});

	it("defaults transcript folding on and preserves an explicit off setting", async () => {
		const plugin = new PerplexitySaverPlugin({} as App, {
			id: "perplexity-saver", name: "Perplexity Saver", version: "1.0.0",
			minAppVersion: "1.14.0", author: "", description: "",
		});
		vi.spyOn(plugin, "loadData").mockResolvedValue({});
		await plugin.loadSettings();
		expect(plugin.settings.collapseTranscriptOnOpen).toBe(true);
		vi.mocked(plugin.loadData).mockResolvedValue({ collapseTranscriptOnOpen: false });
		await plugin.loadSettings();
		expect(plugin.settings.collapseTranscriptOnOpen).toBe(false);
		const tab = new PerplexitySaverSettingTab({} as App, plugin);
		const group = tab.getSettingDefinitions().find((item): item is SettingDefinitionGroup =>
			"type" in item && item.type === "group" && item.heading === "YouTube transcripts");
		expect(group?.items).toContainEqual(expect.objectContaining({
			name: "Collapse transcript on open",
			control: { type: "toggle", key: "collapseTranscriptOnOpen" },
		}));
		vi.spyOn(plugin, "saveSettings").mockResolvedValue();
		vi.spyOn(tab, "refreshDomState").mockImplementation(() => {});
		await tab.setControlValue("collapseTranscriptOnOpen", true);
		expect(plugin.settings.collapseTranscriptOnOpen).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});

	it("defaults copies to link only while retaining an explicit list-item choice", async () => {
		const plugin = new PerplexitySaverPlugin({} as App, {
			id: "perplexity-saver", name: "Perplexity Saver", version: "1.0.0",
			minAppVersion: "1.14.0", author: "", description: "",
		});
		vi.spyOn(plugin, "loadData").mockResolvedValue({});
		await plugin.loadSettings();
		expect(plugin.settings.timestampCopyFormat).toBe("link");
		vi.mocked(plugin.loadData).mockResolvedValue({ timestampCopyFormat: "list" });
		await plugin.loadSettings();
		expect(plugin.settings.timestampCopyFormat).toBe("list");
	});

	it("defaults toolbar captures to insertion and preserves and saves an explicit copy choice", async () => {
		const plugin = new PerplexitySaverPlugin({} as App, {
			id: "perplexity-saver", name: "Perplexity Saver", version: "1.0.0",
			minAppVersion: "1.14.0", author: "", description: "",
		});
		vi.spyOn(plugin, "loadData").mockResolvedValue({});
		await plugin.loadSettings();
		expect(plugin.settings.videoToolbarCaptureAction).toBe("insert");
		vi.mocked(plugin.loadData).mockResolvedValue({ videoToolbarCaptureAction: "copy" });
		await plugin.loadSettings();
		expect(plugin.settings.videoToolbarCaptureAction).toBe("copy");
		const tab = new PerplexitySaverSettingTab({} as App, plugin);
		const group = tab.getSettingDefinitions().find((item): item is SettingDefinitionGroup =>
			"type" in item && item.type === "group" && item.heading === "Video viewer");
		expect(group?.items).toContainEqual(expect.objectContaining({
			name: "Toolbar timestamp and screenshot action",
			control: {
				type: "dropdown", key: "videoToolbarCaptureAction",
				options: { insert: "Insert into note (default)", copy: "Copy to clipboard" },
			},
		}));
		vi.spyOn(plugin, "saveSettings").mockResolvedValue();
		vi.spyOn(tab, "refreshDomState").mockImplementation(() => {});
		await tab.setControlValue("videoToolbarCaptureAction", "insert");
		expect(plugin.settings.videoToolbarCaptureAction).toBe("insert");
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});

	it("defaults YouTube captions off, preserves an explicit on choice and exposes a saved toggle", async () => {
		const plugin = new PerplexitySaverPlugin({} as App, {
			id: "perplexity-saver", name: "Perplexity Saver", version: "1.0.0",
			minAppVersion: "1.14.0", author: "", description: "",
		});
		vi.spyOn(plugin, "loadData").mockResolvedValue({});
		await plugin.loadSettings();
		expect(plugin.settings.showYoutubeCaptions).toBe(false);
		vi.mocked(plugin.loadData).mockResolvedValue({ showYoutubeCaptions: true });
		await plugin.loadSettings();
		expect(plugin.settings.showYoutubeCaptions).toBe(true);
		const tab = new PerplexitySaverSettingTab({} as App, plugin);
		const group = tab.getSettingDefinitions().find((item): item is SettingDefinitionGroup =>
			"type" in item && item.type === "group" && item.heading === "Video viewer");
		expect(group?.items).toContainEqual(expect.objectContaining({
			name: "Show YouTube captions",
			control: { type: "toggle", key: "showYoutubeCaptions" },
		}));
		vi.spyOn(plugin, "saveSettings").mockResolvedValue();
		vi.spyOn(tab, "refreshDomState").mockImplementation(() => {});
		await tab.setControlValue("showYoutubeCaptions", false);
		expect(plugin.settings.showYoutubeCaptions).toBe(false);
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});

	it("defaults inserted timestamp list items to the current list and offers every list form", async () => {
		const plugin = new PerplexitySaverPlugin({} as App, {
			id: "perplexity-saver", name: "Perplexity Saver", version: "1.0.0",
			minAppVersion: "1.14.0", author: "", description: "",
		});
		vi.spyOn(plugin, "loadData").mockResolvedValue({});
		await plugin.loadSettings();
		expect(plugin.settings.timestampListStyle).toBe("match");
		vi.mocked(plugin.loadData).mockResolvedValue({ timestampListStyle: "task" });
		await plugin.loadSettings();
		expect(plugin.settings.timestampListStyle).toBe("task");
		const tab = new PerplexitySaverSettingTab({} as App, plugin);
		const group = tab.getSettingDefinitions().find((item): item is SettingDefinitionGroup =>
			"type" in item && item.type === "group" && item.heading === "Video viewer");
		expect(group?.items).toContainEqual(expect.objectContaining({
			name: "Timestamp list item style",
			control: {
				type: "dropdown", key: "timestampListStyle",
				options: {
					match: "Match current list (default)",
					unordered: "Unordered list (-)",
					ordered: "Ordered list (1.)",
					task: "Task list (- [ ])",
				},
			},
		}));
		vi.spyOn(plugin, "saveSettings").mockResolvedValue();
		vi.spyOn(tab, "refreshDomState").mockImplementation(() => {});
		await tab.setControlValue("timestampListStyle", "ordered");
		expect(plugin.settings.timestampListStyle).toBe("ordered");
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});

	const createMockPlugin = () => ({
		settings: {
			timestampCopyFormat: "link",
			timestampListStyle: "match",
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
			preferredVideoWorkspace: "video",
			videoNoteFocusIndicator: true,
		},
		zoteroClient: {
			clearCache: vi.fn(),
		},
		litNoteServerSettings: null as any,
		saveSettings: vi.fn().mockResolvedValue(undefined),
	});

	it("exposes the video workspace default and focus indicator settings", async () => {
		const plugin = createMockPlugin();
		const tab = new PerplexitySaverSettingTab({} as any, plugin as any);
		const group = tab.getSettingDefinitions().find((item): item is SettingDefinitionGroup =>
			"type" in item && item.type === "group" && item.heading === "YouTube transcripts");
		expect(group?.items).toContainEqual(expect.objectContaining({
			name: "Video workspace default",
			control: expect.objectContaining({ type: "dropdown", key: "preferredVideoWorkspace" }),
		}));
		expect(group?.items).toContainEqual(expect.objectContaining({
			name: "Video note focus indicator",
			control: { type: "toggle", key: "videoNoteFocusIndicator" },
		}));
		vi.spyOn(tab, "refreshDomState").mockImplementation(() => {});
		await tab.setControlValue("preferredVideoWorkspace", "both");
		expect((plugin.settings as any).preferredVideoWorkspace).toBe("both");
		expect((plugin.settings as any).videoNoteFocusIndicator).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
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
		const format = group.items.find((item) => "name" in item && item.name === "Copy current timestamp format");
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
