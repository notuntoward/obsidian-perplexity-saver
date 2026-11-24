import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

test.beforeEach(async ({ page }) => {
	const result = await build({
		entryPoints: [path.resolve("src/litNote/decisionModal.ts")],
		bundle: true, write: false, format: "iife", globalName: "AttachmentReview",
		external: ["obsidian"],
	});
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			body { font: 16px sans-serif; }
			.modal { width: 800px; max-width: 90vw; margin: 20px auto; padding: 20px; }
			.modal-button-container { display: flex; gap: 8px; }
			:root { --font-semibold: 600; }
		</style>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.addScriptTag({ content: `
		HTMLElement.prototype.createEl = function(tag, opts = {}) {
			const el = this.ownerDocument.createElement(tag);
			if (opts.text) el.textContent = opts.text;
			if (opts.cls) el.className = opts.cls;
			for (const [key, value] of Object.entries(opts.attr || {})) el.setAttribute(key, value);
			this.appendChild(el); return el;
		};
		HTMLElement.prototype.createDiv = function(opts) { return this.createEl("div", opts); };
		HTMLElement.prototype.createSpan = function(opts) { return this.createEl("span", opts); };
		HTMLElement.prototype.setText = function(text) { this.textContent = text; };
		HTMLElement.prototype.empty = function() { this.replaceChildren(); };
		HTMLElement.prototype.addClass = function(name) { this.classList.add(name); };
		window.require = () => ({
			Modal: class {
				constructor(app) {
					this.app = app;
					this.modalEl = document.body.createDiv({cls: "modal"});
					this.containerEl = this.modalEl;
					this.titleEl = this.modalEl.createDiv();
					this.contentEl = this.modalEl.createDiv();
				}
				open() {}
				close() { this.onClose(); this.modalEl.remove(); }
			},
			FileSystemAdapter: class {}, TFile: class {}, Notice: class {}
		});
	` });
	await page.addScriptTag({ content: result.outputFiles[0].text });
});

test("review status fits its text and the status bar", async ({ page }) => {
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			.status-bar { display: flex; align-items: center; height: 28px; font: 12px sans-serif; }
			.status-bar-item { display: flex; align-items: center; padding: 3px 4px; }
			button { display: flex; height: 36px; }
		</style>
		<div class="status-bar"><div class="status-bar-item">
			<button class="lit-note-review-status">Zotero reviews: 51</button>
		</div></div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	const dimensions = await page.locator(".lit-note-review-status").evaluate((button) => {
		const range = document.createRange();
		range.selectNodeContents(button);
		const text = range.getBoundingClientRect();
		const bounds = button.getBoundingClientRect();
		const bar = button.closest(".status-bar")!.getBoundingClientRect();
		return {
			leftPadding: text.left - bounds.left,
			rightPadding: bounds.right - text.right,
			height: bounds.height,
			barHeight: bar.height,
		};
	});
	expect(dimensions.leftPadding).toBeGreaterThanOrEqual(6);
	expect(dimensions.rightPadding).toBeGreaterThanOrEqual(6);
	expect(dimensions.height).toBeLessThanOrEqual(dimensions.barHeight);
});

test("attachment review exposes file roles and choices at desktop and narrow widths", async ({ page }) => {
	await page.evaluate(() => {
		const api = (window as Window & { AttachmentReview?: {
			withNoteDecisionSession: (app: object, run: (session: {
				ask: (...args: unknown[]) => Promise<string>;
			}) => Promise<string>) => Promise<string>;
		}; decision?: string }).AttachmentReview;
		if (!api) throw new Error("Attachment review bundle is unavailable.");
		void api.withNoteDecisionSession({}, (session) => session.ask(
			"Review attachment links", "Choose how to update the note's links.",
			[{ label: "Continue", value: "create" }, { label: "Cancel", value: "cancel" }],
			[{
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
			}, {
				kind: "note",
				label: "Obsidian note link target: missing/paper.pdf",
				copyValue: "missing/paper.pdf",
				description: "The Obsidian note link could not be resolved.",
				options: [
					{ label: "Keep this link in the Obsidian note", value: "keep" },
					{ label: "Remove this link from the Obsidian note", value: "remove" },
				],
				defaultValue: "keep",
			}], {
				title: "Paper title", itemkey: "ITEM1234", libraryURI: "http://zotero.org/users/1",
				notePath: "lit/note.md", noteCitekey: "note-key", zoteroCitekey: "zotero-key",
			}
		)).then((decision) => { (window as Window & { decision?: string }).decision = decision; });
	});
	const modal = page.locator(".modal");
	await expect(modal.getByRole("searchbox")).toHaveCount(0);
	await expect(modal.getByText("Current note link:", { exact: false })).toBeVisible();
	await expect(modal.getByText("Zotero attachment:", { exact: false })).toBeVisible();
	await expect(modal.getByText("Obsidian note link target: missing/paper.pdf")).toBeVisible();
	await expect(modal.getByText("The Obsidian note link could not be resolved.")).toBeVisible();
	await expect(modal.getByRole("link", { name: "Paper title" })).toHaveAttribute("href", "zotero://select/library/items/ITEM1234");
	await expect(modal.getByRole("link", { name: "note.md" })).toBeVisible();
	await expect(modal.getByRole("button", { name: "Copy Zotero item key" })).toBeVisible();
	await expect(modal.getByRole("button", { name: "Copy link target missing/paper.pdf" })).toBeVisible();
	await expect(modal.getByRole("button", { name: "Copy attachment path attachments/new.pdf" })).toHaveCount(0);
	const keep = modal.getByRole("radio", { name: "Keep this note link unchanged" });
	const change = modal.getByRole("radio", { name: "Change this note link to attachments/new.pdf" });
	await expect(keep).toBeChecked();
	await expect(change).toBeVisible();
	for (const width of [1024, 320]) {
		await page.setViewportSize({ width, height: 768 });
		expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	}
	await change.check();
	await modal.getByRole("button", { name: "Continue" }).click();
	await expect.poll(() => page.evaluate(() => (window as Window & { decision?: string }).decision))
		.toBe('review:["0","keep"]');
});

