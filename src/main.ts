import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, WidgetType, EditorView } from "@codemirror/view";
import { createPerplexityNote } from "./note-creator";

interface PerplexitySaverSettings {
  searchesFolder: string;
  generatedTag: string;
}

const DEFAULT_SETTINGS: PerplexitySaverSettings = {
  searchesFolder: "ai-searches",
  generatedTag: "ai-generated",
};

interface InlineInputData {
  pos: number;
  from: number;
  to: number;
  noteContent: string;
  defaultFilename: string;
  activeFile: TFile;
  editorView: EditorView;
}

const startPerplexityInput = StateEffect.define<InlineInputData>();
const clearPerplexityInput = StateEffect.define<null>();

export default class PerplexitySaverPlugin extends Plugin {
  settings: PerplexitySaverSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEditorExtension(perplexityInputStateField(this));

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
    const activeFile = view.file;
    if (!activeFile) {
      new Notice("No active file found.");
      return;
    }

    const cm6View = (editor as any).cm as EditorView;
    if (!cm6View) {
      new Notice("Could not access editor.");
      return;
    }

    const noteContent = await navigator.clipboard.readText();
    if (!noteContent) {
      new Notice("Clipboard is empty. Copy content from Perplexity first.");
      return;
    }

    const selection = cm6View.state.selection.main;
    const hasSelection = selection.from !== selection.to;

    if (hasSelection) {
      const defaultFilename = cm6View.state.doc.sliceString(selection.from, selection.to);
      const pos = selection.from;
      cm6View.dispatch({
        changes: { from: selection.from, to: selection.to, insert: "" },
        effects: startPerplexityInput.of({
          pos,
          from: pos,
          to: pos,
          noteContent,
          defaultFilename,
          activeFile,
          editorView: cm6View,
        }),
      });
    } else {
      const pos = selection.from;
      cm6View.dispatch({
        effects: startPerplexityInput.of({
          pos,
          from: pos,
          to: pos,
          noteContent,
          defaultFilename: "",
          activeFile,
          editorView: cm6View,
        }),
      });
    }
  }
}

class InlineInputWidget extends WidgetType {
  constructor(
    private plugin: PerplexitySaverPlugin,
    private data: InlineInputData
  ) {
    super();
  }

  eq(other: InlineInputWidget): boolean {
    return other.data.pos === this.data.pos;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "perplexity-inline-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter filename...";
    input.value = this.data.defaultFilename;
    input.className = "perplexity-inline-input";
    input.style.marginLeft = "4px";
    input.style.marginRight = "4px";
    input.style.border = "none";
    input.style.borderBottom = "1px solid var(--text-accent)";
    input.style.background = "var(--background-primary-alt)";
    input.style.padding = "2px 6px";
    input.style.minWidth = "200px";

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 10);

    input.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const filename = input.value.trim();
        if (filename) {
          await this.handleSubmit(filename);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.data.editorView.dispatch({
          effects: clearPerplexityInput.of(null),
        });
        this.data.editorView.focus();
      }
    });

    wrap.appendChild(input);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }

  private async handleSubmit(filename: string): Promise<void> {
    const { noteContent, activeFile, editorView, from, to } = this.data;

    const result = await createPerplexityNote({
      app: this.plugin.app,
      activeFile,
      clipboardContent: noteContent,
      filename,
      searchesFolder: this.plugin.settings.searchesFolder,
      generatedTag: this.plugin.settings.generatedTag,
    });

    if (!result.success) {
      new Notice(result.error);
      return;
    }

    editorView.dispatch({
      changes: { from, to, insert: result.linkText },
      effects: clearPerplexityInput.of(null),
    });

    editorView.focus();
    new Notice(`Saved note to ${result.newNotePath}`);
  }
}

function perplexityInputStateField(plugin: PerplexitySaverPlugin) {
  return StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },
    update(value, tr) {
      value = value.map(tr.changes);

      for (const effect of tr.effects) {
        if (effect.is(startPerplexityInput)) {
          const deco = Decoration.widget({
            widget: new InlineInputWidget(plugin, effect.value),
            side: 1,
          });
          return Decoration.set([deco.range(effect.value.pos)]);
        }
        if (effect.is(clearPerplexityInput)) {
          return Decoration.none;
        }
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
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

    new Setting(containerEl)
      .setName("AI save folder")
      .setDesc(
        "The name of the folder where AI notes are stored (relative to the active note)."
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
      .setDesc("The tag inserted into the AI note's frontmatter.")
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
