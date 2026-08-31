import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerJumpCommand } from "../../src/commands/jump";
import { registerSyncCommand, registerSyncViaLinkCommand } from "../../src/commands/sync";
import { registerDeleteTurnCommand } from "../../src/commands/delete";
import { registerRelinkSourcesCommand } from "../../src/commands/relink";
import { registerRemoveSourcesWithNoCiteCommand } from "../../src/commands/removeNoCite";
import { registerRemoveSourcesWithNoDialogCommand } from "../../src/commands/removeNoDialog";
import { registerReplaceViaLinkCommand } from "../../src/commands/replace";
import { Notice } from "obsidian";

const mockNoticeInstances: any[] = [];
vi.mock("obsidian", async (importOriginal) => {
	const actual: any = await importOriginal();
	class MockNotice {
		message: string;
		setMessage = vi.fn();
		hide = vi.fn();
		constructor(message: string) {
			this.message = message;
			mockNoticeInstances.push(this);
		}
	}
	class MockSuggestModal {
		setPlaceholder = vi.fn();
		open = vi.fn();
	}
	class MockFuzzySuggestModal {
		setPlaceholder = vi.fn();
		open = vi.fn();
	}
	return {
		...actual,
		Notice: MockNotice,
		SuggestModal: MockSuggestModal,
		FuzzySuggestModal: MockFuzzySuggestModal,
	};
});

describe("Command Context Guards", () => {
	let mockPlugin: any;
	let commands: Map<string, any>;
	let mockEditor: any;
	let mockView: any;

	beforeEach(() => {
		vi.clearAllMocks();
		mockNoticeInstances.length = 0;
		Object.assign(navigator, {
			clipboard: { readText: vi.fn().mockResolvedValue("") },
		});
		commands = new Map();
		mockPlugin = {
			app: {
				vault: { read: vi.fn() },
				metadataCache: { getFileCache: vi.fn() },
			},
			addCommand: vi.fn().mockImplementation((cmd: any) => {
				commands.set(cmd.id, cmd);
			}),
			headlineOptions: vi.fn().mockReturnValue({ method: "lead" }),
			settings: {
				autoFetchSourceTitles: true,
				sourceTitleMaxChars: 100,
				autoRelinkSources: false,
				zoteroPort: 23119,
				litNotesFolder: "",
				minTitleMatchScore: 95,
				collapseBlankLines: true,
				collapsePromptCallouts: true,
			},
		};

		registerJumpCommand(mockPlugin);
		registerSyncCommand(mockPlugin);
		registerSyncViaLinkCommand(mockPlugin);
		registerDeleteTurnCommand(mockPlugin);
		registerRelinkSourcesCommand(mockPlugin);
		registerRemoveSourcesWithNoCiteCommand(mockPlugin);
		registerRemoveSourcesWithNoDialogCommand(mockPlugin);
		registerReplaceViaLinkCommand(mockPlugin);
	});

	describe("Direct commands (must run in AI note)", () => {
		const directCommandIds = [
			"jump-to-turn-response",
			"sync-ai-dialog-from-clipboard",
			"delete-ai-dialog-turn",
			"relink-sources-with-zotero",
			"remove-sources-with-no-cite",
			"remove-sources-with-no-dialog",
		];

		it.each(directCommandIds)("%s shows error Notice when run outside AI note", async (cmdId) => {
			const cmd = commands.get(cmdId);
			expect(cmd).toBeDefined();

			mockEditor = {
				getValue: vi.fn().mockReturnValue("Normal note content without turn anchors"),
				lineCount: vi.fn().mockReturnValue(1),
				getLine: vi.fn().mockReturnValue("Normal note content"),
				getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
			};
			mockView = { file: { path: "normal.md" } };

			await cmd.editorCallback(mockEditor, mockView);

			const noticeMessage = mockNoticeInstances.find(
				(n) => n.message === "This command can only be run within an AI dialog note."
			);
			expect(noticeMessage).toBeDefined();
		});

		it.each(directCommandIds)("%s proceeds without error Notice when run inside AI note", async (cmdId) => {
			const cmd = commands.get(cmdId);
			expect(cmd).toBeDefined();

			const aiNoteContent = `## Heading ^turn-1\n> [!Prompt]-\n> Prompt\n\nResponse`;
			mockEditor = {
				getValue: vi.fn().mockReturnValue(aiNoteContent),
				lineCount: vi.fn().mockReturnValue(4),
				getLine: vi.fn().mockImplementation((i: number) => aiNoteContent.split("\n")[i]),
				getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
			};
			mockView = { file: { path: "ai-note.md" } };
			mockPlugin.app.vault.read.mockResolvedValue(aiNoteContent);

			await cmd.editorCallback(mockEditor, mockView);

			const noticeMessage = mockNoticeInstances.find(
				(n) => n.message === "This command can only be run within an AI dialog note."
			);
			expect(noticeMessage).toBeUndefined();
		});
	});

	describe("Via-link commands (must NOT run inside AI note)", () => {
		const viaLinkCommandIds = [
			"sync-ai-dialog-from-clipboard-via-link",
			"replace-linked-ai-dialog-from-clipboard",
		];

		it.each(viaLinkCommandIds)("%s shows error Notice when run inside AI note", async (cmdId) => {
			const cmd = commands.get(cmdId);
			expect(cmd).toBeDefined();

			const aiNoteContent = `## Heading ^turn-1\n> [!Prompt]-\n> Prompt\n\nResponse`;
			mockEditor = {
				getValue: vi.fn().mockReturnValue(aiNoteContent),
			};
			mockView = { file: { path: "ai-note.md" } };

			await cmd.editorCallback(mockEditor, mockView);

			const noticeMessage = mockNoticeInstances.find(
				(n) => n.message === "This command cannot be run inside an AI dialog note."
			);
			expect(noticeMessage).toBeDefined();
		});

		it.each(viaLinkCommandIds)("%s proceeds past context check when run outside AI note", async (cmdId) => {
			const cmd = commands.get(cmdId);
			expect(cmd).toBeDefined();

			mockEditor = {
				getValue: vi.fn().mockReturnValue("Normal note with [[link]]"),
				getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
			};
			mockView = { file: { path: "normal.md" } };

			await cmd.editorCallback(mockEditor, mockView);

			const noticeMessage = mockNoticeInstances.find(
				(n) => n.message === "This command cannot be run inside an AI dialog note."
			);
			expect(noticeMessage).toBeUndefined();
		});
	});
});
