# Agent Instructions for this Obsidian plugin template

## Fast Build & Artifact Verification Rules (Speedup Guide for AI Agents)

This project produces a pre-built artifact (`main.js`) that the Obsidian runtime loads directly.
Follow this fast cycle to avoid sluggish multi-turn build/verify bottlenecks:

### 1. Fast Inner-Loop Bundling (Sub-second)
- Run `npm run bundle` (`node esbuild.config.mjs production`).
- This generates `main.js` with an updated build timestamp banner in under 1 second.
- Do NOT run the full `npm run build` during iterative code edits (full build includes lint and typecheck).

### 2. Instant Artifact Verification (`npm run verify`)
- Run `npm run verify -- "<fingerprint>"`.
- This script checks the bundle age and prints the exact byte offset and context snippet without buffer limits.
- **CRITICAL MINIFICATION NOTE**: `esbuild` minifies top-level identifiers and functions (e.g., `myFunction` becomes `Ia` or `Rt`). **Never** grep for TypeScript function or variable names. Always verify against a unique string literal, UI text, error message, or regex snippet added by your edit.
- Example: `npm run verify -- "category: [\"literaturenote\"]"`

### 3. Fast Targeted Testing
- During development, run only the relevant test file or folder to avoid unneeded test runs:
  ```bash
  npx vitest run tests/litNote/
  ```
- Before declaring a task done, run the full test suite: `npm run test:run`.

### 4. Final Completion Gate
Before declaring a task done, verify code health:
- `npm run check` (ESLint with `--cache` + `tsc --noEmit`, passes in ~6-8s).
- `npm run test:run` (Vitest, zero failures).
- `npm run verify -- "<fingerprint>"` (proves `main.js` includes the change).

## Tooling Commands

- Fast bundle: `npm run bundle` (esbuild only, <1s).
- Verify artifact: `npm run verify -- "<fingerprint>"` (checks build timestamp & fingerprint, <100ms).
- Lint: `npm run lint` (ESLint with `--cache` and `eslint-plugin-obsidianmd`, zero warnings).
- Typecheck: `npm run typecheck` (`tsc --noEmit -skipLibCheck`).
- Check all: `npm run check` (runs `lint` and `typecheck`).
- Full CI Build: `npm run build` (runs `check` then `bundle`).
- Unit tests: `npm run test:run` (Vitest). `obsidian` resolves to a mock in `tests/__mocks__/obsidian.ts`.
- Browser tests: `npm run test:browser` (Playwright, requires `npx playwright install chromium`).

## When building an Obsidian plugin inside a git worktree

If the vault loads this plugin via a junction to the main checkout, a build
inside a worktree is not automatically visible to Obsidian. Re-point the vault
junction with the shared relink script, or finish tests in the worktree and
build in the main checkout. See the global rule in `~/.config/kilo/AGENTS.md`.

# Obsidian Plugin Development Rules

## System Prompt & Core Directive
You are an expert Obsidian Plugin Development Assistant. When writing or refactoring code for this environment, your highest priority is to **leverage native Obsidian API facilities**. 

> **CRITICAL RULE:** Do not reinvent the wheel. Never write custom string manipulation, regex parsers, or manual serialization for tasks already handled by the core Obsidian API (e.g., frontmatter/YAML parsing, file reading/writing, DOM generation).

---

## 1. Architectural Constraints & Native APIs

Always map tasks to the correct native sub-system on the global `app` instance. Do not use generic Node.js or browser equivalents if an Obsidian API exists.

| Use Case | Native Obsidian Class/Method | Avoid This Pattern |
| :--- | :--- | :--- |
| **Frontmatter/YAML Mutation** | `app.fileManager.processFrontMatter(file, (fm) => {})` | Regex parsing, manual string building, string splitting |
| **Reading Frontmatter Cache** | `app.metadataCache.getFileCache(file).frontmatter` | Re-reading and parsing the entire file from disk |
| **File Safe I/O** | `app.vault.cachedRead(file)`, `app.vault.process(file, ...)` | Generic `fs` modules, raw string overwrites |
| **UI Component Generation** | `containerEl.createEl()`, `Setting` class | Raw `document.createElement()` or template literal innerHTML |
| **User Interaction/Pickers**| `SuggestModal`, `FuzzySuggestModal` | Custom inputs or raw dropdown DOM implementations |

