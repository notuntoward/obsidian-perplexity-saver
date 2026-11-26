import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { MergePlan } from "../../src/litNote/noteMerge";

const opened: Array<{ initial: Record<string, unknown>; submit: (values: Record<string, unknown>) => void; cancel: () => void; context: unknown; options: Record<string, unknown> }> = [];

vi.mock("commons/properties/review-modal", () => ({
	SelectPropertiesModal: class {
		constructor(_app: unknown, _catalog: unknown, initial: Record<string, unknown>, submit: (values: Record<string, unknown>) => void,
			cancel: () => void, context: unknown, options: Record<string, unknown>) {
			opened.push({ initial, submit, cancel, context, options });
		}
		open(): void {}
	},
}));
vi.mock("commons/properties/catalog", () => ({ collectVaultMetadata: () => ({}) }));
vi.mock("commons/modal", () => ({ applyModalAppearance: vi.fn() }));

const { reviewMergedProperties, chooseMergeOptions } = await import("../../src/litNote/mergeNotesModal");
const { createdModals } = await import("../__mocks__/obsidian");
type Node = { tag: string; text: string; children: Node[] };
const walk = (node: Node): Node[] => [node, ...node.children.flatMap(walk)];

const plan = {
	keeper: { basename: "Keeper" },
	sources: [],
	properties: {
		original: { status: "reading", tags: ["a"] },
		proposed: { status: ["reading", "done"], tags: ["a", "b"] },
		conflicts: ["status"],
		sources: { status: { reading: [{ note: "Keeper", count: 1 }], done: [{ note: "Old", count: 1 }] }, tags: { b: [{ note: "Old", count: 1 }] } },
		protectedValues: { citekey: "smith25" },
	},
} as unknown as MergePlan;

describe("merge options", () => {
	it("emphasizes only the kept note's name, never the note being trashed", () => {
		void chooseMergeOptions({} as App, {
			...plan,
			sources: [{ file: { path: "lit/Old.md", basename: "Old" }, blocks: [], linkedFrom: [] }],
		} as unknown as MergePlan);
		const nodes = walk((createdModals.at(-1) as unknown as { contentEl: Node }).contentEl);
		const emphasized = nodes.filter((node) => /^(strong|b|h[1-6])$/.test(node.tag)).map((node) => node.text);
		expect(emphasized).toEqual(["Keeper"]);
		expect(nodes.some((node) => node.text === "Merge in, then trash")).toBe(true);
	});
});

describe("merged property review", () => {
	it("opens the shared editor on the proposed result and resolves the approved values", async () => {
		const review = reviewMergedProperties({} as App, plan);
		const modal = opened.at(-1)!;
		expect(modal.initial).toEqual(plan.properties.proposed);
		expect(modal.options).toMatchObject({
			title: "Review merged properties",
			subtitle: "Keeper",
			conflictNames: ["status"],
			finishText: "Merge",
			original: plan.properties.original,
			readOnly: { citekey: "smith25" },
		});
		expect(modal.context).toMatchObject({
			status: { conflictNotes: ["Keeper", "Old"], valueSources: { status: plan.properties.sources.status } },
			tags: { valueSources: { tags: plan.properties.sources.tags } },
		});
		modal.submit({ status: "done" });
		await expect(review).resolves.toEqual({ status: "done" });
	});

	it("resolves null when the review is cancelled, so nothing is merged", async () => {
		const review = reviewMergedProperties({} as App, plan);
		opened.at(-1)!.cancel();
		await expect(review).resolves.toBeNull();
	});
});
