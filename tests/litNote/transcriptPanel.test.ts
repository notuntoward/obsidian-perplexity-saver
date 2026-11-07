import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import {
	TRANSCRIPT_VIEW_TYPE,
	currentRowIndex,
	scrollParent,
	stepRow,
	hideTranscriptPanels,
	showTranscriptPanel,
	visibleTranscriptLeaves,
} from "../../src/litNote/transcriptView";

const mainWin = { closed: false } as unknown as Window;
const popWin = { closed: false } as unknown as Window;
const rootSplit = {};

interface Dock {
	collapsed: boolean;
	collapse(): void;
	expand(): void;
}
const dock = (): Dock => ({
	collapsed: false,
	collapse() {
		this.collapsed = true;
	},
	expand() {
		this.collapsed = false;
	},
});

let rightSplit: Dock;

function leaf(root: object, shown: boolean, win: Window = mainWin) {
	return {
		getRoot: () => root,
		getContainer: () => ({ win }),
		view: { containerEl: { isShown: () => shown } },
		detach: vi.fn(),
	};
}

type FakeLeaf = ReturnType<typeof leaf>;

function appWith(leaves: FakeLeaf[], extra: Record<string, unknown> = {}): App {
	return {
		workspace: {
			rootSplit,
			rightSplit,
			leftSplit: dock(),
			getLeavesOfType: (type: string) => (type === TRANSCRIPT_VIEW_TYPE ? leaves : []),
			...extra,
		},
	} as unknown as App;
}

beforeEach(() => {
	rightSplit = dock();
});

describe("transcript panel visibility (viewer's show/hide transcript button)", () => {
	it("closes a transcript panel open in the right sidebar", () => {
		const side = leaf(rightSplit, true);
		const app = appWith([side]);
		expect(visibleTranscriptLeaves(app)).toEqual([side as unknown as WorkspaceLeaf]);
		expect(hideTranscriptPanels(app)).toBe(true);
		expect(side.detach).toHaveBeenCalled();
	});

	it("does not count a panel in a collapsed sidebar or a background tab as shown", () => {
		rightSplit.collapsed = true;
		const collapsed = leaf(rightSplit, true);
		const background = leaf(rootSplit, false);
		const app = appWith([collapsed, background]);
		expect(visibleTranscriptLeaves(app)).toEqual([]);
		expect(hideTranscriptPanels(app)).toBe(false);
		expect(collapsed.detach).not.toHaveBeenCalled();
		expect(background.detach).not.toHaveBeenCalled();
	});

	it("closes a visible panel below the viewer", () => {
		const below = leaf(rootSplit, true);
		expect(hideTranscriptPanels(appWith([below]))).toBe(true);
		expect(below.detach).toHaveBeenCalled();
	});

	it("scoped to a pop-out viewer, sees and closes only panels in that window", () => {
		const viewer = leaf(rootSplit, true, popWin) as unknown as WorkspaceLeaf;
		const side = leaf(rightSplit, true, mainWin);
		const beside = leaf(rootSplit, true, popWin);
		const app = appWith([side, beside]);
		expect(visibleTranscriptLeaves(app, viewer)).toEqual([beside as unknown as WorkspaceLeaf]);
		expect(hideTranscriptPanels(app, viewer)).toBe(true);
		expect(beside.detach).toHaveBeenCalled();
		expect(side.detach).not.toHaveBeenCalled();
	});
});

