import { describe, expect, it } from "vitest";
import { extractLitNoteMetadata, readLitNote } from "../../src/litNote/litNoteReader";

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

	describe("extractLitNoteMetadata (in-memory frontmatter extraction)", () => {
		it("extracts metadata directly from frontmatter object", () => {
			const fm = {
				title: "Machine Learning Concepts",
				citekey: "ML2024",
				date: "2024-01-15",
				aliases: ["ML Concepts"],
				authors: ["Alan Turing"],
			};
			const meta = extractLitNoteMetadata(fm, "ML2024");
			expect(meta.title).toBe("Machine Learning Concepts");
			expect(meta.citekey).toBe("ML2024");
			expect(meta.publication_date).toBe("2024-01-15");
			expect(meta.aliases).toContain("Machine Learning Concepts");
			expect(meta.aliases).toContain("ML Concepts");
			expect(meta.authors).toEqual(["Alan Turing"]);
		});

		it("handles null or undefined frontmatter gracefully using fallbackStem", () => {
			const meta = extractLitNoteMetadata(null, "Fallback2025");
			expect(meta.title).toBe("Fallback2025");
			expect(meta.citekey).toBe("Fallback2025");
			expect(meta.aliases).toEqual(["Fallback2025"]);
			expect(meta.publication_date).toBeUndefined();
			expect(meta.authors).toBeUndefined();
		});
	});
});
