import { expect, test } from "@playwright/test";
import path from "node:path";
import { build } from "esbuild";

test("compact tabs do not let native window buttons cover the video corner", async ({ page }) => {
	await page.setContent(`
		<style>
			body { margin: 0; } :root { --header-height: 40px; --size-4-1: 4px; --size-4-2: 8px; }
			.titlebar { position: absolute; top: 0; right: 0; height: 39px; z-index: 100; }
			.titlebar-button { height: 100%; width: 42px; background: white; }
			.workspace-tab-header-container { height: 30px; }
			.view-content { width: 600px; height: 360px; box-sizing: border-box; }
		</style>
		<div class="titlebar"><div class="titlebar-button mod-close"></div></div>
		<div class="workspace-tabs mod-top mod-top-right-space">
			<div class="workspace-tab-header-container">Tabs</div>
			<div class="workspace-tab-container"><div class="workspace-leaf-content">
				<div class="view-content perplexity-saver-video-view has-video">
					<div class="perplexity-saver-video-stage"><div class="perplexity-saver-video-overlay"></div></div>
				</div>
			</div></div>
		</div>
	`);
	await page.locator("body").evaluate((el) => el.classList.add("is-hidden-frameless"));
	await page.addStyleTag({ path: path.resolve("styles.css") });
	const geometry = await page.evaluate(() => {
		const stage = document.querySelector(".perplexity-saver-video-stage")!.getBoundingClientRect();
		const close = document.querySelector(".titlebar-button")!.getBoundingClientRect();
		return { pictureTop: stage.top, buttonBottom: close.bottom };
	});
	expect(geometry.pictureTop).toBeGreaterThanOrEqual(geometry.buttonBottom);
	await page.locator(".workspace-tabs").evaluate((el) => el.classList.remove("mod-top-right-space"));
	expect((await page.locator(".workspace-tab-header-container").boundingBox())!.height).toBe(30);
});

