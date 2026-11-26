import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { openNotesSideBySide } from "../../src/litNote/noteComparison";

const model = vi.hoisted(() => ({ groups: [] as Array<{ group: object; window: object; leaves: object[]; direction: string | null }> }));
vi.mock("commons/workspace", () => ({
	buildNavigationModel: () => model,
	getGroupForLeaf: (m: typeof model, leaf: { parent?: object }) => m.groups.find((group) => group.group === leaf.parent) ?? null,
	getGroupsInWindow: (m: typeof model, win: object) => m.groups.filter((group) => group.window === win),
}));

function leaf(parent: object) {
	return { parent, openFile: vi.fn(async () => undefined), detach: vi.fn() };
}

describe("openNotesSideBySide", () => {
	it("adds the first note to the current group and the others as tabs in an existing group", async () => {
		const win = {};
		const current = {};
		const left = {};
		const right = {};
		const first = leaf(current);
		model.groups = [
			{ group: current, window: win, leaves: [first], direction: null },
			{ group: left, window: win, leaves: [leaf(left)], direction: "left" },
			{ group: right, window: win, leaves: [leaf(right), leaf(right)], direction: "right" },
		];
		const created = [leaf(right), leaf(right)];
		const workspace = {
			getLeavesOfType: () => [],
			getLeaf: vi.fn(() => first),
			createLeafInParent: vi.fn(() => created.shift()),
			createLeafBySplit: vi.fn(),
			setActiveLeaf: vi.fn(),
		};
		const files = ["a", "b", "c"].map((name) => ({ path: `lit/${name}.md` }) as TFile);

		await openNotesSideBySide({ workspace } as unknown as App, files);

		expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
		expect(workspace.createLeafInParent.mock.calls).toEqual([[right, 2], [right, 3]]);
		expect(workspace.createLeafBySplit).not.toHaveBeenCalled();
		expect(first.openFile).toHaveBeenCalledWith(files[0], { active: true });
		expect(workspace.setActiveLeaf).toHaveBeenCalledWith(first, { focus: true });
	});
});
