import { describe, expect, it } from "vitest";
import { parseOldFormatNote, extractDataviewFields } from "../../src/litNote/oldFormatReader";
import { readLitNote } from "../../src/litNote/litNoteReader";

describe("Old-Format Reader and Canonical LitNote Reader", () => {
	it("parses old format notes with empty lines separating sections in callout", () => {
		const rawNote = `---
category: literaturenote
tags:
aliases:
  - Heterodox Hate Parties: Political Polarization
  - Heterodox Hate
citekey: Lopez26heterodoxHateParties
---

> [!info]- &nbsp;[**Zotero**](zotero://select/library/items/12345)
>
> **Abstract**
> Some abstract text here.

> **FirstAuthor**:: Lopez, Maria
> **Author**:: Smith, John
>
> **Title**:: "Heterodox Hate Parties: Political Polarization and Extremism"
> **Date**:: 2026-03-15
> **Citekey**:: Lopez26heterodoxHateParties
`;

		const parsed = parseOldFormatNote(rawNote, "Lopez26heterodoxHateParties");
		expect(parsed.title).toBe("Heterodox Hate Parties: Political Polarization and Extremism");
		expect(parsed.date).toBe("2026-03-15");
		expect(parsed.citekey).toBe("Lopez26heterodoxHateParties");
		expect(parsed.layoutType).toBe("LayoutA");
		expect(parsed.authors).toEqual(["Lopez, Maria", "Smith, John"]);
	});

	it("handles multiline and lowercase Dataview property lines", () => {
		const body = `
> [!info]-
> **author**:: Single Author
> **title**:: "A Very Long Multiline
> Title That Spans Multiple Lines"
> **date**:: 2025-11-20
`;
		const fields = extractDataviewFields(body);
		expect(fields.title).toBe("A Very Long Multiline Title That Spans Multiple Lines");
		expect(fields.date).toBe("2025-11-20");
		expect(fields.authors).toEqual(["Single Author"]);
	});

	it("readLitNote delegates old-format notes to oldFormatReader and guarantees title-first aliases", () => {
		const oldNote = `---
category: literaturenote
aliases:
  - Truncated Alias
---

> [!info]-
> **Author**:: Doe, Jane
> **Title**:: "Full Comprehensive Title of the Article Here"
> **Date**:: 2024-05-10
`;

		const meta = readLitNote(oldNote, "Doe24");
		expect(meta.isOldFormat).toBe(true);
		expect(meta.title).toBe("Full Comprehensive Title of the Article Here");
		expect(meta.aliases[0]).toBe("Full Comprehensive Title of the Article Here");
		expect(meta.aliases[1]).toBe("Full Comprehensive Title of the");
		expect(meta.aliases[2]).toBe("Truncated Alias");
		expect(meta.publication_date).toBe("2024-05-10");
	});

	it("readLitNote directly reads new-format notes without old format parsing", () => {
		const newNote = `---
category:
  - literaturenote
tags: []
read: false
in_progress: false
linked: false
aliases:
  - New Format Note Title
  - New Format Note
citekey: Doe24new
title: "New Format Note Title"
publication_date: 2024-05-10
---

> [!info]- &nbsp;[**Zotero**](zotero://select/library/items/ABC)

> Doe, Jane. New Format Note Title. 2024.
`;

		const meta = readLitNote(newNote, "Doe24new");
		expect(meta.isOldFormat).toBe(false);
		expect(meta.title).toBe("New Format Note Title");
		expect(meta.aliases[0]).toBe("New Format Note Title");
		expect(meta.citekey).toBe("Doe24new");
		expect(meta.publication_date).toBe("2024-05-10");
	});
});
