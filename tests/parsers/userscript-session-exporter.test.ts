// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePerplexityDialog } from "../../src/parsers/perplexity";

interface SessionTurn {
  id: string;
  prompt: string;
  response: string;
  sources: { url: string }[];
}

interface AnnotatedExport {
  text: string;
  warnings: number[];
}

const script = readFileSync(resolve(__dirname, "../../browser-userscript/perplexity-obsidian-exporter-direct.user.js"), "utf8");

function helper(name: string) {
  const match = script.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
  if (!match) throw new Error(`Missing production helper: ${name}`);
  return match[0];
}

function load(fetcher = vi.fn()) {
  const names = [
    "buildComparableWithMap", "sessionComparable", "sessionMarkdownMarkers",
    "sessionTurnsFromResults", "readSessionTurns", "normalizeSourceUrl",
    "displaySourceUrl", "sessionSourceMatches", "matchSessionChunk", "cleanSessionCitationLabels",
    "annotateSessionConversation",
  ];
  const api: {
    sessionTurnsFromResults: (results: unknown) => SessionTurn[];
    readSessionTurns: () => Promise<SessionTurn[]>;
    annotateSessionConversation: (text: string, turns: SessionTurn[]) => AnnotatedExport;
  } = new Function("document", "fetch", "location", names.map(helper).join("\n") +
    "\nreturn { sessionTurnsFromResults, readSessionTurns, annotateSessionConversation };")(
      document, fetcher, new URL("https://www.perplexity.ai/session/test"),
    );
  return api;
}

function turns(): SessionTurn[] {
  return [
    {
      id: "first", prompt: "Assess this:\n\nA long first paragraph.\n\nThe hidden final paragraph.",
      response: "## Assessment\n\nFirst answer with B&O and $1 million.[1]\n\n---\n\nIts final paragraph.",
      sources: [{ url: "https://example.com/first" }, { url: "https://example.com/unused" }],
    },
    {
      id: "second", prompt: "<q>\n\n> A quoted passage from the answer.\n\n</q> What is the total?",
      response: "Combined, B&O and sales make up the total.[1]\n\n| Measure | Share |\n| :-- | :-- |\n| Combined | 70% |",
      sources: [{ url: "https://example.com/second" }],
    },
    {
      id: "third", prompt: "Check this:\n\nThe complete revised prompt.\n\nIts hidden last paragraph.",
      response: "## Verdict\n\nThird answer with a code example:\n\n```md\n---\n# Not another turn\n```\n\nEnd of answer.[1]",
      sources: [{ url: "https://example.com/third" }],
    },
  ];
}

function results(data = turns()) {
  return data.map(t => ({
    uuid: t.id, query_str: t.prompt, status: "COMPLETED",
    blocks: [
      { workflow_block: {
        status: "WORKFLOW_COMPLETED",
        steps: [{ items: [{
          type: "WORKFLOW_ITEM_TEXT", variant: "answer",
          payload: { text_payload: { text: t.response, is_streaming: false } },
        }] }],
      } },
      { web_result_block: { web_results: t.sources } },
    ],
  }));
}

function apiEntries(data = turns()) {
  return data.map(t => ({
    uuid: t.id, query_str: t.prompt, status: "completed",
    text: JSON.stringify([{ content: { answer: JSON.stringify({
      answer: t.response, web_results: t.sources,
    }) } }]),
  }));
}

function nativeExport(data = turns()) {
  return data.map((t, i) => {
    const prompt = i === 1 ? "# \\<q>\n\n> A quoted passage from the answer.\n\n\\</q> What is the total?\n\n" : "";
    const answer = t.response.replace(/\[(\d+)\]/g, `[^${i + 1}_$1]`).replace(/B&O/g, "B\\&O");
    const sources = t.sources.map((s, j) => `[^${i + 1}_${j + 1}]: ${s.url}`).join("\n\n");
    return prompt + answer + '\n\n<span style="display:none"></span>\n\n<div align="center">⁂</div>\n\n' + sources;
  }).join("\n\n---\n\n");
}

