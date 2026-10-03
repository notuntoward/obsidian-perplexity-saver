import { describe, expect, it } from "vitest";
import { readLitNote } from "../../src/litNote/litNoteReader";

describe("Canonical LitNote Reader (new frontmatter format)", () => {
	it("reads new-format frontmatter notes with full fidelity", () => {
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
		expect(meta.title).toBe("New Format Note Title");
		expect(meta.aliases[0]).toBe("New Format Note Title");
		expect(meta.citekey).toBe("Doe24new");
		expect(meta.publication_date).toBe("2024-05-10");
	});

	it("falls back to fallbackStem when frontmatter has no title", () => {
		const noTitleNote = `---
category:
  - literaturenote
citekey: Smith25test
---

Body text here.
`;
		const meta = readLitNote(noTitleNote, "Smith25test");
		expect(meta.title).toBe("Smith25test");
		expect(meta.citekey).toBe("Smith25test");
	});

	it("reads authors array from frontmatter", () => {
		const noteWithAuthors = `---
citekey: Jones24test
title: "A Test Paper"
authors:
  - Jones, Alice
  - Brown, Bob
---
`;
		const meta = readLitNote(noteWithAuthors, "Jones24test");
		expect(meta.authors).toEqual(["Jones, Alice", "Brown, Bob"]);
	});
});
