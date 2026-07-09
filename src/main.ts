import { App, Editor, MarkdownView, Modal, Notice, Plugin, normalizePath, TFile } from "obsidian";

export default class PerplexityDialogSaverPlugin extends Plugin {
  async onload(): Promise<void> {
    this.addCommand({
      id: "save-perplexity-dialog",
      name: "Save Perplexity Dialog",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.saveDialog(editor, view);
      },
    });
  }

  private async saveDialog(editor: Editor, view: MarkdownView): Promise<void> {
    const app = this.app;

    const activeFile = view.file;
    if (!activeFile) {
      new Notice("No active file found.");
      return;
    }

    const clipboardText = await navigator.clipboard.readText();
    if (!clipboardText) {
      new Notice("Clipboard is empty.");
      return;
    }

    const filename = await this.promptForFilename();
    if (!filename) {
      return;
    }

    const activeFolderPath = activeFile.parent ? activeFile.parent.path : "";
    const searchesFolderPath = normalizePath(
      activeFolderPath ? `${activeFolderPath}/ai-searches` : "ai-searches"
    );

    const folderExists = app.vault.getAbstractFileByPath(searchesFolderPath);
    if (!folderExists) {
      await app.vault.createFolder(searchesFolderPath);
    }

    const newNotePath = normalizePath(`${searchesFolderPath}/${filename}.md`);

    const existingFile = app.vault.getAbstractFileByPath(newNotePath);
    if (existingFile) {
      new Notice("A note with that name already exists. Pick a different name.");
      return;
    }

    const newFile: TFile = await app.vault.create(newNotePath, clipboardText);

    await app.fileManager.processFrontMatter(newFile, (fm: Record<string, unknown>) => {
      const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
      if (!tags.includes("ai-generated")) {
        tags.push("ai-generated");
      }
      fm.tags = tags;
    });

    // 1. Refocus the editor to ensure it's active and clean
    view.editor.focus();

    // 2. Grab the true cursor coordinates now that the modal is closed
    const cursor = editor.getCursor();

    // 3. Generate the link
    const linkText = app.fileManager.generateMarkdownLink(newFile, activeFile.path);
    
    // 4. Insert the link inline with no extra spaces or newlines
    editor.replaceRange(linkText, cursor);

    // 5. Explicitly place the cursor at the end of the newly added link text
    editor.setCursor({
      line: cursor.line,
      ch: cursor.ch + linkText.length
    });

    new Notice(`Saved dialog to ${newNotePath}`);
  }

  private promptForFilename(): Promise<string | null> {
    return new Promise((resolve) => {
      const app = this.app;

      class FilenameModal extends Modal {
        constructor(app: App) {
          super(app);
        }

        onOpen(): void {
          const { contentEl } = this;
          contentEl.createEl("h2", { text: "Filename" });

          const input = contentEl.createEl("input", { type: "text" });
          input.style.width = "100%";
          input.focus();

          const submit = () => {
            const value = input.value.trim();
            this.close();
            resolve(value.length > 0 ? value : null);
          };

          // FIXED: Prevent key event bubbling to stop Enter/Escape from bleeding into the editor
          input.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              this.close();
              resolve(null);
            }
          });

          const buttonRow = contentEl.createEl("div");
          buttonRow.style.marginTop = "12px";
          buttonRow.style.textAlign = "right";

          const okButton = buttonRow.createEl("button", { text: "Ok" });
          okButton.style.marginLeft = "8px";
          okButton.addEventListener("click", submit);

          const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
          cancelButton.addEventListener("click", () => {
            this.close();
            resolve(null);
          });
        }

        onClose(): void {
          this.contentEl.empty();
        }
      }

      new FilenameModal(app).open();
    });
  }
}