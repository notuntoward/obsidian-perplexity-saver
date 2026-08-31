import { App, Editor, Notice, TFile } from "obsidian";
import { relinkSourcesInNote } from "../zotero/relinker";
import { ZoteroClient } from "../zotero/zoteroClient";
import { isAiDialogNote } from "../utils";

export function registerRelinkSourcesCommand(
	plugin: {
		app: App;
		addCommand: (cmd: unknown) => unknown;
		settings: {
			zoteroPort: number;
			litNotesFolder: string;
			minTitleMatchScore: number;
		};
		zoteroClient?: ZoteroClient;
	}
): void {
	plugin.addCommand({
		id: "relink-sources-with-zotero",
		name: "Relink sources with Zotero",
		editorCallback: async (editor: Editor, view: { file?: TFile }) => {
			const file = view.file;
			if (!file) {
				new Notice("No active file.");
				return;
			}

			const noteText = editor.getValue() || (await plugin.app.vault.read(file));
			if (!isAiDialogNote(noteText)) {
				new Notice("This command can only be run within an AI dialog note.");
				return;
			}

			// Create persistent notice (0 timeout) for real-time progress updates
			const notice = new Notice("Relinking sources with Zotero...", 0);
			try {
				const noteText = editor.getValue() || (await plugin.app.vault.read(file));
				const result = await relinkSourcesInNote(plugin.app, noteText, {
					zoteroPort: plugin.settings.zoteroPort,
					litNotesFolder: plugin.settings.litNotesFolder,
					minTitleMatchScore: plugin.settings.minTitleMatchScore,
					zoteroClient: plugin.zoteroClient,
					onProgress: (msg: string) => {
						notice.setMessage(msg);
					},
				});

				if (result.relinkedCount === 0) {
					notice.setMessage("No new Zotero or Literature Note matches found.");
					window.setTimeout(() => notice.hide(), 4000);
					return;
				}

				// Update active CodeMirror editor buffer directly and persist to file
				editor.setValue(result.updatedText);
				await plugin.app.vault.modify(file, result.updatedText);

				notice.setMessage(
					`Relinking complete! Matched ${result.relinkedCount} source(s) (${result.litNoteCount} Lit Note(s), ${result.zoteroCount} Zotero Item(s)).`
				);
				window.setTimeout(() => notice.hide(), 5000);
			} catch (err: any) {
				console.error("Zotero relinking error:", err);
				notice.setMessage(err.message || "Failed to relink sources with Zotero.");
				window.setTimeout(() => notice.hide(), 7000);
			}
		},
	});
}
