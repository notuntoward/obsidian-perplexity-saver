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

function load() {
  const names = [
    "buildComparableWithMap", "sessionComparable", "sessionMarkdownMarkers",
    "sessionTurnsFromResults", "readSessionTurns", "normalizeSourceUrl",
    "displaySourceUrl", "matchSessionChunk", "cleanSessionCitationLabels",
    "annotateSessionConversation",
  ];
  const api: {
    sessionTurnsFromResults: (results: unknown) => SessionTurn[];
    readSessionTurns: () => SessionTurn[];
    annotateSessionConversation: (text: string, turns: SessionTurn[]) => AnnotatedExport;
  } = new Function("document", names.map(helper).join("\n") +
    "\nreturn { sessionTurnsFromResults, readSessionTurns, annotateSessionConversation };")(document);
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

function nativeExport(data = turns()) {
  return data.map((t, i) => {
    const prompt = i === 1 ? "# \\<q>\n\n> A quoted passage from the answer.\n\n\\</q> What is the total?\n\n" : "";
    const answer = t.response.replace(/\[(\d+)\]/g, `[^${i + 1}_$1]`).replace(/B&O/g, "B\\&O");
    const sources = t.sources.map((s, j) => `[^${i + 1}_${j + 1}]: ${s.url}`).join("\n\n");
    return prompt + answer + '\n\n<span style="display:none"></span>\n\n<div align="center">⁂</div>\n\n' + sources;
  }).join("\n\n---\n\n");
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

  it("reads only the known results property on a bounded ancestor chain", () => {
    document.body.innerHTML = '<main><div data-message-bubble="right">Only the last visible prompt</div></main>';
    const bubble = document.querySelector("[data-message-bubble]");
    const root = { memoizedProps: { placeholderResults: results() }, return: null };
    Object.defineProperty(bubble, "__reactFiber$test", { enumerable: true, value: { memoizedProps: {}, return: root } });
    expect(load().readSessionTurns()).toEqual(turns());
  });

  it("does not recursively traverse hooks, DOM nodes, or unrelated result collections", () => {
    document.body.innerHTML = '<main><div data-message-bubble="right">A prompt</div></main>';
    const trap = vi.fn(() => { throw new Error("Unrelated state was read"); });
    const props = {};
    Object.defineProperty(props, "unrelated", { get: trap });
    const fiber = { memoizedProps: props, return: null };
    Object.defineProperty(fiber, "memoizedState", { get: trap });
    Object.defineProperty(document.querySelector("[data-message-bubble]"), "__reactFiber$test", { enumerable: true, value: fiber });
    expect(() => load().readSessionTurns()).toThrow(/session/i);
    expect(trap).not.toHaveBeenCalled();
  });

  it("terminates even if a React parent link is cyclic", () => {
    document.body.innerHTML = '<main><div data-message-bubble="right"></div></main>';
    const fiber: { memoizedProps: object; return?: object } = { memoizedProps: {} };
    fiber.return = fiber;
    Object.defineProperty(document.querySelector("[data-message-bubble]"), "__reactFiber$test", { enumerable: true, value: fiber });
    expect(() => load().readSessionTurns()).toThrow(/session/i);
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
      { pathname: "/session/test" }, vi.fn(), () => turns(), api.annotateSessionConversation,
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
