import { describe, it, expect } from "vitest";
import { parseGeminiDialog, isGeminiContent } from "../../src/parsers/gemini";

describe("isGeminiContent", () => {
	it("detects the [Gemini](gemini.google.com/...) metadata line", () => {
		const text = "[Gemini](https://gemini.google.com/app/abc) 2026-07-24 23:57:41 (-07:00)";
		expect(isGeminiContent(text)).toBe(true);
	});

	it("rejects perplexity content", () => {
		expect(isGeminiContent("[Perplexity](https://www.perplexity.ai/search/x) hello")).toBe(false);
	});
});

describe("parseGeminiDialog", () => {
	it("parses the sample two-turn gemini dialog from the reference doc", () => {
		const raw = `# New chat

[Gemini](https://gemini.google.com/app/9b436e72b8d6ecaa) 2026-07-24 23:57:41 (-07:00)

**You**

I have found the tools in the attached code to be useful for unifying zotero, perplexity and obsidian but they are clunky to use. I am considering creating an obsidian plugin which implements the same functionality all in one interface: perplexity and zotero would feed into it. Suggest a first step in the plugin development that would provide real usefulness, and also be extendable for fuller implementation of these ideas.

---

**Gemini**

Moving your Python logic into a native Obsidian plugin is a fantastic idea. The current workflow is clunky because it forces a context switch.

## The First Step

The most impactful, friction-reducing first step is to build an **Active Note "Paste & Relink" Command**.

---

**You**

In zotero, I use the better bibtex plugin. Would that be superior to reusing the python zotero dump?

---

**Gemini**

Yes, relying on the **Better BibTeX (BBT)** plugin is definitively superior.`;

		const dialog = parseGeminiDialog(raw);
		expect(dialog.sourceVendor).toBe("gemini");
		expect(dialog.turns).toHaveLength(4);
		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText.startsWith("I have found the tools")).toBe(true);
		expect(dialog.turns[1].role).toBe("ai");
		expect(dialog.turns[1].rawText.startsWith("Moving your Python logic")).toBe(true);
		// The AI turn contains an embedded heading that should be preserved verbatim
		// in rawText (the renderer is responsible for demoting it).
		expect(dialog.turns[1].rawText).toContain("## The First Step");
		expect(dialog.turns[2].role).toBe("prompt");
		expect(dialog.turns[3].role).toBe("ai");
		expect(dialog.turns[3].rawText.startsWith("Yes, relying on the")).toBe(true);
	});

	it("returns zero turns for content with no speaker markers", () => {
		const dialog = parseGeminiDialog("Some random text\n\n# Not a gemini dialog\n\nMore text");
		expect(dialog.turns).toHaveLength(0);
	});

	it("extracts inline markdown links as citations on AI turns", () => {
		const raw = `**You**

question?

---

**Gemini**

See [Obsidian Forum](https://forum.obsidian.md/) and [Discord](https://discord.gg/obsidianmd).`;
		const dialog = parseGeminiDialog(raw);
		expect(dialog.turns).toHaveLength(2);
		expect(dialog.turns[1].citations).toHaveLength(2);
		expect(dialog.turns[1].citations[0]).toEqual({
			origNum: "1",
			url: "https://forum.obsidian.md/",
			title: "Obsidian Forum",
		});
		expect(dialog.turns[1].citations[1]).toEqual({
			origNum: "2",
			url: "https://discord.gg/obsidianmd",
			title: "Discord",
		});
	});

	it("parses Gemini's native 'Copy' format with 'You said' / '## Gemini said' markers", () => {
		const raw = `# \u200eGoogle Gemini

[Gemini](https://gemini.google.com/app) 2026-07-27 16:02:05 (-07:00)

## Conversation with Gemini

You said

What's so base about baseball? Give references with URLs

## Gemini said

What makes baseball so "base" comes down to etymology.

### References & Sources

- **Etymonline:** *Baseball - Etymology*
	[https://www.etymonline.com/word/baseball](https://www.etymonline.com/word/baseball)

You said

Why don't European football players wear shoulder pads?

## Gemini said

Short answer: it comes down to how the game is played.

### You've reached your Thinking model limit

Responses will use other models until it resets.

Gemini is AI and can make mistakes.`;

		const dialog = parseGeminiDialog(raw);
		expect(dialog.sourceVendor).toBe("gemini");
		expect(dialog.turns).toHaveLength(4);

		// First prompt: preamble (title, metadata, conversation heading) is skipped.
		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText).toBe("What's so base about baseball? Give references with URLs");

		// First AI response: the "### References & Sources" section is extracted
		// into citations and removed from the rendered body.
		expect(dialog.turns[1].role).toBe("ai");
		expect(dialog.turns[1].rawText).toContain("What makes baseball so");
		expect(dialog.turns[1].rawText).not.toContain("References & Sources");
		expect(dialog.turns[1].citations).toHaveLength(1);
		expect(dialog.turns[1].citations[0].url).toBe("https://www.etymonline.com/word/baseball");
		expect(dialog.turns[1].citations[0].title).toBe("Etymonline: Baseball - Etymology");

		// Second prompt.
		expect(dialog.turns[2].role).toBe("prompt");
		expect(dialog.turns[2].rawText).toBe("Why don't European football players wear shoulder pads?");

		// Second AI response: trailing rate-limit notice and "Gemini is AI..."
		// disclaimer are stripped, not treated as content.
		expect(dialog.turns[3].role).toBe("ai");
		expect(dialog.turns[3].rawText).toContain("Short answer");
		expect(dialog.turns[3].rawText).not.toContain("Thinking model limit");
		expect(dialog.turns[3].rawText).not.toContain("Gemini is AI and can make mistakes");
		expect(dialog.turns[3].citations).toHaveLength(0);
	});

	it("isGeminiContent detects the native format (no bold markers)", () => {
		const text = `[Gemini](https://gemini.google.com/app) 2026-07-27 16:02:05 (-07:00)

You said

hello

## Gemini said

world`;
		expect(isGeminiContent(text)).toBe(true);
	});
});

describe("parseGeminiDialog — sourceUrl extraction", () => {
	it("extracts the URL from the native-format metadata line", () => {
		const raw = `[Gemini](https://gemini.google.com/app) 2026-07-27 16:02:05 (-07:00)

You said

hello

## Gemini said

world`;
		const dialog = parseGeminiDialog(raw);
		expect(dialog.sourceUrl).toBe("https://gemini.google.com/app");
	});

	it("leaves sourceUrl undefined when the metadata line is missing", () => {
		const dialog = parseGeminiDialog("plain text with no gemini metadata");
		expect(dialog.sourceUrl).toBeUndefined();
	});
});
