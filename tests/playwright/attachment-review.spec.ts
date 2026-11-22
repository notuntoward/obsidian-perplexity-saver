import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

test("attachment review exposes file roles and choices at desktop and narrow widths", async ({ page }) => {
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
			}]
		)).then((decision) => { (window as Window & { decision?: string }).decision = decision; });
	});
	const modal = page.locator(".modal");
	await expect(modal.getByRole("searchbox")).toHaveCount(0);
	await expect(modal.getByText("Current note link:", { exact: false })).toBeVisible();
	await expect(modal.getByText("Zotero attachment:", { exact: false })).toBeVisible();
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
		.toBe('review:["0"]');
});
