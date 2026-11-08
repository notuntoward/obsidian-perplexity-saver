import { expect, test } from "@playwright/test";
import path from "node:path";
import { build } from "esbuild";

test("a tall pane keeps a 16:9 capture stage with controls immediately below it", async ({ page }) => {
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			body { margin: 0; }
			:root { --size-4-2: 8px; }
			.view-content { width: 420px; height: 720px; }
			.perplexity-saver-video-controls { height: 30px; }
		</style>
		<div class="view-content perplexity-saver-video-view has-video">
			<div class="perplexity-saver-video-stage">
				<div class="perplexity-saver-video-frame"><iframe class="perplexity-saver-video-iframe"></iframe></div>
			</div>
			<div class="perplexity-saver-video-controls"></div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	const geometry = await page.evaluate(() => {
		const stage = document.querySelector(".perplexity-saver-video-stage")!.getBoundingClientRect();
		const frame = document.querySelector("iframe")!.getBoundingClientRect();
		const controls = document.querySelector(".perplexity-saver-video-controls")!.getBoundingClientRect();
		return { ratio: stage.width / stage.height, height: stage.height, frameHeight: frame.height, gap: controls.top - stage.bottom };
	});
	expect(geometry.ratio).toBeCloseTo(16 / 9, 2);
	expect(geometry.height).toBeLessThan(250);
	expect(geometry.frameHeight).toBeCloseTo(geometry.height, 1);
	expect(geometry.gap).toBe(8);
});

test("focus lines are 2px accent underlines without changing header size; playback shading has no stripe", async ({ page }) => {
	await page.setContent(`
		<style>
			:root { --interactive-accent: rgb(100, 80, 220); --interactive-accent-hsl: 249, 67%, 59%; }
			.view-header, .perplexity-saver-transcript-header { height: 40px; }
		</style>
		<div class="workspace-leaf" id="note"><div class="workspace-leaf-content">
			<div class="view-header">Note</div><div class="view-content markdown-source-view"></div>
		</div></div>
		<div class="workspace-leaf" id="video"><div class="workspace-leaf-content">
			<div class="view-header">Video</div><div class="view-content perplexity-saver-video-view"></div>
		</div></div>
		<div class="workspace-leaf" id="transcript">
			<div class="workspace-leaf-content">
			<div class="view-header">Native header</div>
			<div class="perplexity-saver-transcript-view">
				<div class="perplexity-saver-transcript-header">Transcript controls</div>
				<div class="perplexity-saver-transcript-row is-playing">Current chunk</div>
			</div>
			</div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	for (const selector of ["#note .view-header", "#video .view-header"]) {
		const header = page.locator(selector);
		const before = await header.boundingBox();
		await header.evaluate((el) => el.closest(".workspace-leaf")!.classList.add("perplexity-saver-focused-pane"));
		expect(await header.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("rgb(100, 80, 220) 0px -2px 0px 0px inset");
		expect(await header.boundingBox()).toEqual(before);
		await header.evaluate((el) => el.closest(".workspace-leaf")!.classList.remove("perplexity-saver-focused-pane"));
		expect(await header.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
	}
	const playing = page.locator(".is-playing");
	expect(await playing.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
	expect(await playing.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
});

test("transcript accent aligns with native pane headers regardless of sidebar, hints, scrolling or theme header height", async ({ page }) => {
		await page.setViewportSize({ width: 1152, height: 768 });
		await page.setContent(`
			<style>
				:root {
					--header-height: 40px; --interactive-accent: rgb(100, 80, 220);
					--size-4-2: 8px; --size-4-3: 12px;
				}
				body { margin: 0; display: flex; }
				.workspace-leaf { width: 384px; }
				.workspace-leaf-content { position: relative; }
				.view-header { height: var(--header-height); }
				.mod-sidedock .view-header { display: none; }
				.view-content { padding: 12px; height: 250px; overflow-y: auto; }
				.perplexity-saver-transcript-row { height: 600px; }
			</style>
			<div class="workspace-leaf" id="note"><div class="workspace-leaf-content">
				<div class="view-header">Note</div><div class="view-content markdown-source-view"></div>
			</div></div>
			<div class="workspace-leaf" id="video"><div class="workspace-leaf-content">
				<div class="view-header">Video</div><div class="view-content perplexity-saver-video-view"></div>
			</div></div>
			<div class="mod-sidedock"><div class="workspace-leaf" id="transcript"><div class="workspace-leaf-content">
				<div class="view-header">Hidden native header</div>
				<div class="view-content perplexity-saver-transcript-view">
					<div class="perplexity-saver-transcript-header">
						<a>Transcript note title</a><button>Format as paragraphs</button>
						<div class="perplexity-saver-transcript-search"><input placeholder="Search"></div>
						<div class="perplexity-saver-transcript-hints"><div class="is-search">Search hints</div><div class="is-rows">Row hints</div></div>
					</div>
					<div class="perplexity-saver-transcript-row" tabindex="0">Timestamp</div>
				</div>
			</div></div></div>
		`);
		await page.addStyleTag({ path: path.resolve("styles.css") });
		for (const height of [40, 32, 48]) {
			await page.evaluate((height) => document.documentElement.style.setProperty("--header-height", `${height}px`), height);
			for (const sidebar of [true, false]) {
				await page.locator("#transcript").evaluate((el, sidebar) => el.parentElement!.classList.toggle("mod-sidedock", sidebar), sidebar);
				for (const focus of ["input", ".perplexity-saver-transcript-row"]) {
					await page.locator(focus).focus();
					const controlsBefore = await page.locator(".perplexity-saver-transcript-header").boundingBox();
					await page.locator("#transcript").evaluate((el) => el.classList.add("perplexity-saver-focused-pane"));
					const accent = await page.locator("#transcript > .workspace-leaf-content").evaluate((el) => {
						const css = getComputedStyle(el, "::after");
						return {
							content: css.content, y: el.getBoundingClientRect().top + parseFloat(css.top),
							height: css.height, background: css.backgroundColor, pointerEvents: css.pointerEvents,
						};
					});
					expect(accent.content).toBe('""');
					for (const id of ["note", "video"]) {
						const header = await page.locator(`#${id} .view-header`).boundingBox();
						expect(accent.y).toBe(header!.y + header!.height - 2);
					}
					expect(accent.height).toBe("2px");
					expect(accent.background).toBe("rgb(100, 80, 220)");
					expect(accent.pointerEvents).toBe("none");
					await page.locator(".perplexity-saver-transcript-view").evaluate((el) => { el.scrollTop = 120; });
					const scrolledY = await page.locator("#transcript > .workspace-leaf-content").evaluate((el) => el.getBoundingClientRect().top + parseFloat(getComputedStyle(el, "::after").top));
					expect(scrolledY).toBe(accent.y);
					await page.locator(".perplexity-saver-transcript-view").evaluate((el) => { el.scrollTop = 0; });
					expect(await page.locator(".perplexity-saver-transcript-header").boundingBox()).toEqual(controlsBefore);
					expect(await page.locator(".perplexity-saver-transcript-header").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
					await page.locator("#transcript").evaluate((el) => el.classList.remove("perplexity-saver-focused-pane"));
					expect(await page.locator("#transcript > .workspace-leaf-content").evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none");
				}
			}
		}
});

