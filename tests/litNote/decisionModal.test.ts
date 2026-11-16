// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import "commons/testing";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import { askAuthorFormatDecision } from "../../src/litNote/authorFormatModal";
import type { DomModal } from "../__mocks__/obsidian";

const state = vi.hoisted(() => ({ modals: [] as DomModal[] }));
vi.mock("obsidian", async (original) => {
	const mock = await original<typeof import("../__mocks__/obsidian")>();
	return {
		...mock,
		Modal: class extends mock.DomModal {
			constructor() { super(document); state.modals.push(this); }
		},
	};
});

beforeEach(() => {
	state.modals = [];
	document.body.replaceChildren();
});

function latestModal(): DomModal {
	return state.modals[state.modals.length - 1];
}

function findButton(label: string): HTMLButtonElement {
	const button = Array.from(latestModal().contentEl.querySelectorAll("button")).find(el => el.textContent === label);
	if (!button) throw new Error(`Missing modal action: ${label}`);
	return button;
}

async function settleMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("askNoteDecision", () => {
	it("preserves multiline messages and warning actions inside the shared frame", async () => {
		const promise = askNoteDecision({} as App, "Lit note already exists", "Overwrite?\nExisting note.md\n\nChoose an action.", [
			{ label: "Overwrite", value: "overwrite", warning: true },
			{ label: "Skip", value: "skip" },
			{ label: "Cancel", value: "cancel" },
		]);
		await settleMicrotasks();
		const modal = latestModal();
		expect(modal.titleEl.textContent).toBe("Lit note already exists");
		expect(modal.modalEl.classList.contains("commons-modal")).toBe(true);
		expect(modal.contentEl.querySelector(".commons-modal-intro br")).not.toBeNull();
		expect(modal.contentEl.querySelectorAll(".commons-modal-intro p")).toHaveLength(2);
		expect(findButton("Overwrite").classList.contains("mod-warning")).toBe(true);
		findButton("Skip").click();
		await expect(promise).resolves.toBe("skip");
	});

	it("resolves cancel when dismissed and serializes overlapping requests", async () => {
		const buttons = [{ label: "Create", value: "create", cta: true }] as const;
		const first = askNoteDecision({} as App, "First", "Create?", [...buttons]);
		const second = askNoteDecision({} as App, "Second", "Create?", [...buttons]);
		await settleMicrotasks();
		expect(state.modals).toHaveLength(1);
		latestModal().close();
		await expect(first).resolves.toBe("cancel");
		await settleMicrotasks();
		expect(state.modals).toHaveLength(2);
		expect(findButton("Create").classList.contains("mod-cta")).toBe(true);
		findButton("Create").click();
		await expect(second).resolves.toBe("create");
	});
});

describe("author format prompt", () => {
	it.each([true, false])("preserves conditional correction actions (suggestion: %s)", async (hasSuggestion) => {
		const promise = askAuthorFormatDecision({} as App, [{
			citekey: "smith2020", creatorType: "author", rawName: "Jane Smith",
			detail: "Use last, first.", creatorIndex: 0,
			suggestion: hasSuggestion ? "Smith, Jane" : undefined,
		}]);
		await settleMicrotasks();
		const modal = latestModal();
		expect(modal.contentEl.textContent).toContain("Jane Smith");
		expect(modal.contentEl.querySelector(".author-format-issue-list")).not.toBeNull();
		const correction = Array.from(modal.contentEl.querySelectorAll("button")).find(el => el.textContent === "Auto-correct & create");
		expect(Boolean(correction)).toBe(hasSuggestion);
		if (hasSuggestion) {
			expect(modal.contentEl.textContent).toContain("Smith, Jane");
			correction!.click();
			await expect(promise).resolves.toBe("auto-correct");
		} else {
			findButton("Cancel").click();
			await expect(promise).resolves.toBe("cancel");
		}
	});
});
