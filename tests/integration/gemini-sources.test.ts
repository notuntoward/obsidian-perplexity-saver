import { describe, it, expect } from "vitest";
import { detectAndParse } from "../../src/parsers/detect";
import { buildNoteBody } from "../../src/normalize/buildNote";

/**
 * Regression test for the user's actual Gemini clipboard showing
 * Seattle/Portland book club data. Verifies that:
 *   - The "## Sources & References" heading (Sources-first ordering) is
 *     detected, not just "## References & Sources"
 *   - Numbered reference items (1. 2. 3.) are parsed, not just bullets
 *   - Multi-link items (one bold title with multiple URLs joined by
 *     "and") produce one citation per URL
 *   - The sources section is removed from the rendered body, not left
 *     inline
 *   - The single consolidated # Sources block is produced, not duplicated
 */
const SEATTLE_PORTLAND_CLIPBOARD = `[Gemini](https://gemini.google.com/app/2a123c6fc1e19544) 2026-07-27 22:54:07 (-07:00)

You said

Compare the number of Seattle and Portland bookclubs.

**Gemini**

There is no single government registry that tracks every private book club.

## 1. Raw Numbers

| Metric | Seattle | Portland |
| --- | --- | --- |
| Population | 816,600 | 652,503 |

## Sources & References

1. **BookBrowse Research & NEA Survey:**
	[How Many People Are in a Book Club in the US?](https://www.bookbrowse.com/blogs/editor/index.cfm/2025/5/16/How-many-people-are-in-a-book-club)
2. **National Endowment for the Arts:**
	[Unpacking the 2022 NEA Survey Results](https://www.arts.gov/impact/research/responses-to-the-2022-SPPA/a-time-of-hope-and-worry)
3. **Portland State University Library Study:**
	[Gen Z and Millennials: How They Use Public Libraries](https://pdxscholar.library.pdx.edu/cgi/viewcontent.cgi?article=1135&context=eng_fac)
4. **Census Bureau Data:**
	[Seattle QuickFacts](https://www.census.gov/quickfacts/fact/table/WA/PST045225)
	and
	[Portland QuickFacts](https://www.census.gov/quickfacts/fact/table/OR/PST045225)
5. **Meetup Directory:**
	[Meetup Book Club Groups](https://www.meetup.com/topics/bookclub/us/)
	and
	[Silent Book Club Seattle](https://www.meetup.com/silent-book-club-seattle/)`;

describe("uniform format — Gemini 'Sources & References' numbered list", () => {
	it("extracts the sources section and dedupes to a single # Sources block", () => {
		const dialog = detectAndParse(SEATTLE_PORTLAND_CLIPBOARD);
		expect(dialog.sourceVendor).toBe("gemini");
		expect(dialog.sourceUrl).toBe("https://gemini.google.com/app/2a123c6fc1e19544");
		expect(dialog.turns).toHaveLength(2);

		const aiTurn = dialog.turns[1];
		expect(aiTurn.role).toBe("ai");
		// The sources section is stripped from the rendered body.
		expect(aiTurn.rawText).not.toContain("Sources & References");
		expect(aiTurn.rawText).not.toContain("BookBrowse Research");
		// But the body of the response is preserved.
		expect(aiTurn.rawText).toContain("Raw Numbers");
		expect(aiTurn.rawText).toContain("816,600");

		// 5 numbered items, but item 4 has 2 links and item 5 has 2 links
		// -> 7 citations total.
		expect(aiTurn.citations).toHaveLength(7);
		expect(aiTurn.citations[0].url).toBe(
			"https://www.bookbrowse.com/blogs/editor/index.cfm/2025/5/16/How-many-people-are-in-a-book-club"
		);
		expect(aiTurn.citations[0].title).toBe("BookBrowse Research & NEA Survey");
		// Item 4's second URL is extracted.
		expect(aiTurn.citations[3].url).toBe(
			"https://www.census.gov/quickfacts/fact/table/WA/PST045225"
		);
		expect(aiTurn.citations[4].url).toBe(
			"https://www.census.gov/quickfacts/fact/table/OR/PST045225"
		);
		// Item 5's two URLs.
		expect(aiTurn.citations[5].url).toBe("https://www.meetup.com/topics/bookclub/us/");
		expect(aiTurn.citations[6].url).toBe("https://www.meetup.com/silent-book-club-seattle/");

		const { body, sourceLines } = buildNoteBody(dialog);
		// Exactly one # Sources block in the rendered note.
		expect((body.match(/# Sources/g) ?? []).length).toBe(1);
		expect(sourceLines).toHaveLength(7);
	});

	it("the legacy bold-marker format also strips its trailing sources section", () => {
		const raw = `# New chat

[Gemini](https://gemini.google.com/app/x) 2026-07-24

**You**

q

---

**Gemini**

A body paragraph.

## Sources

1. **First:**
	[https://one.com/](https://one.com/)
2. **Second:**
	[https://two.com/](https://two.com/)

---

**You**

next q

---

**Gemini**

next answer.`;
		const dialog = detectAndParse(raw);
		expect(dialog.turns).toHaveLength(4);
		// First AI turn: the "## Sources" section is stripped, the 2 links
		// are extracted as citations, and the body no longer contains them.
		expect(dialog.turns[1].rawText).toBe("A body paragraph.");
		expect(dialog.turns[1].citations).toHaveLength(2);
		// Second AI turn: no sources section, no citations.
		expect(dialog.turns[3].citations).toHaveLength(0);
	});
});
