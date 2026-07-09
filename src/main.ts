import { App, Editor, MarkdownView, Modal, Notice, Plugin, normalizePath, PluginSettingTab, Setting, TFile } from "obsidian";

interface PerplexitySaverSettings {
  searchesFolder: string;
  generatedTag: string;
}

const DEFAULT_SETTINGS: PerplexitySaverSettings = {
  searchesFolder: "ai-searches",
  generatedTag: "ai-generated",
};

export default class PerplexitySaverPlugin extends Plugin {
  settings: PerplexitySaverSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "save-perplexity-note",
      name: "Save Perplexity Note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.saveNote(editor, view);
      },
    });

    this.addSettingTab(new PerplexitySaverSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async saveNote(editor: Editor, view: MarkdownView): Promise<void> {
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
      activeFolderPath
        ? `${activeFolderPath}/${this.settings.searchesFolder}`
        : this.settings.searchesFolder
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
      if (!tags.includes(this.settings.generatedTag)) {
        tags.push(this.settings.generatedTag);
      }
      fm.tags = tags;
    });

    view.editor.focus();
    const cursor = editor.getCursor();
    const linkText = app.fileManager.generateMarkdownLink(newFile, activeFile.path);
    editor.replaceRange(linkText, cursor);
    editor.setCursor({
      line: cursor.line,
      ch: cursor.ch + linkText.length,
    });

    new Notice(`Saved note to ${newNotePath}`);
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

class PerplexitySaverSettingTab extends PluginSettingTab {
  plugin: PerplexitySaverPlugin;

  constructor(app: App, plugin: PerplexitySaverPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Perplexity Saver Settings" });

    new Setting(containerEl)
      .setName("AI save folder")
      .setDesc(
        "The name of the folder where perplexity notes are stored (relative to the active note)."
      )
      .addText((text) =>
        text
          .setPlaceholder("ai-searches")
          .setValue(this.plugin.settings.searchesFolder)
          .onChange(async (value) => {
            this.plugin.settings.searchesFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AI generated tag")
      .setDesc("The tag inserted into the note's frontmatter.")
      .addText((text) =>
        text
          .setPlaceholder("ai-generated")
          .setValue(this.plugin.settings.generatedTag)
          .onChange(async (value) => {
            this.plugin.settings.generatedTag = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
