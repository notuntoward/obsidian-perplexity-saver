# Obsidian Perplexity Saver

[![Build](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-perplexity-saver/actions/workflows/scorecard.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/notuntoward/obsidian-perplexity-saver/badge)](https://securityscorecards.dev/viewer/?uri=github.com/notuntoward/obsidian-perplexity-saver)

This plugin saves conversational threads from Perplexity.ai into your Obsidian vault, retaining proper Markdown formatting, deep-linking citations to footnotes, and generating clean metadata headers for fast search and archival.

It also supports rich integration with Zotero 7/8/9 to automatically link your Perplexity sources to your local Zotero library, and allows creating Zotero literature notes directly into Obsidian via a companion Zotero plugin.

The time-entry, literature-note decision and author-format dialogs use the shared
`commons/modal` appearance: plain headings, readable unshaded text, aligned form
controls and responsive action rows, following the active Obsidian theme. The time
dialog has a labeled timestamp field with format guidance beneath it; labels stack
above controls on narrow screens. Simple dialogs omit decorative icons and
standard-key shortcut footers. Existing validation, warning actions, prompt
serialization and cancel behavior are unchanged.

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

### Prerequisites & Dependencies
- **Zotero 7/8/9** running locally.
- **[Zotero Obsidian Companion](https://github.com/notuntoward/zotero-obsidian-companion)**: The companion plugin installed in Zotero 7/8/9. (This provides the "Create Lit Note" command, among others, in Zotero).
- **Zotero Local API enabled**: Check `Zotero -> Settings -> Advanced -> Allow other applications on this computer to communicate with Zotero`.
- **Better BibTeX** (optional, highly recommended): Provides reliable citekeys.

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
- **"Get literature note link"** - inserts a literature note link at your cursor in any note. Opens a fuzzy-searchable picker of your literature notes (scoped to the *Literature notes folder* setting, ranked with recently opened notes first), then a second picker for the link description built from the note's aliases or title. The inserted wikilink looks like `[[Smith 2020 - Topic|smith2020: Topic]] `, with the citekey's year-disambiguation suffix stripped and a bare citekey description used when the note has no aliases.
- **"Video: show or hide transcript"** - closes this note's visible transcript, or opens its stored transcript (the section under the *Transcript heading* setting) using *Initial transcript panel location*. The command, viewer's document button and C key share the same toggle, including an explicitly sidebar-placed transcript associated with a pop-out video. Choose **Paragraphs** (the default), **Sentences**, or original YouTube **Captions**. Timing quality is automatic, not a separate format; the old comparison control is removed. Each timestamp links to that moment in the video. Existing saved original-paragraph and word-timed-sentence modes restore as Paragraphs and Sentences respectively. The panel follows when you open another note that has a transcript; a panel whose note already has a loaded player, in any window, stays with that player instead.
  - **Paragraphs**: groups complete punctuation-derived sentences into flowing prose. Confirmed English uses local vocabulary/topic transitions and modest discourse-cue adjustments. Paragraph lengths target about 120 words with a 160-word cap; global balancing helps avoid a tiny leftover tail. A single longer sentence is never split. This is a local formatting heuristic, not semantic understanding or an acoustic pause detector: sentence-start spacing and caption display durations are not used as silence. No extra downloads, Python, models or API calls; choosing this format does not rewrite the note. Every sentence retains its timestamp, playback highlighting, keyboard navigation, search and filtering. Matching saved timings are always reused offline; otherwise caption anchors are used and starts inside a caption are marked **≈**. Switching formats preserves source position without seeking. Successful timing selects **Sentences**; choose **Paragraphs** whenever preferred.
  - **Other or unknown languages**: use the same paragraph-length balancing without English vocabulary or discourse heuristics. Chinese/Japanese use non-whitespace grapheme counts instead, targeting about 300 characters with a 400-character cap; unknown-language text containing those scripts uses character lengths too, without claiming to identify its language. A warning toast explains the fallback and is not repeated on ordinary panel rerenders/reloads. Sentence segmentation uses the saved caption locale when available and maps sentences by character offsets, including unspaced text. When no sentence boundaries are observed across multiple cues and the text has no final sentence-ending punctuation, group whole caption cues instead; the header identifies them as captions. Text without punctuation cannot acquire reliable sentences automatically.
  - **Caption language metadata**: new downloads retain the actual selected track's language in a hidden `<!-- saver-transcript-language: fr -->` comment, including English regional variants. A translated track's `tlang` output language takes precedence over its source language; requesting English does not label a fallback French track English. Missing, invalid, undetermined or conflicting metadata uses the unknown-language fallback, not text-based guessing. Older notes are not modified automatically. If you know an older transcript is English, you can explicitly add `<!-- saver-transcript-language: en -->` under its transcript heading to enable English topic grouping. A fresh caption-timing check also stores the selected output language; offline cache reuse does not guess it. Language annotations do not invalidate existing compact timing fingerprints.
  - **Placement**: direct controls toggle **Show pane tabs and navigation** (pressed when enabled) and name the destination: **→ Beside video** when currently below, **↓ Below video** when beside or in the sidebar. The **Transcript: toggle below / beside video** command flips the current orientation too, including restored panes; from the sidebar it first moves below the video. Right-sidebar placement remains available through *Initial transcript panel location* or an existing bound legacy sidebar shortcut. Moving preserves formatting, filtering preference, selected sentence, follow state and last-search recall; the viewer opens paused if needed. Language-fallback warnings appear once per note/language/fallback type per plugin session, not on every move. The choice applies to this note for the current plugin session, including closing/reopening its panel, without changing the saved default. Obsidian restores open panes normally; restarting Saver clears its per-note session choices.
  - **Pane chrome**: in a non-top, non-stacked tab group containing only the transcript, its redundant tab strip and native title/navigation header are hidden. The transcript remains a normal Obsidian pane with its split divider and workspace restoration. Tabs/header reappear when another tab joins the group; top-of-window controls and stacked tabs stay intact. For native tab dragging or pane menu access, enable **Show pane tabs and navigation** using its toolbar icon (for this pane's lifetime). A custom **X** is available when native pane controls are hidden, avoiding duplicate close controls.
  - **Search**: the search row is hidden when idle. The magnifying-glass button, Ctrl/Cmd+F, **Video: search transcript**, row Escape or a directional search command reveals it. Accepting/cancelling hides it again. Leaving the transcript cancels without stealing focus and retains last-query recall. Clicking search controls or browsing filtered rows within the transcript keeps search open. By default, rows containing all words in any order are matched case-insensitively. *Transcript matching* can instead require a literal phrase. Enter / Shift+Enter (or the arrow buttons) go to the next / previous match in the default Obsidian-style mode; F3 / Shift+F3 work in either mode. **Tab or the checkmark button accepts the selected match without playing**: it clears the search, restores all transcript rows even with filtering enabled, selects that row (so Insert and Copy use it) and focuses it so ↑/↓ browse the surrounding transcript. Ctrl/Cmd+Enter (or the play button) still plays the selected match. The filter button shows only matching rows while searching; the X button cancels.
  - **Keyboard behavior**: choose *Obsidian-style* (Enter next, Shift+Enter previous, Esc accepts) or *Emacs-style* (Enter accepts, Esc cancels), as in Incremental Search. Directional search commands work anywhere in the active transcript pane, including native pane chrome or a blank background without a selected row, then navigate matches on subsequent presses in the search box. In Emacs-style mode, accepting or cancelling remembers the panel's last non-empty query: the next search starts empty, and repeating a directional command before typing recalls that query and selects the next/previous matching row from where search started, wrapping at the ends. The repeat command's direction wins, and typed text is never replaced. Recall uses the same `commons/search` policy as Incremental Search's note/PDF search. They work in either mode and in pop-outs. Ctrl/Cmd+G cancels in either mode, restoring the pre-search row and scroll position; Tab accepts in either mode.
  - **Emacs search hotkey setup (Incremental Search is optional)**:
    - **Using Saver alone, or with Incremental Search disabled:** in **Settings → Hotkeys**, bind **Perplexity Saver: Transcript search: Forward Emacs** and **Transcript search: Reverse Emacs**, for example to Ctrl+S / Ctrl+R. Saver's commands are unassigned by default and work without any other plugin. They act only within the focused transcript panel, not in note editors or PDFs.
    - **Using the [Incremental Search plugin](https://github.com/notuntoward/obsidian-incremental-search):** bind its **Forward Emacs** and **Reverse Emacs** commands instead. Those same shortcuts search notes/PDFs and, when focus is in the transcript panel, start or navigate transcript search through the shared `commons` integration. **Leave Saver's own directional commands unassigned when reusing those keys.** Do not assign Ctrl+S / Ctrl+R (or any identical shortcut) to both plugins: that creates an Obsidian hotkey conflict. Separate, transcript-only shortcuts on Saver are optional if you want them.
    - **If you later disable or uninstall Incremental Search:** assign the desired keys to Saver's commands so transcript navigation remains available.
    - Emacs hints and arrow-button tooltips show Saver's assigned bindings first, otherwise Incremental Search's optional bindings, or **Unassigned** when neither has a binding. There are no hardcoded Ctrl+S/R handlers; use your actual assigned keys.
  - **Keyboard on rows**: clicking a line selects it. ↑/↓ or Ctrl+N/Ctrl+P move between lines; they work whenever the transcript pane has keyboard focus (for example after clicking a toolbar button or switching to the pane), not only after clicking a line: the first press puts the cursor on the playing line, or the first line on screen (after Page Up/Down they start from the lines on screen). Home/End focus the first/last visible line without seeking or starting playback, Enter plays the video from the line, Shift+Enter moves the video there without starting it, Ctrl/Cmd+C copies a timestamp link such as `[1:23](https://www.youtube.com/watch?v=ID&t=83)` to paste into a note (when no text is selected), and Esc clears the selection and returns to the playing line (Ctrl/Cmd+F opens search). If you move to rows without accepting the search, navigation skips filtered-out rows. **More → Keyboard help** toggles hints for the current search/browsing mode; hints take no space by default.
  - **Quiet reading and selection**: Paragraphs contain plain prose, without inline timestamps or moving sentence shading. A subtle gutter marker identifies the playing paragraph; Sentences and Captions retain timestamps and playback shading. Clicking a sentence selects it without seeking; its stable timestamp actions let you insert or copy that sentence's start, independently of playback. Approximate starts remain marked **≈**. Selection stays put as playback advances. Counts and timing information live under **More → Transcript details** rather than in the toolbar.
  - **Following playback**: **Follow video** is on by default, respecting an existing explicit *Follow playback in transcript* preference. It means automatic scrolling, not moving text selection. **Follow video** is a preference that only you change, with its button. While you browse (scrolling, clicking or moving between rows, accepting a search match) or search (from the moment the search box opens), auto-scroll is held: the button stays pressed but its outline and text dim, the panel stays where you put it and a clicked or accepted row is selected. The hold ends, and following resumes at the playing line, when you press **Esc** on a row, click **Follow video** or **Show playing passage**, play from the selected row (Enter), or start playback while a row is selected. It never resumes on a timer. If Follow was off before, it stays off afterwards. Cancelling a search returns to the previous state (and to the playing line if you were following) and does not change the preference. **Show playing passage** is available while auto-scroll is held or following is off. With following on it ends the hold; with following off it reveals the current passage once without enabling follow, seeking, starting playback or replacing your selected sentence. Turning follow on also reveals the current passage. Opening the transcript or clicking a note timestamp still reveals that timestamp even with following off, without changing the follow preference. If no transcript panel is open, a note timestamp opens it as the offline/no-player fallback, except when online with a visible video player.
  - **Transcript-only playback**: when no video player is visible in the panel's window, the transcript shows **Previous · Play/Pause · Next**, then a separate timestamp insertion control. They use the associated playback session without opening a player pane. Insertion uses the selected transcript timestamp when one exists, otherwise current playback. Navigation tooltips identify sentences or captions rather than generic rows.
- **"Video: search transcript"** - puts the cursor in the transcript panel's search box (opening the active note's transcript first if no panel is open).
- **Legacy shortcuts**: the old show-transcript ID still runs the toggle, preserving its hotkey. Redundant **Transcript: move to ...** and viewer-specific transcript-toggle commands register only when they already have assigned hotkeys at plugin startup, with a **legacy shortcut** label. Unbound duplicates disappear; existing hotkey settings are not rewritten. Use the main toggle, orientation, **Video: open or change workspace...** and **Video: cycle panes** commands for new bindings.
- **Video playback commands** remain available for hotkeys in **Settings → Hotkeys**: play or pause, faster / slower / normal speed, screenshots (drag an area or capture the whole picture), copy or insert a timestamp, and open in browser at the current time. **Video: back 10 seconds** and **Video: forward 10 seconds** shift playback without changing its paused/playing state. Playback and timestamp commands work while focus is in the associated note, viewer or transcript. With **Note + transcript**, playback, speed, timestamp copy/insertion and open-in-browser use background audio without opening or focusing a video pane. Transcript row playback and timestamp clicks use that same audio session, and transcript highlighting/following remains active. Screenshot commands require an open video pane and desktop Obsidian.
  - **Video toolbar**: transport (**−10s · Play/Pause · +10s · Speed**), transcript navigation (**↑ Sentence/Caption ↓**), capture (**Insert time · Copy · Screenshot**), then **Transcript · ? · More**. Groups stay together when the toolbar wraps. Time/duration sit quietly beside the timeline, and speed is always visible, including **1×**. **More** contains zoom and open-in-browser. **?** opens persistent, formatted help below the controls: your actual assigned shared shortcuts first, then clearly separated player-only aliases. Close it with **?**, its **X**, or Escape inside the help. Assigned playback shortcuts still do the same thing from the associated note, player and transcript; bare letter/Space aliases remain local to the player so they cannot steal note typing.
  - **Insert timestamp list item** pauses playback and inserts the selected transcript timestamp, or current playback when no associated transcript selection exists. The command, video button and transcript buttons use the same rule even after focus returns to the note. **Video: insert current playback timestamp** explicitly ignores transcript selections. Inserts preserve selected note text and bullet hierarchy, resolve a safe local position, then focus the note and briefly flash the inserted line. See **Automatic insertion placement** below. **Settings → Video viewer → Timestamp list item style** chooses *Match current list* (the default), *Unordered list (-)*, *Ordered list (1.)*, or *Task list (- [ ])*. Ordered items start at `1.` on a blank line.
  - **Insert screenshot** pauses playback, saves an image attachment first, then inserts a timestamped image list item at the same safe tracked note target. Its link uses the captured frame's playback time, not transcript selection. Use the region command to drag a snip, or the whole-picture command to capture immediately. Both preserve the current bullet hierarchy, with the image indented inside the new sibling item, and remain paused; if the note/editor closes during capture, Saver saves the image and copies its embed plus timestamp instead, with an explanatory notice. The original screenshot commands still save and copy the embed plus timestamp for manual pasting.
- **"Video: go to time..."** opens the same timestamp entry used by clicking the player's time display or choosing **More → Go to time...** in the transcript. Enter seconds, `m:ss`, or `h:mm:ss`; Enter seeks, and Escape or Cancel leaves playback unchanged. Invalid times and times past the duration are reported; if the duration is not yet available, wait for the video to load. Seeking preserves play/pause state and also works with transcript-only background playback.
- **"Video: next transcript timestamp" / "Video: previous transcript timestamp"** seek to the next or previous transcript row without wrapping or changing play/pause state. Previous skips the currently playing row rather than restarting it. They use the panel's current captions/paragraphs mode, or stored caption lines when the panel is closed, and work from the associated note, viewer or transcript, including background audio. Existing command IDs and hotkeys are retained. Timestamps written elsewhere in the note remain timeline marks, not transcript navigation targets.
- **Note video workspace control** - any note with a YouTube link has a quiet play-square action in its header. Click **Open video workspace** to restore that note's last workspace (or its initial default); if a requested transcript is missing, the player opens instead. While either associated interface is open, including an inactive tab or pop-out, the icon becomes an X-square and one click **closes the whole video workspace**, exactly like **Video: close player and transcript**. Hidden panes still count as open; visibility never changes what a click does. The adjacent **Video tools** chevron offers **Bring video workspace forward**, checked **Player** / **Transcript** toggles, and **Close video workspace**. With both closed, the menu offers **Open player only** / **Open transcript only**. Controls affect only this note's media, not another note playing the same video. They use the first YouTube link, including unsaved edits; independent sessions for multiple videos in one note are not supported. Nothing is written into the note.
- **"Video: open or change workspace..."** - from a note, its player or transcript, open or show its first video or choose which panes to show. Also available as **Reopen or change video workspace...** in the note's file / more-options menu. The video action appears first; the layout choices include **Reopen last workspace: ...** or **Open initial workspace: ...** when no associated media is open. With media open, the current layout appears first among those choices; **Note only** closes the associated media and returns to the note. Existing command IDs and hotkeys are unchanged.
  - **Initial video workspace** under **YouTube transcripts** is a first-use fallback, not an override of a remembered session. Timestamp links use the same reopening policy as the picker. Choosing another combination replaces the note's remembered configuration without changing the initial default. Saved configurations include nested split orientations, pane proportions, sidebar widths and separate pop-out positions/sizes; they are stored in plugin data, not in the note. Resize or rearrange panes normally to update the saved geometry. **Note only**, closing media together, or closing panes individually retains the last full configuration instead of saving intermediate teardown layouts. Existing open panes remain where you put them; reopening does not replace the entire Obsidian workspace or reopen unrelated notes. The currently open literature note anchors the restored splits.
  - Playback progress is independent of geometry. Reopening through the picker starts paused at zero; **Play...** offers **Resume at …** or **Start from beginning**, and plays only after you choose. Space/K, clicking the picture and the transcript's Play control offer the same choice. A timestamp click instead plays immediately at the **clicked time**, overriding saved progress, and reveals that passage when a transcript is present. Closing without choosing preserves progress. A changed video URL uses the initial workspace and does not inherit another video's configuration or progress.
  - Reuse associated panes and existing playback whenever possible. A hidden media tab sharing the note's tab group is split out so the chosen panes can be visible together. New panes respect **Initial video viewer location**, **Initial transcript panel location**, and the current session's transcript orientation. Transcript-only never opens a video pane, even with a below/beside placement default; audio starts when requested. Switching between audio and a visible player preserves the current position, speed and playing/paused state, without simultaneous playback. **Note only**, closing the transcript and unloading Saver stop background audio and remember its position; reopening after closure starts paused. A transcript whose note has a loaded player, in any window, remains associated with that player, and workspace transcripts stay on their note, rather than following unrelated note opens.
  - Applying a layout returns focus to the literature note for typing. Other notes' media are not closed or repurposed. Missing video/transcript content is reported before closing existing media; cancelling the picker changes nothing. Playback/caption, transcript-following and insertion preferences are unchanged.
- **"Video: cycle panes"** moves focus to the next visible, associated pane in note → video → transcript order, across tab groups and pop-outs. It wraps around; note + video cycles between those two; note + transcript cycles between those two; note alone stays in the note. Background tabs and collapsed sidebars are skipped, not reopened. Existing `cycle-note-video-transcript` hotkey bindings are preserved.
- **"Video: close player and transcript"** finishes a viewing session in one action: close that note's player and transcript, stop background audio, save playback progress and focus the literature note if it is still open. An already-closed note stays closed. Other notes' media and your default workspace layout stay untouched. Use the note-header workspace toggle, the command palette, a hotkey in **Settings → Hotkeys**, or either pane's **More → Close player and transcript** action. Custom close-button clusters have been removed from the player and transcript; use the note's **Video tools** menu to toggle either interface independently, or ordinary pane/tab closing where available. Closing the literature note does not automatically close independent media panes.

The 2px theme-accent focus indicator marks only the player, transcript, or their associated literature note, independently of playback highlighting. The note is eligible only while its player or transcript is visible, including in another window. Unrelated notes and notes with only hidden/background media tabs remain unmarked. **Video note focus indicator** defaults to on and can be disabled.

#### Everyday video note-taking

1. Open a note with a YouTube link and run **Video: open or change workspace...**. Choose **Open video** or **Show open video**, or choose a saved/initial layout below. Clicking a timestamp restores the note's last configuration or initial default, then plays at that timestamp.
2. Choose **Note + video** to watch, **Note + transcript** to listen while reading, or **Note + video + transcript** for both. In transcript-only mode, use **Video: play or pause** or press Enter on a transcript row to start audio; no video pane is added.
3. Use **Video: cycle panes** to move between the panes you chose. It never opens a missing pane. The thin focus line identifies the active pane only within the associated video note-taking session.
4. Choose **Note only** when finished. Media closes and playback stops, but its last pane combination, geometry and playback progress are retained. Picker reopening starts paused; timestamp links explicitly start playback. Switching layouts within an ongoing session retains the playing/paused state.

The initial default is shared across notes; configurations and playback positions are remembered per note and video. Speed is retained during a live layout switch, not saved as a per-note preference. Sessions closed before this feature was installed have no saved geometry: open the desired combination once and adjust it normally.

A freshly reopened transcript-only session does not repurpose another note's video pane. Starting its audio pauses other playing video panes in the same window to avoid overlapping playback, leaving their files and geometry untouched. Starting one of those players again stops the background audio.

#### Video and transcript on separate windows or monitors

Obsidian panes can live in separate windows, and those windows can be moved to different monitors. Saver keeps a note's player and transcript in one session even when they are in different windows.

1. Set **Settings → Video viewer → Initial video viewer location** to **New window**. The player opens in a pop-out window; drag that window to the monitor you want.
2. Drag the transcript tab to the window or monitor you want. With a pop-out player, **Initial transcript panel location → Right sidebar** opens the transcript beside the player in that pop-out; drag it to the main window (or another monitor) to keep it separate.
3. Open the note normally. Opening a different note does not move a transcript whose note already has a loaded player, in any window.
4. Use **Video: open or change workspace...** from the note, its player or its transcript to add or close panes. **Note only** closes the associated media and remembers the position.
5. Clicking a timestamp link, pressing Enter on a transcript row, or using the transcript toolbar drives the note's player in whichever window it lives. It does not open a second player or start duplicate background audio.

For a three-monitor setup, leave the note in the main window and put the video on one monitor and the transcript on another. The transcript-only transport controls stay available when the player is in a different window, so you can control playback from the transcript's monitor. If you move the transcript into the same window as the player, those redundant controls hide.

**Video: cycle panes** includes panes across windows, and the focus indicator shows the active pane in a pop-out. Closing the player leaves the transcript as a standalone panel; reopening the note's player reattaches it. Closing the transcript with **Note only** stops playback and remembers the position.

#### Suggested hotkeys for the Main vault

These are suggestions, not plugin defaults; assign them in **Settings → Hotkeys**. The right column records the current Main-vault assignments so existing muscle memory can be retained. The candidate shortcuts were checked against that vault's current `hotkeys.json`.

| Priority | Action | Suggested shortcut | Main vault now |
|---|---|---|---|
| Highest | Play/pause | `Ctrl+Shift+Space` | `Ctrl+ContextMenu` |
| High | Cycle note → video → transcript | `Alt+V` | `Alt+V` |
| High | Insert timestamp list item | `Alt+Shift+T` | Unassigned |
| High | Insert screenshot snip | `Alt+Shift+S` | Unassigned |
| Medium | Copy timestamp | `Ctrl+Alt+T` | Same |
| Lower | Insert whole-frame screenshot | `Ctrl+Alt+Shift+S` | Unassigned |

`Alt+P`, `Alt+T`, and `Alt+S` already have other assignments in the Main vault, so these suggestions avoid those collisions. Unmodified `Alt+Left/Right` continue to navigate Obsidian history there.

### Native YouTube caption timing

All transcript downloads use **JSON3**, fetched directly by the plugin. The same
caption data supplies text, punctuation, caption times and available native word
offsets. There are no XML/SRT/VTT downloads, Python helpers, audio downloads,
WhisperX, yt-dlp, FFmpeg or model installations. Existing local environments are
not used or removed automatically.

The previous implementations are preserved on GitHub:
[WhisperX sentence alignment](https://github.com/notuntoward/obsidian-perplexity-saver/tree/archive/whisperx-sentence-alignment)
and [Jev sentence alignment](https://github.com/notuntoward/obsidian-perplexity-saver/tree/archive/jev-sentence-alignment).

**New notes:** every download stores native word offsets alongside each caption
automatically, without a second fetch or transcript. The obsolete **Transcript
detail** setting and lossy **5-caption blocks** download path have been removed;
previously saved storage preferences cannot discard native timing.
Caption, sentence and readable-paragraph views are derived locally from the
stored transcript. JSON3 does not repair missing or incorrect punctuation.

Existing notes are not rewritten automatically. Block transcripts can
repeat approximate sentence timestamps because their word offsets were discarded.
Before this fix, a saved block-format preference also affected newly created notes.
Use **Get timings** below to recover word offsets from JSON3. The existing
confirmation appears before downloading; when wording or usable bounds differ,
replacement still requires explicit approval and preserves other note sections.

Saved word offsets are used automatically in sentence and paragraph views.
Opening a YouTube transcript without usable saved word timings offers an
**Transcript timing needs repair** popup, including when restoring the active note
after plugin reload. Declining does not download or write anything; the same
transcript is offered only once per plugin session. Healthy saved timings do not
trigger the popup. Choose **Redownload transcript** to fetch native captions and
replace only the transcript section, or **Cancel** to leave the note alone.
There is no timing opt-in setting, and old saved off preferences cannot hide repair.
Older notes without native timings still work with caption anchors:

1. Use the opening popup. After dismissing it, the existing **More -> Get timings** action and **Transcript: time sentences from YouTube captions** command can offer it again.
2. Confirm **Redownload transcript** to fetch JSON3. No note text is
   uploaded and there is no inference or API charge.
3. If wording or caption bounds differ, explicitly choose **Cancel** or
   **Replace transcript**. Replacement uses the fetched captions, their output
   language and native timings. Other sections and properties survive; errors,
   cancellation or concurrent body edits prevent applying new results.
4. Success selects **Sentences** without seeking or starting playback.
   Search, filtering, keyboard controls and paragraphs remain available.
   Cancellation prevents saving, although an in-flight Obsidian HTTP
   request may finish. Existing timing/cancel command IDs retain their hotkeys.

**Timing and uncertainty.** The first word of a caption uses its original start.
A JSON3 segment offset times only the first word in that segment, not every word
inside a multiword segment. Missing offsets stay missing: sentence starts without
a usable native offset are marked **approximately (`≈`)**. Estimates use a known
word in the sentence or a preceding timing, never earlier than the current caption
anchor. Unspaced sentences retain their own caption anchors; unsupported starts
inside a whitespace timing token remain approximate. Missing internal word offsets
do not make a known sentence start approximate. Reversed or out-of-bound offsets
are rejected, while native starts tied at the next caption boundary are preserved.
Native timestamps are YouTube's timings, not verified acoustic boundaries.

**Compact offline storage.** Existing timestamp-link titles hold relative
millisecond offsets; `?` means a missing word start:

```markdown
[0:12](https://youtu.be/abcdefghijk?t=12 "12-14; w=0,?,900,?") We left. We stayed.
```

One `<!-- saver-word-timing:1 SOURCE_SHA256 -->` comment records a source
fingerprint. The caption language has its own hidden comment. No large timing
Properties or second transcript are created. Editing text, cue times or links
invalidates saved timings; unrelated note edits and language annotations do not.

**Compatibility:** existing untimed captions, legacy blocks, compact timings and
matching version-2 `whisperx_transcript` caches remain readable offline, including
previously accepted acoustic tuples. No new acoustic timings are produced.
**Compact saved timings** migrates an old property offline: save and verify the
body copy before removing only that property. Failed cleanup retains both copies
for retry; unrelated properties, including old Jev data, are untouched. No bulk
note migration or automatic transcript replacement occurs.

YouTube can reject a request or supply no usable captions; this is reported rather
than falling back to audio or another transcript format. Playback still requires
network access. These changes do not establish a fix for the separately reported
Properties freeze.

### YouTube video viewer

The picture area stays 16:9 instead of stretching to fill a tall pane; controls sit directly below it. Whole-picture screenshots capture this area, not unused pane space. Letterboxing or black backgrounds inherent to the video remain intact; non-16:9 videos may still have bars inside the YouTube player.

Clicking a YouTube link that has a time (`&t=83`, `?t=1m23s`, `#t=83`) plays at that moment in the note's viewing workspace. This works in reading view, live preview and the transcript panel. With only the note open, Saver restores its last pane combination and geometry, or uses **Initial video workspace** if none is saved. A remembered/initial **Note + transcript** session plays background audio without adding a video pane; **Note + video + transcript** opens both media panes and reveals the clicked passage. Existing sessions keep their current configuration, including a transcript you deliberately closed. Ctrl/Cmd-click does the opposite of *Timestamp link click*. Picker reopening and Obsidian startup restoration do not start playback. Seeking with viewer controls preserves paused/playing state; playing a transcript search match starts playback, accepting one does not. Stored transcripts remain an offline fallback when no transcript is open and playback is unavailable.

- **Timestamp and screenshot toolbar actions**: timestamps have separate **Insert time** and **Copy** buttons, without an alternatives menu. In **Settings → Video viewer → Toolbar screenshot action**, choose **Insert into note** (the default, including existing installations without an explicit choice) or **Copy to clipboard** for the camera only. Existing saved choices are retained. Explicitly named copy and insert commands keep their behavior, and camera labels update without reopening the viewer.
  - **Timestamp buttons**: the video button displays the time it will insert, such as **Insert 12:43**. It and **Video: insert timestamp list item** use an explicit selection in a visible transcript for the associated note/video, otherwise current playback. The transcript's selected-sentence button uses the same resolution without seeking the player. Conflicting selections in multiple visible panels are reported instead of guessed; hidden panels and selections for other notes/videos are ignored. The adjacent copy icon still copies current playback.
  - **Camera icon**: click to select an area; **Shift-click** captures the whole picture immediately using the selected destination. Shift changes the capture area, not copy versus insert. Right-click or use the adjacent arrow for **Insert selected area into note...**, **Copy selected area...**, **Insert whole picture into note**, and **Copy whole picture**; these explicitly choose both area and destination, regardless of the setting or Shift.
  - **Insertion** works in any associated Markdown note, not only literature notes. When it is open in Source mode or Live Preview, insertion pauses playback, preserves selected text and bullet hierarchy, resolves a safe position near the tracked cursor, then returns focus to that note and flashes the inserted line. Screenshot commands, the camera's insert action and its explicit insert menu choices use the same placement and captured-frame timestamp, never a different selected transcript time. Video identity and playback time are frozen together for the captured frame, so changes while saving cannot relabel its link. Screenshot insertions remain paused. Successful insertion leaves the clipboard unchanged; unavailable targets use the explicit clipboard fallback below.

### Automatic insertion placement

- Inside a list item, insert the next sibling after all its sub-items; reuse an empty item and continue ordered numbering. Inside a paragraph, insert after the complete paragraph. On a heading, insert first under that heading.
- Inside a quote, callout, code block or table, insert outside the complete block. Continue an immediately following list when available; otherwise start a list immediately below. Never jump across prose or a later heading to find a list. A quote inside a list item gets a sibling outside the containing item.
- With the cursor at the top, in properties or in the transcript, use the initial notes area instead of the document's last block. Continue its first adjacent list, or create a safe list without entering a later section. Ordinary notes need no callout or quote: a leading list is continued, or insertion goes after the opening paragraph (below an initial heading when present).
- A literature note is identified by explicit frontmatter `category: literaturenote`, as a string or array entry (case-insensitive), using Obsidian's metadata cache. A folder, filename, quote or callout alone is not proof. Missing category/cache uses ordinary-note rules and never prevents video use. Only a confirmed literature note with a leading info callout gets source-preamble handling: skip that callout, bibliography quotes and an optional imported Zotero-note callout/divider; continue the immediately following notes list, otherwise start a list below the preamble.
- A notice explains redirected placement. All automatic timestamp/image insertions remain one undoable editor change. A malformed block crossing the transcript boundary is reported rather than inserting into the transcript.
- **Insertion target marker**: while the associated note editor is unfocused, an accent line and **Next insert below / above / here** label show the same adjusted target used by insertion. The marker follows edits and the cursor; a pending screenshot keeps its original tracked anchor. It hides while editing, does not alter Markdown, move the cursor, scroll or unfold the note, and disappears for an unavailable or ambiguous target. Off-screen/folded locations remain off-screen/folded until insertion. Disable it with **Settings → Video viewer → Show insertion target**.
- **Clipboard fallback**: if the associated note is missing, closed, in Reading view, read-only, or has multiple editors without an explicitly focused target, copy instead of guessing. A timestamp copies the resolved timestamp as a list item using the configured list style; a screenshot still saves its attachment and copies an image embed plus the captured-frame timestamp. This also applies if the note or capture anchor becomes unavailable while saving. A notice says **copied to clipboard instead**, why, and where the image was saved. Playback stays paused and the clipboard is replaced only by the fallback; cancelling an area selection does not save or copy. Clipboard failure is reported explicitly. If an editor error happens after the note has changed, nothing is copied: check the note before retrying to avoid duplicates. Conflicting transcript selections or an unavailable time still require correction rather than copying a guessed timestamp.
- **Copy timestamp**: the toolbar's copy action and **Video: copy current timestamp** command pause playback at the current position and copy it as plain-text Markdown, without moving focus. In **Settings → Video viewer → Copy current timestamp format**, choose **Timestamp link only** (the default, `[1:23](https://www.youtube.com/watch?v=ID&t=83)`) or **List item**, which copies `- [1:23](https://www.youtube.com/watch?v=ID&t=83): ` including a trailing space. Paste a list item into an editable note to leave the cursor after `: `, outside the link, ready to type a plain-text description. This setting does not change direct insertions, transcript-row copies or screenshot copies.

#### Keyboard timestamps and optional Steady Links integration

- **Without Steady Links:** put the editor cursor on a timestamp link and invoke Obsidian's **Follow link under cursor** command, normally **Alt+Enter** on Windows/Linux or **Option+Enter** on macOS. Its assigned shortcut can be changed in Settings → Hotkeys. Saver routes that native command through the same workspace restoration and timestamp playback as a mouse click when *Timestamp link click* is set to *Play in the note's video workspace*. Plain Enter still inserts a newline; Saver does not take it over.
- **With [Steady Links](https://github.com/notuntoward/obsidian-steady-links):** its existing plain-Enter behavior in Live Preview also opens timestamp links in Saver's viewer. Keep *Keep links steady* enabled and place an unselected cursor inside the link. Its existing boundaries, selection, suggestion and IME rules are unchanged. At the link's outer edge, Enter still inserts a newline. Modified-Enter commands retain their native behavior; the native *Follow link under cursor* command is the one Saver intercepts.
- **Optional handshake:** Steady Links offers a cancelable, bubbling `commons:link-activation` event from the owning editor's `contentDOM`. Saver listens in each window, reads the link at that editor's cursor, and claims only supported YouTube URLs with an explicit timestamp. If Saver is missing/disabled, the URL is not a timestamp, or the setting chooses the browser, Steady Links falls back to Obsidian's normal link following. Neither plugin imports from or requires the other.
- Saver also uses this same handshake for native keyboard activation without Steady Links. Native availability checks never start playback. The native command adapter is restored when Saver unloads, and receivers are removed on window close/plugin unload. Ordinary wikilinks, other websites, and video links without timestamps are not claimed. The native editor token check prevents URLs in code or non-link text from being treated as links. Mouse Ctrl/Cmd-click retains its opposite-action behavior.

- **Controls**: The viewer toolbar provides back/forward 10 s, play/pause, current time, playback speed, zoom, timestamp copy/insert, open in browser, screenshot copy/insert, previous/next transcript row, and show/hide transcript. Use the commands listed above for supported hotkeys; the toolbar action setting does not change those commands.
- **Video pane header**: the redundant native Video navigation row is hidden; the top tab strip remains available for dragging, closing and window controls. When native window buttons overlay that strip, it retains at least Obsidian's header height so shorter-tab snippets cannot let the close button cover the video's corner. Other tab groups and fullscreen remain compact. Keyboard focus is marked by a non-interactive 2px accent at the pane's top edge without taking extra space.
- **Keyboard**: click the picture (or Tab into the viewer) to give it keyboard focus. Space/K play-pause, J/L ±10 s, ←/→ ±5 s, Page Up/Page Down ±1 minute, Home/End start/end, `[`/`]` previous/next transcript timestamp, `<`/`>` slower/faster, `+`/`-` zoom, `0` reset zoom, C show/hide transcript. Tab moves through the buttons (Enter or Space presses the focused one; the speed button opens its menu, which arrow keys navigate) and the timeline, which is a slider (arrows move ±5 s).
- **Open in browser**: the external-link button pauses the viewer and opens the video in your web browser at the current time.
- **Speed**: the gauge button opens a menu of speeds (0.25×-2×); the mouse wheel over it, or `<`/`>`, steps the speed. When not at normal speed the button is highlighted and shows the speed (e.g. "1.5×").
- **Transcript button**: highlighted while a transcript panel is visible; click it again to close the panel. If opening the transcript had expanded the collapsed right sidebar, closing it collapses the sidebar again. Below/beside placements work in pop-out windows too. The sidebar default opens beside a pop-out viewer; an explicit sidebar move uses the main window's sidebar.
- **On-picture captions**: **Settings → Video viewer → Show YouTube captions** defaults to off, including existing installations without an explicit choice, so screenshots do not inherit YouTube's caption preference. Turn it on to display the video's available closed captions. Changes apply to open viewers without seeking, restarting playback or changing the transcript panel. Off is reapplied when YouTube reports playback starting, with bounded retries over the next three seconds for late-loading captions; explicit setting saves also reapply the request. This uses YouTube's embedded-player caption module commands (verified in Obsidian, but not a documented on/off API); availability depends on YouTube and the video's caption tracks. Captions burned into the video itself cannot be removed. This does not hide YouTube's play button/title/other paused-player overlays.
- **Laptop layout**: choose below-video placement, then drag Obsidian's horizontal divider upward to give the transcript more height. The whole 16:9 picture shrinks to fit the available viewer height, retaining its controls without cropping; zoomed pan scales with the resized picture. In tall panes it still uses the natural width-based 16:9 size. Viewer padding overrides Obsidian's large native bottom inset: 4px vertical padding and gaps, with a 12px-high seek-bar target, leave more height for the picture without shrinking control buttons. Transcript title, count, formatting and icon controls share a compact toolbar; search and keyboard help consume space only when used.
- **Timeline**: a thin line along the bottom; click or drag to seek. Subtle marks show the timestamps in your own notes for this video (transcript links are not marked); dragging snaps to a nearby mark. The marks update as you edit the note.
- **Zoom**: mouse wheel zooms around the pointer (up to 6×), drag pans while zoomed, double-click resets. A click on the picture plays or pauses.
- **Screenshot** (desktop only): the camera button pauses the video and lets you drag a rectangle to snip, like the Windows Snipping Tool; click without dragging (or press Enter) for the whole picture, Esc to cancel. Shift-click the camera captures the whole picture immediately. The PNG (of exactly what is shown, including zoom) is saved to your attachment folder. In **Insert into note** mode, Saver inserts a timestamped image list item at the associated note's tracked cursor, returns focus to the note and leaves playback paused. In **Copy to clipboard** mode, it copies an image embed plus timestamp link for manual pasting; area selection resumes previously playing video afterwards, including on cancellation. The existing whole-picture copy action captures immediately without changing playback state. Right-click lets you choose either destination for either capture area. The file is named `<note name> <date> @<video time>.png`, e.g. `Feynman 1964 - The Character of Physical 2026-11-06 @1m05s.png`; long note names are shortened at a word boundary to about 40 characters.

---

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

### YouTube Transcripts
- **Initial video workspace** (default: note + video): First-use pane combination for a note/video with no remembered session. Timestamp links and **Video: open or change workspace...** restore the last combination and geometry in preference to this default.
- **Collapse transcript on open** (default: on): Each time a note opens, folds only its transcript heading in Source mode, Live Preview, or Reading view, including pop-outs. This also runs when a restored background tab is first visited after startup, and after Zotero finishes creating/opening a note and placing its cursor. Click the heading arrow to expand it for viewing or copying; unlock the transcript first to edit it. Saver does not continually re-fold it. Uses the configured heading with the legacy `Transcript` fallback, without changing the note's Markdown. Search or navigation into the transcript can subsequently unfold it. Enable Obsidian's **Settings -> Editor -> Fold heading** to use the heading arrow. Turning this option off stops automatic folding on future openings; it does not unfold sections already collapsed.
- **Transcript protection**: In Source mode and Live Preview, transcript headings, text and timing metadata are locked by default, including in pop-outs. Selection and copying still work. Typing, paste, cut, drag-and-drop, undo/redo and deletions crossing the protected section are rejected as a whole, with a brief rate-limited notice. Use **Unlock transcript for editing** in the command palette or click the small closed-padlock icon beside the transcript heading, then confirm the timing warning. While unlocked, an amber open padlock and **Unlocked** label remain visible; click the padlock to relock immediately. Hover tooltips explain each action, and **Lock transcript** in the command palette also relocks immediately. The unlock applies only to that editor until relocked or closed; restarting Obsidian or reloading the document restores protection. Relocking does not undo edits or repair timings. Video timestamp and screenshot insertions never go inside the transcript, even when unlocked: with the cursor there, they use the initial notes area above it; copy and paste to place one deliberately. Protection does not change the Markdown and cannot prevent external file edits or other plugins replacing the whole document. Saver's intentional transcript downloads/repairs remain available.
- **Download YouTube transcripts** (default: on): When enabled, automatically downloads the timestamped transcript and inserts it two blank lines below the note body under the transcript heading when creating literature notes from YouTube video references (e.g. `youtube.com` or `youtu.be` URLs). The editor cursor is automatically positioned on the blank line directly above the transcript heading.
- **Transcript heading** (default: `Transcript`): Name of the H1 heading the downloaded transcript is stored under (leading `#` characters are ignored). The transcript side panel looks for this heading (at any level, case-insensitive) and falls back to `Transcript` for notes created before the name was changed. If neither is present, it uses the one section whose content is recognizably a stored YouTube transcript (Saver's timing or language comments, or at least five YouTube timestamp lines making up most of the section), whatever its heading says; panel, auto-fold, transcript protection, caption timing and cursor placement all share this lookup. If a note has several such sections, none is chosen and the failure notice offers a button to rename a candidate to the current name. **Transcript: rename other transcript headings to the current name** scans the vault for notes with an unambiguous transcript under a different heading, previews them, and after confirmation rewrites only those heading lines (keeping their level).
- **Transcript storage:** Downloads always keep each caption's exact bounds and available native word offsets in timestamp-link titles. Markdown characters in caption text are escaped. **Paragraphs**, **Sentences** and **Captions** change the panel's presentation, not stored timing. Older block and precise-caption note formats remain readable; there is no lossy download setting.
### Transcript Panel
- **Search keyboard behavior** (default: Obsidian-style): Same acceptance/cancellation modes as Incremental Search. Tab always accepts without playing and restores the full transcript.
- **Transcript matching** (default: all words): Match every query word in any order, or select *Literal phrase* for exact phrase matching. Both are case-insensitive and search displayed transcript text, not timestamp URLs.
- **Highlight all matches** (default: always): *Always*, *On demand* (toggle the highlighter button), or *Off* (current match only). Unlike Incremental Search, Ctrl/Cmd+Enter remains the playback shortcut. Highlighting does not change matching or filtering.
- **Initial transcript panel location** (default: right sidebar): Placement when no saved workspace geometry is being restored: sidebar, below or beside the video viewer (opening the viewer, paused, if needed). Use the direct below/beside toolbar icon or **Transcript: toggle below / beside video** to change the current arrangement without changing this preference. Whole-workspace reopening remembers that arrangement across plugin restarts; explicit single-panel commands use their placement/session preference. A separate icon toggles **Show pane tabs and navigation**; explicit move commands remain only as already-bound legacy shortcuts.
- **Follow playback in transcript** (default: on): While the video viewer plays, scroll the transcript panel to keep the current line in view (the line is highlighted either way).

### Video Viewer
- **Show YouTube captions** (default: off): Explicitly request closed captions off or on over the picture, independently of YouTube's stored preference and Saver's transcript panel. Applies to existing viewers and new/restored viewers. Does not remove burned-in text or paused-player overlays.
- **Timestamp link click** (default: play in the note's video workspace): Play at the clicked time using existing associated panes, or restore the last workspace/first-use default when none are open. Ctrl/Cmd-click does the other action (open in the browser).
- **Toolbar screenshot action** (default: insert into note): The camera inserts into the associated Markdown note, or copies to the clipboard if you select that option. Right-click offers both. Shift-click takes the whole picture using the selected destination. Explicit copy/insert commands are unchanged. Timestamp insertion and copying have separate buttons. An unavailable editing target falls back to copying, with an explanatory notice.
- **Timestamp list item style** (default: match current list): The list form inserted by **Video: insert timestamp list item** and the toolbar's insert action. *Match current list* reuses the current marker and advances ordered numbering; *Unordered list (-)*, *Ordered list (1.)*, and *Task list (- [ ])* start that form. An ordered item on a blank line starts at `1.`. Indentation and placement follow the cursor, moved to a safe block boundary when needed, and empty list items are reused.
- **Highlight inserted line** (default: left to right): Briefly flashes the note line where a timestamp or screenshot was inserted. Choose *Off*, *Centered around cursor*, *Left to right*, or *Right to left*. **Inserted line highlight duration** (200-1500 ms, default 1000 ms) and **width** (4-30 characters, default 15) tune it, using the shared `commons/flash` renderer and controls also used by Visible Cursor.
- **Show insertion target** (default: on): Mark the adjusted insertion location while the associated note editor is unfocused, without moving its cursor or changing Markdown. Off-screen/folded targets are not scrolled into view or unfolded merely to show the marker.
- **Copy current timestamp format** (default: timestamp link only): **Video: copy current timestamp** and the toolbar's copy action produce `[m:ss](URL)`. Choose *List item* to copy `- <timestamp link>: `, ready for a description after pasting. This setting does not affect direct insertions, transcript-row copies or screenshot copies.
- **Initial video viewer location** (default: split next to the note): Where a viewer opens when no saved geometry is being restored; *New window* opens it in a pop-out window. Reopening restores saved pop-out bounds and split placement. An already-open viewer for the note is reused, in any window.

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
