import { describe, expect, it } from "vitest";
import { workspaceChoices, VideoWorkspaceModal } from "../../src/video/workspaceLayout";
import type { App } from "obsidian";

describe("video workspace choices", () => {
	it("offers the saved default first when only the note is visible", () => {
		const choices = workspaceChoices("note", "transcript");
		expect(choices.map((choice) => choice.layout)).toEqual(["transcript", "video", "both"]);
		expect(choices[0].title).toBe("Note + transcript");
	});

	it("offers all layouts, current first, when media is visible", () => {
		const choices = workspaceChoices("both", "video");
		expect(choices).toHaveLength(4);
		expect(choices[0].layout).toBe("both");
		expect(choices.find((choice) => choice.layout === "video")?.title).toBe("Note + video");
		expect(choices.find((choice) => choice.layout === "note")?.title).toBe("Note only");
	});

	it("uses the ordered first item for Enter without a separate selection path", () => {
		let selected = "";
		const modal = new VideoWorkspaceModal({} as App, "note", "both", (layout) => { selected = layout; });
		const results = modal.getSuggestions("");
		expect(results[0].item.layout).toBe("both");
		modal.onChooseItem(results[0].item);
		expect(selected).toBe("both");
	});

	it("offers the same open/show action without removing the saved layout choices", () => {
		let selected = "";
		const modal = new VideoWorkspaceModal({} as App, "note", "video",
			(layout, restore) => { selected = `${layout}:${restore}`; }, "both",
			{ title: "Show open video", run: () => { selected = "show"; } });
		const results = modal.getSuggestions("");
		expect(results[0].item.title).toBe("Show open video");
		modal.onChooseItem(results[0].item);
		expect(selected).toBe("show");
		modal.onChooseItem(results[1].item);
		expect(selected).toBe("both:true");
	});
});
