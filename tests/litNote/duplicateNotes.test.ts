// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import { createdNotices } from "../__mocks__/obsidian";
import { compareDuplicateReview, DUPLICATE_NOTES_REASON, watchDuplicateReviews } from "../../src/litNote/duplicateNotes";
import { allReviews, clearReviews, queueReview, reviewKey, setReviewListener } from "../../src/litNote/pendingReviews";
import { chooseMergeOptions, reviewMergedProperties } from "../../src/litNote/mergeNotesModal";
import type { MergePlan } from "../../src/litNote/noteMerge";

vi.mock("../../src/litNote/mergeNotesModal", () => ({
	chooseMergeOptions: vi.fn(async (_app: unknown, plan: MergePlan) => ({
		blocks: new Map(plan.sources.map((source) => [source.file.path, new Set(source.blocks.map((_, index) => index))])),
		trashZoteroItems: new Set<string>(),
		properties: {},
	})),
	reviewMergedProperties: vi.fn(async () => ({})),
}));

const settings = { litNotesFolder: "lit" };

function note(path: string, itemkey: string): { file: TFile; frontmatter: Record<string, unknown> } {
	return { file: Object.assign(new TFile(), { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), parent: { path: "lit" } }), frontmatter: { category: "literaturenote", zotero_item_key: itemkey, zotero_library_uri: "library" } };
}

function setup(notes: Array<ReturnType<typeof note>>) {
	const handlers = new Map<string, () => void>();
	const leaves: Array<{ file?: TFile; openFile: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }> = [];
	const makeLeaf = () => {
		const leaf = { file: undefined as TFile | undefined, openFile: vi.fn(async (file: TFile) => { leaf.file = file; }), detach: vi.fn() };
		leaves.push(leaf);
		return leaf;
	};
	const workspace = {
		getLeaf: vi.fn(() => makeLeaf()),
		createLeafBySplit: vi.fn(() => makeLeaf()),
		getLeavesOfType: vi.fn(() => leaves.filter((leaf) => !leaf.detach.mock.calls.length)),
		setActiveLeaf: vi.fn(),
	};
	const on = (event: string, callback: () => void) => { handlers.set(event, callback); return { event }; };
	const processFrontMatter = vi.fn(async (file: TFile, update: (fm: Record<string, unknown>) => void) => {
		update(notes.find((entry) => entry.file === file)!.frontmatter);
	});
	const text = new Map<TFile, string>(notes.map((entry) => [entry.file, ""]));
	const live = () => notes.filter((entry) => text.has(entry.file));
	const read = vi.fn(async (file: TFile) => text.get(file) ?? "");
	const app = {
		workspace,
		fileManager: {
			processFrontMatter,
			trashFile: vi.fn(async (file: TFile) => {
				text.delete(file);
				handlers.get("delete")?.();
			}),
		},
		vault: {
			getFolderByPath: () => ({ children: live().map((entry) => entry.file) }),
			getMarkdownFiles: () => live().map((entry) => entry.file),
			getAbstractFileByPath: (path: string) => live().find((entry) => entry.file.path === path)?.file ?? null,
			read,
			cachedRead: read,
			process: vi.fn(async (file: TFile, update: (value: string) => string) => {
				text.set(file, update(text.get(file) ?? ""));
			}),
			on: vi.fn(on),
			offref: vi.fn(),
		},
		metadataCache: {
			getFileCache: (file: TFile) => ({ frontmatter: notes.find((entry) => entry.file === file)?.frontmatter }),
			getFirstLinkpathDest: () => null,
			resolvedLinks: {},
			on: vi.fn(on),
			offref: vi.fn(),
		},
	};
	return { app: app as unknown as App, raw: app, workspace, leaves, text, fire: (event: string) => handlers.get(event)?.() };
}

function queueDuplicate(itemkey: string, title: string): void {
	queueReview({ title, citekey: itemkey.toLowerCase(), itemkey, libraryURI: "library" } as never, DUPLICATE_NOTES_REASON);
}

function review(itemkey: string) {
	return allReviews().find((entry) => entry.key === reviewKey({ itemkey, libraryURI: "library" }))!;
}