describe("collapsing the right sidebar when the transcript is hidden", () => {
	const file = { path: "lit.md", basename: "lit", extension: "md" };
	const note = "# Transcript\n[00:01](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1) hello\n";

	function appForShow(leaves: FakeLeaf[], sideLeaf: FakeLeaf) {
		return appWith(leaves, {
			ensureSideLeaf: vi.fn(async () => {
				rightSplit.expand();
				if (!leaves.includes(sideLeaf)) leaves.push(sideLeaf);
				return sideLeaf;
			}),
		}) as App & { vault?: unknown; metadataCache?: unknown };
	}

	async function show(app: App): Promise<void> {
		Object.assign(app, {
			vault: { cachedRead: async () => note },
			metadataCache: {
				getFileCache: () => ({
					headings: [{ heading: "Transcript", level: 1, position: { start: { offset: 0 }, end: { offset: 12 } } }],
				}),
			},
		});
		await showTranscriptPanel(app, file as never, "Transcript");
	}

	it("collapses the sidebar again when showing the transcript expanded it", async () => {
		rightSplit.collapsed = true;
		const side = leaf(rightSplit, true);
		const leaves: FakeLeaf[] = [];
		const app = appForShow(leaves, side);
		await show(app);
		expect(rightSplit.collapsed).toBe(false);
		expect(hideTranscriptPanels(app)).toBe(true);
		expect(rightSplit.collapsed).toBe(true);
	});

	it("leaves the sidebar open when it was already open", async () => {
		const side = leaf(rightSplit, true);
		const leaves: FakeLeaf[] = [];
		const app = appForShow(leaves, side);
		await show(app);
		expect(hideTranscriptPanels(app)).toBe(true);
		expect(rightSplit.collapsed).toBe(false);
	});
});

describe("currentRowIndex", () => {
	const starts = [0, 2.5, 7, 12];

	it("returns the last row starting at or before the time", () => {
		expect(currentRowIndex(starts, 0)).toBe(0);
		expect(currentRowIndex(starts, 2.4)).toBe(0);
		expect(currentRowIndex(starts, 2.5)).toBe(1);
		expect(currentRowIndex(starts, 11.99)).toBe(2);
		expect(currentRowIndex(starts, 500)).toBe(3);
	});

	it("returns -1 before the first row or with no rows", () => {
		expect(currentRowIndex([3, 5], 1)).toBe(-1);
		expect(currentRowIndex([], 10)).toBe(-1);
	});
});

describe("scrollParent", () => {
	// The panel's rows sit inside the view content, whose scroller can be the content element or an ancestor.
	function chain(styles: { overflowY: string; scrolls: boolean }[]) {
		const computed = new Map<object, { overflowY: string }>();
		const win = { getComputedStyle: (el: object) => computed.get(el) ?? { overflowY: "visible" } };
		const doc = { defaultView: win };
		let parent: Record<string, unknown> | null = null;
		const nodes: Record<string, unknown>[] = [];
		for (const style of styles) {
			const node: Record<string, unknown> = {
				parentElement: parent,
				ownerDocument: doc,
				scrollHeight: style.scrolls ? 500 : 100,
				clientHeight: 100,
			};
			computed.set(node, { overflowY: style.overflowY });
			nodes.push(node);
			parent = node;
		}
		const row = { parentElement: parent, ownerDocument: doc } as unknown as HTMLElement;
		return { row, nodes };
	}

	it("finds the nearest ancestor that actually scrolls", () => {
		const { row, nodes } = chain([
			{ overflowY: "auto", scrolls: true },
			{ overflowY: "auto", scrolls: false },
			{ overflowY: "visible", scrolls: true },
		]);
		expect(scrollParent(row)).toBe(nodes[0]);
	});

	it("returns null when nothing scrolls", () => {
		const { row } = chain([{ overflowY: "hidden", scrolls: true }]);
		expect(scrollParent(row)).toBeNull();
	});
});

describe("stepRow", () => {
	const visible = [0, 2, 4, 6, 8];
	it("moves to the next or previous visible row", () => {
		expect(stepRow(visible, 4, 1, visible)).toBe(6);
		expect(stepRow(visible, 4, -1, visible)).toBe(2);
	});
	it("stops at the ends", () => {
		expect(stepRow(visible, 8, 1, visible)).toBe(8);
		expect(stepRow(visible, 0, -1, visible)).toBe(0);
	});
	it("starts from the rows on screen when the focused row was scrolled away (after Page Up/Down)", () => {
		expect(stepRow(visible, 0, 1, [4, 6])).toBe(4);
		expect(stepRow(visible, 0, -1, [4, 6])).toBe(6);
		expect(stepRow(visible, -1, 1, [2, 4])).toBe(2);
	});
	it("handles hidden (filtered) rows and an empty list", () => {
		// The focused row was hidden by the filter: start from the rows on screen.
		expect(stepRow(visible, 3, 1, [2, 4, 6])).toBe(2);
		expect(stepRow([], 3, 1, [])).toBe(-1);
	});
});
