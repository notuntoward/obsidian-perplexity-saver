import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let script: string;
test.beforeAll(async () => {
	const result = await build({
		entryPoints: [path.resolve("src/video/goToTime.ts")],
		bundle: true, write: false, format: "iife", globalName: "SaverTime",
		external: ["obsidian", "crypto"],
	});
	script = result.outputFiles[0].text;
});

for (const theme of ["light", "dark"]) {
	test(`shared time dialog fits desktop and narrow screens in ${theme}`, async ({ page }) => {
		await page.setContent(`
			<style>
				:root {
					--text-normal: ${theme === "light" ? "#262626" : "#dedede"};
					--text-muted: ${theme === "light" ? "#666" : "#aaa"};
					--text-accent: ${theme === "light" ? "#5746c9" : "#b4a7ff"};
					--interactive-accent: #7460df;
					--text-error: ${theme === "light" ? "#b22222" : "#ff8585"};
					--background-primary: ${theme === "light" ? "#fff" : "#242424"};
					--background-secondary: ${theme === "light" ? "#f5f5f5" : "#303030"};
					--background-modifier-border: ${theme === "light" ? "#ddd" : "#555"};
					--size-4-2: 8px; --size-4-3: 12px; --size-4-4: 16px;
					--radius-s: 4px; --radius-m: 8px; --input-height: 32px;
					--font-ui-medium: 16px; --font-ui-small: 14px; --font-ui-smaller: 12px;
					--font-normal: 400;
					--font-medium: 500; --font-monospace: monospace;
				}
				* { box-sizing: border-box; }
				body { margin: 0; font-family: sans-serif; color: var(--text-normal); background: var(--background-secondary); }
				.modal { width: 800px; max-width: 90vw; margin: 32px auto; padding: 24px; border-radius: 16px; background: var(--background-primary); }
				.modal-title { margin-bottom: 16px; font-size: 24px; }
				input, button { color: inherit; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 6px 12px; min-height: 32px; }
				input:focus-visible, button:focus-visible { outline: 2px solid var(--interactive-accent); outline-offset: 2px; }
				.mod-cta { color: white; background: var(--interactive-accent); }
				.modal-button-container { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
			</style>
			<div class="modal" id="native"><div class="modal-title">Untouched native dialog</div></div>
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
			window.require = () => ({
				Modal: class {
					constructor(app) {
						this.app = app;
						this.modalEl = document.body.createDiv({cls: "modal"});
						this.containerEl = this.modalEl;
						this.titleEl = this.modalEl.createDiv({cls: "modal-title"});
						this.contentEl = this.modalEl.createDiv({cls: "modal-content"});
					}
					open() { this.onOpen(); }
					close() { this.onClose(); this.modalEl.remove(); }
				},
				setIcon(el) {
					el.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
				}
			});
		` });
		await page.addScriptTag({ content: script });
		await page.addScriptTag({ content: `
			const token = { player: {}, revision: 1 };
			SaverTime.openGoToTime({workspace: {iterateAllLeaves() {}, on() {}, offref() {}}}, {
				getPlaybackToken: () => token, getDuration: () => 4000,
				seekTo: seconds => { window.sought = seconds; }
			});
		` });
		const modal = page.locator(".commons-modal");
		const input = modal.getByRole("textbox", { name: "Video timestamp" });
		await expect(input).toBeFocused();
		await expect(page.locator("#native .modal-title")).toHaveCSS("font-size", "24px");
		await expect(modal.locator(".modal-title")).toHaveCSS("color", theme === "light" ? "rgb(38, 38, 38)" : "rgb(222, 222, 222)");
		await expect(modal.locator(".modal-title")).toHaveCSS("font-size", "24px");
		await expect(modal.locator("[data-commons-modal-icon], .commons-modal-hints, .commons-modal-intro")).toHaveCount(0);
		await expect(input).toHaveAccessibleDescription("Seconds, m:ss, or h:mm:ss.");
		await expect(modal.locator(".commons-modal-description")).toHaveCSS("font-size", "14px");
		await expect(modal.locator(".commons-modal-actions")).toHaveCSS("border-top-width", "0px");
		for (const width of [1024, 320]) {
			await page.setViewportSize({ width, height: 768 });
			const rect = (await modal.boundingBox())!;
			expect(rect.width).toBeLessThanOrEqual(440);
			expect(rect.x).toBeGreaterThanOrEqual(0);
			expect(rect.x + rect.width).toBeLessThanOrEqual(width);
			expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
			const field = (await input.boundingBox())!;
			const label = (await modal.locator(".commons-modal-field > span").first().boundingBox())!;
			const description = (await modal.locator(".commons-modal-description").boundingBox())!;
			expect(description.x).toBeCloseTo(field.x, 0);
			expect(description.y).toBeGreaterThanOrEqual(field.y + field.height);
			if (width === 1024) {
				expect(label.x + label.width).toBeLessThanOrEqual(field.x);
				expect(Math.abs(label.y - field.y)).toBeLessThan(12);
			} else {
				expect(label.y + label.height).toBeLessThanOrEqual(field.y);
				expect(label.x).toBeCloseTo(field.x, 0);
			}
			const actions = (await modal.locator(".commons-modal-actions").boundingBox())!;
			expect(field.y + field.height).toBeLessThan(actions.y);
			await input.fill("4001");
			await input.press("Enter");
			await expect(modal.getByRole("alert")).toContainText("exceeds");
			await expect(input).toBeFocused();
			expect(await input.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
		}
		await page.setViewportSize({ width: 1024, height: 768 });
		await input.fill("1:23");
		await expect(modal.getByRole("alert")).toBeEmpty();
		await page.keyboard.press("Tab");
		await expect(modal.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(modal.getByRole("button", { name: "Go to time", exact: true })).toBeFocused();
		await input.focus();
		await modal.screenshot({ path: test.info().outputPath(`time-modal-${theme}.png`) });
		await input.press("Enter");
		await expect(modal).toHaveCount(0);
		expect(await page.evaluate("window.sought")).toBe(83);
		await page.locator("#native").evaluate(el => {
			el.classList.add("commons-modal");
			const message = el.ownerDocument.createElement("div");
			message.className = "commons-modal-intro";
			message.textContent = "Choose whether to overwrite the existing note.";
			el.appendChild(message);
		});
		const message = page.locator("#native .commons-modal-intro");
		await expect(message).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(message).toHaveCSS("border-inline-start-width", "0px");
		await expect(message).toHaveCSS("padding-inline-start", "0px");
		await expect(message).toHaveCSS("font-size", "16px");
		await expect(message).toHaveCSS("text-align", "start");
	});
}