describe("duplicate-note comparison", () => {
	beforeEach(() => {
		setReviewListener();
		clearReviews();
		createdNotices.length = 0;
		vi.mocked(chooseMergeOptions).mockClear();
	});

	it("opens every matching note side by side without asking Zotero to recheck", async () => {
		const first = note("lit/first.md", "ABC");
		const second = note("lit/second.md", "ABC");
		const { app, workspace, leaves } = setup([first, second, note("lit/other.md", "XYZ")]);
		queueDuplicate("ABC", "Paper");

		await compareDuplicateReview(app, settings, review("ABC"));

		expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
		expect(workspace.createLeafBySplit).toHaveBeenCalledWith(leaves[0], "vertical");
		expect(leaves.map((leaf) => leaf.file)).toEqual([first.file, second.file]);
		expect(workspace.setActiveLeaf).toHaveBeenCalledWith(leaves[0], { focus: true });
		expect(review("ABC").requested).toBeFalsy();
		const choice = createdNotices.at(-1)!;
		expect(choice.message).toContain("Choose the note to keep");
		const rows = Array.from(choice.messageEl.querySelectorAll(".perplexity-saver-keeper-row"));
		expect(rows.map((row) => row.querySelector(".perplexity-saver-keeper-name")?.textContent)).toEqual(["first", "second"]);
		expect(rows.map((row) => row.querySelector("button")?.textContent)).toEqual(["Keep", "Keep"]);
		expect(rows[0].classList.contains("is-suggested")).toBe(true);
		expect(rows[0].querySelector(".perplexity-saver-keeper-badge")?.textContent).toBe("Suggested");
		expect(rows[1].querySelector(".perplexity-saver-keeper-badge")).toBeNull();
	});

	it("merges the other notes into the chosen note, then pauses for tidying before the next set", async () => {
		const first = note("lit/first.md", "ABC");
		const second = note("lit/second.md", "ABC");
		const nextA = note("lit/next-a.md", "NXT");
		const nextB = note("lit/next-b.md", "NXT");
		const { app, raw, text, leaves } = setup([first, second, nextA, nextB]);
		text.set(first.file, "Kept text.\n");
		text.set(second.file, "Important duplicate text.\n");
		queueDuplicate("ABC", "Paper");
		queueDuplicate("NXT", "Next paper");
		watchDuplicateReviews(app, settings);
		await compareDuplicateReview(app, settings, review("ABC"));

		// Clicking the note's name, not only its Keep button, chooses it.
		const name = Array.from(createdNotices.at(-1)!.messageEl.querySelectorAll<HTMLElement>(".perplexity-saver-keeper-name")).find((el) => el.textContent === "first")!;
		const dismissed = vi.fn();
		createdNotices.at(-1)!.messageEl.addEventListener("click", dismissed);
		name.click();
		await vi.waitFor(() => expect(review("ABC").requested).toBe(true));
		expect(dismissed).not.toHaveBeenCalled();

		expect(chooseMergeOptions).toHaveBeenCalledOnce();
		expect(raw.fileManager.trashFile).toHaveBeenCalledWith(second.file);
		expect(text.get(first.file)).toContain("Important duplicate text.");
		expect(leaves[0].openFile).toHaveBeenLastCalledWith(first.file, expect.objectContaining({ eState: { line: 2 } }));
		expect(leaves[1].detach).toHaveBeenCalled();
		const progress = createdNotices.at(-1)!;
		expect(progress.message).toMatch(/^Merged 1 note into first: copied 1 block of text\.\n\nTidy first now\. 1 duplicate set remains\. When you are finished, click this message/);
		expect(createdNotices.some((notice) => notice.message.startsWith("Duplicate fixed"))).toBe(false);
	});

	it("merges nothing when the property review is cancelled", async () => {
		const first = note("lit/first.md", "ABC");
		const second = note("lit/second.md", "ABC");
		second.frontmatter.status = "read";
		const { app, raw, text } = setup([first, second]);
		text.set(first.file, "Kept text.\n");
		text.set(second.file, "Important duplicate text.\n");
		queueDuplicate("ABC", "Paper");
		vi.mocked(reviewMergedProperties).mockClear().mockResolvedValueOnce(null);
		await compareDuplicateReview(app, settings, review("ABC"));

		Array.from(createdNotices.at(-1)!.messageEl.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Keep first")!.click();
		await vi.waitFor(() => expect(reviewMergedProperties).toHaveBeenCalledOnce());
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(raw.fileManager.trashFile).not.toHaveBeenCalled();
		expect(text.get(first.file)).toBe("Kept text.\n");
	});

	it("rechecks automatically once only one note matches and offers the next duplicate set", async () => {
		const first = note("lit/first.md", "ABC");
		const second = note("lit/second.md", "ABC");
		const nextA = note("lit/next-a.md", "NXT");
		const nextB = note("lit/next-b.md", "NXT");
		const { app, raw, workspace, leaves, fire } = setup([first, second, nextA, nextB]);
		queueDuplicate("ABC", "Paper");
		queueDuplicate("NXT", "Next paper");
		const stop = watchDuplicateReviews(app, settings);

		fire("changed");
		expect(review("ABC").requested).toBeFalsy();

		delete second.frontmatter.zotero_item_key;
		fire("changed");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(review("ABC").requested).toBe(true);
		expect(review("NXT").requested).toBeFalsy();
		const progress = createdNotices.at(-1)!;
		expect(progress.message).toContain("1 duplicate set remains. Click this message to compare the next one.");
		expect(progress.timeout).toBe(0);

		progress.messageEl.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(leaves.map((leaf) => leaf.file)).toEqual([nextA.file, nextB.file]);
		expect(workspace.getLeaf).toHaveBeenCalledWith("tab");

		stop();
		expect(raw.metadataCache.offref).toHaveBeenCalledWith({ event: "changed" });
		expect(raw.vault.offref).toHaveBeenCalledWith({ event: "delete" });
		expect(raw.vault.offref).toHaveBeenCalledWith({ event: "rename" });
	});

	it("completes the remaining note's missing library identity so the fix does not become a new review", async () => {
		const kept = note("lit/kept.md", "ABC");
		delete kept.frontmatter.zotero_library_uri;
		const removed = note("lit/removed.md", "ABC");
		const { app, fire } = setup([kept, removed]);
		queueDuplicate("ABC", "Paper");
		watchDuplicateReviews(app, settings);

		delete removed.frontmatter.zotero_item_key;
		fire("changed");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(kept.frontmatter.zotero_library_uri).toBe("library");
		expect(review("ABC").requested).toBe(true);
		expect(createdNotices.at(-1)?.message).toContain("Added its Zotero library identity to kept");
	});
});
