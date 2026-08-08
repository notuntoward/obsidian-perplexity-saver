import { describe, it, expect } from "vitest";
import { parsePerplexityDialog, isPerplexityContent } from "../../src/parsers/perplexity";

describe("isPerplexityContent", () => {
	it("detects the [Perplexity](perplexity.ai/...) metadata line", () => {
		const text = "[Perplexity](https://www.perplexity.ai/search/abc) · *2026-07-25 00:00 PDT*";
		expect(isPerplexityContent(text)).toBe(true);
	});

	it("detects the # Citations: block", () => {
		expect(isPerplexityContent("some text\n# Citations:\n[1] ...")).toBe(true);
	});

	it("rejects gemini content", () => {
		expect(isPerplexityContent("[Gemini](https://gemini.google.com/app/x) hello")).toBe(false);
	});
});

describe("parsePerplexityDialog — Save My Chatbot format", () => {
	it("parses a multi-turn SMC export with **You** / **AI answer** markers", () => {
		const raw = `**You**

Where is a good place to ask questions about Obsidian plugin programming? My specific question is how to embed a file completion interface in my plugin?

**AI answer**

For Obsidian plugin development questions like this, the best communities are the official Obsidian developer forum and the developer Discord.[1][2]

Obsidian's public API includes a class called \`AbstractInputSuggest\` specifically designed to add autocomplete suggestions to any text input element, including ones inside a modal.[3]

**You**

The other thing I want to do is use Emacs cursor movement keys inside the suggestion.

**AI answer**

Since your file-completion box is a plain HTML \`<input>\` element, none of the existing Emacs plugins for Obsidian will help — you'll need to implement the bindings yourself with a manual keydown handler.[4]`;

		const dialog = parsePerplexityDialog(raw);
		expect(dialog.sourceVendor).toBe("perplexity");
		expect(dialog.turns).toHaveLength(4);
		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText).toContain("Where is a good place");
		expect(dialog.turns[1].role).toBe("ai");
		expect(dialog.turns[1].rawText).toContain("best communities");
		// Citations [1][2][3] are present but no source list, so citations array is empty.
		expect(dialog.turns[1].citations).toHaveLength(0);
		expect(dialog.turns[2].role).toBe("prompt");
		expect(dialog.turns[3].role).toBe("ai");
	});
});