function attachmentExport() {
  const upload = "https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments";
  const data = [{
    ...turns()[0],
    response: "## Suggested edits\n\nUse the first image.[1] Follow the guide.[2]\n\nCompare the final image.[3]",
    sources: [
      { url: `${upload}/images/123/first/preview.jpg` },
      { url: `${upload}/123/second/style%20guide.md?download=1` },
      { url: `${upload}/images/123/third/preview.jpg` },
      { url: "https://example.com/web-source" },
    ],
  }];
  const native = nativeExport(data)
    .replace('<span style="display:none"></span>', '<span style="display:none">[^1_1][^1_2][^1_3][^1_4]</span>')
    .replace(data[0].sources[0].url, "preview.jpg")
    .replace(data[0].sources[1].url, "style guide.md")
    .replace(data[0].sources[2].url, "preview.jpg");
  return { data, native };
}

describe("native session exports", () => {
  it("restores omitted prompts, preserves quoted context, answers and every source", () => {
    const data = turns();
    const output = load().annotateSessionConversation(nativeExport(), data);
    expect(output.warnings).toEqual([]);
    expect(output.text.match(/<!-- PPLX-TURN /g)).toHaveLength(3);
    for (const [i, t] of data.entries()) {
      expect(output.text).toContain(`<!-- PPLX-ROLE: prompt -->\n${t.prompt}\n`);
      expect(output.text).toContain(t.response.replace(/\[(\d+)\]/g, `[^${i + 1}_$1]`).replace(/B&O/g, "B\\&O"));
      for (const s of t.sources) expect(output.text).toContain(s.url);
    }
    expect(output.text).not.toContain('display:none');
    expect(output.text).not.toContain("Read more");
    expect(output.text).not.toContain("# \\<q>");
  });

  it("verifies the supplied export's 18/16/6 source-list shape", () => {
    const data = turns().map((t, i) => ({
      ...t, sources: Array.from({ length: [18, 16, 6][i] }, (_, j) => ({ url: `https://example.com/${i}/${j}` })),
    }));
    const output = load().annotateSessionConversation(nativeExport(data), data);
    expect([...output.text.matchAll(/^\[\^1_\d+\]:/gm)]).toHaveLength(18);
    expect([...output.text.matchAll(/^\[\^2_\d+\]:/gm)]).toHaveLength(16);
    expect([...output.text.matchAll(/^\[\^3_\d+\]:/gm)]).toHaveLength(6);
  });

  it("supports uncited answers without inventing sources", () => {
    const data = [{ ...turns()[0], response: "An answer with no web search.", sources: [] }];
    const output = load().annotateSessionConversation(nativeExport(data), data);
    expect(output.text).toContain("<!-- PPLX-ROLE: sources -->\n(none)");
  });

  it("verifies and imports mixed sessions whose uncited turns omit the web-result block", () => {
    const data = turns();
    data[1] = { ...data[1], response: "An answer without a web search.", sources: [] };
    const structured = results(data);
    structured[1].blocks = structured[1].blocks.filter(b => !b.web_result_block);
    const api = load();
    expect(api.sessionTurnsFromResults(structured)).toEqual(data);
    const output = api.annotateSessionConversation(nativeExport(data), api.sessionTurnsFromResults(structured));
    const dialog = parsePerplexityDialog(output.text);
    expect(output.warnings).toEqual([]);
    expect(dialog.turns.map(t => t.role)).toEqual(["prompt", "ai", "prompt", "ai", "prompt", "ai"]);
    expect(dialog.turns[3].rawText).toBe(data[1].response);
    expect(dialog.turns[3].citations).toEqual([]);
    expect(dialog.turns[5].citations[0].url).toBe(data[2].sources[0].url);
  });

  it.each([undefined, null, {}, [{ url: null }]])(
    "rejects a present web-result block with malformed sources: %j",
    (web_results) => {
      const structured = results();
      const block = structured[0].blocks.find(b => b.web_result_block)!;
      Object.assign(block, { web_result_block: { web_results } });
      expect(() => load().sessionTurnsFromResults(structured)).toThrow(/incomplete|unsupported/i);
    },
  );

  it("rejects unresolved citations even when the web-result block is absent", () => {
    const data = [{ ...turns()[0], response: "A claim.[1]", sources: [] }];
    const structured = results(data);
    structured[0].blocks = structured[0].blocks.filter(b => !b.web_result_block);
    const api = load();
    const extracted = api.sessionTurnsFromResults(structured);
    expect(() => api.annotateSessionConversation(nativeExport(data), extracted)).toThrow(/verify/i);
  });

  it("accepts native footnotes added for named references while retaining numbered citations", () => {
    const data = [{ ...turns()[0], response: "An answer.[1] Another fact [Publisher]." }];
    const native = nativeExport(data).replace("[Publisher]", "[Publisher][^1_2]");
    expect(load().annotateSessionConversation(native, data).text).toContain("Another fact Publisher[^1_2].");
  });

  it("restores a named citation that native export turns into multiline math inside a table", () => {
    const label = "ITEP *Washington: Who Pays? 7th Edition*";
    const data = [{
      ...turns()[0],
      response: `| Claim | Note |\n| :-- | :-- |\n| Tax | See [${label}]. More text. |\n\n## Suggested edits\n\nKeep these edits.`,
    }];
    const native = nativeExport(data).replace(`[${label}]`, () => `$$   \n${label}\n$$[^1_1]`);
    const output = load().annotateSessionConversation(native, data).text;
    expect(output).toContain(`| Tax | See ${label}[^1_1]. More text. |`);
    expect(output).not.toContain("$$");
    expect(output).toContain("## Suggested edits\n\nKeep these edits.");
    expect(parsePerplexityDialog(output).turns[1].citations[0].url).toBe(data[0].sources[0].url);
  });

  it("preserves actual math and code instead of treating every dollar block as a citation", () => {
    const data = [{
      ...turns()[0],
      response: "A [Publisher] label.\n\n$$\nx^2\n$$[1]\n\n```md\n$$\nPublisher\n$$\n```\n\nEnd.",
    }];
    const native = nativeExport(data);
    const output = load().annotateSessionConversation(native, data).text;
    expect(output).toContain("$$\nx^2\n$$[^1_1]");
    expect(output).toContain("```md\n$$\nPublisher\n$$\n```");
    expect(output).toContain("A [Publisher] label.");
  });

  it("unwraps only confirmed labels beside native footnotes, preserving links, code and other brackets", () => {
    const data = [{
      ...turns()[0],
      response: "A fact [Publisher]. Another [unrelated] label.\n\n[Real link](https://example.com/link)\n\n`[Publisher][^1_1]`\n\n``multi-line code\n[Publisher][^1_1]\nend``\n\n```md\n[Publisher][^1_1]\n```",
    }];
    const native = nativeExport(data).replace("A fact [Publisher].", "A fact [Publisher].[^1_1]");
    const output = load().annotateSessionConversation(native, data).text;
    expect(output).toContain("A fact Publisher.[^1_1]");
    expect(output).toContain("Another [unrelated] label.");
    expect(output).toContain("[Real link](https://example.com/link)");
    expect(output).toContain("`[Publisher][^1_1]`");
    expect(output).toContain("``multi-line code\n[Publisher][^1_1]\nend``");
    expect(output).toContain("```md\n[Publisher][^1_1]\n```");
    expect(output).toContain("[^1_1]: https://example.com/first");
  });

  it("accepts a source URL that differs only by %-escaping and writes the encoded form", () => {
    // Real Perplexity data: the structured value is percent-encoded while the
    // native Markdown can contain a raw space for the same source
    // (".../84%200013_April25.pdf" vs ".../84 0013_April25.pdf"). Requiring
    // identical spelling failed verification for the whole turn.
    const data = [{
      ...turns()[0],
      response: "An answer.[1]",
      sources: [{ url: "https://example.com/reports/84%200013_April25.pdf" }],
    }];
    const native = nativeExport(data).replace("84%200013_April25.pdf", "84 0013_April25.pdf");
    const output = load().annotateSessionConversation(native, data);
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain("[^1_1]: https://example.com/reports/84%200013_April25.pdf");
    expect(output.text).not.toContain("84 0013_April25.pdf");
  });

  it.each([false, true])("restores distinct URLs for repeated attachment filenames (includes web source: %s)", (withWebSource) => {
    const { data, native } = attachmentExport();
    const text = withWebSource ? native : native
      .replace("[^1_4]</span>", "</span>")
      .replace("\n\n[^1_4]: https://example.com/web-source", "");
    if (!withWebSource) data[0].sources.pop();
    const api = load();
    const output = api.annotateSessionConversation(text, api.sessionTurnsFromResults(apiEntries(data)));
    const dialog = parsePerplexityDialog(output.text);
    expect(output.warnings).toEqual([]);
    expect(dialog.turns.map(t => t.role)).toEqual(["prompt", "ai"]);
    expect(dialog.turns[0].rawText).toBe(data[0].prompt);
    expect(output.text).toContain("Use the first image.[^1_1] Follow the guide.[^1_2]\n\nCompare the final image.[^1_3]");
    expect(dialog.turns[1].citations.map(c => c.url)).toEqual(data[0].sources.map(s => s.url));
    expect(output.text).not.toContain('display:none');
  });

  it.each([
    ["wrong filename", "[^1_2]: style guide.md", "[^1_2]: other guide.md"],
    ["wrong footnote number", "[^1_2]: style guide.md", "[^1_3]: style guide.md"],
    ["missing definition", "[^1_2]: style guide.md", ""],
    ["web URL replaced by its basename", "[^1_4]: https://example.com/web-source", "[^1_4]: web-source"],
  ])("rejects a mixed attachment export with %s", (_label, original, changed) => {
    const { data, native } = attachmentExport();
    expect(() => load().annotateSessionConversation(native.replace(original, changed), data)).toThrow(/verify/i);
  });

  it("verifies Markdown-escaped source query separators and emits the structured URL", () => {
    const url = "https://www.tampermonkey.net/changelog.php?locale=en&more=true&show=neuu";
    const data = [{ ...turns()[0], response: "An answer.[1]", sources: [{ url }] }];
    const native = nativeExport(data).replace(url, url.replace(/&/g, "\\&"));
    const output = load().annotateSessionConversation(native, data);
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(`[^1_1]: ${url}`);
    expect(output.text).not.toContain("\\&");
    expect(parsePerplexityDialog(output.text).turns[1].citations[0].url).toBe(url);
    expect(() => load().annotateSessionConversation(native.replace("more=true", "more=false"), data)).toThrow(/verify/i);
    expect(() => load().annotateSessionConversation(native.replace(/\\&/g, "%26"), data)).toThrow(/verify/i);
  });

  it("verifies Markdown escapes for dollar signs, underscores and parentheses in source URLs", () => {
    const url = "https://example.com/Income_Over_$1_Million_(2026)";
    const data = [{ ...turns()[0], response: "An answer.[1]", sources: [{ url }] }];
    const native = nativeExport(data).replace(url, url.replace(/[$_()]/g, "\\$&"));
    const output = load().annotateSessionConversation(native, data);
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(`[^1_1]: ${url}`);
    expect(() => load().annotateSessionConversation(native.replace("Million", "Billion"), data)).toThrow(/verify/i);
  });

  it.each(["&amp;", "&#38;", "&#x26;"])("decodes API source URL entities (%s) before verification and output", (entity) => {
    const url = "https://app.leg.wa.gov/RCW/default.aspx?cite=26.04.010&pdf=true";
    const data = [{ ...turns()[0], response: "An answer.[1]", sources: [{ url }] }];
    const encoded = [{ ...data[0], sources: [{ url: url.replace("&", entity) }] }];
    const api = load();
    const extracted = api.sessionTurnsFromResults(apiEntries(encoded));
    expect(extracted).toEqual(data);
    const native = nativeExport(data).replace(url, url.replace("&", "\\&"));
    const output = api.annotateSessionConversation(native, extracted);
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(`[^1_1]: ${url}`);
    expect(parsePerplexityDialog(output.text).turns[1].citations[0].url).toBe(url);
  });

  it("imports the assembled output as three complete prompt/answer pairs with sources", () => {
    const output = load().annotateSessionConversation(nativeExport(), turns());
    const dialog = parsePerplexityDialog(output.text);
    expect(dialog.turns.map(t => t.role)).toEqual(["prompt", "ai", "prompt", "ai", "prompt", "ai"]);
    expect(dialog.turns[0].rawText).toBe(turns()[0].prompt);
    expect(dialog.turns[2].rawText).toContain("> A quoted passage from the answer.");
    expect(dialog.turns[4].rawText).toBe(turns()[2].prompt);
    expect(dialog.turns[1].citations.map(c => c.url)).toEqual(turns()[0].sources.map(s => s.url));
    expect(dialog.turns[3].citations[0].url).toBe(turns()[1].sources[0].url);
    expect(dialog.turns[5].citations[0].url).toBe(turns()[2].sources[0].url);
  });

  it("does not ignore missing non-ASCII answer text during verification", () => {
    const data = [{ ...turns()[0], response: "An answer: \u4f60\u597d\u4e16\u754c.[1]" }];
    expect(load().annotateSessionConversation(nativeExport(data), data).warnings).toEqual([]);
    expect(() => load().annotateSessionConversation(nativeExport(data).replace("\u4e16\u754c", ""), data)).toThrow(/verify/i);
  });

  it("verifies code between comparison operators rather than treating it as HTML", () => {
    const data = [{ ...turns()[0], response: "Compare: `a < 20 && b > 10`.[1]" }];
    expect(() => load().annotateSessionConversation(nativeExport(data).replace("< 20 && b >", ""), data)).toThrow(/verify/i);
    expect(load().annotateSessionConversation(nativeExport(data), data).warnings).toEqual([]);
  });

  it.each([
    ["missing response text", (s: string) => s.replace("Its final paragraph.", "")],
    ["extra response text", (s: string) => s.replace("Its final paragraph.", "Its final paragraph. Unexpected extra text.")],
    ["wrong source URL", (s: string) => s.replace("https://example.com/first", "https://example.com/wrong")],
    ["missing source", (s: string) => s.replace("[^1_2]: https://example.com/unused", "")],
    ["unresolved citation", (s: string) => s.replace("[^1_1]", "[^1_99]")],
    ["changed citation", (s: string) => s.replace("[^1_1]", "[^1_2]")],
    ["extra turn", (s: string) => s + "\n\n---\n\nAn extra answer."],
    ["missing turn", (s: string) => s.slice(0, s.indexOf("\n\n---\n\n# \\<q>"))],
  ])("rejects %s instead of guessing or silently dropping content", (_label, change) => {
    expect(() => load().annotateSessionConversation(change(nativeExport()), turns())).toThrow(/verify|verified/i);
  });

  it("names the failed verification check so session drift is diagnosable", () => {
    const data = turns();
    // Drop one source definition: the native export no longer matches the
    // structured source list, which is the most common Perplexity drift.
    const native = nativeExport(data).replace("[^1_2]: https://example.com/unused", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => load().annotateSessionConversation(native, data)).toThrow(/verify/i);
      const report = spy.mock.calls
        .map((call) => String(call[0]))
        .find((message) => message.includes("[PPLX Session Diag]"));
      expect(report).toBeTruthy();
      const payload = JSON.parse(String(report).slice(String(report).indexOf("{")));
      expect(payload.failedTurn).toBe(1);
      expect(payload.reactSources).toBe(2);
      // The fixture answer contains an internal "---", so the first sampled
      // chunk is truncated there (no definitions) and a later attempt covers
      // the real turn chunk (one of the two expected definitions).
      const sourceCounts = payload.attempts
        .flatMap((attempt: { reasons: { reason: string; nativeSources?: number }[] }) => attempt.reasons)
        .filter((reason: { reason: string }) => reason.reason === "source-count")
        .map((reason: { nativeSources?: number }) => reason.nativeSources);
      expect(sourceCounts).toContain(0);
      expect(sourceCounts).toContain(1);
      expect(payload.attempts[0].reasons[0].reactSources).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports bounded unmatched trailing content instead of silently discarding it", () => {
    const data = turns();
    const extra = "Unexpected additional answer. ".repeat(100);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => load().annotateSessionConversation(nativeExport(data) + "\n\n---\n\n" + extra, data))
        .toThrow("Could not verify all session export turns.");
      const report = spy.mock.calls.map(call => String(call[0]))
        .find(message => message.includes("[PPLX Session Diag]"));
      expect(report).toBeTruthy();
      const payload = JSON.parse(String(report).slice(String(report).indexOf("{")));
      expect(payload.reason).toBe("unmatched-trailing-content");
      expect(payload.turnCount).toBe(3);
      expect(payload.remainingLength).toBe(extra.trim().length);
      expect(payload.head).toBe(extra.slice(0, 240));
      expect(payload.tail).toBe(extra.trim().slice(-240));
    } finally {
      spy.mockRestore();
    }
  });

  it("reads all paginated API turns instead of partial React placeholders", async () => {
    document.body.innerHTML = '<main><div data-message-bubble="right"></div></main>';
    const trap = vi.fn(() => { throw new Error("React state was read"); });
    Object.defineProperty(document.querySelector("[data-message-bubble]"), "__reactFiber$test", { enumerable: true, get: trap });
    const expected = [...turns(), {
      ...turns()[0], id: "fourth", prompt: "One more question.", response: "Fourth answer.[1]",
    }].map((turn, i) => ({
      ...turn, sources: Array.from({ length: [10, 15, 16, 4][i] }, (_, j) => ({ url: `https://example.com/${i}/${j}` })),
    }));
    const entries = apiEntries(expected);
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: entries.slice(0, 1), has_next_page: true, next_cursor: "page&2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: entries.slice(1), has_next_page: false, next_cursor: null }) });
    const api = load(fetcher);
    const data = await api.readSessionTurns();
    expect(data).toEqual(expected);
    expect(api.annotateSessionConversation(nativeExport(expected), data).warnings).toEqual([]);
    const urls = fetcher.mock.calls.map(call => new URL(String(call[0])));
    expect(urls[0].pathname).toBe("/rest/thread/test");
    expect(urls[0].searchParams.get("from_first")).toBe("true");
    expect(urls[1].searchParams.get("cursor")).toBe("page&2");
    expect(fetcher.mock.calls[0][1].signal).toBe(fetcher.mock.calls[1][1].signal);
    expect(trap).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP error", { ok: false, status: 403 }, /403/],
    ["missing entries", { ok: true, json: async () => ({ has_next_page: false }) }, /session/i],
    ["missing pagination state", { ok: true, json: async () => ({ entries: apiEntries() }) }, /session/i],
    ["missing cursor", { ok: true, json: async () => ({ entries: apiEntries(), has_next_page: true }) }, /cursor/i],
  ])("rejects %s instead of returning partial turns", async (_label, response, error) => {
    await expect(load(vi.fn().mockResolvedValue(response)).readSessionTurns()).rejects.toThrow(error);
  });

  it("rejects repeating pagination cursors instead of looping", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ entries: apiEntries(), has_next_page: true, next_cursor: "same" }),
    });
    await expect(load(fetcher).readSessionTurns()).rejects.toThrow(/cursor/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds pagination even when every cursor is new", async () => {
    let cursor = 0;
    const fetcher = vi.fn().mockImplementation(async () => ({
      ok: true, json: async () => ({
        entries: apiEntries(), has_next_page: true, next_cursor: String(++cursor),
      }),
    }));
    await expect(load(fetcher).readSessionTurns()).rejects.toThrow(/pagination limit/i);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it.each([
    ["unfinished entry", { ...apiEntries()[0], status: "in_progress" }],
    ["malformed serialized data", { ...apiEntries()[0], text: "not JSON" }],
    ["missing serialized answer", { ...apiEntries()[0], text: "[]" }],
    ["malformed source list", { ...apiEntries()[0], text: JSON.stringify([{ content: { answer: JSON.stringify({ answer: "A claim.", web_results: null }) } }]) }],
  ])("rejects API %s", async (_label, entry) => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ entries: [entry], has_next_page: false }),
    });
    await expect(load(fetcher).readSessionTurns()).rejects.toThrow();
  });

  it("refuses incomplete, duplicate, streaming, or unsupported structured data", () => {
    const api = load();
    const incomplete = results();
    incomplete[0].status = "IN_PROGRESS";
    expect(() => api.sessionTurnsFromResults(incomplete)).toThrow();
    const duplicate = results();
    duplicate[1].uuid = duplicate[0].uuid;
    expect(() => api.sessionTurnsFromResults(duplicate)).toThrow();
    const streaming = results();
    streaming[0].blocks[0].workflow_block!.steps[0].items[0].payload.text_payload.is_streaming = true;
    expect(() => api.sessionTurnsFromResults(streaming)).toThrow();
    expect(() => api.sessionTurnsFromResults([{ query_str: "Only a prompt" }])).toThrow();
  });

  it("routes session exports through verified assembly without legacy expansion or React search", async () => {
    const clipboard = vi.fn(async (_text: string) => ({ success: true }));
    const expand = vi.fn();
    const legacy = vi.fn();
    const api = load();
    const copy: (text: string) => Promise<boolean> = new Function(
      "location", "showToast", "readSessionTurns", "annotateSessionConversation",
      "expandAllPrompts", "annotateConversation", "stripLogo", "collapseAllPrompts",
      "buildHeader", "writeToClipboard",
      helper("copyText") + "\nreturn copyText;",
    )(
      { pathname: "/session/test" }, vi.fn(), async () => turns(), api.annotateSessionConversation,
      expand, legacy, (text: string) => ({ result: text }), vi.fn(),
      () => "[Perplexity](https://www.perplexity.ai/session/test)\n\n", clipboard,
    );
    expect(await copy(nativeExport())).toBe(true);
    expect(clipboard).toHaveBeenCalledOnce();
    expect(clipboard.mock.calls[0][0]).toContain("The hidden final paragraph.");
    expect(expand).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    clipboard.mockClear();
    expect(await copy(nativeExport().replace("Its final paragraph.", ""))).toBe(false);
    expect(clipboard).not.toHaveBeenCalled();
  });
});
