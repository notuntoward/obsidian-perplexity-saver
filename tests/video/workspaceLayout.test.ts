import { describe, expect, it } from "vitest";
import { workspaceChoices, VideoWorkspaceModal } from "../../src/video/workspaceLayout";
import type { App } from "obsidian";

describe("video workspace choices", () => {
	it("offers the preferred layout first when only the note is visible", () => {
		const choices = workspaceChoices("note", "transcript");
		expect(choices.map((choice) => choice.layout)).toEqual(["transcript", "video", "both"]);
		expect(choices[0].title).toBe("Open preferred: Note + transcript");
	});

	it("offers all layouts, current first, when media is visible", () => {
		const choices = workspaceChoices("both", "video");
		expect(choices).toHaveLength(4);
		expect(choices[0]).toMatchObject({ layout: "both", badge: "Current" });
		expect(choices.find((choice) => choice.layout === "video")?.badge).toBe("Preferred");
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
});