describe("parsePerplexityDialog — stock Perplexity format", () => {
	function pdfPlusPlusClipboard(): string {
		return `[Perplexity](https://www.perplexity.ai/search/7ad6ca5d-cf6a-4a3f-8833-9852ecd7bc0e) · *2026-07-27 10:18 PDT*
# IN the obsidian pdf++ plugin, by default, when I do highlights, I must highlight with my mouse and the press a highlight color every time.  This is two click tedium.  Can it be configured to act like a standard pdf annotator, where you click on the highlight color once, and then do a highlight for every selection without the extra click?  
  
PDF++ can actually be configured to skip that extra click, but it requires a specific settings combination rather than a single toggle labeled "modal highlighting."

## How to Set It Up

In the PDF++ plugin settings, look for the "Selection" or "Toolbar" section and enable the option often labeled **"Highlight color palette in the selection popup"** together with **"Set a default highlight color"** — once a default color is defined, PDF++ can trigger a highlight action automatically on text selection without waiting for a manual color click, effectively mimicking single-click annotator behavior. The core mechanism people use is: go to PDF++ settings → set your preferred color as the default under the "Colors" section, then enable "Copy commands" or the built-in "Auto-highlight" behavior tied to a hotkey, so each text selection immediately applies that default color instead of popping up a picker every time. Users on Reddit confirmed that the highlight color logic is tied into settings that aren't always obvious — for instance, one user found their highlight color was actually being controlled by Obsidian's global Vault Accent Color rather than a PDF++-specific setting, which can cause confusion if you're trying to fix the color first.[1][2]

## The Known Limitation

There isn't currently a true "modal highlight mode" (click once, then drag-select repeatedly with automatic coloring, click again to exit) built into PDF++ by default — that exact behavior has been explicitly requested as a feature by users but is more thoroughly discussed for other Obsidian plugins like obsidian-editing-toolbar rather than natively solved in PDF++. The workaround most PDF++ users rely on is binding a **hotkey to "highlight with default color"** (found in Obsidian's Hotkeys settings, searchable as "PDF++ highlight selection") and simply selecting text then pressing that hotkey — this cuts it down to one keypress instead of a second mouse click, though it's not literally "click once and everything after auto-highlights".[3][4]

## Practical Setup Steps

- Open Settings → Community plugins → PDF++ → find the "Highlight" or "Colors" section and set a default highlight color[1]
- Go to Settings → Hotkeys, search "PDF++," and assign a keyboard shortcut to the "Copy link to selection with format" or "Highlight selection" command tied to your default color[4]
- Select text in the PDF and use the hotkey instead of clicking a color swatch each time — this removes the second click but keeps a keypress step[4]
- If your highlight color looks wrong or unexpected, check Obsidian's Appearance settings for "Accent color," since it can override PDF++'s highlight display in some versions[1]

If you want the closest thing to true "one-click-then-drag-repeatedly" annotator behavior, some users instead pair PDF++ with the **obsidian-editing-toolbar** plugin, which supports genuine modal highlighting (click a color once, then every subsequent text selection is highlighted until you toggle it off) — though that plugin's modal highlighting was designed for markdown notes, not PDFs, so compatibility with PDF++ specifically isn't guaranteed.[3]  
  
# Citations:  
[1] [Help with PDF++ and text selection highlighting. : r/ObsidianMD](https://www.reddit.com/r/ObsidianMD/comments/1qbtlip/help_with_pdf_and_text_selection_highlighting/)
[2] [PDF++ – Obsidian Plugin](https://www.obsidianstats.com/plugins/pdf-plus)
[3] [Modal highlighting, as in most pdf readers · Issue #118 · PKM-er/obsidian-editing-toolbar](https://github.com/PKM-er/obsidian-editing-toolbar/issues/118)
[4] [PDF highlighting - misunderstanding - Help - Obsidian Forum](https://forum.obsidian.md/t/pdf-highlighting-misunderstanding/109772)
[5] [Mobile experience · Issue #217 · RyotaUshio/obsidian-pdf-plus](https://github.com/RyotaUshio/obsidian-pdf-plus/issues/217)
[6] [PDF++: The Best PDF Plugin For Obsidian](https://www.youtube.com/watch?v=4dU6WXULSqg)
[7] [Highlighting / annotation of PDFs as a core feature of Obsidian (annotate)](https://forum.obsidian.md/t/highlighting-annotation-of-pdfs-as-a-core-feature-of-obsidian-annotate/31015)
[8] [PDF++ howto - Help](https://forum.obsidian.md/t/pdf-howto/108401)
[9] [How to Video - PDF++ and Obsidian for PDF highlights on iPads : r ...](https://www.reddit.com/r/ObsidianMD/comments/1kcu4i5/how_to_video_pdf_and_obsidian_for_pdf_highlights/)
[10] [Feature Walkthrough: Import and Annotate PDF documents (Obsidian ...](https://www.youtube.com/watch?v=nB4cOfn0xAs)
[11] [[FR] Hightlight content without copy text · Issue #16 · RyotaUshio/obsidian-pdf-plus](https://github.com/RyotaUshio/obsidian-pdf-plus/issues/16)
[12] [Obsidian and PDF++: what deep PDF integration with Markdown can look ...](https://discourse.devontechnologies.com/t/obsidian-and-pdf-what-deep-pdf-integration-with-markdown-can-look-like/78921)
[13] [NEW PDF highlight options](https://www.youtube.com/watch?v=czE6wq89o-g)
[14] [PDF++ highlight w/ 'display text' & 'link copy' format preset](https://www.reddit.com/r/ObsidianMD/comments/1qn30hj/pdf_highlight_w_display_text_link_copy_format/)
[15] [Working with PDFs in Obsidian: PDF++ Plugin and Full-Text Search](https://effortlessacademic.com/working-with-pdfs-in-obsidian-pdf-plugin-and-full-text-search/)
---  


# <q>In the PDF++ plugin settings, look for the "Selection" or "Toolbar" section and enable the option often labeled "Highlight color palette in the selection popup" together with "Set a default highlight color"</q> don't guess.  Find the specific settings on the current version.  Look it up.  
  
Yes — this is documented as an actual feature in PDF++, not something you need to guess at. It's called the **"select text to copy" mode**, toggled from a ribbon icon.[1]

## The Exact Feature

PDF++'s GitHub documentation describes a command called **"Toggle 'select text to copy' mode"**, accessible as an icon in Obsidian's left ribbon menu. While this mode is active, the plugin automatically triggers the "Copy link to selection or annotation" action (which applies your currently active color) every time you select a range of text in the PDF viewer — you don't need to click a color swatch or press a hotkey after each selection. This is the closest built-in equivalent to a standard PDF annotator's "click once, then highlight repeatedly" workflow.[1]

## How to Enable It

- Open the PDF++ settings and locate the **"Color palette in the toolbar"** setting — this adds a row of color swatches to the top of your PDF viewer[1]
- Click a color swatch once to set it as the active color for the "Copy link to selection" action[1]
- Click the **"Toggle 'select text to copy' mode"** icon in the left ribbon (it looks like a text-selection/copy icon) to turn the mode on[1]
- With the mode active, every text selection you make in the PDF automatically triggers the copy-and-highlight action using the currently active color — no second click needed[1]
- Click the ribbon icon again to turn the mode off when you're done highlighting[1]

## Related Settings Worth Knowing

- **Default highlight color**: a dedicated setting that lets you specify one color as the default so any \`&color=...\`-free link/highlight uses it automatically, and this value is also exposed as the CSS variable \`--pdf-plus-default-color-rgb\`[1]
- **Custom color palette actions**: lets you customize exactly what command each palette color triggers when clicked during a selection, which pairs well with select-to-copy mode[1]
- **Copy link to selection or annotation command**: bindable to a hotkey (\`Ctrl+Shift+C\` recommended by the author) if you'd rather trigger it manually per-selection instead of using the always-on ribbon toggle[1]

Note that PDF++ documentation explicitly states these commands (including the auto-copy-on-select behavior) **cannot be triggered from the Command Palette** — you must either use the ribbon icon toggle or assign a custom hotkey in Obsidian's Hotkeys settings. This confirms the "one click to enter mode, then repeated selections auto-highlight" behavior is a real, supported PDF++ feature, not a workaround via a separate plugin.[1]  
  
# Citations:  
[1] [RyotaUshio/obsidian-pdf-plus: PDF++: the most ...](https://github.com/RyotaUshio/obsidian-pdf-plus)
[2] [Help with PDF++ and text selection highlighting.](https://www.reddit.com/r/ObsidianMD/comments/1qbtlip/help_with_pdf_and_text_selection_highlighting/)
[3] [Assistance with PDF Highlighting/Backlink Workflow - Help](https://forum.obsidian.md/t/assistance-with-pdf-highlighting-backlink-workflow/82434)
[4] [Is there a PDF Highlighter that doesn't need to create ...](https://www.reddit.com/r/ObsidianMD/comments/1rnbwx4/is-there-a-pdf_highlighter-that-doesnt-need_to/)
[5] [PDF ++ plugin - Highlight extraction customization - Help](https://forum.obsidian.md/t/pdf-plugin-highlight-extraction-customization/81979)
[6] [Persistent highlight sets - RelativityOne](https://help.relativity.com/RelativityOne/Content/Relativity/Persistent_highlight_sets/Persistent_highlight_sets.htm)
[7] [PDF++: The Best PDF Plugin For Obsidian](https://www.youtube.com/watch?v=4dU6WXULSqg)
[8] [what deep PDF integration with Markdown can look like](https://discourse.devontechnologies.com/t/obsidian-and-pdf-what-deep-pdf-integration-with-markdown-can-look-like/78921)
[9] [Highlight colours + obsidian plugin highlightr #152](https://github.com/stefanopagliari/bibnotes/issues/152)
[10] [Working with PDFs in Obsidian: PDF++ Plugin and Full- ...](https://effortlessacademic.com/working-with-pdfs-in-obsidian-pdf-plugin-and-full-text-search/)
[11] [NEW PDF highlight options](https://www.youtube.com/watch?v=czE6wq89o-g)
[12] [https://helpej2.syncfusion.com/angular/documentati...](https://helpej2.syncfusion.com/angular/documentation/api/pdfviewer/highlightSettings/)
---  `;
	}

	function assertPdfPlusPlusParsedCorrectly(dialog: ReturnType<typeof parsePerplexityDialog>): void {
		expect(dialog.sourceVendor).toBe("perplexity");
		expect(dialog.turns).toHaveLength(4);

		// First prompt is the user's initial question.
		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText).toContain("IN the obsidian pdf++ plugin");

		// First AI response starts at "PDF++ can actually..." and excludes # Citations:.
		expect(dialog.turns[1].role).toBe("ai");
		expect(dialog.turns[1].rawText).toContain("PDF++ can actually be configured");
		expect(dialog.turns[1].rawText).toContain("## How to Set It Up");
		expect(dialog.turns[1].rawText).not.toContain("# Citations:");
		// Only the four citation numbers actually referenced in the response are kept.
		expect(dialog.turns[1].citations).toHaveLength(4);
		expect(dialog.turns[1].citations[3].url).toBe(
			"https://forum.obsidian.md/t/pdf-highlighting-misunderstanding/109772"
		);

		// Second prompt is the follow-up quoted question. The <q>...</q> excerpt
		// quoting the prior AI answer is pulled out as a markdown blockquote
		// placed above the rest of the (non-quoted) prompt text. Note: the
		// prompt's own leading "# " heading marker is stripped later, by the
		// renderer (turns.ts stripHeadingMarkers), not by the parser -- so it
		// is still present here on the non-quoted remainder.
		expect(dialog.turns[2].role).toBe("prompt");
		expect(dialog.turns[2].rawText).toContain("don't guess");
		expect(dialog.turns[2].rawText).toMatch(
			/^> In the PDF\+\+ plugin settings, look for the "Selection" or "Toolbar" section and enable the option often labeled "Highlight color palette in the selection popup" together with "Set a default highlight color"\n\n#? ?don't guess/
		);
		expect(dialog.turns[2].rawText).not.toContain("<q>");
		expect(dialog.turns[2].rawText).not.toContain("</q>");

		// Second AI response has its own distinct citation, correctly attributed
		// to turn 4 (not swallowed into turn 2's source list, and not overwritten
		// by turn 1's citation numbering).
		expect(dialog.turns[3].role).toBe("ai");
		expect(dialog.turns[3].rawText).toContain("Yes — this is documented");
		expect(dialog.turns[3].citations).toHaveLength(1);
		expect(dialog.turns[3].citations[0].url).toBe("https://github.com/RyotaUshio/obsidian-pdf-plus");
	}

	it("parses the user's PDF++ test clipboard (LF line endings)", () => {
		const dialog = parsePerplexityDialog(pdfPlusPlusClipboard());
		assertPdfPlusPlusParsedCorrectly(dialog);
	});

	it("parses the same clipboard correctly when line endings are CRLF", () => {
		// Real clipboard content from Windows browsers is frequently CRLF. A
		// naive "\n"-only splitter would collapse both prompt/response pairs
		// into a single section, scrambling turn count, citation numbering,
		// and source attribution across pairs.
		const crlfClipboard = pdfPlusPlusClipboard().replace(/\n/g, "\r\n");
		const dialog = parsePerplexityDialog(crlfClipboard);
		assertPdfPlusPlusParsedCorrectly(dialog);
	});

	it("parses a stock export with a centered-divider and source list", () => {
		const raw = `For Obsidian plugin development questions, the best communities are the official forum[1] and Discord[2].

Obsidian's API includes \`AbstractInputSuggest\` for autocomplete.[3]

<div style="text-align: center">Sources</div>

[1] [Obsidian Forum](https://forum.obsidian.md/)
[2] [Obsidian Discord](https://discord.gg/obsidianmd)
[3] [AbstractInputSuggest](https://docs.obsidian.md/Reference/TypeScript+API/AbstractInputSuggest)`;

		const dialog = parsePerplexityDialog(raw);
		expect(dialog.sourceVendor).toBe("perplexity");
		// Stock format: no explicit prompt, so only an AI turn.
		expect(dialog.turns).toHaveLength(1);
		expect(dialog.turns[0].role).toBe("ai");
		expect(dialog.turns[0].rawText).toContain("best communities");
		expect(dialog.turns[0].citations).toHaveLength(3);
		expect(dialog.turns[0].citations[0]).toEqual({
			origNum: "1",
			url: "https://forum.obsidian.md/",
			title: "Obsidian Forum",
		});
		expect(dialog.turns[0].citations[1].url).toBe("https://discord.gg/obsidianmd");
		expect(dialog.turns[0].citations[2].title).toBe("AbstractInputSuggest");
	});

	it("handles a stock export with no source list (citations unresolved)", () => {
		const raw = `Some response text[1] and more[2].`;
		const dialog = parsePerplexityDialog(raw);
		expect(dialog.turns).toHaveLength(1);
		expect(dialog.turns[0].citations).toHaveLength(0);
	});

	it("extracts citations from # Citations: block even if response body has no inline bracket references", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/123) · *2026-07-31*
# Question?

Response without inline bracket numbers.

# Citations:  
[1] [Source One](https://example.com/1)  
[2] [Source Two](https://example.com/2)`;
		const dialog = parsePerplexityDialog(raw);
		expect(dialog.turns[1].citations).toHaveLength(2);
		expect(dialog.turns[1].citations[0]).toEqual({
			origNum: "1",
			url: "https://example.com/1",
			title: "Source One",
		});
		expect(dialog.turns[1].citations[1]).toEqual({
			origNum: "2",
			url: "https://example.com/2",
			title: "Source Two",
		});
	});

	it("handles bulleted, numbered list, or colon-formatted source lines under ## Sources:", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/123) · *2026-07-31*
# Question?

Response text with citations[1] and [2].

## Sources:
- 1. [Source One](https://example.com/1)
* [2]: https://example.com/2 "Anchor"`;
		const dialog = parsePerplexityDialog(raw);
		expect(dialog.turns[1].citations).toHaveLength(2);
		expect(dialog.turns[1].citations[0]).toEqual({
			origNum: "1",
			url: "https://example.com/1",
			title: "Source One",
		});
		expect(dialog.turns[1].citations[1]).toEqual({
			origNum: "2",
			url: "https://example.com/2",
			title: undefined,
		});
	});
});