test("attachment errors show the path first and align expandable details", async ({ page }) => {
	await page.evaluate(() => {
		const api = (window as Window & { AttachmentReview?: {
			withNoteDecisionSession: (app: object, run: (session: {
				ask: (...args: unknown[]) => Promise<string>;
			}) => Promise<string>) => Promise<string>;
		} }).AttachmentReview;
		if (!api) throw new Error("Attachment review bundle is unavailable.");
		void api.withNoteDecisionSession({}, (session) => session.ask(
			"Zotero attachment is outside the Obsidian vault", "",
			[{ label: "Close", value: "skip" }], undefined, {
				title: "A long Zotero item title", itemkey: "ITEM1234", libraryURI: "http://zotero.org/users/1",
				notePath: "lit/note.md", noteCitekey: "note-key", zoteroCitekey: "zotero-key", compact: true,
				attachmentProblems: [{
					path: "C:\\outside\\a-very-long-attachment-path-without-spaces\\paper.pdf",
					title: "Zotero attachment is outside the Obsidian vault",
					problem: "Attachment links require a file inside the vault.",
					action: "Link the file inside the vault in Zotero, then retry.",
				}],
			},
		));
	});
	const modal = page.locator(".modal");
	await expect(modal.locator(".lit-note-attachment-problem").locator(":scope > :first-child")).toContainText("Zotero attachment:");
	await expect(modal.locator("details")).not.toHaveAttribute("open");
	await modal.getByText("Item and note details").click();
	await expect(modal.getByRole("button", { name: "Copy Zotero item title" })).toHaveCount(0);
	await expect(modal.getByRole("button", { name: "Copy Obsidian note name" })).toHaveCount(0);
	for (const width of [1024, 320]) {
		await page.setViewportSize({ width, height: 768 });
		expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		const positions = await modal.locator(".lit-note-identity-value").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
		expect(positions.length).toBe(5);
		expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
		await expect(modal.locator(".lit-note-identity-grid strong").first()).toHaveCSS("font-weight", /^(bold|[6-9]00)$/);
	}
	await modal.getByRole("button", { name: "Close" }).click();
});

test("bulk move details are a readable list and the next step is explicit", async ({ page }) => {
	await page.evaluate(() => {
		const api = (window as Window & { AttachmentReview?: {
			askNoteDecision: (app: object, title: string, message: string, buttons: object[]) => Promise<string>;
		} }).AttachmentReview;
		if (!api) throw new Error("Attachment review bundle is unavailable.");
		void api.askNoteDecision({}, "Move Zotero attachments into the vault?",
			"Move 4 attachments for 3 notes.\n\nDestination: C:\\vault\\attachments\n\n- Move 1 duplicate to Trash.\n- Keep extra files.\n\nContinue to the backup confirmation. No files will move yet.",
			[{ label: "Continue to backup", value: "create", cta: true }, { label: "Cancel", value: "cancel" }]);
	});
	const modal = page.locator(".modal");
	await expect(modal.locator(".lit-note-decision-message ul li")).toHaveCount(2);
	await expect(modal.getByText("No files will move yet.", { exact: false })).toBeVisible();
	await expect(modal.getByRole("button", { name: "Continue to backup" })).toBeVisible();
	for (const width of [1024, 320]) {
		await page.setViewportSize({ width, height: 768 });
		expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	}
	await modal.getByRole("button", { name: "Cancel" }).click();
});
