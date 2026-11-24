// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import * as windows from "commons/windows";
import { FileSystemAdapter, TFile } from "obsidian";
import type { App } from "obsidian";
import * as Obsidian from "obsidian";
import "commons/testing";
import { askNoteDecision, withNoteDecisionSession } from "../../src/litNote/decisionModal";
import { askAuthorFormatDecision } from "../../src/litNote/authorFormatModal";
import type { DomModal } from "../__mocks__/obsidian";

const state = vi.hoisted(() => ({ modals: [] as DomModal[], doc: undefined as Document | undefined }));
const createdNotices = (Obsidian as unknown as { createdNotices: Array<{ message: string }> }).createdNotices;
vi.mock("obsidian", async (original) => {
	const mock = await original<typeof import("../__mocks__/obsidian")>();
	return {
		...mock,
		Modal: class extends mock.DomModal {
			constructor() { super(state.doc ?? document); state.modals.push(this); }
		},
	};
});

beforeEach(() => {
	state.modals = [];
	state.doc = undefined;
	createdNotices.length = 0;
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
	it("shows and copies each recovery path from the modal's window", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const popoutWindow = { name: "pop-out" };
		Object.defineProperty(state.doc, "defaultView", { value: popoutWindow });
		const copy = vi.spyOn(windows, "writeClipboardIn").mockResolvedValue(true);
		const promise = askNoteDecision({} as App, "Check attachments", "", [{ label: "Close", value: "cancel" }], {
			title: "Paper", itemkey: "ABC", libraryURI: "library",
			recoveryPaths: [
				{ label: "Original", path: "C:\\storage\\paper.pdf", status: "File exists." },
				{ label: "Planned location", path: "C:\\vault\\paper.pdf", status: "File is missing." },
			],
		});
		await settleMicrotasks();
		expect(latestModal().contentEl.textContent).toContain("File is missing.");
		const button = Array.from(latestModal().contentEl.querySelectorAll("button"))
			.find((entry) => entry.getAttribute("aria-label") === "Copy Original C:\\storage\\paper.pdf")!;
		button.click();
		await settleMicrotasks();
		expect(copy).toHaveBeenCalledWith(popoutWindow, "C:\\storage\\paper.pdf");
		findButton("Close").click();
		await expect(promise).resolves.toBe("cancel");
		copy.mockRestore();
	});

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

	it("keeps a single modal open for multiple decisions in one batch", async () => {
		const promise = withNoteDecisionSession({} as App, async (session) => {
			const first = await session.ask("First", "Choose.", [{ label: "Next", value: "create" }]);
			const second = await session.ask("Second", "Choose again.", [{ label: "Done", value: "skip" }]);
			return [first, second];
		});
		await settleMicrotasks();
		findButton("Next").click();
		await settleMicrotasks();
		expect(state.modals).toHaveLength(1);
		expect(latestModal().titleEl.textContent).toBe("Second");
		findButton("Done").click();
		await expect(promise).resolves.toEqual(["create", "skip"]);
	});

	it("filters a long attachment review and applies bulk choices in the modal's own document", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const promise = withNoteDecisionSession({} as App, (session) =>
			session.ask("Review", "Attachments", [{ label: "Continue", value: "create" }], [
				...Array.from({ length: 100 }, (_, index) => ({
					kind: "note" as const, label: `Note link ${index}`,
					options: [{ label: "Keep", value: "keep" }, { label: "Remove", value: "remove" }],
					defaultValue: "keep",
					...(index === 99 ? { description: "Unresolved link", files: [{ path: "attachments/paper.pdf" }] } : {}),
				})),
				{ kind: "add", label: "Zotero attachment", options: [{ label: "Add", value: "add" }, { label: "Skip", value: "skip" }], defaultValue: "skip" },
			]));
		await settleMicrotasks();
		const modal = latestModal();
		expect(modal.contentEl.ownerDocument).toBe(state.doc);
		const search = modal.contentEl.querySelector<HTMLInputElement>("input[type=search]")!;
		search.value = "paper.pdf";
		search.dispatchEvent(new Event("input"));
		const rows = Array.from(modal.contentEl.querySelectorAll<HTMLElement>(".lit-note-attachment-review-row"));
		expect(rows.filter((row) => !row.hidden)).toHaveLength(1);
		expect(modal.contentEl.querySelector(".lit-note-attachment-review-search-status")?.textContent)
			.toContain("Showing 1 of 101 items. Choices in hidden items still apply.");
		search.value = "unresolved";
		search.dispatchEvent(new Event("input"));
		expect(rows.filter((row) => !row.hidden)).toHaveLength(1);
		findButton("Remove all Obsidian-only links").click();
		findButton("Add all Zotero item links").click();
		findButton("Continue").click();
		await expect(promise).resolves.toBe(`review:${JSON.stringify([...Array(100).fill("remove"), "add"])}`);
	});

	it("opens a review candidate with the system default application from the modal's window", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const openPath = vi.fn().mockResolvedValue("");
		const require = vi.fn().mockReturnValue({ shell: { openPath } });
		Object.defineProperty(state.doc, "defaultView", { value: { require } });
		const file = Object.assign(new TFile(), { path: "attachments/paper.pdf" });
		const adapter = Object.assign(new FileSystemAdapter(), { getFullPath: () => "C:\\vault\\attachments\\paper.pdf" });
		const app = { vault: { adapter, getAbstractFileByPath: () => file } } as unknown as App;
		const promise = withNoteDecisionSession(app, (session) =>
			session.ask("Review", "Attachments", [{ label: "Cancel", value: "cancel" }], [{
				kind: "note", label: "Note attachment", options: [{ label: "Keep", value: "keep" }],
				defaultValue: "keep", files: [{ path: file.path, modified: Date.UTC(2025, 0, 1) }],
			}]));
		await settleMicrotasks();
		const link = latestModal().contentEl.querySelector<HTMLAnchorElement>(".lit-note-attachment-review-files a")!;
		expect(link.textContent).toBe(file.path);
		expect(link.parentElement?.textContent).toContain("Modified");
		expect(latestModal().contentEl.querySelector("input[type=search]")).toBeNull();
		link.click();
		await settleMicrotasks();
		expect(require).toHaveBeenCalledWith("electron");
		expect(openPath).toHaveBeenCalledWith("C:\\vault\\attachments\\paper.pdf");
		findButton("Cancel").click();
		await expect(promise).resolves.toBe("cancel");
	});

	it("shows the unresolved-link explanation in the modal's document", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const promise = withNoteDecisionSession({} as App, (session) =>
			session.ask("Review attachment links", "Choose links.", [{ label: "Cancel", value: "cancel" }], [{
				kind: "note",
				label: "Obsidian note link target: missing/paper.pdf",
				description: "The Obsidian note link could not be resolved.",
				options: [{ label: "Keep", value: "keep" }],
				defaultValue: "keep",
			}]));
		await settleMicrotasks();
		const modal = latestModal();
		expect(modal.contentEl.ownerDocument).toBe(state.doc);
		expect(modal.contentEl.textContent).toContain("Obsidian note link target: missing/paper.pdf");
		expect(modal.contentEl.textContent).toContain("The Obsidian note link could not be resolved.");
		findButton("Cancel").click();
		await expect(promise).resolves.toBe("cancel");
	});

	it("shows labeled files and visible choices for changing a note link", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const promise = withNoteDecisionSession({} as App, (session) =>
			session.ask("Review", "Attachments", [{ label: "Continue", value: "create" }], [{
				kind: "body", label: "Another note link to old.pdf",
				options: [
					{ label: "Keep this note link unchanged", value: "keep" },
					{ label: "Change this note link to attachments/new.pdf", value: "0" },
				],
				defaultValue: "keep",
				files: [
					{ path: "attachments/old.pdf", role: "Current note link" },
					{ path: "attachments/new.pdf", role: "Zotero attachment" },
				],
			}]));
		await settleMicrotasks();
		const modal = latestModal();
		expect(modal.contentEl.ownerDocument).toBe(state.doc);
		const text = modal.contentEl.textContent ?? "";
		expect(text).toContain("Current note link: attachments/old.pdf");
		expect(text).toContain("Zotero attachment: attachments/new.pdf");
		expect(text).toContain("Keep this note link unchanged");
		expect(text).toContain("Change this note link to attachments/new.pdf");
		const radios = modal.contentEl.querySelectorAll<HTMLInputElement>("input[type=radio]");
		expect(radios).toHaveLength(2);
		expect(radios[0].checked).toBe(true);
		radios[1].click();
		findButton("Continue").click();
		await expect(promise).resolves.toBe('review:["0"]');
	});

	it("reports when a review candidate cannot be opened", async () => {
		const notices = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = { vault: { adapter: new FileSystemAdapter(), getAbstractFileByPath: () => null } } as unknown as App;
		const promise = withNoteDecisionSession(app, (session) =>
			session.ask("Review", "Attachments", [{ label: "Cancel", value: "cancel" }], [{
				kind: "note", label: "Note attachment", options: [{ label: "Keep", value: "keep" }],
				defaultValue: "keep", files: [{ path: "missing.pdf" }],
			}]));
		await settleMicrotasks();
		latestModal().contentEl.querySelector<HTMLAnchorElement>(".lit-note-attachment-review-files a")!.click();
		await settleMicrotasks();
		expect(notices).toHaveBeenCalledWith("Could not open attachment", expect.objectContaining({ message: "The file is no longer available in the vault." }));
		expect(createdNotices.at(-1)?.message).toContain("The file is no longer available in the vault.");
		findButton("Cancel").click();
		await expect(promise).resolves.toBe("cancel");
		notices.mockRestore();
	});

	it("reports a system opener error without closing the review", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const openPath = vi.fn().mockResolvedValue("No application is associated with this file");
		Object.defineProperty(state.doc, "defaultView", { value: { electron: { shell: { openPath } } } });
		const file = Object.assign(new TFile(), { path: "attachments/paper.pdf" });
		const adapter = Object.assign(new FileSystemAdapter(), { getFullPath: () => "C:\\vault\\attachments\\paper.pdf" });
		const app = { vault: { adapter, getAbstractFileByPath: () => file } } as unknown as App;
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const promise = withNoteDecisionSession(app, (session) =>
			session.ask("Review", "Attachments", [{ label: "Cancel", value: "cancel" }], [{
				kind: "note", label: "Note attachment", options: [{ label: "Keep", value: "keep" }],
				defaultValue: "keep", files: [{ path: file.path }],
			}]));
		await settleMicrotasks();
		latestModal().contentEl.querySelector<HTMLAnchorElement>(".lit-note-attachment-review-files a")!.click();
		await settleMicrotasks();
		expect(createdNotices.at(-1)?.message).toContain("No application is associated with this file");
		findButton("Cancel").click();
		await expect(promise).resolves.toBe("cancel");
		errors.mockRestore();
	});

	it("links to the correct Zotero library and copies each key from the modal's window", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const openExternal = vi.fn().mockResolvedValue(undefined);
		const popoutWindow = { name: "pop-out", electron: { shell: { openExternal } } };
		Object.defineProperty(state.doc, "defaultView", { value: popoutWindow });
		const copy = vi.spyOn(windows, "writeClipboardIn").mockResolvedValue(true);
		const openLinkText = vi.fn().mockResolvedValue(undefined);
		const app = { workspace: { openLinkText } } as unknown as App;
		const promise = withNoteDecisionSession(app, (session) => session.ask("Citekeys differ", "Search Zotero for the item key.", [
			{ label: "Cancel", value: "cancel" },
		], undefined, {
			title: "Paper title", itemkey: "ITEM1234", libraryURI: "http://zotero.org/groups/42",
			notePath: "lit/note.md", noteCitekey: "note-key", zoteroCitekey: "zotero-key",
		}));
		await settleMicrotasks();
		const modal = latestModal();
		const zotero = modal.contentEl.querySelector<HTMLAnchorElement>("a.external-link")!;
		expect(zotero.getAttribute("href")).toBe("zotero://select/groups/42/items/ITEM1234");
		zotero.click();
		await settleMicrotasks();
		expect(openExternal).toHaveBeenCalledWith("zotero://select/groups/42/items/ITEM1234");
		expect(Array.from(modal.contentEl.querySelectorAll("a")).find((el) => el.textContent === "note.md")).toBeDefined();
		expect(modal.contentEl.querySelector('button[aria-label="Copy Zotero item title"]')).toBeNull();
		expect(modal.contentEl.querySelector('button[aria-label="Copy Obsidian note name"]')).toBeNull();
		const labels = Array.from(modal.contentEl.querySelectorAll(".lit-note-identity-grid strong")).map((el) => el.textContent);
		expect(labels).toEqual(["Zotero item:", "Obsidian note:", "Obsidian citekey:", "Zotero citekey:", "Zotero item key:"]);
		for (const [label, value] of [["Obsidian citekey", "note-key"], ["Zotero citekey", "zotero-key"], ["Zotero item key", "ITEM1234"]]) {
			modal.contentEl.querySelector<HTMLButtonElement>(`button[aria-label="Copy ${label}"]`)!.click();
			expect(copy).toHaveBeenCalledWith(popoutWindow, value);
		}
		findButton("Cancel").click();
		await expect(promise).resolves.toBe("cancel");
		copy.mockRestore();
	});

	it("opens a personal Zotero item using the note callout URI", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const openExternal = vi.fn().mockRejectedValue(new Error("Zotero is unavailable"));
		Object.defineProperty(state.doc, "defaultView", { value: { electron: { shell: { openExternal } } } });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const promise = withNoteDecisionSession({} as App, (session) => session.ask("Review", "", [
			{ label: "Cancel", value: "cancel" },
		], undefined, { title: "Paper", itemkey: "ITEM1234", libraryURI: "http://zotero.org/users/1", zoteroCitekey: "key" }));
		await settleMicrotasks();
		latestModal().contentEl.querySelector<HTMLAnchorElement>("a.external-link")!.click();
		await settleMicrotasks();
		expect(openExternal).toHaveBeenCalledWith("zotero://select/library/items/ITEM1234");
		expect(createdNotices.at(-1)?.message).toContain("Zotero is unavailable");
		findButton("Cancel").click();
		await expect(promise).resolves.toBe("cancel");
		errors.mockRestore();
	});

	it.each([
		{ title: "Update literature note", buttons: [{ label: "Cancel", value: "cancel" as const }], compact: false, decision: "cancel" },
		{ title: "Attachment error", buttons: [{ label: "Close", value: "skip" as const }], compact: true, decision: "skip" },
	])("closes $title before opening the note for editing in a pop-out", async ({ title, buttons, compact, decision }) => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		let closedWhenOpened = false;
		const openLinkText = vi.fn().mockImplementation(async () => { closedWhenOpened = latestModal().closed; });
		const app = { workspace: { openLinkText } } as unknown as App;
		const promise = withNoteDecisionSession(app, (session) => session.ask(title, "Review", buttons, undefined, {
			title: "Paper", itemkey: "ABC", libraryURI: "library", zoteroCitekey: "key", notePath: "lit/note.md", compact,
		}));
		await settleMicrotasks();
		const modal = latestModal();
		try {
			const description = modal.contentEl.textContent;
			modal.contentEl.querySelector<HTMLAnchorElement>('a[href="#"]')!.click();
			expect(closedWhenOpened).toBe(true);
			expect(openLinkText).toHaveBeenCalledWith("lit/note.md", "", false);
			expect(description).toContain("Opening the note closes this dialog and cancels the current review.");
			await expect(promise).resolves.toBe(decision);
			expect(createdNotices.at(-1)?.message).toContain("retry the update from Zotero");
		} finally {
			if (!modal.closed) modal.close();
			await promise;
		}
	});

	it("directs a checked-note review back to the review list instead of retrying the update", async () => {
		const openLinkText = vi.fn().mockResolvedValue(undefined);
		const app = { workspace: { openLinkText } } as unknown as App;
		const promise = askNoteDecision(app, "Check the note", "Check both apps.", [
			{ label: "Cancel", value: "cancel" },
		], {
			title: "Paper", itemkey: "ABC", libraryURI: "library", notePath: "lit/note.md",
			noteOpenFollowUp: "Return to Zotero reviews after checking the note.",
		});
		await settleMicrotasks();
		latestModal().contentEl.querySelector<HTMLAnchorElement>('a[href="#"]')!.click();
		await expect(promise).resolves.toBe("cancel");
		await settleMicrotasks();
		expect(openLinkText).toHaveBeenCalledWith("lit/note.md", "", false);
		expect(createdNotices.at(-1)?.message).toBe("Return to Zotero reviews after checking the note.");
	});

	it("shows the affected path first in a pop-out error dialog", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const promise = withNoteDecisionSession({} as App, (session) => session.ask(
			"Zotero attachment outside the vault", "",
			[{ label: "Close", value: "skip" }], undefined, {
				title: "Paper", itemkey: "ABC", libraryURI: "library", zoteroCitekey: "key",
				compact: true,
				attachmentProblems: [{ path: "C:\\outside\\paper.pdf", title: "Zotero attachment outside the vault", problem: "Outside the vault.", action: "Link a file inside the vault." }],
			},
		));
		await settleMicrotasks();
		const modal = latestModal();
		const issue = modal.contentEl.querySelector(".lit-note-attachment-problem")!;
		expect(modal.contentEl.firstElementChild?.className).toBe("lit-note-attachment-problems");
		expect(issue.firstElementChild?.textContent).toContain("Zotero attachment:");
		expect(issue.textContent).toContain("Outside the vault.");
		expect(issue.textContent).toContain("Link a file inside the vault.");
		expect(modal.contentEl.textContent?.split("C:\\outside\\paper.pdf")).toHaveLength(2);
		expect(modal.contentEl.textContent).not.toContain("Existing note links were preserved.");
		expect(modal.contentEl.querySelector("details")?.open).toBe(false);
		findButton("Close").click();
		await expect(promise).resolves.toBe("skip");
	});

	it("copies unresolved link targets but not clickable attachment paths", async () => {
		state.doc = document.implementation.createHTMLDocument("pop-out");
		const popoutWindow = { name: "pop-out" };
		Object.defineProperty(state.doc, "defaultView", { value: popoutWindow });
		const copy = vi.spyOn(windows, "writeClipboardIn").mockResolvedValue(true);
		const promise = withNoteDecisionSession({} as App, (session) => session.ask("Review", "Attachments", [
			{ label: "Cancel", value: "cancel" },
		], [{
			kind: "note", label: "Unresolved link", copyValue: "old.pdf",
			options: [{ label: "Keep", value: "keep" }], defaultValue: "keep",
			files: [{ path: "attachments/paper.pdf" }],
		}]));
		await settleMicrotasks();
		latestModal().contentEl.querySelector<HTMLButtonElement>('button[aria-label="Copy link target old.pdf"]')!.click();
		expect(copy).toHaveBeenCalledWith(popoutWindow, "old.pdf");
		expect(latestModal().contentEl.querySelector('button[aria-label="Copy attachment path attachments/paper.pdf"]')).toBeNull();
		findButton("Cancel").click();
		await expect(promise).resolves.toBe("cancel");
		copy.mockRestore();
	});

	it("does not use bare window, document, or navigator for modal actions", () => {
		const source = readFileSync("src/litNote/decisionModal.ts", "utf8")
			.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
		expect(source).not.toMatch(/(?<![\w.$])(?:document|window|navigator)\s*\./);
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
