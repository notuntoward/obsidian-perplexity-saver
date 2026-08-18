# Obsidian Perplexity Saver

This plugin saves conversational threads from Perplexity.ai into your Obsidian vault, retaining proper Markdown formatting, deep-linking citations to footnotes, and generating clean metadata headers for fast search and archival.

It also supports rich integration with Zotero 7 to automatically link your Perplexity sources to your local Zotero library, and allows creating Zotero literature notes directly into Obsidian via a companion Zotero plugin.

---

# Zotero & Literature Note Integration

This plugin serves as the Obsidian backbone for a complete literature note and citation workflow with Zotero. It provides two main features: 
1. **Source Relinking**: Automatically matches and relinks `# Sources` in your Perplexity saves to your local Zotero items or existing literature notes.
2. **Local HTTP Server**: Runs a zero-configuration local server on port `27124` that allows Zotero to instantly push new literature notes directly into your vault.

### Prerequisites & Dependencies
- **Zotero 7** running locally.
- **[Zotero Obsidian Companion](https://github.com/notuntoward/zotero-obsidian-companion)**: The companion plugin installed in Zotero 7. (This provides the "Create Lit Note" button in Zotero).
- **Zotero Local API enabled**: Check `Zotero -> Settings -> Advanced -> Allow other applications on this computer to communicate with Zotero`.
- **Better BibTeX** (optional, highly recommended): Provides reliable citekeys.

### Commands

- **"Relink sources with Zotero"** - manually relinks the current note's `# Sources` section. Shows a live progress notice and reports how many sources were matched (split into Zotero items vs. literature notes). If nothing new matches, the note is left untouched.
- **"Auto-relink sources" setting** - when enabled, relinking runs automatically at the end of **"Import AI dialog from clipboard"** and **"Sync AI dialog from clipboard"** (the two commands that create new turns).

---

# Settings Configuration

### AI Import Settings
- **AI save folder** (default: `ai-searches`): Folder name where notes are created (relative to your currently active note).
- **AI generated tag** (default: `ai-generated`): Tag inserted into the frontmatter.
- **Collapse blank lines** (default: on): Collapses consecutive blank lines into a single blank line to make the note structure clean and dense.
- **Collapse prompt callouts** (default: on): When on, user prompts start collapsed (`> [!Prompt]+`). When off, they start expanded (`> [!Prompt]-`).

### Prompt Heading Formatting
- **Heading max characters** (default: `100`): Maximum length for the summary heading.
- **Prompt heading method** (default: `Lead sentence`): Choice between `Lead sentence` and `TF-IDF ranked sentence`.
- **Heading lead bias** (default: `0.20`): TF-IDF only. Determines how much to favor sentences closer to the start of the prompt.

### Source Link Formatting
- **Auto-fetch source titles** (default: on): Fetches webpage titles for sources that don't already have one, producing clean markdown links instead of bare URLs.
- **Source title max characters** (default: `100`): Maximum length of a fetched source link title, including a possible ellipsis.

### Zotero & Literature Note Relinking
- **Auto-relink sources** (default: off): Automatically run Zotero relinking when importing or syncing new turns.
- **Zotero HTTP Port** (default: `23119`): Local HTTP port for the Zotero 7 Local API.
- **Literature notes folder** (default: `lit/lit_notes`): Vault folder where literature notes reside (and where new notes sent from the Zotero companion plugin are saved). Leave blank to search anywhere in the vault.
- **Minimum title match score** (default: `95`): Minimum similarity score (0-100) required to match an AI source to a Zotero item.
- **Zotero library cache**: Button to clear the in-memory cached Zotero library so the next relink fetches fresh from Zotero.

*(Note: The local HTTP port `27124` that listens for literature notes from Zotero is completely zero-configuration and runs automatically in the background).*

---

# Installation & Setup

### A. Obsidian Plugin Setup
*(See "Building from Source" below if you want to install from source).*

1. Download the latest release from the Releases page.
2. Unzip and copy the folder into your vault under `<your vault>/.obsidian/plugins/`.
3. In Obsidian, go to **Settings -> Community plugins**, disable Restricted mode if needed, refresh the plugin list, and enable **Perplexity Saver**.
4. Go to **Settings -> Hotkeys**, search "Import AI dialog from clipboard", and assign a hotkey (e.g., `Ctrl+Shift+V`).

### B. Perplexity UserScript Setup (Tampermonkey)
To set up the automated boundary-aligning "Direct" exporter:
1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open Tampermonkey's dashboard, click "Create a new script," and replace the default code with the contents of [`browser-userscript/perplexity-obsidian-exporter-direct.user.js`](./browser-userscript/perplexity-obsidian-exporter-direct.user.js) from this repository. Save it.
3. In your browser's extension settings (e.g. `chrome://extensions` -> **Tampermonkey** -> **Details**):
   - Confirm Tampermonkey is enabled.
   - Set **Site access** to **On all sites** (or explicitly permit `https://www.perplexity.ai`).
   - Turn on **Allow access to file URLs** and/or **Allow user scripts** depending on your browser.
4. Reload your Perplexity tab. When you click **Export as Markdown** inside Perplexity, the UserScript will run and process the export automatically.

### C. Gemini Web Clipper Setup
1. Install the official **Obsidian Web Clipper** from your browser's extension store.
2. Open the clipper, click the gear icon to open **Settings**, and set the destination/action to **Clipboard**.

---

# Building from Source

This project uses standard Node.js tooling.

```bash
# 1. Clone the repository
git clone https://github.com/notuntoward/obsidian-perplexity-saver.git
cd obsidian-perplexity-saver

# 2. Install dependencies (requires Node.js 18+)
npm install

# 3. Build the production files
npm run build
```

Once built, you need to manually copy the required distribution files into your Obsidian vault:
1. Create a folder in your vault: `<your_vault>/.obsidian/plugins/perplexity-saver/`
2. Copy the following three files into that new folder:
   - `main.js` (generated by the build)
   - `styles.css` (if it exists)
   - `manifest.json`
3. Restart Obsidian (or reload plugins) and enable it in the Community Plugins tab.

---

# Credits

- Thanks to [Tampermonkey](https://www.tampermonkey.net/) chrome extension
- Zotero connections inspired by [Zotero Bridge](https://github.com/vanakat/zotero-bridge) by vanakat

# Deprecated Workflows & Legacy Interfaces

*The following sections outline older browser extensions and Tampermonkey configurations which are no longer recommended but remain supported for backward compatibility.*

### Complexity Chrome Extension & Older Tampermonkey Script
Previously, exporting multi-turn dialogs from Perplexity required installing the "Complexity" Chrome companion plugin along with an older script. While still functional, this has been deprecated in favor of the **Direct & Robust UserScript** (`perplexity-obsidian-exporter-direct.user.js`), which has zero dependencies, does not require the "Complexity" extension, and operates directly inside Perplexity's native export menu.

If you are still using Complexity:
1. Install the [Complexity](https://github.com/pnd280/complexity) Chrome extension.
2. In Tampermonkey, use the [`browser-userscript/perplexity-obsidian-exporter.user.js`](./browser-userscript/perplexity-obsidian-exporter.user.js) script instead.
3. This adds a floating circular "📝 Copy for Obsidian" button near the bottom right of Perplexity, which triggers the Complexity popup and copies the formatted thread.
