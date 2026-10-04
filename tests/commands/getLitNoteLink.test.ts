import { describe, expect, it, vi } from "vitest";
import {
	LitNoteSelectModal,
	LinkOptionSelectModal,
	buildLinkOptionsForNote,
	getLitNoteInfo,
	parseLitNoteInfo,
	registerGetLitNoteLinkCommand,
} from "../../src/commands/getLitNoteLink";
import { getLitNoteFiles } from "../../src/litNote/litNoteFinder";
import { TFile } from "obsidian";

describe("Get Literature Note Link Command", () => {
	it("registers get-literature-note-link command", () => {
		const commands: any[] = [];
		const mockPlugin: any = {
			app: {},
			addCommand: (cmd: any) => commands.push(cmd),
			settings: { litNotesFolder: "lit/lit_notes" },
		};

		registerGetLitNoteLinkCommand(mockPlugin);
		expect(commands).toHaveLength(1);
		expect(commands[0].id).toBe("get-literature-note-link");
		expect(commands[0].name).toBe("Get literature note link");
	});

	it("sorts literature note files by recency (most recent mtime first)", () => {
		const fileOlder = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Older.md",
			parent: { path: "lit/lit_notes" },
			stat: { mtime: 1000 },
		});
		const fileNewer = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Newer.md",
			parent: { path: "lit/lit_notes" },
			stat: { mtime: 5000 },
		});

		const mockApp: any = {
			vault: {
				getMarkdownFiles: () => [fileOlder, fileNewer],
			},
		};

		const files = getLitNoteFiles(mockApp, "lit/lit_notes");
		expect(files).toHaveLength(2);
		expect(files[0].path).toBe("lit/lit_notes/Newer.md");
		expect(files[1].path).toBe("lit/lit_notes/Older.md");
	});

	it("strictly excludes pdf files, non-markdown files, and source directory files", () => {
		const validMd = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Chen24.md",
			extension: "md",
			parent: { path: "lit/lit_notes" },
			stat: { mtime: 2000 },
		});
		const pdfFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_sources/Tyszler15InformationStrategicVoting.pdf",
			extension: "pdf",
			parent: { path: "lit/lit_sources" },
			stat: { mtime: 3000 },
		});
		const misplacedPdf = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Paper.pdf",
			extension: "pdf",
			parent: { path: "lit/lit_notes" },
			stat: { mtime: 4000 },
		});
		const sourceMd = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_sources/Notes.md",
			extension: "md",
			parent: { path: "lit/lit_sources" },
			stat: { mtime: 1000 },
		});

		const mockApp: any = {
			vault: {
				getMarkdownFiles: () => [validMd, pdfFile, misplacedPdf, sourceMd],
			},
		};

		const files = getLitNoteFiles(mockApp, "lit/lit_notes");
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("lit/lit_notes/Chen24.md");
	});

	it("parses literature note info from note frontmatter and body", async () => {
		const mockFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Chen24.md",
			basename: "Chen24",
		});

		const noteContent = `---
title: "Multi-type concept drift detection"
citekey: Chen24
publication_date: 2024-02-12
aliases:
  - "Multi-type concept drift"
---
`;

		const mockApp: any = {
			vault: {
				read: vi.fn().mockResolvedValue(noteContent),
			},
		};

		const info = await parseLitNoteInfo(mockApp, mockFile);
		expect(info.title).toBe("Multi-type concept drift detection");
		expect(info.citekey).toBe("Chen24");
		expect(info.publication_date).toBe("2024-02-12");
		expect(info.aliases).toEqual([
			"Multi-type concept drift detection",
			"Multi-type concept drift",
		]);
	});

	it("builds Level 2 link options in order: title, then aliases, then citekey", () => {
		const mockFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Chen24.md",
			basename: "Chen24",
		});

		const noteInfo = {
			file: mockFile,
			title: "Multi-type concept drift detection",
			aliases: ["Multi-type concept drift", "Drift detection"],
			citekey: "Chen24",
		};

		const options = buildLinkOptionsForNote(noteInfo);
		expect(options).toHaveLength(4);

		// Option 1: Title
		expect(options[0].displayText).toBe("Multi-type concept drift detection");
		expect(options[0].linkText).toBe("[[Chen24|Multi-type concept drift detection]]");

		// Option 2: Alias 1
		expect(options[1].displayText).toBe("Multi-type concept drift");
		expect(options[1].linkText).toBe("[[Chen24|Multi-type concept drift]]");

		// Option 3: Alias 2
		expect(options[2].displayText).toBe("Drift detection");
		expect(options[2].linkText).toBe("[[Chen24|Drift detection]]");

		// Option 4: Citekey
		expect(options[3].displayText).toBe("Chen24");
		expect(options[3].linkText).toBe("[[Chen24]]");
	});

	it("Level 1 modal displays note title and citekey", () => {
		const mockFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Chen24.md",
			basename: "Chen24",
		});

		const noteInfo = {
			file: mockFile,
			title: "Multi-type concept drift detection",
			aliases: [],
			citekey: "Chen24",
		};

		const modal = new LitNoteSelectModal({} as any, [noteInfo], () => {});
		expect(modal.getItemText(noteInfo)).toBe("Multi-type concept drift detection (Chen24)");
	});

	it("Level 2 modal displays option displayText", () => {
		const option = {
			displayText: "Multi-type concept drift",
			linkText: "[[Chen24|Multi-type concept drift]]",
		};

		const modal = new LinkOptionSelectModal({} as any, [option], () => {});
		expect(modal.getItemText(option)).toBe("Multi-type concept drift");
	});

	it("getLitNoteInfo extracts note metadata synchronously from metadataCache", () => {
		const mockFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Chen24.md",
			basename: "Chen24",
		});

		const mockApp: any = {
			metadataCache: {
				getFileCache: (file: any) => {
					if (file.path === "lit/lit_notes/Chen24.md") {
						return {
							frontmatter: {
								title: "Multi-type concept drift detection",
								citekey: "Chen24",
								publication_date: "2024-02-12",
								aliases: ["Multi-type concept drift"],
							},
						};
					}
					return null;
				},
			},
		};

		const info = getLitNoteInfo(mockApp, mockFile);
		expect(info.title).toBe("Multi-type concept drift detection");
		expect(info.citekey).toBe("Chen24");
		expect(info.publication_date).toBe("2024-02-12");
		expect(info.aliases).toContain("Multi-type concept drift detection");
		expect(info.aliases).toContain("Multi-type concept drift");
		expect(info.displayText).toBe("Multi-type concept drift detection (Chen24)");
	});

	it("parseLitNoteInfo uses metadataCache without reading file from vault", async () => {
		const mockFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Chen24.md",
			basename: "Chen24",
		});

		const readSpy = vi.fn();
		const mockApp: any = {
			vault: {
				read: readSpy,
			},
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						title: "Cached Title",
						citekey: "Chen24",
					},
				}),
			},
		};

		const info = await parseLitNoteInfo(mockApp, mockFile);
		expect(info.title).toBe("Cached Title");
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("editorCallback runs synchronously and opens modal immediately without disk reads", () => {
		const mockFile = Object.assign(Object.create(TFile.prototype), {
			path: "lit/lit_notes/Chen24.md",
			basename: "Chen24",
			extension: "md",
			parent: { path: "lit/lit_notes" },
			stat: { mtime: 1000 },
		});

		const readSpy = vi.fn();
		let openedModal: any = null;
		const openSpy = vi.spyOn(LitNoteSelectModal.prototype, "open").mockImplementation(function (this: any) {
			openedModal = this;
		});

		const commands: any[] = [];
		const mockApp: any = {
			vault: {
				read: readSpy,
				getMarkdownFiles: () => [mockFile],
			},
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						category: ["literaturenote"],
						title: "Fast Title",
						citekey: "Chen24",
					},
				}),
			},
		};

		const mockPlugin: any = {
			app: mockApp,
			addCommand: (cmd: any) => commands.push(cmd),
			settings: { litNotesFolder: "lit/lit_notes" },
		};

		registerGetLitNoteLinkCommand(mockPlugin);
		const command = commands[0];

		// Execute editorCallback synchronously
		command.editorCallback({ replaceSelection: vi.fn() }, {});

		expect(openSpy).toHaveBeenCalled();
		expect(openedModal).toBeInstanceOf(LitNoteSelectModal);
		expect(openedModal.getItems()).toHaveLength(1);
		expect(openedModal.getItems()[0].title).toBe("Fast Title");
		expect(readSpy).not.toHaveBeenCalled();

		openSpy.mockRestore();
	});
});
