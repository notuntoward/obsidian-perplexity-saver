---
name: debug-perplexity-export
description: Reproduce Perplexity userscript export failures using an authenticated browser corpus, captured console/network evidence and offline replay instead of requesting pasted diagnostics.
---

# Debug Perplexity exports

Use the repository's dedicated Playwright runner before asking the user to paste
console output. It executes the actual userscript and validates its clipboard
output with the actual Obsidian importer. It does not submit queries, regenerate
answers, install Tampermonkey, or write to the system clipboard.

## One-time setup

Run commands in the original repository checkout, following its shell rules.
The installed Chrome browser and existing npm dependencies are sufficient.

```bash
npm run debug:perplexity -- init 'https://www.perplexity.ai/session/APPROVED-ID'
npm run debug:perplexity -- login
```

`init` merges approved URLs into the private corpus. `login` opens a separate
persistent browser profile; ask the user to sign in there once and close that
window. The command expires after ten minutes. Never copy cookies from their
everyday browser, automate credentials/CAPTCHA, or bypass browser verification.
Expired authentication needs this same login step, not a series of console probes.
Do not run two commands against the persistent profile simultaneously.

## Autonomous reproduction

```bash
npm run debug:perplexity -- run
npm run debug:perplexity -- run 'https://www.perplexity.ai/session/APPROVED-ID' --headed
```

Run sequentially over the existing corpus; add more user-approved existing
dialogs with `init`. Do not create queries or spend credits to manufacture cases.
Headless is the default; use `--headed` for UI-dependent failures, not anti-bot
evasion. Authentication/verification barriers are blockers requiring user action.

The runner injects the current userscript, supplies a page-local `GM_setClipboard`
capture, and clicks the floating Obsidian button. It verifies prompt text,
answer content, turn order/count and source URLs through the importer; a toast
alone is not success. Unexpected native-download fallback fails the case and is
cancelled, rather than silently accepting an incomplete export.

Read the printed private run directory:

- `summary.json`: per-dialog results and source counts.
- Numbered subdirectories: `result.json` with bounded relevant console messages,
  page errors, failed request paths and capture errors.
- `replay.json`: native Markdown and whitelisted conversation API pages.
- `clipboard.md`: captured export, when produced.
- `failure.png`: failed page screenshot, when available.

All of `.perplexity-debug/` is Git-ignored, including the authenticated `profile/`
and `corpus.json`. These contain private conversations/session cookies. Do not
commit, upload or attach them. Captures strip account metadata and API tokens
but retain private conversation content, URLs and diagnostic samples. Do not
save full browser traces, storage state, request headers or unsanitized API
responses. Unsupported response shapes produce explicit capture errors; they
are not silently made replayable.

## Iterate without live traffic

```bash
npm run debug:perplexity -- replay '.perplexity-debug/runs/RUN/1/replay.json'
npm run test:perplexity-debug
npm run test:run -- tests/parsers/userscript-session-exporter.test.ts tests/parsers/userscript-exporter.test.ts tests/parsers/userscript-toolbar.test.ts
node --check browser-userscript/perplexity-obsidian-exporter-direct.user.js
```

Replay uses the saved native export and paginated responses with the **current**
userscript/importer. All other network requests are blocked, and no authenticated
profile is used. It exercises the real export button, but its minimal native
menu cannot reproduce a changed Perplexity UI. Confirm UI fixes with a live run.
The offline self-test proves a two-page, mixed-source export succeeds and a
corrupted answer fails. Do not interpret that intentionally rejected case as a
broken self-test.

Turn a specific failure into a small, synthetic unit fixture in the existing
userscript tests. Verify it fails without the fix. Do not commit copied private
dialogs. Follow the userscript-only validation scope in AGENTS.md; neither this
runner nor userscript-only fixes require an Obsidian bundle or full plugin suite.

The harness replaces Tampermonkey clipboard APIs and cannot prove actual
extension permissions, installation freshness, OS clipboard delivery or native
download saving. Request one bounded manual check only for those gaps or when
authentication genuinely prevents automated reproduction.