describe("parsePerplexityDialog — sourceUrl extraction", () => {
	it("extracts the URL from the metadata line of a stock export", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/7ad6ca5d-cf6a-4a3f-8833-9852ecd7bc0e) · *2026-07-27 10:18 PDT*
# How do I foo?

Yes, you can.[1]

# Citations:
[1] [One](https://one.com/)`;
		const dialog = parsePerplexityDialog(raw);
		expect(dialog.sourceUrl).toBe(
			"https://www.perplexity.ai/search/7ad6ca5d-cf6a-4a3f-8833-9852ecd7bc0e"
		);
	});

	it("leaves sourceUrl undefined when the metadata line is missing", () => {
		const dialog = parsePerplexityDialog("Just some text with [1] inline.\n[1] [A](https://a.com/)");
		expect(dialog.sourceUrl).toBeUndefined();
	});

	it("accepts perplexity.ai without the www. prefix", () => {
		const dialog = parsePerplexityDialog(
			"[Perplexity](https://perplexity.ai/search/x) · *2026-07-27 10:18 PDT*\n\nbody"
		);
		expect(dialog.sourceUrl).toBe("https://perplexity.ai/search/x");
	});
});

describe("parsePerplexityDialog — question-only export (no AI response text)", () => {
	it("treats a # question heading as the prompt when no response text follows", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/6eeee0a8) · *2026-08-02 15:15 PDT*
# Tell me about google jules.  What does it do?  
  
  
  
# Citations:  
[1] [Source One](https://example.com/1)
[2] [Source Two](https://example.com/2)
---  
# Is there an extension for it in vscode?  
  
  
  
# Citations:  
[1] [Source Three](https://example.com/3)`;

		const dialog = parsePerplexityDialog(raw);
		expect(dialog.sourceVendor).toBe("perplexity");
		expect(dialog.sourceUrl).toBe("https://www.perplexity.ai/search/6eeee0a8");
		expect(dialog.turns).toHaveLength(2);

		// First section: question heading is the prompt, no AI response.
		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText).toContain("Tell me about google jules");
		expect(dialog.turns[0].citations).toHaveLength(0);

		// Second section: same pattern.
		expect(dialog.turns[1].role).toBe("prompt");
		expect(dialog.turns[1].rawText).toContain("Is there an extension for it in vscode");
	});

	it("unwraps fenced code blocks surrounding prompts correctly", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/x) · *2026-08-07 19:44 PDT*

# Question 1

AI response 1.

---

\`\`\`
# <q>Quote here</q> My follow up question
\`\`\`

AI response 2.`;
		const dialog = parsePerplexityDialog(raw);
		expect(dialog.turns).toHaveLength(4);
		expect(dialog.turns[2].role).toBe("prompt");
		expect(dialog.turns[2].rawText).toMatch(/^> Quote here\n\n# My follow up question/);
	});
});

