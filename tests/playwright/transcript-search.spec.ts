import { expect, test } from "@playwright/test";
import path from "node:path";
import { build } from "esbuild";

test("rendered reading and video toolbars keep usable task groups at narrow widths", async ({ page }) => {
	const bundled = await build({
		stdin: { contents: 'export { TranscriptView } from "./src/litNote/transcriptView"; export { VideoView } from "./src/video/videoView";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "ReadingUI",
		external: ["obsidian", "crypto", "commons/windows", "commons/workspace", "commons/os"],
	});
	await page.setContent(`<style>
		* { box-sizing: border-box; } body { margin: 0; font: 14px/20px sans-serif; }
		:root { --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px; --size-2-1: 2px; --font-ui-smaller: 12px; --line-height-normal: 1.5; --background-modifier-border: #ddd; --background-modifier-border-focus: #999; --text-selection: rgba(100,80,220,.2); --text-faint: #888; --interactive-accent-hsl: 254, 80%, 68%; --radius-s: 4px; }
		.view-content { width: 700px; height: 300px; padding: 8px; overflow: auto; }
		.clickable-icon { display: inline-flex; align-items: center; justify-content: center; padding: 4px; border: 0; }
		.clickable-icon svg { width: 16px; height: 16px; } select { height: 28px; }
		</style><div class="workspace-tabs"><div class="workspace-tab-container"><div class="workspace-leaf"><div class="workspace-leaf-content"><div id="transcript" class="view-content"></div></div></div></div></div><div id="video" class="view-content"></div>`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	await page.addScriptTag({ content: `
		const p = HTMLElement.prototype;
		p.createEl = function(tag, opts = {}) {
			const el = this.ownerDocument.createElement(tag);
			if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(" ") : opts.cls;
			if (opts.text) el.textContent = opts.text;
			for (const [k,v] of Object.entries(opts.attr || {})) el.setAttribute(k, v);
			for (const k of ["href", "title", "type"]) if (opts[k]) el.setAttribute(k, opts[k]);
			this.appendChild(el); return el;
		};
		p.createDiv = function(o) { return this.createEl("div", o); };
		p.createSpan = function(o) { return this.createEl("span", o); };
		p.addClass = function(...c) { this.classList.add(...c); };
		p.removeClass = function(...c) { this.classList.remove(...c); };
		p.hasClass = function(c) { return this.classList.contains(c); };
		p.toggleClass = function(c,v) { this.classList.toggle(c,v); };
		p.empty = function() { this.replaceChildren(); };
		p.setText = function(t) { this.textContent = t; };
		p.getText = function() { return this.textContent; };
		p.appendText = function(t) { this.append(t); };
		p.setAttr = function(k,v) { this.setAttribute(k,v); };
		p.setCssProps = function(o) { for (const [k,v] of Object.entries(o)) this.style.setProperty(k,v); };
		p.isShown = function() { return this.getClientRects().length > 0 && !this.closest("[hidden]"); };
		class ItemView {
			constructor(leaf) { this.leaf = leaf; this.app = leaf.app; }
			register() {} registerEvent() {} getState() { return {}; } async setState() {}
			registerDomEvent(el,type,fn,opts) { el.addEventListener(type,fn,opts); }
		}
		class DropdownComponent {
			constructor(parent) { this.selectEl = parent.createEl("select"); }
			addOptions(o) { for (const [value,text] of Object.entries(o)) { const el = this.selectEl.createEl("option",{text}); el.value = value; } return this; }
			setValue(v) { this.selectEl.value = v; return this; }
			onChange(fn) { this.selectEl.addEventListener("change",()=>fn(this.selectEl.value)); return this; }
		}
		class SearchComponent {
			constructor(parent) { this.inputEl = parent.createEl("div",{cls:"search-input-container"}).createEl("input"); }
			setPlaceholder(v) { this.inputEl.placeholder=v; return this; } setValue(v) { this.inputEl.value=v; return this; }
			getValue() { return this.inputEl.value; } onChange(fn) { this.inputEl.addEventListener("input",()=>fn(this.inputEl.value)); return this; }
		}
		const obsidian = { ItemView, DropdownComponent, SearchComponent, Platform:{isDesktopApp:true}, Notice:class {}, Scope:class {register(){}},
			setIcon(el,name) { el.dataset.icon=name; el.querySelectorAll("svg").forEach(svg=>svg.remove()); const svg=el.ownerDocument.createElementNS("http://www.w3.org/2000/svg","svg"); el.appendChild(svg); } };
		globalThis.require = name => name === "obsidian" ? new Proxy(obsidian,{get:(o,k)=>o[k] || class {}})
			: name === "crypto" ? { createHash:()=>({update(){return this;},digest:()=>"a".repeat(64)}) }
			: name === "commons/workspace" ? { getWindowForLeaf:()=>window }
			: name === "commons/windows" ? { requestFrameIn:()=>()=>{} }
			: {};
	` });
	await page.addScriptTag({ content: bundled.outputFiles[0].text });
	await page.addScriptTag({ content: `
		(async () => {
			const text = "# Transcript\\n<!-- saver-transcript-language: en -->\\n" + Array.from({length:40},(_,i)=>
				'[0:00](https://youtu.be/abcdefghijk?t='+i*4+' "'+i*4+'-'+(i*4+4)+'") Sentence '+i+' contains enough words for comfortable paragraph reading.\\n').join("");
			const app = { scope:{}, vault:{getFileByPath:()=>({path:"note.md",basename:"A very long literature note title for this transcript"}),cachedRead:async()=>text,on:()=>({})},
				metadataCache:{on:()=>({}),getFileCache:()=>({headings:[{heading:"Transcript",level:1,position:{start:{offset:0},end:{offset:12}}}]})},
				workspace:{on:()=>({}),requestSaveLayout(){}} };
			const host = { getHeadingName:()=>"Transcript",getSearchSettings:()=>({keyboard:"obsidian",matching:"all-words",highlights:"always"}),
				playAt(){},insertTimestampAt:async()=>{},toggleOrientation:async()=>{},getOrientation:()=>"below",runPlaybackControl(){},
				// Like the real host (leaf.containerEl.isShown()), this reads layout, mid-render, while the list is empty.
				isVideoVisible:()=>{ document.querySelector("#video").isShown(); return false; } };
			const transcript = new ReadingUI.TranscriptView({app},host);
			transcript.contentEl = document.querySelector("#transcript");
			await transcript.setState({file:"note.md"},{history:false}); await transcript.onOpen();
			globalThis.transcriptView=transcript;
			const video = new ReadingUI.VideoView({app},{getTranscriptHeading:()=>"Transcript",getToolbarCaptureAction:()=>"insert",
				getShowYoutubeCaptions:()=>false,isTranscriptShown:()=>true,onPlayback(){}});
			video.contentEl=document.querySelector("#video"); await video.onOpen(); video.videoId="abcdefghijk"; video.updateEmpty();
			video.update({currentTime:7954,duration:9956,playbackRate:1.75,playerState:2});
			globalThis.videoView=video;
			globalThis.uiReady=true;
		})().catch(error=>{ globalThis.uiError=error.message; });
	` });
	await expect.poll(() => page.evaluate(() => (globalThis as unknown as { uiReady?: boolean; uiError?: string }).uiError ?? (globalThis as unknown as { uiReady?: boolean }).uiReady)).toBe(true);
	await expect(page.locator("#transcript select option")).toHaveText(["Paragraphs", "Sentences", "Captions"]);
	await expect(page.locator("#transcript select")).toHaveValue("readable-paragraphs");
	await expect(page.getByRole("button", { name: "Compare segmentations" })).toHaveCount(0);
	await expect(page.locator("#transcript .perplexity-saver-transcript-time")).toHaveCount(0);
	await expect(page.locator("#transcript .perplexity-saver-transcript-count")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Move transcript beside video" })).toHaveText("Beside video");
	await expect(page.getByRole("button", { name: "Follow video", exact: true })).toHaveAttribute("aria-pressed", "true");
	await page.locator("#transcript .perplexity-saver-transcript-row").first().click();
	await page.evaluate(() => (globalThis as unknown as { transcriptView: { showPlayback(t: number): void } }).transcriptView.showPlayback(4));
	await expect(page.locator("#transcript .is-selected")).toHaveCount(1);
	// REGRESSION GUARD: in Paragraphs the playing marker must be visibly painted on the playing SENTENCE, and must
	// move when the player steps to the next sentence of the same paragraph. A class-only jsdom check cannot see
	// CSS that hides the marker in this mode, which is how this bug shipped before.
	const transcriptRowBackgrounds = () => page.locator("#transcript .perplexity-saver-transcript-row").evaluateAll((els) => els.map((el) => ({
		bg: getComputedStyle(el).backgroundColor, playing: el.classList.contains("is-playing"), selected: el.classList.contains("is-selected"), paragraph: el.parentElement,
	})).map(({ paragraph, ...rest }, i, all) => ({ ...rest, sameParagraphAsNext: i + 1 < all.length && paragraph === all[i + 1].paragraph })));
	const unmarked = (await transcriptRowBackgrounds()).find((row) => !row.playing && !row.selected)!.bg;
	let painted = await transcriptRowBackgrounds();
	expect(painted[1].playing).toBe(true);
	expect(painted[1].sameParagraphAsNext).toBe(true);
	expect(painted[1].bg).not.toBe(unmarked);
	expect(painted[1].bg).not.toBe(painted[0].bg);
	await page.evaluate(() => (globalThis as unknown as { transcriptView: { showPlayback(t: number, follow?: boolean, stateChanged?: boolean): void } }).transcriptView.showPlayback(8, true, false));
	painted = await transcriptRowBackgrounds();
	expect(painted.filter((row) => row.playing)).toHaveLength(1);
	expect(painted[2].playing).toBe(true);
	expect(painted[2].bg).not.toBe(unmarked);
	expect(painted[1].bg).toBe(unmarked);
	await expect(page.locator("#transcript .perplexity-saver-transcript-paragraph.is-playing")).toHaveCount(0);
	// REGRESSION GUARD: the keyboard cursor (the focused, selected row) is an EMPTY grey outline. A selection fill under
	// it looked like a second, darker "playing" mark. The fill may return only once focus leaves the row, so the
	// selection stays visible. Checked by painted color because jsdom cannot see CSS.
	const transcriptRows = page.locator("#transcript .perplexity-saver-transcript-row");
	const cursorPaint = (index: number) => transcriptRows.nth(index).evaluate((el) => ({
		bg: getComputedStyle(el).backgroundColor, outline: getComputedStyle(el).outlineStyle, focused: el === el.ownerDocument.activeElement,
		selected: el.classList.contains("is-selected"), playing: el.classList.contains("is-playing"),
	}));
	await transcriptRows.nth(3).click();
	expect(await cursorPaint(3)).toEqual({ bg: unmarked, outline: "solid", focused: true, selected: true, playing: false });
	await page.keyboard.press("ArrowDown");
	expect(await cursorPaint(4)).toEqual({ bg: unmarked, outline: "solid", focused: true, selected: true, playing: false });
	expect((await cursorPaint(3)).bg).toBe(unmarked);
	await transcriptRows.nth(4).evaluate((el) => (el as HTMLElement).blur());
	const blurred = await cursorPaint(4);
	expect(blurred.selected).toBe(true);
	expect(blurred.bg).not.toBe(unmarked);
	// REGRESSION GUARD: while following, keyboard focus rides on the playing row. That row must show only its tint,
	// not the grey focus ring around it. Once the user browses (following pauses), the ring is the cursor again.
	await page.getByRole("button", { name: "Follow video", exact: true }).click();
	await expect(page.getByRole("button", { name: "Follow video", exact: true })).toHaveAttribute("aria-pressed", "true");
	const playingIndex = () => transcriptRows.evaluateAll((els) => els.findIndex((el) => el.classList.contains("is-playing")));
	await transcriptRows.nth(await playingIndex()).focus();
	await page.evaluate(() => (globalThis as unknown as { transcriptView: { showPlayback(t: number, follow?: boolean, stateChanged?: boolean): void } }).transcriptView.showPlayback(10, true, false));
	const ridden = await playingIndex();
	const riding = await cursorPaint(ridden);
	expect({ focused: riding.focused, playing: riding.playing, outline: riding.outline }).toEqual({ focused: true, playing: true, outline: "none" });
	expect(riding.bg).not.toBe(unmarked);
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("button", { name: "Follow video", exact: true })).toHaveAttribute("aria-pressed", "false");
	expect((await cursorPaint(ridden + 1)).outline).toBe("solid");
	await page.keyboard.press("ArrowUp");
	expect(await cursorPaint(ridden)).toMatchObject({ focused: true, playing: true, outline: "solid" });
	for (const width of [240, 320, 700]) {
		await page.locator(".view-content").evaluateAll((els, w) => els.forEach((el) => { (el as HTMLElement).style.width = w + "px"; }), width);
		await page.evaluate(() => (globalThis as unknown as { videoView: { onResize(): void } }).videoView.onResize());
		for (const panel of await page.locator(".view-content").all()) {
			const sizing = await panel.evaluate((el) => ({
				panel: el.id, overflow: el.scrollWidth - el.clientWidth,
				groups: Array.from(el.querySelectorAll('[role="group"]')).map(group => ({ name: group.getAttribute("aria-label"), width: group.getBoundingClientRect().width })),
				overflowing: Array.from(el.querySelectorAll("*")).filter(child => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map(child => ({ cls: child.className, width: child.getBoundingClientRect().width })).slice(0, 8),
			}));
			expect(sizing.overflow, JSON.stringify({ width, ...sizing })).toBeLessThanOrEqual(1);
		}
		for (const group of await page.locator(".perplexity-saver-video-control-group, .perplexity-saver-transcript-control-group").all()) {
			if (!await group.isVisible()) continue;
			const tops = await group.locator(":scope > button").evaluateAll((buttons) => buttons.map((el) => el.getBoundingClientRect().top));
			if (tops.length) expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
		}
		await page.getByRole("button", { name: "Video keyboard help", exact: true }).click();
		await expect(page.getByRole("region", { name: "Video keyboard shortcuts" })).toBeVisible();
		expect((await page.getByRole("region", { name: "Video keyboard shortcuts" }).boundingBox())!.height).toBeGreaterThanOrEqual(60);
		await expect(page.locator(".perplexity-saver-video-help .perplexity-saver-hint-key").first()).toHaveText("Unassigned");
		expect(await page.locator("#video").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		expect(await page.locator("#video").evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
		await page.getByRole("button", { name: "Close video keyboard help" }).click();
	}
	await page.locator("#transcript select").selectOption("sentences");
	await expect(page.locator("#transcript .perplexity-saver-transcript-row")).toHaveCount(40);
	await page.locator("#transcript select").selectOption("readable-paragraphs");
	await expect(page.locator("#transcript .perplexity-saver-transcript-row")).toHaveCount(40);
	// REGRESSION GUARD: with Follow on, a format switch must show the playing sentence immediately, in real layout,
	// without waiting for the next playback update (no showPlayback call between the switch and the check).
	await page.getByRole("button", { name: "Follow video", exact: true }).click();
	await expect(page.getByRole("button", { name: "Follow video", exact: true })).toHaveAttribute("aria-pressed", "true");
	await page.evaluate(() => (globalThis as unknown as { transcriptView: { showPlayback(t: number, follow?: boolean, stateChanged?: boolean): void } }).transcriptView.showPlayback(130, true, false));
	const playingInView = () => page.locator("#transcript").evaluate((box) => {
		const playing = box.querySelectorAll(".perplexity-saver-transcript-row.is-playing");
		const header = box.querySelector(".perplexity-saver-transcript-header")!.getBoundingClientRect();
		const view = box.getBoundingClientRect();
		const row = playing[0]?.getBoundingClientRect();
		return { count: playing.length, inView: !!row && row.top >= header.bottom - 1 && row.bottom <= view.bottom + 1 };
	});
	for (const mode of ["sentences", "readable-paragraphs", "lines", "readable-paragraphs"]) {
		// Park the list at the top so the old "first row on screen" anchor would be far from the playing row.
		await page.locator("#transcript").evaluate((box) => { box.scrollTop = 0; });
		await page.locator("#transcript select").selectOption(mode);
		expect(await playingInView(), mode).toEqual({ count: 1, inView: true });
	}
	// REGRESSION GUARD: inserting a timestamp edits the note, which reloads and re-renders the transcript. The list must
	// not move at all: no jump to the top and no smooth scroll back to the playing row. Every scroll position seen during
	// the reload is recorded, so even a jump that ends back in place fails. The second case leaves the playing row
	// visible but at the bottom edge (as after reading on while following), where a "re-center if needed" scroll fires.
	const reloadScroll = (edge: boolean) => page.locator("#transcript").evaluate(async (box, edge) => {
		if (edge) {
			const playing = box.querySelector<HTMLElement>(".perplexity-saver-transcript-row.is-playing")!;
			box.scrollTop += playing.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom + 2;
		}
		// Start from a settled list, so a scroll left over from the previous step is not blamed on the reload.
		for (let last = -1; last !== box.scrollTop;) { last = box.scrollTop; await new Promise((resolve) => setTimeout(resolve, 300)); }
		const before = box.scrollTop;
		const seen: number[] = [];
		const record = () => seen.push(box.scrollTop);
		box.addEventListener("scroll", record);
		// Follow comes from the setting in real use, not from the Follow button's override. Without an override, a reload
		// that suppresses scrolling by passing follow=false to showPlayback would silently turn Follow off.
		const view = (globalThis as unknown as { transcriptView: { reload(): Promise<void>; followOverride: boolean | null } }).transcriptView;
		view.followOverride = null;
		await view.reload();
		seen.push(box.scrollTop);
		await new Promise((resolve) => setTimeout(resolve, 800));
		box.removeEventListener("scroll", record);
		const follow = box.querySelector('[aria-label="Follow video"]')?.getAttribute("aria-pressed");
		return { before, positions: [...new Set([...seen, box.scrollTop])], follow };
	}, edge);
	for (const edge of [false, true]) {
		const scroll = await reloadScroll(edge);
		expect(scroll.before, `edge=${edge}`).toBeGreaterThan(0);
		expect(scroll.positions, `edge=${edge}`).toEqual([scroll.before]);
		expect(scroll.follow, `edge=${edge}`).toBe("true");
		expect(await playingInView(), `edge=${edge}`).toEqual({ count: 1, inView: true });
	}
	// REGRESSION GUARD: clicking a sentence while following must select THAT sentence and must not move the rows.
	// The press pauses Follow, which shows "Show playing passage" in the sticky header; that used to push the list
	// down between press and release, so the release landed elsewhere and the click selected nothing. Real mouse
	// clicks, at the top of the list (no room to scroll up) and mid-list.
	const followButton = page.getByRole("button", { name: "Follow video", exact: true });
	for (const [atTop, rowIndex] of [[true, 3], [false, 18]] as const) {
		if (await followButton.getAttribute("aria-pressed") !== "true") await followButton.click();
		await expect(followButton).toHaveAttribute("aria-pressed", "true");
		await page.locator("#transcript").evaluate(async (box, [atTop, rowIndex]) => {
			const target = box.querySelectorAll<HTMLElement>(".perplexity-saver-transcript-row")[rowIndex];
			box.scrollTop = atTop ? 0 : box.scrollTop + target.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2;
			for (let last = -1; last !== box.scrollTop;) { last = box.scrollTop; await new Promise((resolve) => setTimeout(resolve, 300)); }
		}, [atTop, rowIndex] as const);
		const row = page.locator("#transcript .perplexity-saver-transcript-row").nth(rowIndex);
		// Paragraph rows are inline spans that wrap; click the middle of the first line box, which is inside the row.
		const before = await row.evaluate((el) => { const r = el.getClientRects()[0]; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
		expect(before.y, `row ${rowIndex} is on screen before the click`).toBeGreaterThan(0);
		await page.mouse.click(before.x, before.y);
		await expect(page.locator("#transcript .is-selected"), `row ${rowIndex} selected`).toHaveText(new RegExp(`^Sentence ${rowIndex} `));
		await expect(followButton).toHaveAttribute("aria-pressed", "false");
		expect(Math.abs(await row.evaluate((el) => el.getClientRects()[0].top + el.getClientRects()[0].height / 2) - before.y), `row ${rowIndex} stayed put`).toBeLessThanOrEqual(1);
	}
	// REGRESSION GUARD: with Follow paused (a sentence selected far from the playing one) the user owns the scroll
	// position. Inserting a timestamp (reload) and coming back with "cycle panes" (focusPlayback) must not scroll to the
	// playing row; focus returns to the selected row. Every scroll position during the round trip is recorded.
	const returnToPane = await page.locator("#transcript").evaluate(async (box) => {
		for (let last = -1; last !== box.scrollTop;) { last = box.scrollTop; await new Promise((resolve) => setTimeout(resolve, 300)); }
		const before = box.scrollTop;
		const seen: number[] = [];
		const record = () => seen.push(box.scrollTop);
		box.addEventListener("scroll", record);
		(box.ownerDocument.activeElement as HTMLElement | null)?.blur();
		const view = (globalThis as unknown as { transcriptView: { reload(): Promise<void>; focusPlayback(seconds: number, follow: boolean): void } }).transcriptView;
		await view.reload();
		view.focusPlayback(130, true);
		seen.push(box.scrollTop);
		await new Promise((resolve) => setTimeout(resolve, 800));
		box.removeEventListener("scroll", record);
		const active = box.ownerDocument.activeElement;
		return {
			before,
			positions: [...new Set([before, ...seen, box.scrollTop])],
			focusedSelected: !!active?.classList.contains("is-selected"),
			follow: box.querySelector('[aria-label="Follow video"]')?.getAttribute("aria-pressed"),
		};
	});
	expect(returnToPane).toEqual({ before: returnToPane.before, positions: [returnToPane.before], focusedSelected: true, follow: "false" });
	const close = page.locator(".perplexity-saver-transcript-close");
	await expect(close).toBeVisible();
	await page.locator("#transcript").evaluate(el => el.classList.add("show-pane-chrome"));
	await expect(close).toBeHidden();
	await page.locator("#transcript").evaluate(el => el.classList.remove("show-pane-chrome"));
	await page.locator(".workspace-tabs").evaluate(el => el.classList.add("mod-top"));
	await expect(close).toBeHidden();
});

test("readable paragraphs flow inline, retain sentence controls and hide empty filtered paragraphs", async ({ page }) => {
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			body { margin: 0; font: 14px/20px sans-serif; }
			:root { --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px; --font-ui-smaller: 12px; --line-height-normal: 1.5; }
			.view-content { padding: 12px; width: 700px; }
		</style>
		<div class="view-content perplexity-saver-transcript-view">
			<div class="perplexity-saver-transcript-list is-readable-paragraphs" role="listbox">
				<div class="perplexity-saver-transcript-paragraph" role="group">
					<span class="perplexity-saver-transcript-row" tabindex="0" role="option"><span class="perplexity-saver-transcript-text">Orchard apples are ready.</span></span>
					<span class="perplexity-saver-transcript-row" tabindex="-1" role="option"><span class="perplexity-saver-transcript-text">Farmers pick ripe fruit.</span></span>
				</div>
				<div class="perplexity-saver-transcript-paragraph" role="group">
					<span class="perplexity-saver-transcript-row" tabindex="-1" role="option"><span class="perplexity-saver-transcript-text">Bond prices respond to interest rates.</span></span>
					<span class="perplexity-saver-transcript-row is-match" tabindex="-1" role="option"><span class="perplexity-saver-transcript-text">Markets adjust their expectations.</span></span>
				</div>
			</div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	const text = page.locator(".perplexity-saver-transcript-text");
	const first = await text.nth(0).boundingBox();
	const second = await text.nth(1).boundingBox();
	expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
	const paragraphs = page.locator(".perplexity-saver-transcript-paragraph");
	const a = await paragraphs.nth(0).boundingBox();
	const b = await paragraphs.nth(1).boundingBox();
	expect(b!.y - (a!.y + a!.height)).toBeGreaterThanOrEqual(8);
	for (const width of [240, 320, 700]) {
		await page.locator(".view-content").evaluate((el, width) => { (el as HTMLElement).style.width = width + "px"; }, width);
		expect(await page.locator(".view-content").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
	}
	await page.getByRole("option").nth(1).focus();
	await expect(page.getByRole("option").nth(1)).toBeFocused();
	await page.locator(".perplexity-saver-transcript-list").evaluate((el) => el.classList.add("is-filtered"));
	await expect(paragraphs.nth(0)).toBeHidden();
	await expect(page.locator(".perplexity-saver-transcript-row").nth(2)).toBeHidden();
	await expect(page.locator(".perplexity-saver-transcript-row").nth(3)).toBeVisible();
});

test("reading controls fit narrow transcript panes without experimental controls", async ({ page }) => {
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			body { margin: 0; font: 14px/20px sans-serif; }
			:root { --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px; --font-ui-smaller: 12px; }
			.view-content { padding: 12px; width: 700px; height: 400px; overflow: auto; }
			.clickable-icon { width: 28px; height: 28px; }
		</style>
		<div class="view-content perplexity-saver-transcript-view">
			<div class="perplexity-saver-transcript-header">
				<div class="perplexity-saver-transcript-controls">
					<a class="perplexity-saver-transcript-title">A long literature note title</a>
					<span class="perplexity-saver-transcript-count">1234 sentences</span>
					<select class="perplexity-saver-transcript-segmentation" aria-label="Transcript segmentation">
						<option>Paragraphs</option><option>Sentences</option><option>Captions</option>
					</select>
					<button class="clickable-icon" aria-label="Search transcript">S</button>
					<button class="clickable-icon" aria-label="Show pane tabs">T</button>
					<button class="clickable-icon" aria-label="Transcript placement">L</button>
					<button class="clickable-icon" aria-label="More transcript options">M</button>
				</div>
			</div>
			<div class="perplexity-saver-transcript-list"><div class="perplexity-saver-transcript-row">A sentence.</div></div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	const panel = page.locator(".view-content");
	for (const width of [240, 320, 700]) {
		await panel.evaluate((el, value) => { (el as HTMLElement).style.width = value + "px"; }, width);
		expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		await expect(page.getByRole("combobox")).toBeVisible();
		await expect(page.getByRole("button", { name: "More transcript options" })).toBeVisible();
		expect(await page.locator(".perplexity-saver-transcript-row").evaluate((el) => el.getBoundingClientRect().top))
			.toBeLessThan(350);
	}
});

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
					<select class="perplexity-saver-transcript-segmentation" aria-label="Transcript segmentation">
						<option>Paragraphs</option><option>Sentences</option><option>Captions</option>
					</select>
					<button class="clickable-icon" aria-label="Search">S</button>
					<button class="clickable-icon" aria-label="Show pane tabs and navigation">T</button>
					<button class="clickable-icon" aria-label="Move transcript beside video">O</button>
					<button class="clickable-icon" aria-label="More transcript options">M</button>
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

test("transcript-only playback controls remain reachable in narrow panes", async ({ page }) => {
	await page.setContent(`
		<style>
			* { box-sizing: border-box; }
			body { margin: 0; font: 14px/20px sans-serif; }
			:root { --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px; --font-ui-smaller: 12px; }
			.view-content { padding: 12px; width: 700px; height: 240px; overflow: auto; }
			.clickable-icon { flex: none; width: 28px; height: 28px; padding: 0; }
			.perplexity-saver-transcript-row { min-height: 40px; }
		</style>
		<div class="view-content perplexity-saver-transcript-view">
			<div class="perplexity-saver-transcript-header">
				<div class="perplexity-saver-transcript-controls">
					<a class="perplexity-saver-transcript-title">A long literature note title</a>
					<span class="perplexity-saver-transcript-count">381 lines</span>
					<select class="perplexity-saver-transcript-segmentation" aria-label="Transcript segmentation">
						<option>Paragraphs</option><option>Sentences</option><option>Captions</option>
					</select>
					<button class="clickable-icon">S</button><button class="clickable-icon">T</button><button class="clickable-icon">O</button>
					<div class="perplexity-saver-transcript-playback">
						<button class="clickable-icon" aria-label="Previous sentence">B</button>
						<button class="clickable-icon" aria-label="Play">P</button>
						<button class="clickable-icon" aria-label="Next sentence">N</button>
						<button class="clickable-icon" aria-label="Insert current timestamp">I</button>
					</div>
					<button class="clickable-icon">M</button><button class="clickable-icon">X</button>
				</div>
			</div>
			<div class="perplexity-saver-transcript-list"><div class="perplexity-saver-transcript-row">Transcript text</div></div>
		</div>
	`);
	await page.addStyleTag({ path: path.resolve("styles.css") });
	const panel = page.locator(".view-content");
	const playback = page.locator(".perplexity-saver-transcript-playback");
	for (const width of [240, 320, 700]) {
		await panel.evaluate((el, value) => { (el as HTMLElement).style.width = value + "px"; }, width);
		expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		for (const button of await playback.locator("button").all()) await expect(button).toBeVisible();
		const bar = await playback.boundingBox();
		const row = await page.locator(".perplexity-saver-transcript-row").boundingBox();
		expect(bar!.y + bar!.height).toBeLessThanOrEqual(row!.y);
		if (width === 700) {
			const header = await page.locator(".perplexity-saver-transcript-header").boundingBox();
			expect(header!.height).toBeLessThanOrEqual(48);
		}
	}
	await playback.evaluate((el) => { (el as HTMLElement).hidden = true; });
	await expect(playback).toBeHidden();
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
