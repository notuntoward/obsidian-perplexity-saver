import { describe, it, expect } from "vitest";
import { detectAndParse } from "../../src/parsers/detect";
import { buildNoteBody } from "../../src/normalize/buildNote";

/**
 * Minimal but representative Perplexity export covering the bugs reported
 * on the user's PDF++ test case:
 *   - metadata line at the top
 *   - user prompt that starts with a level-1 # line (must not become a
 *     headline in the output; Bug 3)
 *   - a <q>...</q> quoted excerpt in the second prompt (must become a
 *     blockquote above the rest of the prompt; Bug 4)
 *   - AI response with an intro paragraph plus level-2 headings
 *   - a repeated citation number within one response (must convert every
 *     occurrence, not just the first; Bug 5)
 *   - trailing # Citations: block
 *   - multiple prompt/response pairs separated by ---, where both
 *     responses cite the same URL (multi-turn source ownership; Bug 2)
 */
const SAMPLE_PERPLEXITY = `[Perplexity](https://www.perplexity.ai/search/x) · *2026-07-27 10:18 PDT*
# How do I configure foo mode?

Bar mode can actually be configured.[1]

## Setup Steps

Open the settings panel and toggle the option.[1][1][2]

# Citations:
[1] [One](https://one.com/)
[2] [Two](https://two.com/)
---  


# <q>Does it work with baz?</q> Explain.

Yes, baz is supported.[1]

## Implementation Notes

Check the documentation.[1]

# Citations:
[1] [One](https://one.com/)
`;

describe("uniform note format from Perplexity export", () => {
	it("produces one # Dialog, no ## Turns, one # Sources, and correct heading levels", () => {
		const dialog = detectAndParse(SAMPLE_PERPLEXITY);
		const { body, sourceLines } = buildNoteBody(dialog);

		// Structural sections.
		expect(body).toContain("# Dialog");
		expect(body).not.toContain("## Turns");
		expect(body).toContain("# Sources");
		expect((body.match(/# Sources/g) ?? []).length).toBe(1);
		expect(body).not.toContain("# Citations:");

		// Bug 1: a prompt and its AI response are one logical turn and share
		// the same turn number. The prompt heading is a level-2 summary
		// derived from the prompt text; the AI heading is a level-3 stable
		// label "AI response (turn N)". The second prompt contains a <q>
		// excerpt which is extracted as a blockquote, and the remaining
		// prompt text becomes the headline.
		expect(body).toMatch(/## How do I configure foo mode\? \^turn-1-prompt/);
		expect(body).toMatch(/### AI response \(turn 1\) \^turn-1-ai/);
		expect(body).toMatch(/## Does it work with baz\? Explain\. \^turn-2-prompt/);
		expect(body).toMatch(/### AI response \(turn 2\) \^turn-2-ai/);

		// Bug 3: the prompt's embedded "# " heading marker is stripped from
		// the prompt body so it is plain paragraph text under its level-2
		// summary heading, never its own headline. (The level-2 summary
		// heading itself is expected and is not what this test guards.)
		const bodyLines = body.split("\n");
		const promptHeadingIndex = bodyLines.findIndex((l) => l.startsWith("## How do I configure foo mode?"));
		const promptBody = bodyLines.slice(promptHeadingIndex + 1).join("\n");
		expect(promptBody).toContain("How do I configure foo mode?");
		expect(promptBody).not.toMatch(/^#{1,6}[ \t]+How do I configure foo mode\?/m);

		// Bug 4: the <q>...</q> excerpt becomes a blockquote above the rest
		// of the prompt, in the order it appeared, with the tags removed.
		// The headline includes both the quote text and the rest of the
		// prompt (the lead method picks the first sentence which spans both).
		expect(body).toMatch(/## Does it work with baz\? Explain\. \^turn-2-prompt\n> Does it work with baz\?\n\nExplain\./);
		expect(body).not.toContain("<q>");
		expect(body).not.toContain("</q>");

		// AI response headings are demoted to exactly one level below ### AI.
		expect(body).toContain("#### Setup Steps");
		expect(body).toContain("#### Implementation Notes");
		expect(body).not.toMatch(/^##### Setup Steps/m);

		// Bug 5: every occurrence of a repeated citation number converts,
		// not just the first. [1][1][2] in "Setup Steps" must all convert.
		expect(body).toContain("Open the settings panel and toggle the option.[^s1][^s1][^s2]");
		expect(body).not.toMatch(/\[1\]|\[2\]/);

		// Bug 2: the source cited from both turn 1 and turn 2 records both
		// owning turns, not just whichever one happened to introduce it.
		expect(sourceLines).toHaveLength(2);
		expect(sourceLines[0]).toContain("[^s1]: [One](https://one.com/) (turns 1, 2) <!-- src-url: https://one.com/ -->");
		expect(sourceLines[1]).toContain("[^s2]: [Two](https://two.com/) (turn 1) <!-- src-url: https://two.com/ -->");

		// Inline source link at the top of the note, clickable in editor and
		// reading view. Appears as the first content line after # Dialog.
		expect(body).toMatch(
			/# Dialog\n\*\*Source:\*\* \[perplexity\]\(https:\/\/www\.perplexity\.ai\/search\/x\)\n## /
		);
	});
});

describe("inline source link", () => {
	it("renders a clickable link to the source URL for Perplexity", () => {
		const dialog = detectAndParse(
			`[Perplexity](https://www.perplexity.ai/search/abc) · *2026-07-27*\n# q\n\n## A\n\nbody[1]\n\n# Citations:\n[1] [X](https://x.com/)`
		);
		const { body } = buildNoteBody(dialog);
		expect(body).toContain("**Source:** [perplexity](https://www.perplexity.ai/search/abc)");
		// It is the first content line, immediately after # Dialog.
		const dialogHeadingIndex = body.indexOf("# Dialog");
		const linkIndex = body.indexOf("**Source:**");
		expect(linkIndex).toBeGreaterThan(dialogHeadingIndex);
		// The first turn heading is the level-2 prompt summary heading.
		expect(linkIndex).toBeLessThan(body.search(/^## /m));
	});

	it("renders a clickable link to the source URL for Gemini", () => {
		const dialog = detectAndParse(
			`[Gemini](https://gemini.google.com/app/g-1) 2026-07-27 16:02:05 (-07:00)\n\nYou said\n\nhello\n\n## Gemini said\n\nworld`
		);
		const { body } = buildNoteBody(dialog);
		expect(body).toContain("**Source:** [gemini](https://gemini.google.com/app/g-1)");
	});

	it("omits the source link when no sourceUrl is present on the dialog", () => {
		// No metadata line -> no sourceUrl
		const dialog = detectAndParse("plain text[1]\n[1] [X](https://x.com/)");
		const { body } = buildNoteBody(dialog);
		expect(body).not.toContain("**Source:**");
	});
});
