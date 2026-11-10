import { expect, test } from "@playwright/test";
import path from "node:path";

for (const background of ["rgb(255, 255, 255)", "rgb(24, 24, 24)"]) {
test(`footnote destination remains visible with transparent theme highlights on ${background}`, async ({ page }) => {
	await page.setContent(`
		<style>
			:root { --text-highlight-bg: transparent; --interactive-accent: rgb(100, 80, 220); --background-primary: ${background}; }
			.cm-line { line-height: 28px; }
		</style>
		<div class="cm-editor">
		<div class="cm-line">Previous source</div>
		<div class="cm-line" id="target">[^2_2]: <a href="https://example.com">A source title</a></div>
		<div class="cm-line">Next source</div>
		</div>
		<div id="expected" style="background-color: color-mix(in srgb, rgb(100, 80, 220) 24%, ${background})"></div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.addStyleTag({ content: ".cm-editor .cm-line { background-color: transparent; }" });
	const target = page.locator("#target");
	const expected = await page.locator("#expected").evaluate(el => getComputedStyle(el).backgroundColor);
	const before = await target.boundingBox();
	await target.evaluate(el => el.classList.add("perplexity-saver-footnote-target"));
	await expect(target).toHaveCSS("background-color", expected);
	await expect(target).toHaveCSS("box-shadow", "rgb(100, 80, 220) 3px 0px 0px 0px inset");
	expect(await target.boundingBox()).toEqual(before);
	await expect(page.locator(".cm-line").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(target).toHaveCSS("background-color", expected);
	await target.evaluate(el => el.classList.remove("perplexity-saver-footnote-target"));
	await expect(target).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});
}