describe("parsePerplexityDialog — annotated format", () => {
	it("parses the annotated format correctly with PPLX-TURN and PPLX-ROLE tags", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/d32a8935-7c70-4902-b3d8-64e2b7d0fcc9) · *2026-08-03 20:35 PDT*

---

<!-- PPLX-TURN 1 -->
<!-- PPLX-ROLE: prompt -->
Compare population size and land area of the PNW states

<!-- PPLX-ROLE: ai -->
Here’s a quick comparison of the main PNW states often used in the core Pacific Northwest definition: Washington, Oregon, and Idaho.[1][2]

<!-- PPLX-ROLE: sources -->
[^1_1]: https://ofm.wa.gov/data-research/washington-trends/population-changes/
[^1_2]: https://www.census.gov/quickfacts/fact/table/WA/PST045225`;

		const dialog = parsePerplexityDialog(raw);
		expect(dialog.sourceVendor).toBe("perplexity");
		expect(dialog.sourceUrl).toBe("https://www.perplexity.ai/search/d32a8935-7c70-4902-b3d8-64e2b7d0fcc9");
		expect(dialog.turns).toHaveLength(2);

		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText).toBe("Compare population size and land area of the PNW states");

		expect(dialog.turns[1].role).toBe("ai");
		expect(dialog.turns[1].rawText).toBe("Here’s a quick comparison of the main PNW states often used in the core Pacific Northwest definition: Washington, Oregon, and Idaho.[1][2]");
		expect(dialog.turns[1].citations).toHaveLength(2);
		expect(dialog.turns[1].citations[0]).toEqual({
			origNum: "1",
			url: "https://ofm.wa.gov/data-research/washington-trends/population-changes/",
			title: undefined,
		});
		expect(dialog.turns[1].citations[1].url).toBe("https://www.census.gov/quickfacts/fact/table/WA/PST045225");
	});

	it("unwraps fenced code blocks surrounding prompts in annotated format correctly", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/x) · *2026-08-07 19:44 PDT*

