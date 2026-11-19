# Agent Instructions for this Obsidian plugin template

## Task scope and validation

Cache exact instructions per checkout/task; read guides only for changed areas.
Restore only missing/changed sections after compaction.
- Docs/instructions-only: text/link/format checks, not application tests/builds,
  browsers, installs or consumer sweeps. This qualifies completion gates below.
- Publication-only: reuse green checks/artifacts for unchanged code, dependencies,
  build inputs AND linked commons; validate unchecked pending source once.
- Source changes: targeted iteration tests, required final checks once; reuse
  composite steps and verify their bundle rather than rebundling.
- Userscript-only changes (including related tests): Tampermonkey loads
  `browser-userscript/*.user.js` directly, independently of the Obsidian bundle.
  Run focused userscript tests and syntax checks; do not build or verify `main.js`.
  The full unit suite is required only when plugin source, shared parser behavior,
  or build inputs also change. Update README only when installation instructions
  or user-visible behavior need clarification, not merely for diagnostic logging.
Keep fresh Git branch/identity/message/hook checks and final remote-tip verification.

### Safe Perplexity userscript debugging

Do not launch a personal Chrome profile or import cookies, storage state,
captures, or browser sessions. Start with the userscript, existing tests, and
source inspection. For a live DOM/React question, use
`scripts/perplexity-debug.mjs` with a fresh anonymous Playwright Chromium
context. It must keep private output in browser memory and block POST requests,
authentication navigation, popups, downloads, WebSockets, and service workers.
Do not switch the harness into persistent-profile or authenticated mode.

Read the shared `perplexity-debugging` skill at
`~/.agents/skills/perplexity-debugging/SKILL.md` when it is installed. If it is
missing, treat live browser escalation as blocked rather than copying an old
profile or requesting repeated console paste.

## Shared library: commons

Use commons for workspace/window/tab/focus, per-window timers/clipboard, modal,
search, geometry, page-color and line-flash helpers; never duplicate its
undocumented Obsidian adapters in plugin code. For an owned-area change, consult
the installed module exports and relevant commons guide sections. Change commons
with a regression test if needed, never a local copy. Docs/publication-only work
does not require opening the library or rebuilding its consumers.
Local adoption uses file:../obsidian-commons; obey the library's existing
commons-adoption branch and explicit-ref/tag-disabled publication rules.

## Build verification rule

For changed Obsidian plugin source/build inputs, use the package's fast bundler only during an
actual runtime iteration. At completion, run its production build and required
unit tests once; skip steps already included in the composite build. Record the
build start and verify root main.js is newer and contains a unique changed
literal via the repository verifier or a line-length-safe Node check, not grep
for minified names. Reuse unchanged evidence for docs/publication-only follow-ups.
Never search for a vault, change its link or build/copy from another checkout.

## Native Obsidian APIs

Prefer fileManager.processFrontMatter, metadataCache.getFileCache (remove
frontmatter.position before copying), vault.cachedRead/process, native createEl
and SuggestModal/FuzzySuggestModal over custom YAML/I/O/DOM/pickers. Use the
installed obsidian.d.ts for new/uncertain API signatures, not a full rescan for
already verified calls. Keep esbuild/sample-plugin structure, theme variables and
unload cleanup. Bootstrap official scaffolding/types only in a confirmed blank repo.

## 4. Userscript Maintenance & Anti-Pattern Warnings

For Perplexity export failures, follow
[debug-perplexity-export](.agents/skills/debug-perplexity-export/SKILL.md):
use the authenticated private Playwright corpus and offline replay before asking
the user to paste console diagnostics. Keep profiles and real captures out of Git.

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
  raised via `raiseWindow(...)` / `raiseAndFocus(...)` first, so it is never hidden behind
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

### 1. Window Focusing Across OS Boundaries (moved to `commons/os` `raiseWindow`)
When requests arrive from Zotero via HTTP, Obsidian is in the background and might be minimized or obscured behind maximized windows (such as IDEs or browsers). Native DOM `window.focus()` is blocked by Chromium's anti-focus-stealing policy.

The OS-level window raising and Windows Foreground Lock bypass logic is now owned and tested by `commons/os` (`raiseWindow`) and `commons/workspace` (`focusLeafAndWindow({ raiseWindow })`). It uses Electron's `@electron/remote` main-process `BrowserWindow.focus()` to restore minimized windows, raise the window hosting the target leaf, and bypass the Windows foreground lock across all operating systems without python shell-outs or external script dependencies.

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
- Run `npm run test:run` before declaring a plugin change done; for userscript-only
  changes, follow the focused validation exception under Task scope and validation.

## Literature Note Format History (Read Before Touching Note I/O)

**Current format**: All vault literature notes use YAML frontmatter for all
metadata (`citekey`, `title`, `authors`, `publication_date`, etc.). There are
no Dataview callout-body fields (`> **Author**:: ...`) in any live note.

**Old format (dead)**: Notes previously stored metadata as Dataview inline
fields inside an `> [!info]` callout block. This format is obsolete. Do not
write code that produces it, and do not assume vault notes contain it.

**`src/litNote/calloutFieldParser.ts`**: Parses the old Dataview `Key:: value`
callout-body syntax. Kept only because `src/litNote/dataviewConverter.ts` (the
one-time migration tool) still imports it, which is in turn used by
`tests/litNote/propertyRules.test.ts` to test property-name normalization rules
(unrelated to migration). Do not use `calloutFieldParser.ts` for any new feature
that reads or writes notes.

**`src/litNote/dataviewConverter.ts`**: The one-time migration tool that
converted old Dataview-format notes to frontmatter. Kept because
`tests/litNote/propertyRules.test.ts` uses `convertDataviewPropsToFrontmatter`
and `stringifyOrderedFrontmatter` to test property normalization logic.
Do not use it as a template for new format conversions.

**Test fixtures in `tests/fixtures/litNote/`**: Deleted. They were old-format
input samples for the migration tool and do not reflect current vault notes.
