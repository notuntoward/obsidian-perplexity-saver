// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { DomModal } from "../__mocks__/obsidian";
import type { PendingReview } from "../../src/litNote/pendingReviews";
import type { ReviewGroup } from "../../src/litNote/reviewStatus";
import "commons/testing";
import { ReviewOverviewModal } from "../../src/litNote/reviewOverviewModal";

const state = vi.hoisted(() => ({ modal: undefined as DomModal | undefined }));
vi.mock("obsidian", async (original) => {
	const mock = await original<typeof import("../__mocks__/obsidian")>();
	return {
		...mock,
		Modal: class extends mock.DomModal {
			constructor() { super(document); state.modal = this; }
		},
	};
});

beforeEach(() => {
	document.body.replaceChildren();
	state.modal = undefined;
});

it("keeps the review list open and expanded while the count and items change", () => {
	const first: PendingReview = {
		key: "one", itemkey: "one", libraryURI: "library", title: "First paper",
		reason: "Interrupted", requested: false, uncertain: true, uncertainOperation: "attachment-move",
	};
	const second: PendingReview = { ...first, key: "two", itemkey: "two", title: "Second paper" };
	const group: ReviewGroup = { kind: "uncertain", title: "Check attachment repairs (2)", attachmentMove: true, reviews: [first, second] };
	const onGroup = vi.fn();
	const onItem = vi.fn();
	const modal = new ReviewOverviewModal({} as App, onGroup, onItem, vi.fn());
	modal.update([group], 2);
	modal.open();

	const content = state.modal!.contentEl;
	expect(content.textContent).toContain("Back up your vault and Zotero data before making changes.");
	const details = content.querySelector("details")!;
	details.open = true;
	content.scrollTop = 90;
	Array.from(content.querySelectorAll("button")).find((button) => button.textContent === "Copy and repair all")!.click();
	expect(onGroup).toHaveBeenCalledWith(group);
	Array.from(content.querySelectorAll("button")).find((button) => button.textContent === "First paper")!.click();
	expect(onItem).toHaveBeenCalledWith(group, first);

	modal.update([{ ...group, title: "Check attachment repairs (1)", reviews: [second] }], 1);
	expect(state.modal!.closed).toBe(false);
	expect(state.modal!.titleEl.textContent).toContain("1 remaining");
	expect(content.querySelector("details")!.open).toBe(true);
	expect(content.scrollTop).toBe(90);
	expect(content.textContent).not.toContain("First paper");
	expect(content.textContent).toContain("Second paper");
	expect(content.textContent).not.toContain("Copy and repair all");
	expect(content.textContent?.match(/Back up your vault/g)).toHaveLength(1);
	expect(content.firstElementChild?.textContent).toContain("Back up your vault");
});

it("filters reviews by title or note and hides bulk actions while filtered", () => {
	const first: PendingReview = {
		key: "one", itemkey: "one", libraryURI: "library", title: "First paper",
		notePath: "lit/first.md", reason: "Interrupted", requested: false, uncertain: true, uncertainOperation: "attachment-move",
	};
	const second: PendingReview = { ...first, key: "two", itemkey: "two", title: "Second paper", notePath: "lit/second.md" };
	const group: ReviewGroup = { kind: "uncertain", title: "Check attachment repairs (2)", attachmentMove: true, reviews: [first, second] };
	const modal = new ReviewOverviewModal({} as App, vi.fn(), vi.fn(), vi.fn());
	modal.update([group], 2);
	modal.open();

	const content = state.modal!.contentEl;
	const search = content.querySelector<HTMLInputElement>("input[type=search]")!;
	search.value = "second.md";
	search.dispatchEvent(new Event("input"));
	const rows = content.querySelectorAll<HTMLElement>(".lit-note-review-item");
	expect(rows[0].hidden).toBe(true);
	expect(rows[1].hidden).toBe(false);
	expect(content.querySelector<HTMLDetailsElement>("details")!.open).toBe(true);
	expect(Array.from(content.querySelectorAll("button")).find((button) => button.textContent === "Copy and repair all")!.hidden).toBe(true);
	modal.update([group], 2);
	expect(content.querySelector<HTMLInputElement>("input[type=search]")).toBe(search);
	expect(search.value).toBe("second.md");
	expect(content.querySelector<HTMLElement>(".lit-note-review-item")!.hidden).toBe(true);
});

it("offers a single action to step through interrupted reviews", () => {
	const first: PendingReview = {
		key: "one", itemkey: "one", libraryURI: "library", title: "First paper",
		reason: "Interrupted", requested: false, uncertain: true,
	};
	const group: ReviewGroup = { kind: "uncertain", title: "Check Zotero items (2)", attachmentMove: false, reviews: [first, { ...first, key: "two", itemkey: "two" }] };
	const onGroup = vi.fn();
	const modal = new ReviewOverviewModal({} as App, onGroup, vi.fn(), vi.fn());
	modal.update([group], 2);
	modal.open();
	const button = Array.from(state.modal!.contentEl.querySelectorAll("button")).find((entry) => entry.textContent === "Review one by one");
	expect(button).toBeDefined();
	button!.click();
	expect(onGroup).toHaveBeenCalledWith(group);
});
