# Obsidian Perplexity Saver

[![Build](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/scorecard.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/notuntoward/obsidian-perplexity-saver/badge)](https://securityscorecards.dev/viewer/?uri=github.com/notuntoward/obsidian-perplexity-saver)

This plugin saves conversational threads from Perplexity.ai into your Obsidian vault, retaining proper Markdown formatting, deep-linking citations to footnotes, and generating clean metadata headers for fast search and archival.

It also supports integration with Zotero to automatically link your Perplexity sources to your local Zotero library, and allows creating Zotero literature notes directly into Obsidian via a companion Zotero plugin.

The literature-note decision and author-format dialogs use the shared
`commons/modal` appearance, with readable unshaded text and responsive actions.

```mermaid
flowchart TD
    %% Use subgraphs to create "rows" for a wrapping/snaking layout
    subgraph Row1 ["Step 1: Save AI Dialog"]
        direction LR
        A["Ask Perplexity<br/>or Gemini"] --> B["Prepare clipboard via browser<br/>(Tampermonkey or Clipper)"]
        B --> C["Press hotkey<br/>in Obsidian"]
        C --> H["Note created in vault<br/>from clipboard, tagged + linked"]
    end

    subgraph Row2 ["Step 2: Auto-Relink AI Sources (Optional)"]
        direction LR
        I{"Auto-Relinker Enabled?"} -->|Yes| J["Query Better BibTeX<br/>(Port 23119)"]
        J --> K["Relink # Sources to<br/>Zotero items or Obsidian Lit Notes"]
        I -->|No| L["Done"]
        K --> L
    end

    %% Connect the end of Row 1 to the start of Row 2
    H --> I

    %% Define the smaller font style
    classDef smallFont font-size:13px;
    class A,B,C,H,I,J,K,L smallFont;
```

```mermaid
flowchart TD
    subgraph Literature Note Flow
    Zot["Zotero Companion<br/>Plugin"] -. "Push Lit Note (Port 27124)" .-> M["Lit Note Server<br/>(in Obsidian)"]
    M -.-> N["Obsidian Vault<br/>(Creates & Opens .md File)"]
    end

    %% Define the smaller font style
    classDef smallFont font-size:13px;
    class M,N,Zot smallFont;
```

---

# Zotero & Literature Note Integration

This plugin serves as the Obsidian backbone for a complete literature note and citation workflow with Zotero. It provides two main features: 
1. **Source Relinking**: Automatically matches and relinks `# Sources` in your Perplexity saves to your local Zotero items or existing literature notes.
2. **Local HTTP Server**: Runs a zero-configuration local server on port `27124` that allows Zotero to instantly push new literature notes directly into your vault.

### Zotero and Obsidian setup

1. Install and enable Perplexity Saver in the Obsidian vault, and install the [Zotero Obsidian Companion](https://github.com/notuntoward/zotero-obsidian-companion#installation) in Zotero 10. Use current versions of both plugins so unresolved file attachments can be reported correctly.
2. In Obsidian, open **Settings → Perplexity Saver → Zotero & Literature Note Relinking** and set **Literature notes folder** to the vault-relative folder for your notes (default `lit/lit_notes`). Keep this vault open with Perplexity Saver enabled. Its local listener uses `127.0.0.1:27124`; no companion port setting is needed. The companion can try to launch Obsidian if it is closed.
3. In Zotero, ensure each item has a **Citation Key**. [Better BibTeX](https://retorque.re/zotero-better-bibtex/installation/) is recommended for generating keys but is optional; you can use or enter keys in Zotero's native field. Without active BBT, the companion shows a one-time recommendation and its **Regen Citation Key** command is unavailable; its settings show BBT's status.
4. For optional **Relink sources with Zotero** functionality, enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero** in Zotero. This local API setting is separate from the literature-note listener. Leave Saver's **Better BibTeX HTTP Port** at `23119` unless Zotero uses another port.

For companion commands and Zotero-side settings, see the [companion README](https://github.com/notuntoward/zotero-obsidian-companion#commands--usage).

### Attachment files and filenames

- **Location:** To include a supported file attachment link in a literature note, the actual Zotero attachment file must be inside the open vault and indexed by Obsidian. Saver links that exact file, not another file with the same name. The supported extensions are `.pdf`, `.html`, `.docx`, `.pptx`, `.epub`, and `.txt`; URL-only attachments are not file links.
- **Stored or linked:** Zotero's stored files normally live in its data directory, often outside the vault. Linked files can point to files inside the vault. Routine note creation does not move attachments. For eligible existing reconciliation errors, Saver can offer a reviewed bulk move when the Zotero and note citekeys match and Zotero's validated Linked Attachment Base Directory is inside the vault. Saver resolves the note's attachment links to actual files. Links to missing or empty files are replaced by Zotero's files. For files with the same basename, the newest non-empty copy wins. When a Zotero file has byte-identical copies, only the copy whose name is closest to Zotero's file-renaming format is kept; the other identical copies go to the Obsidian or Zotero trash. Zotero files are moved into the base directory, and both the Zotero item and the note link the kept files. Files that appear on only one side are never trashed: they are moved into the vault and linked from both the note and the Zotero item. A link to a missing or empty file that no Zotero file replaces is removed from the header, and the empty file is kept. In either case the note gets a red `==🔴…==` explanation below its top callout and the `zotero_note_file_mismatch: true` property. Stored attachments become linked attachments in Zotero; Zotero group-library attachments are not eligible. Conflicting copies with different contents require a choice, and the copy that is not kept is preserved beside the file as a backup. Back up your vault and Zotero data before approving. Do not move Zotero's whole data directory into a synced vault to solve attachment linking; see [Zotero's data-directory safety guidance](https://www.zotero.org/support/preferences/advanced#data_directory_location).
- **Optional ZotMoov:** To move imported files into the vault and link them in Zotero, configure ZotMoov's **Directory to Move Files To** to a folder inside the vault, choose **move** under **File Behavior**, and enable **Automatically Move/Copy Files When Added** if desired. ZotMoov's **copy** mode is a separate backup, not the file Zotero tracks. Check allowed extensions, and back up your library before moving existing files. Zotero group libraries do not support linked files. See [ZotMoov's settings](https://github.com/wileyyugioh/zotmoov/blob/master/docs/SETTINGS_INFO.md) for details.
- **Linked attachment base directory:** In Zotero **Settings → Advanced → Files and Folders**, this optional setting makes linked paths relative to a chosen folder; it does not apply to stored files, move files, or choose ZotMoov's destination. It may be unset for absolute paths. If you use relative paths, set it on each computer to the local folder containing those linked files, and ensure the resolved attachments are inside that computer's open vault. The companion checks this directory against the open vault at startup and when the setting changes, and retries if Obsidian is unavailable. A base directory outside the vault does not prove that every linked file is outside it. See [Zotero's base-directory guidance](https://www.zotero.org/support/preferences/advanced#linked_attachment_base_directory).
- **Optional renaming:** In Zotero's General settings, enable automatic file renaming and, for linked files, **Rename linked files**. To use the citation key as the filename, set the filename format to `{{ citationKey }}`. Zotero applies its own eligibility and file-type rules; it does not necessarily rename every supplementary attachment. See [Zotero's file-renaming documentation](https://www.zotero.org/support/file_renaming).

Saver's settings show the open vault's path and the resolved literature notes folder. The notes folder is vault-relative and does not have to match Zotero's linked attachment base directory. A blank notes-folder setting searches the whole vault and creates new notes at its root.

When creating or overwriting a note, including after choosing Create for a missing note, Saver checks file attachment paths and marks supported attachments unavailable if needed. Warnings explain whether Zotero did not resolve a path, the path is outside the vault, the file is missing, or Obsidian has not indexed it. The companion supplies attachment mode and base-directory information; Saver does not infer a desired destination from the setting. Attachment warnings do not prevent note creation; during reconciliation, unavailable attachments stop the update to preserve existing links. An eligible attachment move appears in the status-bar review groups and requires explicit conflict and backup confirmation; other cases remain for manual repair. Absence of ZotMoov or an unset base directory alone is not an error. Invalid notes-folder paths and write failures are reported as errors with guidance to check Saver's setting and permissions.

To check the setup, select a Zotero item with a citation key and an accessible supported attachment, then choose **Obsidian → Create Lit Note**. Confirm that the note opens in the intended vault and that its attachment link opens the actual file. If it does not, check the warning and the attachment's location before changing settings.

### Updating existing literature notes

With both plugins running, the companion checks Zotero item changes and periodically reconciles citation keys and attachment links, including changes made by Better BibTeX without a Zotero notification. Automatic checks never open a decision dialog: a notice directs you to **Zotero reviews** in Obsidian's status bar. Reviews are grouped by type; select a group to review its notes. The status entry disappears when all reviews are complete. Zotero must be running to prepare reviews using current data. Pending reviews are held in memory and rediscovered by automatic checks after a restart. When citation keys differ, Obsidian shows the key in each app and lets you choose which to keep. Before offering the Obsidian citation key, the companion checks accessible Zotero libraries for matching keys and identifies any other items found; it checks again before changing Zotero. If the check cannot be completed, the update stops with an error. Choosing the Obsidian citation key changes Zotero first; the companion verifies the saved key and checks attachment paths again before continuing. It waits for matching item snapshots, but this is a best-effort settling check, not a signal that other plugins have finished; later changes are checked again. If Obsidian is closed, reconciliation resumes when it is available. The first automatic reconciliation of an older note requires confirmation in Obsidian; unchanged legacy notes can instead be associated with **Update Lit Note**. Notes without a Zotero item key cannot be associated automatically.

The review list also offers bulk actions for missing library URIs and compatible yes-or-no note updates. It shows the count and proposed actions, then asks you to back up the vault and confirm. A URI-only batch does not change attachment links or files; a read-only recheck clears resolved reviews and leaves other differences for review. The status-bar count is the number of notes still needing review, not the number of missing URIs. Each note and Zotero item is checked again before writing; after rechecks, a persistent notice reports the result and directs you back to any remaining reviews. Changed or ambiguous items remain in the review list instead of being guessed. A bulk note update may include moving identical files to Trash when the group explicitly says so; the same reference and content checks used for individual updates still apply. Bulk reviews require the updated companion to be installed and running.

In reconciliation dialogs, click the Zotero item to open it in Zotero. Clicking the Obsidian note closes the dialog and cancels the current review so the note can be edited; after editing, select it again in **Zotero reviews** or choose **Update Lit Note** in Zotero to retry. Any Zotero changes already made are not undone. Copy buttons are available for both citekeys and the Zotero item key; the item key can also be searched in Zotero.

The `zotero_library_uri` note property records which Zotero library contains the item, so items with the same key in different libraries are not confused. Older notes may not have it. Saver asks you to confirm the association before adding it; you do not need to enter it manually.

**Obsidian → Update Lit Note** in Zotero previews metadata and attachment changes before applying them. It preserves personal properties such as tags, read status, linked status and creation date, and retains existing aliases while removing duplicates. Changes to aliases and filenames can affect links. Before a rename, Saver checks Obsidian's indexed backlinks; when any are found, it explains that it cannot determine whether **Automatically update internal links** is enabled. External or unindexed links may exist even when none are found. Review the preview and back up your vault.

When attachment links differ, Obsidian summarizes note-only links, Zotero attachments not linked in the note, and other links to previously managed attachments. Unrelated note links are left alone. The review shows each available choice and labels the note and Zotero files; click a filename to open it in the system's default application. For longer reviews, a filter narrows the displayed items without changing choices in hidden items. These choices change links, not Zotero attachments or files. Kept links that differ from Zotero are reported as unresolved, not as a successful reconciliation. To reconsider a kept link without changing the Zotero item or restarting Zotero, use **Update Lit Note**.

When a note-only attachment and a Zotero attachment have identical bytes, Saver automatically chooses the Zotero file, updates indexed links in that note, and tries to move the redundant file to Trash according to Obsidian's settings. It first checks accessible Zotero libraries, including trashed items, and Obsidian's indexed links. Shared files, uncertain paths or incomplete indexes block removal; external or unindexed references cannot be ruled out. If a check or trash operation fails after the note is changed, the result reports a partial update. Outside the reviewed bulk move, this does not add note-only files to Zotero, remove Zotero attachments, or deduplicate multiple Zotero attachments.

If you choose the Obsidian citekey, Zotero is changed before the note review. The review identifies that change and any attachment file moves observed for the same Zotero attachment item key. Canceling the later review does not undo changes already made in Zotero.

Updates stop with a warning if an attachment cannot be resolved inside the vault, an identity is ambiguous, or the destination filename already exists. Existing attachment links are preserved on an unresolved-file error; fix the setup and retry. The plugins recheck the note and Zotero data before applying an approved update, but changes across two apps are not atomic. An interrupted update can be partial; review both apps before retrying. Overwriting through **Create Lit Note** remains a separate, destructive choice.

When Zotero cannot match a note, the companion reports the Obsidian note path, its Zotero item key, and the Zotero libraries checked or unavailable. For long reports, **View all** opens a searchable list and **Copy report** copies all entries. The report explains how to restore a trashed item or confirm an association in another Zotero library. An item with a different Zotero item key cannot be matched automatically.

Zotero's personal library identity can change when a previously local library is connected to an account. If this happens, automatic reconciliation warns rather than guessing. Run **Update Lit Note** for the item and confirm reassociation only after verifying that the old and new identities refer to the same item.

### Commands

- **"Import AI dialog from clipboard"** - parses clipboard text into a new note with formatted callouts and sources.
- **"Sync AI dialog from clipboard"** - appends new turns to the active note.
- **"Sync linked AI dialog from clipboard"** - identical to the sync command, but runs on the dialog note linked at your current cursor position (e.g. inside `[[My Dialog]]`), allowing you to sync new turns without leaving your referencing note.
- **"Replace linked AI dialog from clipboard"** - completely replaces (overwrites) the AI dialog note linked at your current cursor position with the parsed dialog from your clipboard. Resets turn watermarks and regenerates all dialog turns, citations, and metadata without leaving your referencing note.
- **"Delete AI dialog turn"** - opens a fuzzy-searchable picker of dialog turns in the current note to select a turn to delete, then removes the turn heading, prompt callout, and AI response, automatically cleaning up any orphaned sources in `# Sources` that were only cited by that turn.
- **"Remove sources with no cite"** - scans the active note and removes any sources from the `# Sources` section that are not cited in the AI response of any dialog turn in the note.
- **"Remove sources with no dialog"** - scans the active note and removes any sources from `# Sources` whose referencing dialog turns have been deleted, or updates the ownership list if only some citing turns remain.
- **"Jump to turn response"** - opens a fuzzy-searchable popup of the current dialog's headings, instantly jumping your cursor to the start of the AI's response for the selected turn. The turn you are currently reading is marked with a subtle box.
- **"Relink sources with Zotero"** - manually relinks the current note's `# Sources` section. Shows a live progress notice and reports how many sources were matched (split into Zotero items vs. literature notes). If nothing new matches, the note is left untouched.
- **"Get literature note link"** - inserts a literature note link at your cursor in any note. Opens a fuzzy-searchable picker of your literature notes (scoped to the *Literature notes folder* setting, ranked with recently opened notes first), then a second picker for the link description built from the note's aliases or title. If text is selected when the command runs, it becomes the link description and the second picker is skipped. The inserted wikilink looks like `[[Smith 2020 - Topic|smith2020: Topic]] `, with the citekey's year-disambiguation suffix stripped and a bare citekey description used when the note has no aliases.
Video playback, transcript panels, transcript editing protection and video-note commands have moved to [Watchword](https://github.com/notuntoward/obsidian-watchword). Saver still creates Zotero literature notes and can download their YouTube captions without Watchword. See Watchword's migration instructions before enabling it alongside an older Saver.

# Settings Configuration

### AI Import Settings
- **AI save folder** (default: `ai-searches`): Folder name where notes are created (relative to your currently active note).
- **AI generated tag** (default: `ai-generated`): Tag inserted into the frontmatter.
- **Collapse blank lines** (default: on): Collapses consecutive blank lines into a single blank line to make the note structure clean and dense while keeping one blank line between paragraphs and headings.
- **Collapse prompt callouts** (default: on): When on, user prompts start collapsed (`> [!Prompt]-`). When off, they start expanded (`> [!Prompt]+`).

### Prompt Heading Formatting
- **Heading max characters** (default: `100`): Maximum length for the summary heading, including a possible ellipsis.
- **Prompt heading method** (default: `Lead sentence`): Choice between `Lead sentence` (first sentence that fits, fast) and `TF-IDF ranked sentence` (ranks sentences by term salience with a lead-position prior).
- **Heading lead bias** (default: `0.20`): TF-IDF only. Determines how much to favor sentences closer to the start of the prompt (0 disables it, reasonable range 0.05-0.35).

### Source Link Title Fetching
- **Auto-fetch source titles** (default: on): Fetches webpage titles for sources that don't already have one, producing clean markdown links instead of bare URLs.
- **Source title max characters** (default: `100`): Maximum length of a fetched source link title, including a possible ellipsis.

### Zotero & Literature Note Relinking
- **Auto-relink sources** (default: off): Automatically runs Zotero relinking at the end of commands that generate or modify turns (**Import AI dialog from clipboard**, **Sync AI dialog from clipboard**, and **Replace linked AI dialog from clipboard**).
- **Better BibTeX HTTP port** (default: `23119`): Local HTTP port used to fetch citation metadata from the Zotero Better BibTeX plugin.
- **Literature notes folder** (default: `lit/lit_notes`): Vault folder where literature notes reside (and where new notes sent from the Zotero companion plugin are saved). Leave blank to search anywhere in the vault.
- **Minimum title match score** (default: `95`): Minimum fuzzy similarity score (0-100) required to match an AI source to a Zotero item.
- **Zotero library cache**: Button to clear the in-memory cached Zotero library so the next relink fetches fresh from Zotero.

*(Note: The local HTTP port `27124` that listens for literature notes from Zotero is completely zero-configuration and runs automatically in the background).*

### Literature Note Formatting

- **Validate author name format** (default: off): When enabled, warns before creating a literature note if any author or creator name with **multiple words** is not in `Last, First` format.

  **Why this matters**: Obsidian Bases sorts and filters the `authors` property by the first element of each list entry. For last-name search to work (e.g. finding "Einstein" without knowing "Albert"), names must be stored as `Einstein, Albert` rather than `Albert Einstein`.

  **Mononym exemption**: Single-word names — such as *Aristotle*, *Prince*, or *Voltaire* — are always accepted without a comma. The check only flags multi-word names without commas, which is the ambiguous case where it is unclear which part is the last name.

  **BibTeX Name Parser & Auto-Correction**: When an ambiguous name is detected, the built-in dependency-free BibTeX name parser attempts to recognize the name structure (handling First/Last, Jr/Sr suffixes like `Smith, John Jr`, and Dutch/German `von` particles like `van Beethoven, Ludwig`). When a reliable correction can be identified, the warning dialog presents an **"Auto-correct & create"** option alongside **"Create anyway"**, **"Edit in Zotero"**, and **"Cancel"**.

- **Author name format style** (default: `Last, First`): Configures the author property output style when creating literature notes:
  - `Last, First` (default): Standard catalog order (`Einstein, Albert`).
  - `BibTeX`: Full canonical BibTeX syntax (`von Last, Jr, First`).
  - `First Last`: Natural reading order (`Albert Einstein`).
  - `Last only`: Surname/particle only (`van Beethoven`).
  - `Initials`: First initials with surname (`J. Smith`, `J.-P. Sartre`).

- **Drop 'von' particle** (default: off): When using `Last, First` style, optionally omits lowercase surname particles such as `von`, `van`, or `de la` (producing `Beethoven, Ludwig` instead of `van Beethoven, Ludwig`).

### YouTube transcripts in literature notes

- **Download YouTube transcripts** (default: on): Download available YouTube captions when creating literature notes from Zotero video references. Watchword is not required.
- **Transcript heading** (default: `Transcript`): Heading used when storing captions. Use the same custom heading in Watchword, if installed.
- Caption timing and Markdown storage are shared through `commons/youtube`. Existing transcript notes remain compatible.

---

# Data Formats

### Expected Clipboard Format
The Obsidian plugin parses clipboard content generated by the export scripts. It expects standard Markdown containing:

1. **Metadata Header**: The script must prepend a line starting with `[Perplexity](URL)` at the very beginning of the text to identify the source and trigger the Perplexity parser.
2. **Conversation Turns**: For stock Perplexity exports, prompt/response pairs should be separated by horizontal rules (`---` or `***`). The user's prompt is typically formatted as a Markdown heading (e.g. `# Prompt Text`) or separated by a blank line.
3. **Citations (Optional)**: A trailing section beginning with `# Citations:` or `**Sources:**` containing numbered markdown links (e.g., `[1] https://example.com`).

*(Note: The plugin also supports an annotated format containing `<!-- PPLX-TURN n -->` comments for more precise boundary alignment).*

### Final Saved Note Format
When the plugin imports a dialog, it constructs a highly structured Obsidian note formatted for readability and Zotero integration:

- **Source Metadata**: A clean link to the original conversation at the top of the note.
- **`# Dialog` Section**: The main conversation history.
  - **Prompts** are rendered as Obsidian callouts (e.g. `> [!Prompt]+`) to distinguish them visually from AI text. They are prefixed with a summary heading containing a block reference anchor (e.g. `### Summary of prompt ^t1`).
  - **AI Responses** follow immediately as standard Markdown, with their inline citation markers (e.g. `[1]`) rewritten to point cleanly to the aggregated sources at the bottom.
- **`# Sources` Section**: An aggregated list of all citations used in the conversation, formatted as Obsidian footnotes/links. These can be automatically relinked to Zotero literature notes using the plugin's commands.
- **Footnote navigation**: Ctrl/Cmd-click a footnote marker in the editor to jump to its definition in the same pane, rather than following the source URL. The destination source line is highlighted for two seconds with an accent-tinted background and an accent edge, making it easy to identify among adjacent sources even when the theme's normal text highlight is transparent. Another jump restarts the highlight; editing clears it. In Live Preview, plain clicks also jump when the citation is outside the line being edited. Plain clicks on the editing line and in Source mode remain editing actions; Reading view keeps Obsidian's native behavior. Relinking a definition to a literature note or Zotero does not change this navigation.

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
   - If the older **via Complexity** exporter is installed, disable it so only one exporter handles the page. The Direct exporter does not require the Complexity extension.
3. In your browser's extension settings (e.g. `chrome://extensions` -> **Tampermonkey** -> **Details**):
   - Confirm Tampermonkey is enabled.
   - Set **Site access** to **On all sites** (or explicitly permit `https://www.perplexity.ai`).
   - Turn on **Allow access to file URLs** and/or **Allow user scripts** depending on your browser.
4. Reload your Perplexity tab. Click the floating **Copy for Obsidian** icon beside the composer. It opens Perplexity's native menu and selects **Export as Markdown** for you. That menu is deliberately hidden while the automated export drives it (version 8.19 and later), so the popup does not flash on screen. You can also select **Export as Markdown** manually; both routes use the same capture pipeline.

Version 8.12 brings back the circular Obsidian icon, purple hover feedback and
light/dark glass styling from the older Complexity script, without its extension
dependency. The button follows the composer when the page resizes, moves above
it on narrow screens, and is hidden outside conversation pages. Compact,
theme-aware status messages retain progress/success/error indicators.
Repeated clicks are blocked while an export is pending. Missing menus and
failed exports restore the button for retry; a 60-second timeout prevents a
stuck busy state. Navigating away cancels the pending capture before clipboard
writing. Native menu selection and download interception still work separately.
Use version 8.13 or later: it fixes a missing download-blob registry in 8.12
that caused the "Could not process export" error and prevented busy-state cleanup.

On `/session/` pages, version 8.11 and later restore full prompts that Perplexity omits
from its native Markdown, including long collapsed prompts and quoted context.
Version 8.24 reads the session's complete structured conversation through
Perplexity's same-site thread API, rather than React startup placeholders that
can contain only the first turn. Earlier prompts need not be visible and
**Read more** need not be clicked. Requests follow pagination, with a 15-second
total timeout and limits of 10 pages / 1,000 turns; incomplete or failed requests
leave the clipboard unchanged. Responses and source URL footnotes come from the native export.
Before copying, it checks response text (ignoring formatting/citation syntax),
cited source numbers, every source URL and the conversation's turn order.
It preserves native response formatting; it does not add source-card snippets
or titles that the native export omits.
Version 8.20 also accepts completed answers that omit the web-source block
because they did not use web search, including sessions mixing sourced and
source-free answers. Malformed source blocks and unresolved citations still
fail verification rather than being silently dropped.
Version 8.24 recognizes native Markdown's ASCII punctuation escapes in source
URLs, including `\&`, `\$`, `\_` and `\(`, while keeping changed URL values and
percent-encoded reserved characters distinct. The output retains the structured
URL without Markdown backslashes and decodes HTML entities such as `&amp;`
in API source URLs before verification and output.
Use version 8.26 or later to verify filename-only footnotes for uploaded attachments
against the session's source list and restores their URLs in the copied
Markdown. It does not download or embed the attached files.
Version 8.14 also repairs named citation labels that native export incorrectly
wraps in multiline `$$` math delimiters. It restores the original bracketed
label only when confirmed by the structured answer and followed by a native
footnote reference, preventing broken tables and swallowed footnotes while
preserving actual math and code.
Version 8.15 removes redundant square brackets around confirmed named citation
labels immediately beside footnotes (for example, `[Publisher].[^1_1]` becomes
`Publisher.[^1_1]`). It retains the label text, footnote IDs and source definitions,
and leaves ordinary links and code alone. This cleanup applies to verified
`/session/` exports; the plugin's navigation fix also works with existing notes,
without reimporting them.

If a session is still generating, Perplexity changes its internal data shape,
or the export cannot be matched completely, the script reports an error, leaves
the clipboard unchanged and saves the unmodified native file instead. That file
may still lack prompts; it is not a verified complete conversation. Version 8.16
and later log a single `[PPLX Session Diag]` console entry first, naming the
failed check (source count or order, answer text, citation IDs) with short
head/tail samples of the attempted chunks.
Version 8.22 also reports `unmatched-trailing-content` with the remaining
length and bounded head/tail samples when text remains after all turns match.
Source URLs are compared after
decoding percent-escapes, because Perplexity's native Markdown can contain a
raw space where its structured data uses `%20` (for example
`84 0013_April25.pdf`); version 8.18 writes that encoded form into the note so
the footnote links stay clickable. Existing `/search/` exports retain their
previous processing.

#### Automated userscript debugging

The automated debugging harness uses fresh, anonymous Chromium and never imports
your Chrome profile or sign-in state:

```bash
node scripts/perplexity-debug.mjs --self-test
```

The smoke test checks prompt/response boundaries, paragraphs, citations, and
network restrictions with synthetic content. For a live check, pass an approved
public `/search/` or `/page/` thread URL without credentials, query parameters,
or fragments. HTTP redirects, authentication pages, challenges, POST requests,
popups, downloads, WebSockets, and service workers are stopped rather than bypassed.

The harness keeps the simulated clipboard grant in browser memory and saves no
profile or capture files. It is not an OS sandbox or a substitute for final
Tampermonkey validation. Authentication or real-extension behavior requires an
approved disposable isolated environment.

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

# Troubleshooting & Edge Cases

### Automated userscript debugging

For recurring Perplexity UI/React changes, use the shared `perplexity-debugging`
skill, managed by [kilo-dotfiles](https://github.com/notuntoward/kilo-dotfiles) and
installed by chezmoi at `~/.agents/skills/perplexity-debugging/SKILL.md`.
The repository's `AGENTS.md` directs agents to read it even without native skill
discovery or GitHub Copilot. Agents escalate from focused local checks to a fresh
anonymous browser, without asking you to paste repeated console probes or reuse
a personal login.

Run the network-free harness smoke test with:

```bash
node scripts/perplexity-debug.mjs --self-test
```

The smoke test checks prompt/response boundaries, paragraph and citation
preservation, and request blocking without contacting Perplexity. If Chromium
is missing, run `npx playwright install chromium` first.

For a live check, pass an approved public `/search/` or `/page/` thread URL
without query parameters or a fragment. A second argument can be a trusted
local `.mjs` scenario; without one, the harness does not click Export. Use the
final thread URL directly: HTTP redirects are not followed. If sign-in or a
browser challenge is required, stop rather than reusing a Chrome profile.

The harness uses fresh Chromium, keeps clipboard output in browser memory,
and saves no profiles or captures. It simulates the userscript clipboard grant;
it is not an OS sandbox or a substitute for real Tampermonkey validation.
Private captures and authenticated profiles must stay outside the checkout.

### Multi-Paragraph Prompts and Boundary Detection
Perplexity's markdown exporter fundamentally lacks boundaries between user prompts and AI responses (they are just separated by blank lines). To reliably parse threads, the UserScript must identify the true prompt text by reading Perplexity's internal React state tree or falling back to a DOM sibling scan.

If you edit a multi-paragraph prompt, or if Perplexity breaks the prompt into multiple content blocks in their internal state, the script handles this gracefully by scanning the entire conversation tree for the **longest matching message** that shares the same heading, and unpacking any array-based text blocks. This guarantees that no paragraphs are accidentally orphaned into the AI response.

In the event of a catastrophic scraper failure (where both React state and DOM extraction fail), the script falls back to purely guessing boundaries from the raw Markdown. To ensure that **pages-long prompts** are never accidentally swallowed by the AI response, this text-guesser is strictly bounded: it will only walk backwards over paragraphs that definitively start with known AI intro phrases (e.g., "Here is", "Certainly"), and it will instantly stop if it hits a paragraph ending in a question mark.

---

# Credits

- Thanks to [Tampermonkey](https://www.tampermonkey.net/) chrome extension
- Zotero connections inspired by [Zotero Bridge](https://github.com/vanakat/zotero-bridge) by vanakat
- YouTube transcript downloading based on and inspired by [obsidian-yt-transcript](https://github.com/lstrzepek/obsidian-yt-transcript) (YTranscript) by Łukasz Strzępek

# Deprecated Workflows & Legacy Interfaces

*The following sections outline older browser extensions and Tampermonkey configurations which are no longer recommended but remain supported for backward compatibility.*

### Complexity Chrome Extension & Older Tampermonkey Script
Previously, exporting multi-turn dialogs from Perplexity required installing the "Complexity" Chrome companion plugin along with an older script. While still functional, this has been deprecated in favor of the **Direct & Robust UserScript** (`perplexity-obsidian-exporter-direct.user.js`), which has zero dependencies, does not require the "Complexity" extension, and operates directly inside Perplexity's native export menu.

If you are still using Complexity:
1. Install the [Complexity](https://github.com/pnd280/complexity) Chrome extension.
2. In Tampermonkey, use the [`browser-userscript/perplexity-obsidian-exporter.user.js`](./browser-userscript/perplexity-obsidian-exporter.user.js) script instead.
3. This adds a floating circular "📝 Copy for Obsidian" button near the bottom right of Perplexity, which triggers the Complexity popup and copies the formatted thread.
