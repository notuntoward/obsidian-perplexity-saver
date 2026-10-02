import { describe, expect, it } from "vitest";
import { askNoteDecision } from "../../src/litNote/decisionModal";
import * as Obsidian from "obsidian";

// `createdModals` only exists on the test mock, not on the type-only
// `obsidian` package, so read it through a cast.
const createdModals = (Obsidian as unknown as { createdModals: any[] })
	.createdModals;

function latestModal(): any {
	return createdModals[createdModals.length - 1];
}

function buttonRow(modal: any): any {
	return modal.contentEl.children.find((c: any) =>
		(c.cls || "").includes("modal-button-container")
	);
}

function findButton(modal: any, label: string): any {
	return buttonRow(modal).children.find((c: any) => c.text === label);
}

async function settleMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("askNoteDecision", () => {
	it("shows the title/message and resolves with the clicked button value", async () => {
		const promise = askNoteDecision({} as any, "Lit note already exists", "Overwrite?", [
			{ label: "Overwrite", value: "overwrite", warning: true },
			{ label: "Skip", value: "skip" },
			{ label: "Cancel", value: "cancel" },
		]);

		await settleMicrotasks();

		const modal = latestModal();
		expect(modal.titleEl.text).toBe("Lit note already exists");
		expect(findButton(modal, "Overwrite").cls).toContain("mod-warning");

		findButton(modal, "Skip").listeners.click[0]();
		await expect(promise).resolves.toBe("skip");
	});

	it("resolves cancel when the modal is dismissed", async () => {
		const promise = askNoteDecision({} as any, "Lit note not found", "Create?", [
			{ label: "Create", value: "create", cta: true },
		]);

		await settleMicrotasks();

		latestModal().onClose();
		await expect(promise).resolves.toBe("cancel");
	});
});
