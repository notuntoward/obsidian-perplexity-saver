import { expect, test } from "@playwright/test";
import path from "node:path";

test("browsing has a compact toolbar, no idle search/hints and substantially more transcript space", async ({ page }) => {
	await page.setViewportSize({ width: 1152, height: 768 });
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			body { margin: 0; font: 14px/20px sans-serif; }
			:root { --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px; --size-2-1: 2px; --size-2-2: 4px; --font-ui-smaller: 12px; }
			.view-content { padding: 12px; width: 700px; height: 210px; overflow: auto; }
			.clickable-icon { flex: none; width: 28px; height: 28px; padding: 0; }
			.perplexity-saver-transcript-row { min-height: 40px; }
		</style>
		<div class="view-content perplexity-saver-transcript-view">
			<div class="perplexity-saver-transcript-header">
				<div class="perplexity-saver-transcript-controls">
					<a class="perplexity-saver-transcript-title">Kashlak21garchProcess with a very long title</a>
					<span class="perplexity-saver-transcript-count">381 lines</span>
					<button class="perplexity-saver-transcript-format">Paragraphs</button>
					<button class="clickable-icon" aria-label="Search">S</button>
					<button aria-label="Transcript layout">Layout</button>
					<button class="clickable-icon" aria-label="Help">?</button>
					<button class="clickable-icon" aria-label="Close">X</button>
				</div>
				<div class="perplexity-saver-transcript-search" hidden><input></div>
				<div class="perplexity-saver-transcript-hints"><div class="is-rows">Keyboard hints</div><div class="is-search">Search hints</div></div>
			</div>
			<div class="perplexity-saver-transcript-list">
				${Array.from({ length: 20 }, (_, i) => `<div class="perplexity-saver-transcript-row" tabindex="${i === 0 ? 0 : -1}">0:${i} Transcript text</div>`).join("")}
			</div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.locator(".perplexity-saver-transcript-row").first().focus();
	const layout = await page.locator(".view-content").evaluate((el) => {
		const header = el.querySelector(".perplexity-saver-transcript-header")!.getBoundingClientRect();
		const first = el.querySelector(".perplexity-saver-transcript-row")!.getBoundingClientRect();
		return { headerHeight: header.height, overhead: first.top - el.getBoundingClientRect().top, visibleHeight: el.getBoundingClientRect().bottom - first.top };
	});
	expect(layout.headerHeight).toBeLessThanOrEqual(48);
	expect(layout.overhead).toBeLessThanOrEqual(56);
	expect(layout.visibleHeight).toBeGreaterThanOrEqual(154);
	await expect(page.locator(".perplexity-saver-transcript-search")).toBeHidden();
	await expect(page.locator(".is-rows")).toBeHidden();
	await page.locator(".view-content").evaluate((el) => el.classList.add("show-help"));
	await expect(page.locator(".is-rows")).toBeVisible();
	for (const width of [320, 240]) {
		await page.locator(".view-content").evaluate((el, width) => { (el as HTMLElement).style.width = width + "px"; }, width);
		expect(await page.locator(".view-content").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		for (const button of await page.locator(".perplexity-saver-transcript-controls button").all()) await expect(button).toBeVisible();
	}
});

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