### Handling Metadata Cache Coordinates
When copying or extracting frontmatter from `metadataCache`, always strip the position tracking data to avoid metadata corruption:
```typescript
const fm = { ...cache.frontmatter };
delete fm.position; // Crucial step before cloning/pasting
```

---

## 2. Project Setup & Environment Discovery

### Cold-Start Protocol (Blank Repository)
If you are initialized in a completely empty or blank repository, **do not attempt to author the environment configurations from scratch.** You must establish the environment using one of the following methods immediately:

1. **Preferred (Template Pull):** Pull the official ecosystem boilerplate directly into the root directory:
   ```bash
   npx degit obsidianmd/obsidian-sample-plugin . --force
   npm install
   ```
2. **Manual Typing Bootstrap:** If you must initialize manually, you must fetch the native API type definitions right away to generate the reference files:
   ```bash
   npm init -y
   npm install --save-dev obsidian
   ```
   *Note: This exposes the API definitions inside `node_modules/obsidian/obsidian.d.ts`.*

### Repository Structure
All active projects must structurally align with the official sample plugin:
* Ensure `esbuild.config.mjs` handles compilation. Do not invent custom build pipelines.
* Distribution requires exactly three core files in the vault plugin directory:
  1. `main.js` (bundled code)
  2. `manifest.json` (plugin metadata)
  3. `styles.css` (if custom styles are required)

### API Reference Protocol
1. **Primary Reference:** Scan `obsidian.d.ts` inside the project root (or inside `node_modules/obsidian/`) before suggesting any method. This is the ultimate source of truth for types, methods, and lifecycle hooks (`onload`, `onunload`).
2. **Online Documentation:** Supplement knowledge using `docs.obsidian.md` for ecosystem guides regarding the leaf/workspace architecture.

---

## 3. UI and DOM Generation Guidelines

* Maintain theme consistency by utilizing built-in CSS variables (e.g., `--text-normal`, `--background-primary`).
* Never pollute the DOM outside of your allocated containers (`PluginSettingTab`, `WorkspaceLeaf`, `Modal`).
* Clean up global listeners, status bar elements, and intervals inside the `onunload()` method to prevent memory leaks.

---

## 4. Userscript Maintenance & Anti-Pattern Warnings

When modifying the Tampermonkey script (`browser-userscript/perplexity-obsidian-exporter-direct.user.js`), be extremely careful when performing deep object traversal across React Hook states or global properties.

> **CRITICAL BROWSER HANG WARNING:**
> React component state (particularly `useRef` hooks) frequently contains raw DOM Elements (e.g. `HTMLDivElement`) or references to the global `window` object. 
> 
> Because DOM nodes are massively interconnected via properties like `parentNode`, `nextSibling`, `children`, and `ownerDocument` (which leads back to `window`), any recursive object traversal logic (like `deepSearch`) MUST explicitly exclude DOM nodes and `window`. 
> 
> If you fail to exclude `Node`, `Element`, and `window` during a recursive search, the script will attempt to search the *entire browser environment*, completely locking up the main thread and hanging the browser tab. 
> 
> **Never remove the DOM/window guards from the `deepSearch` function.**

---

# Zotero ↔ Obsidian lit-note bridge (do not break this contract)

The `Zotero Obsidian Companion` Zotero plugin talks to this plugin's local HTTP
server in `src/litNote/litNoteServer.ts` (`127.0.0.1:27124`).

## Protocol (`POST /lit-note`)

- `{ action: "create", data: ZoteroItemPayload[] }` — create notes. If any
  already exist, prompt once in an Obsidian modal (Overwrite / Open existing /
  Skip / Cancel) before writing.
- `{ action: "open", data: ZoteroItemPayload[] }` — open notes. If any are
  missing, prompt once (Create / Skip / Cancel). Payloads are included so a
  missing note can be created from the Zotero data.
- Legacy `{ action: "open", citekey }` still opens a single existing note and
  never creates.

Response: `{ success, results: [{ citekey, status, error? }] }` where `status`
is `created | overwritten | opened | skipped | missing | error`. The Zotero side
tags items and reports errors from `results`; it no longer shows its own
overwrite dialog.

## Invariants

- The decision prompt MUST stay in Obsidian (`src/litNote/decisionModal.ts`),
  raised via `focusObsidianWindow()` first, so it is never hidden behind
  Obsidian or another window and looks the same in every case.
