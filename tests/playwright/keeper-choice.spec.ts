import { expect, test } from "@playwright/test";
import path from "node:path";
import { colorContrast, type RGB } from "../../../obsidian-commons/src/color/contrast";

function rgb(value: string): RGB {
	const [r, g, b] = value.match(/\d+(\.\d+)?/g)!.map(Number);
	return { r, g, b };
}

// Notices invert the theme; buttons and borders keep the page theme's colors.
const themes = [
	{ name: "light theme (dark notice)", notice: "rgb(30, 30, 30)", text: "rgb(240, 240, 240)", button: "rgb(255, 255, 255)", border: "rgb(224, 224, 224)" },
	{ name: "dark theme (light notice)", notice: "rgb(235, 235, 235)", text: "rgb(20, 20, 20)", button: "rgb(54, 54, 54)", border: "rgb(60, 60, 60)" },
];

for (const theme of themes) {
	test(`the suggested keeper is the most prominent choice in a ${theme.name}`, async ({ page }) => {
		await page.setContent(`
			<style>
				:root { --background-modifier-border: ${theme.border}; --interactive-accent: rgb(80, 60, 200); }
				button { background-color: ${theme.button}; box-shadow: 0 1px 2px black; }
				.notice { background-color: ${theme.notice}; color: ${theme.text}; padding: 12px; width: 320px; }
			</style>
			<div class="notice"><div class="perplexity-saver-keeper-list">
				<div class="perplexity-saver-keeper-row is-suggested"><div class="perplexity-saver-keeper-info">
					<div class="perplexity-saver-keeper-badge">Suggested</div><div class="perplexity-saver-keeper-name">Tapper25bidenHandedTrumpPres</div>
				</div><button id="suggested">Keep</button></div>
				<div class="perplexity-saver-keeper-row" id="other-row"><div class="perplexity-saver-keeper-info">
					<div class="perplexity-saver-keeper-name">Tapper25HowJoeBiden</div>
				</div><button id="other">Keep</button></div>
			</div></div>
		`);
		await page.addStyleTag({ path: path.resolve("styles.css") });
		const style = (selector: string) => page.locator(selector).evaluate((el) => {
			const s = getComputedStyle(el);
			return { border: s.borderTopColor, width: parseFloat(s.borderTopWidth), background: s.backgroundColor, opacity: Number(s.opacity) };
		});
		const notice = rgb(theme.notice);
		const suggestedRow = await style(".is-suggested");
		const otherRow = await style("#other-row");
		const suggested = await style("#suggested");
		const other = await style("#other");

		// No inherited page fill makes the alternative stand out.
		expect(other.background).toBe("rgba(0, 0, 0, 0)");
		expect(suggested.background).toBe("rgba(0, 0, 0, 0)");
		// The suggested row and button are drawn at full contrast, the others faintly.
		expect(colorContrast(rgb(suggestedRow.border), notice)).toBeGreaterThan(7);
		expect(suggestedRow.width).toBeGreaterThan(otherRow.width);
		expect(rgb(otherRow.border)).not.toEqual(rgb(suggestedRow.border));
		expect(suggested.width).toBeGreaterThan(other.width);
		expect(suggested.opacity).toBeGreaterThan(other.opacity);
		await expect(page.locator("#suggested")).toHaveCSS("color", theme.text);
	});
}