---

<!-- PPLX-TURN 1 -->
<!-- PPLX-ROLE: prompt -->
\`\`\`
# <q>Quote here</q> My follow up question
\`\`\`

<!-- PPLX-ROLE: ai -->
AI response 2.

<!-- PPLX-ROLE: sources -->
(none)`;
		const dialog = parsePerplexityDialog(raw);
		expect(dialog.turns).toHaveLength(2);
		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText).toMatch(/^> Quote here\n\n# My follow up question/);
	});

	it("unwraps fenced code blocks with quotes and user text correctly (Tax Foundation case)", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/tax) · *2026-08-08*
# Hello

AI response 1.

---

\`\`\`
# <q>The Tax Foundation's most recent tax burden study (2022) puts Idaho at 10.7% of income (ranked 29th) and Washington at 10.7% (ranked 30th)</q> Find an up to date comparison
\`\`\`

The Tax Foundation hasn't published a newer "tax burden" estimate since the 2022 calendar-year study — that 10.7%/10.7% figure I cited earlier is still their most current one of that specific type. But two other up-to-date data points give a clearer 2026 picture, and they both point the same direction: toward Idaho having a real, not marginal, advantage.`;

		const dialog = parsePerplexityDialog(raw);
		expect(dialog.turns).toHaveLength(4);
		expect(dialog.turns[2].role).toBe("prompt");
		expect(dialog.turns[2].rawText).toContain("> The Tax Foundation's most recent tax burden study (2022)");
		expect(dialog.turns[2].rawText).toContain("# Find an up to date comparison");
		expect(dialog.turns[2].rawText).not.toContain("```");
	});
});
