# perplexity-saver — Obsidian Plugin

This plugin automates saving a Perplexity.ai research conversation into Obsidian,
right next to the note you're currently writing, tagged as AI-generated, and
linked back to both the original Perplexity thread and your working note — in a
single hotkey press plus one filename prompt.

---

## Full Workflow

### One-time setup (done once, ever)

1. Install the Tampermonkey browser extension in Chrome.
2. Install the "Perplexity → Obsidian Markdown Exporter" userscript (provided
   separately) into Tampermonkey. This adds a floating "📋 Copy for Obsidian"
   button to every Perplexity.ai page.
3. Install the "Complexity" Chrome extension
   (https://github.com/pnd280/complexity), which adds an export feature to
   Perplexity's UI that the userscript relies on.
4. Build and install this plugin (see "Installation" below).
5. Assign a hotkey to the "Save Perplexity Dialog" command (e.g. Ctrl+Shift+V) via
   Obsidian Settings → Hotkeys.

### Day-to-day usage

1. **Ask your question(s) in Perplexity** as normal — this can be a multi-turn
   dialog.
2. **Click the "📋 Copy for Obsidian" button** (bottom-right of the Perplexity
   page). This triggers Complexity's built-in "Export → Markdown → Copy" flow
   internally, then prepends a visible `[Perplexity](url)` link to the copied
   text and places the final Markdown on your clipboard.
3. **Switch to Obsidian**, and place your cursor in the note you're writing
   (e.g. `topic_note.md`), at the point where you want a link to the saved
   dialog to appear.
4. **Press your assigned hotkey** (e.g. Ctrl+Shift+V).
5. **Type a filename** when prompted, and press Enter (or click Ok).

At this point, the plugin automatically:

- Creates an `ai-searches` subfolder next to `topic_note.md`, if it doesn't
  already exist.
- Creates a new note inside that folder with your chosen filename, containing
  the clipboard content (the Perplexity link plus the full conversation).
- Adds an `ai-generated` tag into that new note's frontmatter (merging with any
  `created`/`modified` fields the Front Matter Timestamps plugin has already
  added).
- Inserts a link to the new note at your cursor position in `topic_note.md`.

You now have: the original Perplexity thread (optionally also saved to a
Perplexity Space, done manually or via the userscript's right-click shortcut),
a segregated Obsidian note tagged as AI-generated with a visible link back to
Perplexity, and a link to that note embedded in your own working note — all from
one click in the browser and one hotkey plus one filename in Obsidian.

### Linking to a specific heading or block instead of the whole note

If you want to link to a specific section of the saved dialog rather than the
whole note, skip using the auto-inserted link for that case. Instead, open the
saved note, right-click the heading or select the block you want, choose
"Copy link to heading" (or "Copy link to block"), and paste that into
`topic_note.md` manually.

---

## Installation (Developer / Build Instructions)

This repo follows the standard Obsidian plugin layout and ships the same
automated checks as the `obsidian-plugin-template` (ESLint, Prettier, tsc,
Vitest, Playwright, CodeQL, Scorecard, Dependabot, release workflow).

### Prerequisites

- Node.js installed (https://nodejs.org)

### Steps

1. Clone this repo and open a terminal in its folder.
2. Install dependencies:
   ```
   npm install
   ```
3. Build the production bundle (runs lint + type-check + esbuild):
   ```
   npm run build
   ```
   This produces a compiled `main.js` file in the repo root.
4. Locate your Obsidian vault folder (it contains a hidden `.obsidian`
   subfolder).
5. Inside the vault, navigate to `.obsidian/plugins/`. Create this folder if it
   doesn't exist.
6. Copy `manifest.json` and the built `main.js` into
   `.obsidian/plugins/perplexity-saver/`. (`styles.css` is not used by
   this plugin and may be omitted.) You do not need `src/`, `package.json`,
   `tsconfig.json`, or `node_modules`.
7. In Obsidian, go to Settings → Community plugins, disable Restricted mode if
   necessary, click the refresh icon, and enable "perplexity-saver".
8. Go to Settings → Hotkeys, search "Save Perplexity Dialog", and assign a
   hotkey.

### Updating the plugin after code changes

1. Edit `src/main.ts`.
2. Run `npm run build` again in the repo folder.
3. Copy the newly generated `main.js` (and `manifest.json` if you bumped the
   version) into the vault's
   `.obsidian/plugins/perplexity-saver/` folder, overwriting the old one.
4. In Obsidian, disable and re-enable the plugin (or restart Obsidian) to load
   the updated code.

### Development workflow

- `npm run dev` — watch `src` and rebuild `main.js` on change (use with the
  Hot Reload community plugin for live updates).
- `npm run lint` — ESLint with zero-warning policy.
- `npm run test:run` — Vitest unit/integration suite (`obsidian` resolves to a
  mock in `tests/__mocks__/obsidian.ts`).
- `npm run test:browser` — Playwright browser regression suite (after
  `npx playwright install chromium`).

### Debugging

Open the developer console with Ctrl+Shift+I (Cmd+Option+I on Mac), select the
Console tab, reproduce the issue, and read any red error text shown there.