test("the focus header follows real note, embedded-player and transcript clicks and can be disabled", async ({ page }) => {
	const bundled = await build({
		entryPoints: [path.resolve("src/video/focusIndicator.ts")],
		bundle: true,
		write: false,
		format: "iife",
		globalName: "focusIndicator",
		plugins: [{
			name: "single-test-window",
			setup(build) {
				build.onResolve({ filter: /^commons\/windows$/ }, () => ({ path: "windows", namespace: "test" }));
				build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
					contents: "export const forEachWindow = (plugin, setup) => { plugin.register(setup(window)); };",
				}));
			},
		}],
	});
	await page.setContent(`
		<style>
			:root { --interactive-accent: rgb(100, 80, 220); }
			.workspace-leaf { width: 350px; }
			.view-header { height: 40px; }
		</style>
		<div class="workspace-leaf" id="note"><div class="workspace-leaf-content">
			<div class="view-header">Note</div><div class="markdown-source-view"><textarea></textarea></div>
		</div></div>
		<div class="workspace-leaf" id="video"><div class="workspace-leaf-content">
			<div class="view-header">Video</div>
			<div class="perplexity-saver-video-view"><iframe srcdoc="<button>Play</button>"></iframe><button>Pause</button></div>
		</div></div>
		<div class="workspace-leaf" id="transcript"><div class="workspace-leaf-content">
			<div class="view-header">Transcript</div>
			<div class="perplexity-saver-transcript-view">
				<div class="perplexity-saver-transcript-header"><input placeholder="Search"></div>
			</div>
		</div></div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.addScriptTag({ content: bundled.outputFiles[0].text });
	await page.addScriptTag({ content: `
		let indicatorEnabled = true;
		let cleanup;
		const refreshIndicator = focusIndicator.registerVideoNoteFocusIndicator(
			{ register: (callback) => { cleanup = callback; } }, () => indicatorEnabled
		);
	` });
	for (const target of ["note", "video", "transcript", "video", "note"]) {
		if (target === "video") await page.frameLocator("iframe").locator("button").click();
		else await page.locator(`#${target} ${target === "note" ? "textarea" : "input"}`).click();
		await expect(page.locator(".perplexity-saver-focused-pane")).toHaveAttribute("id", target);
		if (target === "transcript") {
			expect(await page.locator("#transcript > .workspace-leaf-content").evaluate((el) => getComputedStyle(el, "::after").backgroundColor)).toBe("rgb(100, 80, 220)");
		} else {
			const header = page.locator(`#${target} .view-header`);
			expect(await header.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("rgb(100, 80, 220) 0px -2px 0px 0px inset");
		}
	}
	await page.addScriptTag({ content: "indicatorEnabled = false; refreshIndicator();" });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveCount(0);
	await page.addScriptTag({ content: "indicatorEnabled = true; refreshIndicator();" });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveAttribute("id", "note");
	await page.addScriptTag({ content: "cleanup();" });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveCount(0);
});
