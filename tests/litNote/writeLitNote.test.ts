import { describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import { createdNotices } from "../__mocks__/obsidian";
import {
	ensureFolder,
	ensureFolderPath,
	ensureWorkspaceReady,
	existingFile,
	notePathFor,
	writeLitNote,
	writeNote,
} from "../../src/litNote/writeLitNote";
import type { ZoteroItemPayload } from "../../src/litNote/types";

function makeMockFile(path: string): TFile {
	return Object.assign(Object.create(TFile.prototype), { path });
}

describe("writeLitNote", () => {
	it("computes note path correctly", () => {
		const settings = { litNotesFolder: "lit/notes" };
		expect(notePathFor(settings, "Smith2020")).toBe("lit/notes/Smith2020.md");
	});

	it("identifies existing file if present", () => {
		const mockFile = makeMockFile("lit/notes/Smith2020.md");
		const app = {
			vault: {
				getAbstractFileByPath: vi.fn((path) => {
					if (path === "lit/notes/Smith2020.md") return mockFile;
					return null;
				}),
			},
		} as unknown as App;

		const settings = { litNotesFolder: "lit/notes" };
		expect(existingFile(app, settings, "Smith2020")).toBe(mockFile);
		expect(existingFile(app, settings, "NotFound")).toBeNull();
	});

	it("creates folder if it does not exist", async () => {
		const createdFolders: string[] = [];
		const app = {
			vault: {
				getAbstractFileByPath: vi.fn(() => null),
				createFolder: vi.fn(async (folder: string) => {
					createdFolders.push(folder);
				}),
			},
		} as unknown as App;

		await ensureFolder(app, { litNotesFolder: "my/folder" });
		expect(createdFolders).toContain("my/folder");
	});

	it("ensures parent folder path for target file", async () => {
		const createdFolders: string[] = [];
		const app = {
			vault: {
				getAbstractFileByPath: vi.fn(() => null),
				createFolder: vi.fn(async (folder: string) => {
					createdFolders.push(folder);
				}),
			},
		} as unknown as App;

		await ensureFolderPath(app, "Scratch Space/lit/notes/MyNote.md");
		expect(createdFolders).toContain("Scratch Space/lit/notes");
	});

	it("waits for workspace to be ready", async () => {
		let registeredCb: (() => void) | null = null;
		const app = {
			workspace: {
				layoutReady: false,
				onLayoutReady: vi.fn((cb: () => void) => {
					registeredCb = cb;
				}),
			},
		} as unknown as App;

		const promise = ensureWorkspaceReady(app);
		expect(app.workspace.onLayoutReady).toHaveBeenCalled();
		if (registeredCb) (registeredCb as () => void)();
		await promise;
	});

	it("creates new file and processes frontmatter in writeLitNote", async () => {
		let createdContent = "";
		let createdPath = "";
		const mockFile = makeMockFile("lit/notes/NewNote.md");
		let fmApplied: Record<string, unknown> = {};

		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn((p) => {
					if (p === "lit/notes/NewNote.md" && createdPath) return mockFile;
					return null;
				}),
				createFolder: vi.fn(),
				create: vi.fn(async (targetPath: string, content: string) => {
					createdPath = targetPath;
					createdContent = content;
					return mockFile;
				}),
			},
			fileManager: {
				processFrontMatter: vi.fn(async (file: TFile, fn: (fm: any) => void) => {
					fn(fmApplied);
				}),
			},
		} as unknown as App;

		const res = await writeLitNote(
			app,
			"lit/notes/NewNote.md",
			"\n> [!info] Callout body",
			{ citekey: "NewNote", title: "New Title" }
		);

		expect(res).toBe(mockFile);
		expect(createdPath).toBe("lit/notes/NewNote.md");
		expect(createdContent).toBe("\n> [!info] Callout body");
		expect(app.fileManager.processFrontMatter).toHaveBeenCalledWith(mockFile, expect.any(Function));
		expect(fmApplied.citekey).toBe("NewNote");
		expect(fmApplied.title).toBe("New Title");
	});

	it("modifies existing file in writeLitNote", async () => {
		const mockFile = makeMockFile("lit/notes/ExistingNote.md");
		let modifiedContent = "";

		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn((p) => {
					if (p === "lit/notes/ExistingNote.md") return mockFile;
					return null;
				}),
				createFolder: vi.fn(),
				modify: vi.fn(async (file: TFile, content: string) => {
					modifiedContent = content;
				}),
			},
			fileManager: {
				processFrontMatter: vi.fn(),
			},
		} as unknown as App;

		const res = await writeLitNote(
			app,
			"lit/notes/ExistingNote.md",
			"---\nkey: val\n---\n\n> [!info] Callout",
			undefined,
			mockFile
		);

		expect(res).toBe(mockFile);
		expect(modifiedContent).toContain("> [!info] Callout");
	});

	it("creates note from Zotero payload using writeNote", async () => {
		const item: ZoteroItemPayload = {
			title: "Sample Article",
			citekey: "Sample2024",
			itemkey: "ABC12345",
			date: "2024-01-01",
		};

		let createdPath = "";
		let createdContent = "";
		const mockFile = makeMockFile("lit/notes/Sample2024.md");
		let fmApplied: Record<string, unknown> = {};

		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn((p) => {
					if (p === "lit/notes/Sample2024.md" && createdPath) return mockFile;
					return null;
				}),
				createFolder: vi.fn(),
				create: vi.fn(async (targetPath: string, content: string) => {
					createdPath = targetPath;
					createdContent = content;
					return mockFile;
				}),
			},
			fileManager: {
				processFrontMatter: vi.fn(async (file: TFile, fn: (fm: any) => void) => {
					fn(fmApplied);
				}),
			},
		} as unknown as App;

		const file = await writeNote(app, { litNotesFolder: "lit/notes" }, item, null);
		expect(file).toBe(mockFile);
		expect(createdPath).toBe("lit/notes/Sample2024.md");
		// Blank line above callout in body
		expect(createdContent.startsWith("\n> [!info]-")).toBe(true);
		expect(fmApplied.citekey).toBe("Sample2024");
		expect(fmApplied.title).toBe("Sample Article");
		expect(fmApplied.tags).toEqual([]);
	});

	it("pops up a warning Notice when unable to create authors file property", async () => {
		createdNotices.length = 0;
		const itemWithoutAuthors: ZoteroItemPayload = {
			title: "No Author Document",
			citekey: "NoAuthor2024",
			creators: [{ firstName: "Donald", lastName: "Knuth", creatorType: "editor" }],
		};

		const mockFile = makeMockFile("lit/notes/NoAuthor2024.md");
		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn(() => mockFile),
				createFolder: vi.fn(),
				modify: vi.fn(),
			},
			fileManager: {
				processFrontMatter: vi.fn(),
			},
		} as unknown as App;

		await writeNote(app, { litNotesFolder: "lit/notes" }, itemWithoutAuthors, mockFile);

		expect(createdNotices.length).toBeGreaterThan(0);
		expect(
			createdNotices.some((n) =>
				n.message.includes("Unable to create authors file property for note 'NoAuthor2024'")
			)
		).toBe(true);
	});

	it("does not pop up a warning Notice when authors file property is successfully created", async () => {
		createdNotices.length = 0;
		const itemWithAuthor: ZoteroItemPayload = {
			title: "Author Document",
			citekey: "WithAuthor2024",
			creators: [{ firstName: "Jane", lastName: "Doe", creatorType: "author" }],
		};

		const mockFile = makeMockFile("lit/notes/WithAuthor2024.md");
		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn(() => mockFile),
				createFolder: vi.fn(),
				modify: vi.fn(),
			},
			fileManager: {
				processFrontMatter: vi.fn(),
			},
		} as unknown as App;

		await writeNote(app, { litNotesFolder: "lit/notes" }, itemWithAuthor, mockFile);

		expect(
			createdNotices.some((n) => n.message.includes("Unable to create authors file property"))
		).toBe(false);
	});

	it("downloads and inserts YouTube transcript when enabled", async () => {
		const ytItem: ZoteroItemPayload = {
			title: "YouTube Lecture",
			citekey: "ytLecture2024",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			creators: [{ firstName: "Richard", lastName: "Feynman", creatorType: "author" }],
		};

		let createdContent = "";
		let createdPath = "";
		const mockFile = makeMockFile("lit/notes/ytLecture2024.md");

		const { requestUrlMock } = await import("../__mocks__/obsidian");
		requestUrlMock.mockImplementation((opts: any) => {
			if (opts.url.includes("youtubei/v1/player")) {
				return Promise.resolve({
					status: 200,
					json: {
						playabilityStatus: { status: "OK" },
						captions: {
							playerCaptionsTracklistRenderer: {
								captionTracks: [
									{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=test" },
								],
							},
						},
					},
					text: "",
				});
			}
			if (opts.url.includes("api/timedtext")) {
				return Promise.resolve({
					status: 200,
					text: `<transcript><text start="0" dur="2">Intro to Physics</text></transcript>`,
				});
			}
			return Promise.reject(new Error("Unknown URL"));
		});

		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn((p) => (p === "lit/notes/ytLecture2024.md" && createdPath ? mockFile : null)),
				createFolder: vi.fn(),
				create: vi.fn(async (targetPath: string, content: string) => {
					createdPath = targetPath;
					createdContent = content;
					return mockFile;
				}),
			},
			fileManager: {
				processFrontMatter: vi.fn(),
			},
		} as unknown as App;

		await writeNote(app, { litNotesFolder: "lit/notes", downloadYoutubeTranscripts: true }, ytItem, null);

		expect(createdContent).toContain("# Transcript");
		expect(createdContent).toContain("[00:00](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0) Intro to Physics");
	});

	it("does not download YouTube transcript when downloadYoutubeTranscripts is false", async () => {
		const ytItem: ZoteroItemPayload = {
			title: "YouTube Lecture Disabled",
			citekey: "ytDisabled2024",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			creators: [{ firstName: "Richard", lastName: "Feynman", creatorType: "author" }],
		};

		let createdContent = "";
		let createdPath = "";
		const mockFile = makeMockFile("lit/notes/ytDisabled2024.md");

		const { requestUrlMock } = await import("../__mocks__/obsidian");
		requestUrlMock.mockClear();

		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn((p) => (p === "lit/notes/ytDisabled2024.md" && createdPath ? mockFile : null)),
				createFolder: vi.fn(),
				create: vi.fn(async (targetPath: string, content: string) => {
					createdPath = targetPath;
					createdContent = content;
					return mockFile;
				}),
			},
			fileManager: {
				processFrontMatter: vi.fn(),
			},
		} as unknown as App;

		await writeNote(app, { litNotesFolder: "lit/notes", downloadYoutubeTranscripts: false }, ytItem, null);

		expect(requestUrlMock).not.toHaveBeenCalled();
		expect(createdContent).not.toContain("# Transcript");
	});

	it("shows warning Notice and still creates note if YouTube transcript download fails", async () => {
		createdNotices.length = 0;
		const ytItem: ZoteroItemPayload = {
			title: "YouTube Lecture Error",
			citekey: "ytError2024",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			creators: [{ firstName: "Richard", lastName: "Feynman", creatorType: "author" }],
		};

		let createdContent = "";
		let createdPath = "";
		const mockFile = makeMockFile("lit/notes/ytError2024.md");

		const { requestUrlMock } = await import("../__mocks__/obsidian");
		requestUrlMock.mockRejectedValueOnce(new Error("Network timeout"));

		const app = {
			workspace: { layoutReady: true },
			vault: {
				getAbstractFileByPath: vi.fn((p) => (p === "lit/notes/ytError2024.md" && createdPath ? mockFile : null)),
				createFolder: vi.fn(),
				create: vi.fn(async (targetPath: string, content: string) => {
					createdPath = targetPath;
					createdContent = content;
					return mockFile;
				}),
			},
			fileManager: {
				processFrontMatter: vi.fn(),
			},
		} as unknown as App;

		await writeNote(app, { litNotesFolder: "lit/notes", downloadYoutubeTranscripts: true }, ytItem, null);

		expect(createdContent).not.toContain("# Transcript");
		expect(
			createdNotices.some((n) => n.message.includes("Could not download YouTube transcript"))
		).toBe(true);
	});
});
