# Zotero Obsidian Companion

Zotero 8/9 plugin that will talk to [Perplexity Saver](https://github.com/notuntoward/obsidian-perplexity-saver).

**Step 0 only:** a hot-reloading skeleton with one right-click menu item that alerts the selected item title. No note create/open yet.

## Dev environment (Windows)

1. Install [Node.js 18+](https://nodejs.org/) if you do not already have it.
2. Create a **separate Zotero development profile** so you do not risk your real library:
   - Close Zotero.
   - Run `C:\Program Files\Zotero\zotero.exe -p` (adjust the path if yours differs).
   - Create a profile named something like `zotero-dev`.
   - Note the profile folder path (Zotero → Help → Debug Output Logging → or look under `%APPDATA%\Zotero\Zotero\Profiles\`).
3. Copy `.env.example` to `.env` and set:

```
ZOTERO_PLUGIN_ZOTERO_BIN_PATH = C:\\Program Files\\Zotero\\zotero.exe
ZOTERO_PLUGIN_PROFILE_PATH = C:\\Users\\scott\\AppData\\Roaming\\Zotero\\Zotero\\Profiles\\xxxxxxxx.zotero-dev
```

Use `\\` in Windows paths.

4. Install and start:

```
cd .scratch-repos/zocompanion
npm install
npm start
```

`npm start` builds the plugin, launches Zotero with the dev profile, and hot-reloads when `src/` or `addon/` changes.

## Verify

1. In the launched Zotero, select one item.
2. Right-click → **Show selected item title**.
3. An alert should show that item's title.

If the menu item is missing, check Tools → Add-ons that **Zotero Obsidian Companion** is enabled.

## Build an XPI without launching Zotero

```
npm run build
```

Output is under `.scaffold/build/`.

## Next

Step 1 will add the HTTP POST that creates a literature note in Obsidian.