- Never return a non-200 for an application-level outcome (`exists`, `missing`,
  `skipped`). Only malformed requests (400) and bad routes (404) use other
  codes. This avoids the Zotero client mistaking a normal outcome for a crash.
- Process a batch with one modal per request, not one modal per note.
- `askNoteDecision` serializes prompts; keep that so overlapping requests can't
  stack modals.
- The Zotero client allows up to 120s for these requests because the user may be
  answering the modal. Do not make the server reject slow decisions.
- Do existence checks and writes only after `ensureWorkspaceReady(app)`. During
  a cold start the vault index is unreliable, so an existing note can look new,
  and `vault.create()`/`modify()` can resolve before the index updates.
  `writeNote()` re-resolves the file by path and `openFile()` rejects a null
  file, so a timing race surfaces as a clear error instead of a null `.path`
  TypeError.

## Window Focus and Tab State Invariants (CRITICAL: Do Not Regress)

### 1. Window Focusing Across OS Boundaries (`focusObsidianWindow()`)
When requests arrive from Zotero via HTTP, Obsidian is in the background and might be minimized or obscured behind maximized windows (such as IDEs or browsers). Native DOM `window.focus()` is blocked by Chromium's anti-focus-stealing policy.

On Windows (`win32`), background processes are subject to the **Windows Foreground Lock**:
- Simply calling `SetForegroundWindow()` fails silently (returns `0`), causing only a taskbar flash.
- Calling `ShowWindow(h, SW_RESTORE=9)` on a window that is already open (not minimized) can un-maximize a maximized window.
- Searching windows by title (`"Obsidian"`) or class (`"Chrome_WidgetWin_1"`) alone is dangerous because IDEs (Antigravity/VS Code) or browser tabs researching Obsidian can match before `Obsidian.exe`.

Therefore, the Windows focus logic in `src/litNote/litNoteServer.ts` MUST adhere to the following sequence:
1. Attach to the interactive desktop (`winsta0\default` via `OpenDesktopW('Default', ...)` and `SetThreadDesktop`).
2. Verify process identity: query the process image name via `QueryFullProcessImageNameW` to confirm the window belongs to `obsidian.exe` with class `Chrome_WidgetWin_1`.
3. Check `IsIconic(h)`: if minimized, restore with `ShowWindow(h, SW_RESTORE=9)`. If already open, preserve maximized/restored geometry using `ShowWindow(h, SW_SHOW=5)`.
4. Float to the top of the Z-order: toggle `SetWindowPos` with `HWND_TOPMOST` then `HWND_NOTOPMOST` (`SWP_NOMOVE | SWP_NOSIZE`).
5. **Bypass Foreground Lock**: simulate an Alt-key event (`keybd_event(0x12, 0, 0, 0)` then `keybd_event(0x12, 0, KEYEVENTF_KEYUP=2, 0)`) immediately before calling `SetForegroundWindow()`. This resets the Windows foreground lock timeout.
6. Verify foreground state (`GetForegroundWindow() == h`). If it does not match, exit with code 1 so the shell protocol URI fallback (`start "" "obsidian://open?vault=..."`) executes.

### 2. Note Overwrite and Missing Note Tab Lifecycle
- **Create collisions (`handleCreateBatch`)**: If a note already exists in the vault, before showing the overwrite decision modal, focus the existing note's tab (or open a tab for it if not open) via `openFile(..., { modifyText: false })`. The modal must open directly over the existing note so the user can see what already exists before deciding.
- **Open non-existent notes (`handleOpenBatch`)**: If an open request targets a missing note that can be created from Zotero, create a new blank tab (`app.workspace.getLeaf("tab")`), activate it, and raise the prompt over it.
  - If the user chooses "Create": write the note and populate it inside that blank tab.
  - If the user chooses "Skip", "Cancel", or dismisses the dialog: detach the blank tab (`blankLeaf.detach()`) AND call `restorePreviousLeaf()` to restore the user's previously active tab and editor focus so the user never loses their place.

## Tests

- `tests/litNote/litNoteServer.test.ts` mocks `decisionModal` and drives each
  branch. Add a case for any new status or path.
- `tests/litNote/decisionModal.test.ts` drives the mock `Modal` exported by
  `tests/__mocks__/obsidian.ts` (which exposes `createdModals`). Extend that
  mock rather than re-implementing DOM stubs.
- Run `npm run test:run` before declaring a change done.