test("video hides only its lower navigation row and retains a non-interactive focus accent", async ({ page }) => {
	await page.setContent(`
		<style>
			body { margin: 0; }
			:root { --header-height: 40px; --interactive-accent: rgb(100, 80, 220); }
			.workspace-tab-header-container { height: 30px; }
			.view-header { height: 40px; }
			.workspace-leaf-content { display: flex; flex-direction: column; }
			.view-content { height: 200px; }
		</style>
		<div class="workspace-tabs mod-top">
			<div class="workspace-tab-header-container">Video tab / close / window controls</div>
			<div class="workspace-tab-container">
				<div class="workspace-leaf" id="video"><div class="workspace-leaf-content">
					<div class="view-header">Back / Forward / Video / More</div>
					<div class="view-content perplexity-saver-video-view">Picture and playback controls</div>
				</div></div>
				<div class="workspace-leaf" id="note"><div class="workspace-leaf-content">
					<div class="view-header">Note navigation</div><div class="view-content markdown-source-view"></div>
				</div></div>
			</div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await expect(page.locator("#video .view-header")).toBeHidden();
	await expect(page.locator(".workspace-tab-header-container")).toBeVisible();
	await expect(page.locator("#note .view-header")).toBeVisible();
	expect((await page.locator("#video .view-content").boundingBox())!.y).toBe(30);
	const before = await page.locator("#video .view-content").boundingBox();
	await page.locator("#video").evaluate((el) => el.classList.add("perplexity-saver-focused-pane"));
	const accent = await page.locator("#video .workspace-leaf-content").evaluate((el) => {
		const css = getComputedStyle(el, "::after");
		return { top: css.top, height: css.height, content: css.content, pointerEvents: css.pointerEvents, color: css.backgroundColor };
	});
	expect(accent).toEqual({ top: "0px", height: "2px", content: '""', pointerEvents: "none", color: "rgb(100, 80, 220)" });
	expect(await page.locator("#video .view-content").boundingBox()).toEqual(before);
	await page.locator("#video").evaluate((el) => el.classList.remove("perplexity-saver-focused-pane"));
	expect(await page.locator("#video .workspace-leaf-content").evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none");
});

test("singleton transcript chrome collapses, restores for another tab, and preserves top-window controls", async ({ page }) => {
	await page.setContent(`
		<style>
			* { box-sizing: border-box; } body { margin: 0; }
			:root { --header-height: 40px; --interactive-accent: rgb(100, 80, 220); }
			.workspace-tabs { height: 240px; display: flex; flex-direction: column; }
			.workspace-tab-header-container { height: 30px; flex: none; }
			.workspace-tab-container { flex: 1; min-height: 0; }
			.workspace-leaf, .workspace-leaf-content { height: 100%; }
			.view-header { height: 40px; }
			.perplexity-saver-transcript-header { height: 30px; }
			.workspace-leaf-resize-handle { height: 4px; }
		</style>
		<div class="workspace-leaf-resize-handle"></div>
		<div class="workspace-tabs" id="group">
			<div class="workspace-tab-header-container">Transcript tab / close / new tab</div>
			<div class="workspace-tab-container"><div class="workspace-leaf perplexity-saver-focused-pane">
				<div class="workspace-leaf-content">
					<div class="view-header">Back / Forward / Transcript / More</div>
					<div class="perplexity-saver-transcript-view">
						<div class="perplexity-saver-transcript-header">Note title / Transcript controls</div>
						<div class="perplexity-saver-transcript-list">Transcript text</div>
					</div>
				</div>
			</div></div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	const tabs = page.locator(".workspace-tab-header-container");
	const header = page.locator(".view-header");
	await expect(tabs).toBeHidden();
	await expect(header).toBeHidden();
	await expect(page.locator(".workspace-leaf-resize-handle")).toBeVisible();
	const compactTop = await page.locator(".perplexity-saver-transcript-header").boundingBox();
	expect(compactTop!.y).toBe(4);
	expect(await page.locator(".workspace-leaf-content").evaluate((el) => getComputedStyle(el, "::after").top)).toBe("0px");
	await page.locator(".workspace-tab-container").evaluate((el) => {
		const other = document.createElement("div"); other.className = "workspace-leaf"; other.id = "other"; el.appendChild(other);
	});
	await expect(tabs).toBeVisible();
	await expect(header).toBeVisible();
	await page.locator("#other").evaluate((el) => el.remove());
	await expect(tabs).toBeHidden();
	for (const cls of ["mod-top", "mod-stacked"]) {
		await page.locator("#group").evaluate((el, cls) => el.classList.add(cls), cls);
		await expect(tabs).toBeVisible();
		await expect(header).toBeVisible();
		await page.locator("#group").evaluate((el, cls) => el.classList.remove(cls), cls);
	}
	await page.locator(".perplexity-saver-transcript-view").evaluate((el) => el.classList.add("show-pane-chrome"));
	await expect(tabs).toBeVisible();
	await expect(header).toBeVisible();
});

test("a short viewer pane fits the whole 16:9 picture and its controls after resizing", async ({ page }) => {
	const bundled = await build({
		entryPoints: [path.resolve("src/video/videoView.ts")],
		bundle: true, write: false, format: "iife", globalName: "SaverVideo",
		external: ["obsidian", "commons/os"],
	});
	await page.setContent(`
		<style>
			* { box-sizing: border-box; } body { margin: 0; }
			:root { --size-4-1: 4px; --size-4-2: 8px; }
			.workspace-leaf-content .view-content { padding: 12px 12px 32px; padding-bottom: max(0px, 32px); }
			.view-content { width: 700px; height: 260px; }
			.perplexity-saver-video-controls { height: 30px; }
		</style>
		<div class="workspace-leaf-content"><div class="view-content perplexity-saver-video-view has-video">
			<div class="perplexity-saver-video-stage"><div class="perplexity-saver-video-frame"><iframe class="perplexity-saver-video-iframe"></iframe></div></div>
			<div class="perplexity-saver-video-timeline"><div class="perplexity-saver-video-track"></div></div>
			<div class="perplexity-saver-video-controls"></div>
		</div></div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.addScriptTag({ content: `globalThis.require = () => new Proxy({}, { get: () => class {} });` });
	await page.addScriptTag({ content: bundled.outputFiles[0].text });
	for (const height of [260, 420, 720, 200]) {
		await page.evaluate((height) => {
			const content = document.querySelector<HTMLElement>(".view-content")!;
			content.style.height = height + "px";
			const stage = content.querySelector<HTMLElement>(".perplexity-saver-video-stage")!;
			const api = (globalThis as unknown as { SaverVideo: { VideoView: { prototype: { onResize?(): void } } } }).SaverVideo;
			api.VideoView.prototype.onResize?.call({ contentEl: content, stageEl: stage });
		}, height);
		const geometry = await page.evaluate(() => {
			const content = document.querySelector(".view-content")!.getBoundingClientRect();
			const stage = document.querySelector(".perplexity-saver-video-stage")!.getBoundingClientRect();
			const controls = document.querySelector(".perplexity-saver-video-controls")!.getBoundingClientRect();
			const frame = document.querySelector("iframe")!.getBoundingClientRect();
			const timeline = document.querySelector(".perplexity-saver-video-timeline")!.getBoundingClientRect();
			return { ratio: stage.width / stage.height, stageHeight: stage.height, bottom: controls.bottom, limit: content.bottom, width: stage.width, frameWidth: frame.width,
				beforeControls: controls.top - stage.bottom, afterControls: content.bottom - controls.bottom, timelineHeight: timeline.height, controlsHeight: controls.height };
		});
		expect(geometry.ratio).toBeCloseTo(16 / 9, 2);
		expect(geometry.bottom).toBeLessThanOrEqual(geometry.limit);
		expect(geometry.frameWidth).toBeCloseTo(geometry.width, 1);
		expect(geometry.controlsHeight).toBe(30);
		if (height === 260) expect(geometry.stageHeight).toBeCloseTo(202, 1);
		if (height < 420) expect(geometry.width).toBeLessThan(684);
		if (height <= 420) {
			expect(geometry.beforeControls).toBeLessThanOrEqual(20);
			expect(geometry.afterControls).toBeLessThanOrEqual(4.1);
			expect(geometry.timelineHeight).toBeGreaterThanOrEqual(12);
		}
	}
});

test("a tall pane keeps a 16:9 capture stage with controls immediately below it", async ({ page }) => {
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			body { margin: 0; }
			:root { --size-4-1: 4px; --size-4-2: 8px; }
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
	expect(geometry.gap).toBe(4);
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
	for (const selector of ["#note .view-header"]) {
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
					for (const id of ["note"]) {
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
		<div class="workspace-leaf" id="unrelated"><div class="workspace-leaf-content">
			<div class="view-header">Unrelated note</div><div class="markdown-source-view"><textarea></textarea></div>
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
		const events = {};
		const leaves = ["note", "unrelated", "video", "transcript"].map(id => ({
			view: {
				containerEl: document.getElementById(id),
				getViewType: () => id === "note" || id === "unrelated" ? "markdown" : "perplexity-saver-" + id
			},
			getViewState: () => ({ state: { file: id === "unrelated" ? "unrelated.md" : "video-note.md" } })
		}));
		for (const { view } of leaves) view.containerEl.isShown = () => view.containerEl.checkVisibility();
		const refreshIndicator = focusIndicator.registerVideoNoteFocusIndicator(
			{
				register: (callback) => { cleanup = callback; },
				registerEvent: () => {},
				app: { workspace: {
					getLeavesOfType: type => leaves.filter(leaf => leaf.view.getViewType() === type),
					on: (name, callback) => { events[name] = callback; }
				} }
			}, () => indicatorEnabled
		);
	` });
	for (const target of ["note", "video", "transcript", "video", "note"]) {
		if (target === "video") await page.frameLocator("iframe").locator("button").click();
		else await page.locator(`#${target} ${target === "note" ? "textarea" : "input"}`).click();
		await expect(page.locator(".perplexity-saver-focused-pane")).toHaveAttribute("id", target);
		if (target === "transcript" || target === "video") {
			expect(await page.locator(`#${target} > .workspace-leaf-content`).evaluate((el) => getComputedStyle(el, "::after").backgroundColor)).toBe("rgb(100, 80, 220)");
		} else {
			const header = page.locator(`#${target} .view-header`);
			expect(await header.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("rgb(100, 80, 220) 0px -2px 0px 0px inset");
		}
	}
	await page.locator("#unrelated textarea").click();
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveCount(0);
	expect(await page.locator("#unrelated .view-header").evaluate(el => getComputedStyle(el).boxShadow)).toBe("none");
	await page.locator("#note textarea").click();
	await page.evaluate(() => {
		for (const id of ["video", "transcript"]) document.getElementById(id)!.style.display = "none";
	});
	await page.addScriptTag({ content: 'events["layout-change"]();' });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveCount(0);
	await page.locator("#transcript").evaluate(el => { el.style.display = ""; });
	await page.addScriptTag({ content: 'events["layout-change"]();' });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveAttribute("id", "note");
	await page.addScriptTag({ content: "indicatorEnabled = false; refreshIndicator();" });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveCount(0);
	await page.addScriptTag({ content: "indicatorEnabled = true; refreshIndicator();" });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveAttribute("id", "note");
	await page.addScriptTag({ content: "cleanup();" });
	await expect(page.locator(".perplexity-saver-focused-pane")).toHaveCount(0);
});
