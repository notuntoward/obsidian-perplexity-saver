import { expect, test } from "@playwright/test";
import path from "node:path";

for (const width of [240, 320, 760]) {
	test(`transcript search controls wrap without squeezing the input at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 600 });
		await page.setContent(`
			<style>
				* { box-sizing: border-box; }
				body { margin: 0; }
				:root { --size-2-2: 4px; }
				.search-input-container input { width: 100%; }
				.clickable-icon { flex: none; width: 28px; height: 28px; padding: 0; }
			</style>
			<div class="perplexity-saver-transcript-search">
				<div class="search-input-container"><input placeholder="Search transcript"></div>
				<span class="perplexity-saver-transcript-matches">12/123</span>
				<button class="clickable-icon">Up</button>
				<button class="clickable-icon">Dn</button>
				<button class="clickable-icon">OK</button>
				<button class="clickable-icon">P</button>
				<button class="clickable-icon">H</button>
				<button class="clickable-icon">F</button>
			</div>
		`);
		await page.addStyleTag({ path: path.resolve("styles.css") });
		const layout = await page.evaluate(() => {
			const bar = document.querySelector<HTMLElement>(".perplexity-saver-transcript-search")!;
			const input = bar.querySelector("input")!.getBoundingClientRect();
			return {
				inputWidth: input.width,
				overflow: bar.scrollWidth - bar.clientWidth,
				allControlsFit: Array.from(bar.querySelectorAll("button")).every((button) => {
					const rect = button.getBoundingClientRect();
					return rect.left >= 0 && rect.right <= bar.clientWidth;
				}),
			};
		});
		expect(layout.inputWidth).toBeGreaterThanOrEqual(160);
		expect(layout.overflow).toBeLessThanOrEqual(1);
		expect(layout.allControlsFit).toBe(true);
	});
}
