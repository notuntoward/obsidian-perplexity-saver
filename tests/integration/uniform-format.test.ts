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
		// the same turn number. The prompt marker is a level-2 heading
		// carrying the single `^turn-N` block ID, followed by a closed
		// `> [!Prompt]+` callout containing the prompt body. The AI body
		// follows directly below with no AI heading of its own.
		expect(body).toMatch(/## How do I configure foo mode\? \^turn-1/);
		expect(body).toMatch(/## Explain\. \^turn-2/);
		expect(body).not.toMatch(/### AI response/);

		// Bug 3: the prompt's embedded "# " heading marker is stripped from
		// the prompt body so it is plain paragraph text inside the callout,
		// never its own headline.
		const bodyLines = body.split("\n");
		const headingIndex = bodyLines.findIndex((l) =>
			l.startsWith("## How do I configure foo mode?")
		);
		const calloutContent = bodyLines.slice(headingIndex + 1).join("\n");
		expect(calloutContent).toContain("> [!Prompt]+");
		expect(calloutContent).toContain("> How do I configure foo mode?");
		expect(calloutContent).not.toMatch(/^#{1,6}[ \t]+How do I configure foo mode\?/m);

		// Bug 4: the <q>...</q> excerpt becomes a blockquote above the rest
		// of the prompt, in the order it appeared, with the tags removed.
		// The headline excludes the quote text and only includes the rest of
		// the prompt typed by the user, if present.
		expect(body).toMatch(
			/## Explain\. \^turn-2\n\n> \[!Prompt\]\+\n> > Does it work with baz\?\n>\n> Explain\./
		);
		expect(body).not.toContain("<q>");
		expect(body).not.toContain("</q>");

		// AI body headings are demoted to start at level 3 (one level below
		// the level-2 prompt heading).
		expect(body).toContain("### Setup Steps");
		expect(body).toContain("### Implementation Notes");
		expect(body).not.toMatch(/^#### Setup Steps/m);

		// Bug 5: every occurrence of a repeated citation number converts,
		// not just the first. [1][1][2] in "Setup Steps" must all convert.
		expect(body).toContain("Open the settings panel and toggle the option.[^1_1], [^1_1], [^1_2]");
		expect(body).not.toMatch(/\[1\]|\[2\]/);

		// Bug 2: the source cited from both turn 1 and turn 2 records both
		// owning turns, not just whichever one happened to introduce it.
		expect(sourceLines).toHaveLength(3);
		expect(sourceLines[0]).toBe("[^1_1]: [One](https://one.com/)");
		expect(sourceLines[1]).toBe("[^1_2]: [Two](https://two.com/)");
		expect(sourceLines[2]).toBe("[^2_1]: [One](https://one.com/)");

		// Inline source link at the top of the note, clickable in editor and
		// reading view. Appears as the first content line.
		expect(body).toMatch(
			/^\[Perplexity\]\(https:\/\/www\.perplexity\.ai\/search\/x\) · \*2026-07-27 10:18 PDT\*\n\n# Dialog/
		);
	});
});

describe("inline source link", () => {
	it("renders a clickable link to the source URL for Perplexity", () => {
		const dialog = detectAndParse(
			`[Perplexity](https://www.perplexity.ai/search/abc) · *2026-07-27*\n# q\n\n## A\n\nbody[1]\n\n# Citations:\n[1] [X](https://x.com/)`
		);
		const { body } = buildNoteBody(dialog);
		expect(body).toContain("[Perplexity](https://www.perplexity.ai/search/abc) · *2026-07-27*");
		const linkIndex = body.indexOf("[Perplexity](https://www.perplexity.ai/search/abc)");
		expect(linkIndex).toBe(0);
		expect(body.indexOf("# Dialog")).toBeGreaterThan(linkIndex);
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

describe("stock Perplexity exports where the response has no level-2 headings", () => {
	// Regression: a real Perplexity export where the user's question is a
	// level-1 heading and the response is a single paragraph with no ## headings
	// at all. The parser must still split prompt from response, and the
	// renderer must place the prompt heading (level 2) BEFORE the AI response
	// heading (level 3). Previously the prompt turn was dropped entirely and
	// the prompt text was demoted inside the AI body.
	it("splits prompt from response when the body starts with a level-1 heading and the response has no ## headings", () => {
		const raw = `[Perplexity](https://www.perplexity.ai/search/d4ac5d72-ef0e-4338-84a1-ce92ae7beba5) · *2026-07-27 10:18 PDT*
# When was the biggest forest fire in WA state?

The **Carlton Complex Fire** was Washington's biggest **single wildfire** on record. It began on **July 14, 2014**, when lightning ignited several fires in north-central Washington's Methow Valley; they merged and ultimately burned about **256,108 acres** (roughly 400 square miles).[1][2]

# Citations:
[1] [Carlton Complex Fire](https://en.wikipedia.org/wiki/Carlton_Complex_Fire)
[2] [Megafire | Window | Western Washington University](https://window.wwu.edu/megafire)
---
# Name two famous ballet dancers and the best quarter back of all time

Two famous ballet dancers are **Anna Pavlova**, celebrated for *The Dying Swan*, and **Misty Copeland**, a trailblazing principal dancer with American Ballet Theatre.[3]

The best NFL quarterback of all time is most commonly considered **Tom Brady**: he won seven Super Bowls and is the NFL's career leader in passing yards.[4][5]

# Citations:
[3] [Famous Ballet Dancers Who Shaped the Art Form](https://www.southerncaliforniaballet.org/articles/famous-ballet-dancers-who-shaped-the-art-form)
[4] [Top 25 quarterbacks of all time: Patriots' Tom Brady leads list](https://www.nfl.com/news/top-25-quarterbacks-of-all-time-patriots-tom-brady-leads-list-0ap3000001035041)
[5] [NFL All-Time Pass Yards Leaders](http://www.espn.com/nfl/history/leaders/_/stat/passyds)`;
		const dialog = detectAndParse(raw);
		// Two sections separated by ---, each producing a prompt+ai pair.
		expect(dialog.turns).toHaveLength(4);

		// Prompt turns have the user's question as their raw text.
		expect(dialog.turns[0].role).toBe("prompt");
		expect(dialog.turns[0].rawText).toContain("When was the biggest forest fire");
		expect(dialog.turns[2].role).toBe("prompt");
		expect(dialog.turns[2].rawText).toContain("Name two famous ballet dancers");

		// AI turns have the response body (no heading demotion at the parser).
		expect(dialog.turns[1].role).toBe("ai");
		expect(dialog.turns[1].rawText).toContain("Carlton Complex Fire");
		expect(dialog.turns[3].role).toBe("ai");
		expect(dialog.turns[3].rawText).toContain("Anna Pavlova");

		const { body } = buildNoteBody(dialog);

		// The prompt heading (level 2) carries the `^turn-N` anchor and appears
		// as the last thing on its line. The AI response for a paired turn
		// follows directly below with no heading of its own. The previous
		// bug had the prompt and AI in the wrong order or the prompt text
		// demoted inside the AI body.
		const turn1Idx = body.indexOf("^turn-1");
		const turn2Idx = body.indexOf("^turn-2");
		expect(turn1Idx).toBeGreaterThan(0);
		expect(turn2Idx).toBeGreaterThan(turn1Idx);

		// The prompt text is rendered as plain paragraph text (heading marker
		// stripped), not as its own heading in the body. The prompt body
		// follows in a closed callout below the heading.
		expect(body).toContain("When was the biggest forest fire");
		expect(body).toMatch(/> \[!Prompt\]\+/);
		expect(body).toMatch(/> When was the biggest forest fire/);
	// The prompt body (the line immediately after the callout title) has no
	// leading "# " — it is plain paragraph text inside the callout.
	expect(body).toMatch(/> When was the biggest forest fire in WA state\?/);

		// The response body does NOT contain the prompt as a heading.
		expect(body).not.toContain("#### When was the biggest forest fire");
	});
});
