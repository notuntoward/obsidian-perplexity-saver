import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
	cleanCalloutBody,
	cleanLegacyBodyMarkers,
	convertDataviewPropsToFrontmatter,
	stringifyOrderedFrontmatter,
} from "../../src/litNote/dataviewConverter";
import {
	CONVERTED_NOTES_DIR,
	convertAndWriteNote,
	getConvertedNoteDiskPath,
	getScratchPathForNote,
	appendToLogFile,
} from "../../src/commands/dataviewConverter";
import { parseLitNoteInfo } from "../../src/commands/getLitNoteLink";
import { TFile } from "obsidian";

describe("Dataview to File Properties Converter", () => {
	const chenFixture = fs.readFileSync(
		path.join(__dirname, "../fixtures/litNote/Chen24multiConceptDriftVrblSlideWin.md"),
		"utf-8"
	);
	const morrisFixture = fs.readFileSync(
		path.join(__dirname, "../fixtures/litNote/Morris25only8pctWantModerat.md"),
		"utf-8"
	);
	const molmenFixture = fs.readFileSync(
		path.join(__dirname, "../fixtures/litNote/Molmen25trainMitochondCapill.md"),
		"utf-8"
	);

	it("converts Layout A (FirstAuthor + Author lines) correctly", async () => {
		const res = await convertDataviewPropsToFrontmatter(
			chenFixture,
			"lit/lit_notes/Chen24multiConceptDriftVrblSlideWin.md"
		);

		expect(res.success).toBe(true);
		expect(res.skipped).toBe(false);
		expect(res.layoutType).toBe("LayoutA");
		expect(res.updatedContent).toBeDefined();

		const content = res.updatedContent!;
		expect(content).toContain("authors:");
		expect(content).toContain("  - Chen, Jing");
		expect(content).toContain("  - Yang, Shengyi");
		expect(content).toContain("title: Multi-type concept drift detection");
		expect(content).toContain("publication_date: 2024-02-12");
		expect(content).toContain("zotero_item_key: SXMSI2V5");
		expect(content).toContain("zotero_item_type: journalArticle");
		expect(content).toContain("doi: 10.1186/s13677-023-00566-9");
		expect(content).toContain("publication: Journal of Cloud Computing");

		// Mandatory boolean file properties initialized if missing
		expect(content).toContain("read: false");
		expect(content).toContain("in_progress: false");
		expect(content).toContain("linked: false");

		// Redundant dataview fields removed from callout
		expect(content).not.toContain("**FirstAuthor**::");
		expect(content).not.toContain("**Author**::");
		expect(content).not.toContain("**Title**::");
		expect(content).not.toContain("**Date**::");

		// Aliases: article title is first item in aliases list
		expect(content).toContain("- Multi-type concept drift detection under a dual-layer variable sliding window in frequent pattern mining with cloud computing");
		expect(content).toContain("- Multi-type concept drift detection under");

		// Legacy Obsidian notes comments removed while preserving user comments inside
		expect(content).not.toContain("%% begin Obsidian Notes %%");
		expect(content).not.toContain("%% end Obsidian Notes %%");
		expect(content).toContain("==Delete this and write here.==");
		expect(content).toContain("==Don't delete the `persist` directives above and below.==");
	});

	it("converts Layout B (single Author string) when Zotero returns creators", async () => {
		const mockZoteroClient: any = {
			getItemByKey: vi.fn().mockResolvedValue({
				key: "MRUCFQGD",
				creators: [{ firstName: "G. Elliott", lastName: "Morris", creatorType: "author" }],
			}),
		};

		const res = await convertDataviewPropsToFrontmatter(
			morrisFixture,
			"lit/lit_notes/Morris25only8pctWantModerat.md",
			mockZoteroClient
		);

		expect(res.success).toBe(true);
		expect(res.skipped).toBe(false);
		expect(res.layoutType).toBe("LayoutB");
		expect(mockZoteroClient.getItemByKey).toHaveBeenCalledWith("MRUCFQGD");

		const content = res.updatedContent!;
		expect(content).toContain("authors:\n  - Morris, G. Elliott");
		expect(content).toContain("title: \"Only 8% of \\\"moderates\\\" actually want moderation\"");
		expect(content).toContain("publication_date: 2025-09-22");
		expect(content).toContain("zotero_item_key: MRUCFQGD");
		expect(content).toContain("zotero_item_type: webpage");
		expect(content).not.toContain("**Author**::");
		expect((res.updatedFm?.aliases as string[])?.[0]).toBe("Only 8% of \"moderates\" actually want moderation");
	});

	it("converts Layout B note using fallback parser when Zotero creators cannot be retrieved", async () => {
		const mockZoteroClient: any = {
			getItemByKey: vi.fn().mockResolvedValue(null),
			getItemByCitekey: vi.fn().mockResolvedValue(null),
		};

		const res = await convertDataviewPropsToFrontmatter(
			molmenFixture,
			"lit/lit_notes/Molmen25trainMitochondCapill.md",
			mockZoteroClient
		);

		expect(res.success).toBe(true);
		expect(res.skipped).toBe(false);
		expect(res.updatedFm?.authors).toEqual([
			"Mølmen, Knut Sindre",
			"Almquist, Nicki Winfield",
			"Skattebo, Øyvind",
		]);
		expect(res.updatedContent).toContain(
			"authors:\n  - Mølmen, Knut Sindre\n  - Almquist, Nicki Winfield\n  - Skattebo, Øyvind"
		);
	});

	it("handles citation key property migration and renames it to citekey if citekey missing", async () => {
		const testNote = `---
category: literaturenote
"citation key": OldKey123
---

> [!info]-
> **Author**:: Doe, Jane
> **Author**:: Smith, Bob
`;

		const res = await convertDataviewPropsToFrontmatter(testNote, "lit/lit_notes/test.md");
		expect(res.success).toBe(true);
		expect(res.updatedContent).toContain("citekey: OldKey123");
		expect(res.updatedContent).not.toContain("citation key");
	});

	it("removes citation key property if citekey already exists", async () => {
		const testNote = `---
category: literaturenote
citekey: ExistingKey
"citation key": OldKey123
---

> [!info]-
> **Author**:: Doe, Jane
> **Author**:: Smith, Bob
`;

		const res = await convertDataviewPropsToFrontmatter(testNote, "lit/lit_notes/test.md");
		expect(res.success).toBe(true);
		expect(res.updatedContent).toContain("citekey: ExistingKey");
		expect(res.updatedContent).not.toContain("OldKey123");
	});

	it("scopes dataview field removal strictly to > [!info] callout block", async () => {
		const testNote = `---
category: literaturenote
citekey: TestNote
---

> [!info]-
> **Author**:: Doe, Jane
> **Author**:: Smith, Bob

> [!quote] User Notes
> **Author**:: Quoted Author inside user note block should NOT be removed
`;

		const res = await convertDataviewPropsToFrontmatter(testNote, "lit/lit_notes/test.md");
		expect(res.success).toBe(true);
		expect(res.updatedContent).toContain("Quoted Author inside user note block should NOT be removed");
	});

	it("deduplicates authors in Layout A", async () => {
		const testNote = `---
category: literaturenote
citekey: TestNote
---

> [!info]-
> **FirstAuthor**:: Doe, Jane
> **Author**:: Doe, Jane
> **Author**:: Smith, Bob
`;

		const res = await convertDataviewPropsToFrontmatter(testNote, "lit/lit_notes/test.md");
		expect(res.success).toBe(true);
		expect(res.updatedContent).toContain("authors:\n  - Doe, Jane\n  - Smith, Bob");
	});

	it("ensures article title is the first item in aliases list", async () => {
		const testNote = `---
category: literaturenote
citekey: TestNote
title: Test Note Title
aliases:
  - Short Alias
  - Medium Alias
---

> [!info]-
> **Author**:: Doe, Jane
> **Author**:: Smith, Bob
`;

		const res = await convertDataviewPropsToFrontmatter(testNote, "lit/lit_notes/test.md");
		expect(res.success).toBe(true);
		expect((res.updatedFm?.aliases as string[])?.[0]).toBe("Test Note Title");
		expect(res.updatedContent).toContain("- Test Note Title");
		expect(res.updatedContent).toContain("- Short Alias");
		expect(res.updatedContent).toContain("- Medium Alias");
	});

	it("converts notes with empty lines in callout and puts Dataview title as first alias", async () => {
		const lopezLikeNote = `---
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
> Polarization and extremism in modern politics.

> **FirstAuthor**:: Lopez, Maria
> **Author**:: Smith, John
>
> **Title**:: "Heterodox Hate Parties: Political Polarization and Extremism"
> **Date**:: 2026-03-15
> **Citekey**:: Lopez26heterodoxHateParties
`;

		const res = await convertDataviewPropsToFrontmatter(lopezLikeNote, "lit/lit_notes/Lopez26heterodoxHateParties.md");
		expect(res.success).toBe(true);
		expect((res.updatedFm?.aliases as string[])?.[0]).toBe("Heterodox Hate Parties: Political Polarization and Extremism");
		expect(res.updatedFm?.title).toBe("Heterodox Hate Parties: Political Polarization and Extremism");
		expect(res.updatedFm?.publication_date).toBe("2026-03-15");
	});

	it("calculates Scratch Space path correctly", () => {
		const scratchPath = getScratchPathForNote(
			"lit/lit_notes/Chen24.md",
			"lit/lit_notes"
		);
		expect(scratchPath).toBe("Scratch Space/lit/lit_notes/Chen24.md");
	});

	it("parses lit note info with title, aliases, and citekey", async () => {
		const mockFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Morris25only8pctWantModerat.md",
			basename: "Morris25only8pctWantModerat",
		});

		const mockApp: any = {
			vault: {
				read: vi.fn().mockResolvedValue(morrisFixture),
			},
		};

		const info = await parseLitNoteInfo(mockApp, mockFile);
		expect(info.citekey).toBe("Morris25only8pctWantModerat");
		expect(info.title).toContain("Only 8%");
		expect(info.aliases).toHaveLength(2);
	});

	it("formats frontmatter in exact requested key order with nested objects", () => {
		const fm = {
			"modified date": "2026-09-28",
			citekey: "Key123",
			title: "Sample Title",
			category: ["literaturenote"],
			authors: ["Smith, John"],
			customNested: { nestedKey: "nestedVal" },
			"created date": "2026-09-27",
		};

		const yaml = stringifyOrderedFrontmatter(fm);
		expect(yaml).not.toContain("[object Object]");
		expect(yaml).toContain("custom_nested:");
		expect(yaml).toContain("nestedKey: nestedVal");

		const lines = yaml.split("\n");
		expect(lines[0]).toBe("---");
		expect(lines[1]).toBe("category:");
		expect(lines[2]).toBe("  - literaturenote");
		const citekeyIdx = lines.findIndex((l) => l.startsWith("citekey:"));
		const authorsIdx = lines.findIndex((l) => l.startsWith("authors:"));
		const titleIdx = lines.findIndex((l) => l.startsWith("title:"));
		const createdIdx = lines.findIndex((l) => l.startsWith("created_date:"));
		const modifiedIdx = lines.findIndex((l) => l.startsWith("modified_date:"));

		expect(citekeyIdx).toBeLessThan(authorsIdx);
		expect(authorsIdx).toBeLessThan(titleIdx);
		expect(titleIdx).toBeLessThan(createdIdx);
		expect(createdIdx).toBeLessThan(modifiedIdx);
	});

	describe("Callout blank line formatting", () => {
		it("ensures a blank line above and below the callout in Chen fixture", async () => {
			const res = await convertDataviewPropsToFrontmatter(
				chenFixture,
				"lit/lit_notes/Chen24multiConceptDriftVrblSlideWin.md"
			);

			expect(res.success).toBe(true);
			const content = res.updatedContent!;

			// Blank line above callout
			expect(content).toMatch(/---\n\n> \[!info\]/);

			// Blank line below callout
			expect(content).toMatch(/> \[!info\][\s\S]*?\n\n> Chen, Jing/);
		});

		it("ensures a blank line above and below the callout in Morris fixture", async () => {
			const mockZoteroClient: any = {
				getItemByKey: vi.fn().mockResolvedValue({
					key: "MRUCFQGD",
					creators: [{ firstName: "G. Elliott", lastName: "Morris", creatorType: "author" }],
				}),
			};

			const res = await convertDataviewPropsToFrontmatter(
				morrisFixture,
				"lit/lit_notes/Morris25only8pctWantModerat.md",
				mockZoteroClient
			);

			expect(res.success).toBe(true);
			const content = res.updatedContent!;

			// Blank line above callout
			expect(content).toMatch(/---\n\n> \[!info\]/);

			// Blank line below callout
			expect(content).toMatch(/> \[!info\][\s\S]*?\n\n> Morris, G. Elliott/);
		});

		it("inserts blank line above callout when input note has no blank line after frontmatter", async () => {
			const noBlankAbove = `---
category: literaturenote
citekey: Test2024
---
> [!info]-
> **FirstAuthor**:: Smith, John
> **Author**:: Doe, Jane
> **Title**:: Test Title

> Bibliography line here
`;

			const res = await convertDataviewPropsToFrontmatter(noBlankAbove, "lit/test.md");
			expect(res.success).toBe(true);
			const content = res.updatedContent!;
			expect(content).toMatch(/---\n\n> \[!info\]/);
		});

		it("inserts blank line below callout when input note has unquoted content immediately following", () => {
			const body = `> [!info]-
> **Title**:: My Title
> **Abstract**
> Some abstract
Paragraph text directly after without blank line.`;

			const cleaned = cleanCalloutBody(body);
			expect(cleaned).toContain("> [!info]-");
			expect(cleaned).toContain("> Some abstract\n\nParagraph text");
		});

		it("trims trailing empty quote lines from the bottom of the callout", () => {
			const body = `> [!info]-
> **Title**:: My Title
>
>
`;
			const cleaned = cleanCalloutBody(body);
			expect(cleaned).toBe("\n> [!info]-\n\n");
		});
	});

	describe("convertAndWriteNote", () => {
		it("converts note and writes to CONVERTED_NOTES_DIR on disk", async () => {
			const mockFile = Object.assign(Object.create(TFile.prototype), {
				path: "lit/lit_notes/Chen24multiConceptDriftVrblSlideWin.md",
			});

			const mockApp: any = {
				vault: {
					read: vi.fn().mockResolvedValue(chenFixture),
				},
			};

			const result = await convertAndWriteNote(
				mockApp,
				mockFile,
				{ litNotesFolder: "lit/lit_notes" }
			);

			expect(result.conversion.success).toBe(true);
			expect(result.conversion.skipped).toBe(false);
			expect(result.targetPath).toBe(
				path.join(CONVERTED_NOTES_DIR, "Chen24multiConceptDriftVrblSlideWin.md")
			);

			const writtenContent = fs.readFileSync(result.targetPath!, "utf-8");
			// Check blank line above and below callout in written content
			expect(writtenContent).toMatch(/---\n\n> \[!info\]/);
			expect(writtenContent).toMatch(/> \[!info\][\s\S]*?\n\n> Chen, Jing/);

			// Clean up written test file
			fs.rmSync(result.targetPath!, { force: true });
		});

		it("calculates disk path in CONVERTED_NOTES_DIR correctly", () => {
			const diskPath = getConvertedNoteDiskPath(
				"lit/lit_notes/Chen24.md",
				"lit/lit_notes"
			);
			expect(diskPath).toBe(path.join(CONVERTED_NOTES_DIR, "Chen24.md"));
		});
	});

	describe("appendToLogFile", () => {
		it("includes Zotero offline warning in log file when Zotero is unavailable", async () => {
			let writtenLog = "";
			const mockApp: any = {
				vault: {
					getAbstractFileByPath: vi.fn().mockReturnValue(null),
				},
			};
			// Mock writeLitNote through writeNoteToScratchSpace
			const writeLitNoteModule = await import("../../src/litNote/writeLitNote");
			const writeSpy = vi.spyOn(writeLitNoteModule, "writeLitNote").mockImplementation(async (_app, _path, content) => {
				writtenLog = content;
				return {} as any;
			});

			await appendToLogFile(
				mockApp,
				[
					{
						success: true,
						skipped: false,
						filePath: "lit/test.md",
						originalContent: "",
					},
				],
				"All Notes",
				false
			);

			expect(writtenLog).toContain("**Zotero Status**: Offline / Unreachable");
			expect(writtenLog).toContain("> [!WARNING] Zotero Offline");
			writeSpy.mockRestore();
		});
	});

	describe("cleanLegacyBodyMarkers", () => {
		it("removes %% begin/end Obsidian Notes %% and adjacent horizontal rule lines while preserving user notes", () => {
			const input = `> [!info]-
> Some callout

%% begin Obsidian Notes %%
___
# User Heading
Here are my important user comments.
- Note bullet 1
- Note bullet 2
___
%% end Obsidian Notes %%
`;

			const cleaned = cleanLegacyBodyMarkers(input);
			expect(cleaned).not.toContain("%% begin Obsidian Notes %%");
			expect(cleaned).not.toContain("%% end Obsidian Notes %%");
			expect(cleaned).toContain("# User Heading");
			expect(cleaned).toContain("Here are my important user comments.");
			expect(cleaned).toContain("- Note bullet 1");
			expect(cleaned).toContain("- Note bullet 2");
		});

		it("removes %% Import Date: ... %% with arbitrary timestamps", () => {
			const input = `Some text content.

%% Import Date: 2024-05-08T14:01:11.313-07:00 %%
`;

			const cleaned = cleanLegacyBodyMarkers(input);
			expect(cleaned).not.toContain("%% Import Date");
			expect(cleaned).toContain("Some text content.");
		});

		it("removes both begin/end Obsidian Notes and Import Date in convertDataviewPropsToFrontmatter", async () => {
			const noteWithBoth = `---
category: literaturenote
citekey: TestNote24
---

> [!info]-
> **Author**:: Smith, John
> **Title**:: Test Title

%% begin Obsidian Notes %%
___
My user comment that must be kept.
___
%% end Obsidian Notes %%

%% Import Date: 2023-11-20T08:15:00.000Z %%
`;

			const res = await convertDataviewPropsToFrontmatter(noteWithBoth, "lit/test.md");
			expect(res.success).toBe(true);
			const content = res.updatedContent!;

			expect(content).not.toContain("%% begin Obsidian Notes %%");
			expect(content).not.toContain("%% end Obsidian Notes %%");
			expect(content).not.toContain("%% Import Date");
			expect(content).toContain("My user comment that must be kept.");
			expect(res.changesMade).toContain("Removed legacy 'begin/end Obsidian Notes' comment markers");
			expect(res.changesMade).toContain("Removed legacy 'Import Date' comment");
		});
	});

	describe("Dataview Creator Types Conversion & Logging", () => {
		it("converts Zhang22-like note with Author dataview field to authors property", async () => {
			const zhangLike = `---
category: literaturenote
citekey: Zhang22runShoeDropKneeStress
---

> [!info]-
> **Author**:: Zhang, X
> **Title**:: Running Shoe Drop Knee Stress
> **Date**:: 2022-05-10
`;

			const res = await convertDataviewPropsToFrontmatter(
				zhangLike,
				"lit/lit_notes/Zhang22runShoeDropKneeStress.md"
			);

			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual(["Zhang, X"]);
			expect(res.updatedContent).toContain("authors:\n  - Zhang, X");
			expect(res.updatedContent).not.toContain("**Author**::");
		});

		it("converts Zimmer24-like note with FirstAuthor / First Author field to authors property", async () => {
			const zimmerLike = `---
category: literaturenote
citekey: Zimmer24thinkNeedLanguage
---

> [!info]-
> **First Author**:: Zimmer, Carl
> **Title**:: Do We Need Language to Think?
> **Date**:: 2024-03-01
`;

			const res = await convertDataviewPropsToFrontmatter(
				zimmerLike,
				"lit/lit_notes/Zimmer24thinkNeedLanguage.md"
			);

			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual(["Zimmer, Carl"]);
			expect(res.updatedContent).toContain("authors:\n  - Zimmer, Carl");
			expect(res.updatedContent).not.toContain("**First Author**::");
		});

		it("converts PodSaveAmerica24-like note with Director field to authors property", async () => {
			const podSaveLike = `---
category: literaturenote
citekey: PodSaveAmerica24trumpBuiltCoalition
---

> [!info]-
> **Director**:: Pod Save America
> **Title**:: How Trump Built His Coalition
> **Date**:: 2024-11-06
`;

			const res = await convertDataviewPropsToFrontmatter(
				podSaveLike,
				"lit/lit_notes/PodSaveAmerica24trumpBuiltCoalition.md"
			);

			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual(["Pod Save America"]);
			expect(res.updatedContent).toContain("authors:\n  - Pod Save America");
			expect(res.updatedContent).not.toContain("**Director**::");
		});

		it("converts all supported creator types into authors property", async () => {
			const creatorTypes = [
				{ key: "podcaster", line: "> **Podcaster**:: Carlin, Dan", expected: "Carlin, Dan" },
				{ key: "bookAuthor", line: "> **Book Author**:: Tolkien, J.R.R.", expected: "Tolkien, J.R.R." },
				{ key: "inventor", line: "> **Inventor**:: Edison, Thomas", expected: "Edison, Thomas" },
				{ key: "artist", line: "> **Artist**:: Da Vinci, Leonardo", expected: "Da Vinci, Leonardo" },
				{ key: "cartographer", line: "> **Cartographer**:: Mercator, Gerardus", expected: "Mercator, Gerardus" },
				{ key: "programmer", line: "> **Programmer**:: Torvalds, Linus", expected: "Torvalds, Linus" },
				{ key: "composer", line: "> **Composer**:: Beethoven, Ludwig van", expected: "Beethoven, Ludwig van" },
				{ key: "interviewee", line: "> **Interviewee**:: Obama, Barack", expected: "Obama, Barack" },
				{ key: "presenter", line: "> **Presenter**:: Jobs, Steve", expected: "Jobs, Steve" },
				{ key: "sponsor", line: "> **Sponsor**:: Sanders, Bernie", expected: "Sanders, Bernie" },
				{ key: "contributor", line: "> **Contributor**:: Watson, John", expected: "Watson, John" },
			];

			for (const c of creatorTypes) {
				const note = `---
category: literaturenote
citekey: TestKey
---

> [!info]-
${c.line}
> **Title**:: Sample Work
`;
				const res = await convertDataviewPropsToFrontmatter(note, "lit/test.md");
				expect(res.success).toBe(true);
				expect(res.updatedFm?.authors).toEqual([c.expected]);
				expect(res.updatedContent).not.toContain(c.line);
			}
		});

		it("retains non-author creator types in callout and notes them in log", async () => {
			const editorNote = `---
category: literaturenote
citekey: Knuth97artCompProg
---

> [!info]-
> **Editor**:: Knuth, Donald
> **Title**:: The Art of Computer Programming
> **Date**:: 1997
`;

			const res = await convertDataviewPropsToFrontmatter(
				editorNote,
				"lit/lit_notes/Knuth97artCompProg.md"
			);

			expect(res.success).toBe(true);
			// Editor is not converted to authors
			expect(res.updatedFm?.authors).toBeUndefined();
			// Retained inside callout
			expect(res.updatedContent).toContain("**Editor**:: Knuth, Donald");
			// Logged in changesMade
			expect(res.changesMade).toContain(
				"Left dataview field in callout: 'Editor' (value: \"Knuth, Donald\")"
			);
			expect(res.changesMade).toContain(
				"Warning: Unable to convert any dataview field into an authors file property"
			);
			expect(res.unconvertedDataviewFields).toEqual([
				{ key: "editor", rawKey: "Editor", value: "Knuth, Donald" },
			]);
		});

		it("retains other non-author fields (translator, seriesEditor, etc.) in callout", async () => {
			const multiFieldNote = `---
category: literaturenote
citekey: MultiField24
---

> [!info]-
> **Author**:: Homer
> **Translator**:: Fagles, Robert
> **Series Editor**:: Knox, Bernard
> **Title**:: The Odyssey
`;

			const res = await convertDataviewPropsToFrontmatter(multiFieldNote, "lit/test.md");
			expect(res.success).toBe(true);
			// Author converted
			expect(res.updatedFm?.authors).toEqual(["Homer"]);
			// Converted field removed
			expect(res.updatedContent).not.toContain("**Author**::");
			// Non-author fields retained in callout
			expect(res.updatedContent).toContain("**Translator**:: Fagles, Robert");
			expect(res.updatedContent).toContain("**Series Editor**:: Knox, Bernard");
			// Logged in changesMade
			expect(res.changesMade).toContain(
				"Left dataview field in callout: 'Translator' (value: \"Fagles, Robert\")"
			);
			expect(res.changesMade).toContain(
				"Left dataview field in callout: 'Series Editor' (value: \"Knox, Bernard\")"
			);
		});

		it("reports notes without authors and notes with unconverted fields in appendToLogFile", async () => {
			let writtenLog = "";
			const mockApp: any = {
				vault: {
					getAbstractFileByPath: vi.fn().mockReturnValue(null),
				},
			};
			const writeLitNoteModule = await import("../../src/litNote/writeLitNote");
			const writeSpy = vi.spyOn(writeLitNoteModule, "writeLitNote").mockImplementation(async (_app, _path, content) => {
				writtenLog = content;
				return {} as any;
			});

			const results: any[] = [
				{
					success: true,
					skipped: false,
					filePath: "lit/note1.md",
					updatedFm: { title: "No Authors Note" },
					unconvertedDataviewFields: [{ key: "editor", rawKey: "Editor", value: "Knuth, Donald" }],
					changesMade: [
						"Left dataview field in callout: 'Editor' (value: \"Knuth, Donald\")",
						"Warning: Unable to convert any dataview field into an authors file property",
					],
				},
				{
					success: true,
					skipped: false,
					filePath: "lit/note2.md",
					updatedFm: { title: "Good Note", authors: ["Smith, John"] },
					changesMade: ["Converted Layout A authors (1 author)"],
				},
			];

			await appendToLogFile(mockApp, results, "All Notes", true);

			expect(writtenLog).toContain("- **Notes without Authors Property**: 1");
			expect(writtenLog).toContain("- **Notes with Unconverted Callout Fields**: 1");
			expect(writtenLog).toContain("## Notes Without Authors Property");
			expect(writtenLog).toContain("- **[[lit/note1.md]]**: No author or creator Dataview field found");
			expect(writtenLog).toContain("## Notes With Unconverted Dataview Fields Retained in Callout");
			expect(writtenLog).toContain("- **[[lit/note1.md]]**: 'Editor' (\"Knuth, Donald\")");

			writeSpy.mockRestore();
		});

		it("converts callout Author field with syntax error (double blockquote > > ) into authors file property", async () => {
			const doubleQuoteNote = `---
category: literaturenote
citekey: Ao2024
---

> [!info]-
> > **Author**:: Ao, Mengmeng,  Zhao, Frank,  Feldman, Ronen,  Attar, Ilan,  Hatskin, Leonid,  Rozenfeld, Benjamin
> **Title**:: Multi-agent Collaboration
> **Date**:: 2024-01-15
`;
			const res = await convertDataviewPropsToFrontmatter(doubleQuoteNote, "lit/Ao2024.md");
			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual([
				"Ao, Mengmeng",
				"Zhao, Frank",
				"Feldman, Ronen",
				"Attar, Ilan",
				"Hatskin, Leonid",
				"Rozenfeld, Benjamin",
			]);
			expect(res.updatedContent).not.toContain("**Author**::");
			expect(res.updatedContent).not.toContain("**Title**::");
			expect(res.updatedFm?.title).toBe("Multi-agent Collaboration");
		});

		it("converts concatenated Dataview line with leading space and secondary field ( > **Author**:: ...> **Title**:: ...)", async () => {
			const malformedLineNote = `---
category: literaturenote
citekey: Morris2024
---

> [!info]-
 > **Author**:: Morris, G. Elliott> **Title**:: "The hidden axis: the left-right spectrum has a non-ideology problem"
> **Date**:: 2024-02-01
`;
			const res = await convertDataviewPropsToFrontmatter(malformedLineNote, "lit/Morris2024.md");
			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual(["Morris, G. Elliott"]);
			expect(res.updatedFm?.title).toBe("The hidden axis: the left-right spectrum has a non-ideology problem");
			expect(res.updatedContent).not.toContain("**Author**::");
			expect(res.updatedContent).not.toContain("**Title**::");
		});

		it("converts Creator and Director Dataview fields to authors file property and strips them from callout", async () => {
			const creatorDirectorNote = `---
category: literaturenote
citekey: PodSave2024
---

> [!info]-
> **Creator**:: Favreau, Jon
> **Director**:: Lovett, Jon
> **Title**:: Pod Save America Episode
`;
			const res = await convertDataviewPropsToFrontmatter(creatorDirectorNote, "lit/PodSave2024.md");
			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual(["Favreau, Jon", "Lovett, Jon"]);
			expect(res.updatedContent).not.toContain("**Creator**::");
			expect(res.updatedContent).not.toContain("**Director**::");
		});

		it("converts FirstDirector and FirstProgrammer Dataview fields to authors file property and strips them from callout", async () => {
			const firstFieldsNote = `---
category: literaturenote
citekey: GameDev2024
---

> [!info]-
> **FirstDirector**:: Nolan, Christopher
> **FirstProgrammer**:: Carmack, John
> **Title**:: Tech and Film Innovation
`;
			const res = await convertDataviewPropsToFrontmatter(firstFieldsNote, "lit/GameDev2024.md");
			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual(["Nolan, Christopher", "Carmack, John"]);
			expect(res.updatedContent).not.toContain("**FirstDirector**::");
			expect(res.updatedContent).not.toContain("**FirstProgrammer**::");
		});

		it("converts dynamic First* author creator fields (FirstCreator, FirstArtist) to authors but leaves FirstEditor in callout", async () => {
			const mixedFirstNote = `---
category: literaturenote
citekey: Mixed2024
---

> [!info]-
> **FirstCreator**:: Satoshi, Nakamoto
> **FirstArtist**:: Da Vinci, Leonardo
> **FirstEditor**:: Knuth, Donald
> **Title**:: Genesis Block
`;
			const res = await convertDataviewPropsToFrontmatter(mixedFirstNote, "lit/Mixed2024.md");
			expect(res.success).toBe(true);
			expect(res.updatedFm?.authors).toEqual(["Satoshi, Nakamoto", "Da Vinci, Leonardo"]);
			expect(res.updatedContent).not.toContain("**FirstCreator**::");
			expect(res.updatedContent).not.toContain("**FirstArtist**::");
			expect(res.updatedContent).toContain("**FirstEditor**:: Knuth, Donald");
			expect(res.changesMade).toContain(
				"Left dataview field in callout: 'FirstEditor' (value: \"Knuth, Donald\")"
			);
		});
	});
});


