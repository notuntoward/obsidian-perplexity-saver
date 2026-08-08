import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Let's implement the core userscript matching functions locally for testing
const TURN_DIVIDER_RE = /\n[ \t]*---[ \t]*\n+(?=(?:```.*\n)?#\s)/g;

function stripAllWS(s: string) {
  return (s || "").replace(/\s+/g, "");
}

function stripHtmlTags(text: string) {
  return (text || "").replace(/<\/?q>/gi, "");
}

function stripForMatch(text: string) {
  return stripHtmlTags(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function unwrapFencedHeading(text: string) {
  const trimmed = (text || "").trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const inside = trimmed.slice(3, -3).trim();
    if (inside.startsWith("#")) {
      return inside;
    }
  }
  return trimmed;
}

function buildComparableWithMap(text: string) {
  let stripped = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '<') {
      const closeIdx = text.indexOf('>', i);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        continue;
      }
    }
    const c = text[i];
    if (/[a-zA-Z0-9]/.test(c)) {
      stripped += c.toLowerCase();
      map.push(i);
    }
    i++;
  }
  return { stripped, map };
}

function stripLogo(text: string) {
  const patterns = [
    /<img\b[^>]*\bsrc=["'][^"']*(?:pplx[-_]?full[-_]?logo|perplexity[-_]?logo)[^"']*["'][^>]*\/?>\s*/gi,
    /!\[[^\]]*\]\([^)]*(?:pplx[-_]?full[-_]?logo|perplexity[-_]?logo)[^)]*\)\s*/gi,
    /<img\b[^>]*\bsrc=["'][^"']*r2cdn\.perplexity\.ai[^"']*["'][^>]*\/?>\s*/gi,
  ];
  const result = patterns.reduce((acc, p) => acc.replace(p, ""), text).trimStart();
  return { result, removed: result !== text.trimStart() };
}

function findBibliographyStart(text: string, fromIdx: number) {
  const spanRe = /<span style="display:none">/;
  const footnoteRe = /\n\s*\[\^[^\]]+\]:\s/;
  const rest = text.slice(fromIdx);
  const spanMatch = spanRe.exec(rest);
  const footnoteMatch = footnoteRe.exec(rest);
  const candidates: number[] = [];
  if (spanMatch) candidates.push(fromIdx + spanMatch.index);
  if (footnoteMatch) candidates.push(fromIdx + footnoteMatch.index);
  return candidates.length > 0 ? Math.min(...candidates) : -1;
}

function splitSources(responsePart: string) {
  const bibStart = findBibliographyStart(responsePart, 0);
  if (bibStart === -1) {
    return { body: responsePart.trim(), sources: "" };
  }
  const body = responsePart.slice(0, bibStart).trim();
  const sources = responsePart.slice(bibStart)
    .replace(/<span style="display:none">[\s\S]*?<\/span>/g, "")
    .replace(/<div align="center">\s*⁂\s*<\/div>/g, "")
    .trim();
  return { body, sources };
}

function findPromptEnd(strippedBody: string, strippedDomPrompt: string) {
  // 1. Try matching the entire stripped prompt
  const idx = strippedBody.indexOf(strippedDomPrompt);
  if (idx !== -1) {
    return idx + strippedDomPrompt.length;
  }

  // 2. Try matching trailing suffixes of the prompt to be robust against markdown formatting differences
  const suffixLens = [40, 30, 20, 15, 12, 10, 8];
  for (const len of suffixLens) {
    if (strippedDomPrompt.length >= len) {
      const suffix = strippedDomPrompt.slice(-len);
      const sIdx = strippedBody.indexOf(suffix);
      if (sIdx !== -1) {
        return sIdx + len;
      }
    }
  }

  return -1;
}

function splitPromptFromResponse(chunkText: string, domPromptText: string, turnNum: number, title: string) {
  const { body: chunkBody, sources } = splitSources(chunkText);

  const headingMatch = chunkBody.match(/^#{1,6}[^\n]*\n+/);
  const startIdx = headingMatch ? headingMatch[0].length : 0;
  const bodyContent = chunkBody.slice(startIdx);

  const domPromptStripped = stripAllWS(stripHtmlTags(domPromptText));
  const titleStripped = stripAllWS(stripHtmlTags(title || ""));
  if (!chunkBody.startsWith("```") && titleStripped && domPromptStripped === titleStripped) {
    let promptPart = chunkBody.slice(0, startIdx).trim();
    promptPart = unwrapFencedHeading(promptPart);
    return {
      prompt: promptPart,
      response: bodyContent.trim(),
      sources
    };
  }

  const { stripped: strippedBody, map: bodyMap } = buildComparableWithMap(chunkBody);
  const strippedDomPrompt = stripForMatch(domPromptText);

  if (!strippedDomPrompt) {
    return null;
  }

  const promptEndStrippedIdx = findPromptEnd(strippedBody, strippedDomPrompt);
  if (promptEndStrippedIdx === -1) {
    return null;
  }

  const originalEndIdx = bodyMap[promptEndStrippedIdx - 1] + 1;

  // Scan forward for the first alphanumeric character of the response
  const remainingText = chunkBody.slice(originalEndIdx);
  const firstAlphanumRelIdx = remainingText.search(/[a-zA-Z0-9]/);
  const splitIdx = firstAlphanumRelIdx === -1 ? originalEndIdx : originalEndIdx + firstAlphanumRelIdx;

  let promptPart = chunkBody.slice(0, splitIdx).trim();
  const responsePart = chunkBody.slice(splitIdx).trim();

  if (!promptPart || !responsePart) {
    return null;
  }

  promptPart = unwrapFencedHeading(promptPart);

  return {
    prompt: promptPart,
    response: responsePart,
    sources
  };
}

function splitPromptFromResponseFallback(chunkText: string, turnNum: number) {
  const { body: chunkBody, sources } = splitSources(chunkText);
  const paragraphs = chunkBody.split(/\n\s*\n/);
  if (paragraphs.length <= 1) {
    let promptPart = chunkBody;
    promptPart = unwrapFencedHeading(promptPart);
    return { prompt: promptPart, response: "", sources };
  }

  const citationRegex = new RegExp(`\\[\\^(?:${turnNum}_)?\\d+\\]`);
  let firstResponseParaIdx = -1;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i].trim();
    if (!para) continue;
    if (i === 0) continue; // Paragraph 0 is the title heading

    if (citationRegex.test(para) || /^##+\s+\S/.test(para)) {
      firstResponseParaIdx = i;
      break;
    }
  }

  let promptPart;
  let responsePart;

  if (firstResponseParaIdx !== -1) {
    promptPart = paragraphs.slice(0, firstResponseParaIdx).join("\n\n").trim();
    responsePart = paragraphs.slice(firstResponseParaIdx).join("\n\n").trim();
  } else {
    // Default fallback if no citations or subheadings found: split after first paragraph
    promptPart = paragraphs[0].trim();
    responsePart = paragraphs.slice(1).join("\n\n").trim();
  }

  promptPart = unwrapFencedHeading(promptPart);

  return { prompt: promptPart, response: responsePart, sources };
}

describe("Userscript Exporter parser alignment", () => {
  it("perfectly aligns and splits Turn 4 where tampermonkey v5.8 failed", () => {
    const inputPath = path.join(__dirname, "../fixtures/input-perp-2.md");
    const rawContent = fs.readFileSync(inputPath, "utf-8");

    // Clean up logo and carriage returns as copyText does
    const { result: logoStripped } = stripLogo(rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));

    // Split into chunks
    const chunks = logoStripped.split(TURN_DIVIDER_RE).filter((c) => c.trim().length > 0);
    expect(chunks).toHaveLength(4);

    // Turn 4 chunk
    const chunk4 = chunks[3];
    expect(chunk4).toContain("# Explain this in plain English:");

    // In a real browser, domPromptText is retrieved from promptEl.textContent,
    // which contains the full, original text of the prompt.
    // Let's mock the exact full text of the prompt for Turn 4 (as seen in input perp 2.md):
    const domPromptText = `Explain this in plain English:

A Hormone Linked to Longevity
One important factor is fibroblast growth factor 21 (FGF21), a hormone that increases when protein intake falls. FGF21 can raise energy expenditure, improve blood sugar regulation, and reduce inflammation.
Mouse studies have shown that animals with elevated levels of FGF21 lived longer than typical mice. The effect was stronger in male mice than in female mice. Lower protein intake also increases FGF21 levels in humans.
Certain Amino Acids May Drive Aging
The review also focuses on several amino acids, which are the individual building blocks of protein. Methionine, isoleucine, and valine appear to play especially important roles.
Research suggests that excessive intake of these amino acids may activate biological pathways that encourage growth. When those pathways remain highly active, they may increase the risk of obesity, inflammation, and other conditions associated with aging.
"These studies show that the amount of protein sedentary people are eating today may have negative health consequences, at least at the population level," Lamming says.`;

    const title = "Explain this in plain English:";

    const split = splitPromptFromResponse(chunk4, domPromptText, 4, title);
    expect(split).not.toBeNull();

    if (split) {
      // Prompt should contain the full prompt (including the "# Explain this in plain English:" heading and trailing period)
      expect(split.prompt).toContain("# Explain this in plain English:");
      expect(split.prompt).toContain("sedentary people are eating today may have negative health consequences");
      expect(split.prompt.endsWith('Lamming says.')).toBe(true);
      expect(split.prompt).not.toContain("In plain English: **eating less protein");

      // Response should cleanly start with "In plain English: **eating less protein..."
      expect(split.response.startsWith("In plain English: **eating less protein")).toBe(true);
      expect(split.response).toContain("If you want, I can also turn this into a **one-paragraph summary**");

      // Sources should have been cleanly separated
      expect(split.sources).toContain("[^4_1]: https://elifesciences.org/articles/00065");
      expect(split.sources).toContain("[^4_15]: https://www.ajinomoto.com/amino-acids/amino-acids-for-healthy-ageing");
    }
  });

  it("perfectly aligns even when the prompt has links or formatting that render differently in the DOM", () => {
    // Let's simulate a chunk where the prompt in markdown has formatting, but the DOM text does not
    const chunk = `# Explain links

Go to [Google](https://google.com) to search.

AI Response here.`;

    const domPromptText = "Explain links\n\nGo to Google to search.";
    const split = splitPromptFromResponse(chunk, domPromptText, 1, "Explain links");
    expect(split).not.toBeNull();
    if (split) {
      expect(split.prompt).toContain("[Google](https://google.com)");
      expect(split.response).toBe("AI Response here.");
    }
  });

  it("perfectly aligns and splits Turn 1, 2, 3 as well", () => {
    const inputPath = path.join(__dirname, "../fixtures/input-perp-2.md");
    const rawContent = fs.readFileSync(inputPath, "utf-8");
    const { result: logoStripped } = stripLogo(rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    const chunks = logoStripped.split(TURN_DIVIDER_RE).filter((c) => c.trim().length > 0);

    // Turn 1
    const split1 = splitPromptFromResponse(chunks[0], "Compare population size and land area of the PNW states", 1, "Compare population size and land area of the PNW states");
    expect(split1).not.toBeNull();
    if (split1) {
      expect(split1.prompt).toBe("# Compare population size and land area of the PNW states");
      expect(split1.response.startsWith("Here’s a quick comparison")).toBe(true);
    }

    // Turn 2
    const split2 = splitPromptFromResponse(chunks[1], "what are the three most embarrassing political blunders?", 2, "what are the three most embarrassing political blunders?");
    expect(split2).not.toBeNull();
    if (split2) {
      expect(split2.prompt).toBe("# what are the three most embarrassing political blunders?");
      expect(split2.response.startsWith("If you mean the **most infamous political blunders")).toBe(true);
    }

    // Turn 3
    const split3 = splitPromptFromResponse(chunks[2], "contrast and compare figs and Newton", 3, "contrast and compare figs and Newton");
    expect(split3).not.toBeNull();
    if (split3) {
      expect(split3.prompt).toBe("# contrast and compare figs and Newton");
      expect(split3.response.startsWith("If you meant **Figs** and **Newton**")).toBe(true);
    }
  });

  it("correctly splits Turn 4 using fallback when DOM matching is unavailable", () => {
    const inputPath = path.join(__dirname, "../fixtures/input-perp-2.md");
    const rawContent = fs.readFileSync(inputPath, "utf-8");
    const { result: logoStripped } = stripLogo(rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    const chunks = logoStripped.split(TURN_DIVIDER_RE).filter((c) => c.trim().length > 0);

    const chunk4 = chunks[3];
    const fallbackSplit = splitPromptFromResponseFallback(chunk4, 4);
    expect(fallbackSplit).not.toBeNull();
    if (fallbackSplit) {
      // The prompt should contain the heading and the entire pasted article
      expect(fallbackSplit.prompt).toContain("# Explain this in plain English:");
      expect(fallbackSplit.prompt).toContain("A Hormone Linked to Longevity");
      expect(fallbackSplit.prompt).toContain('Lamming says.');
      
      // The prompt should NOT contain the response text
      expect(fallbackSplit.prompt).not.toContain("In plain English: **eating less protein");
      
      // The response should start with the correct sentence
      expect(fallbackSplit.response.startsWith("In plain English: **eating less protein")).toBe(true);
      expect(fallbackSplit.response).toContain("## What the passage means");
    }
  });

  it("correctly splits a chunk with code blocks surrounding the prompt (Perplexity bug case)", () => {
    const chunk = "```\n# <q>What is Washington's tax burden?</q> The website you link to says Washington\n```\n\n8.47%; Idaho 7.04%\n\nSome other details here.";
    const domPromptText = "What is Washington's tax burden?\n\nThe website you link to says Washington";
    const title = "<q>What is Washington's tax burden?</q> The website you link to says Washington";

    const result = splitPromptFromResponse(chunk, domPromptText, 2, title);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.prompt).toBe("# <q>What is Washington's tax burden?</q> The website you link to says Washington");
      expect(result.response).toBe("8.47%; Idaho 7.04%\n\nSome other details here.");
    }
  });

  it("ignores HTML tags like <q> in buildComparableWithMap and stripForMatch", () => {
    const textWithTags = "Hello <q>World</q>!";
    const textWithoutTags = "Hello World!";

    expect(stripForMatch(textWithTags)).toBe("helloworld");
    expect(stripForMatch(textWithoutTags)).toBe("helloworld");

    const compWithTags = buildComparableWithMap(textWithTags);
    const compWithoutTags = buildComparableWithMap(textWithoutTags);

    expect(compWithTags.stripped).toBe("helloworld");
    expect(compWithoutTags.stripped).toBe("helloworld");
    // Verify mapped index is correct for 'W' in 'World'
    // For textWithTags: "Hello <q>World</q>!" -> index 9 is 'W'
    // For textWithoutTags: "Hello World!" -> index 6 is 'W'
    expect(compWithTags.map[5]).toBe(9);
    expect(compWithoutTags.map[5]).toBe(6);
  });
});

// =====================================================================
// Regression tests for helpers that caused the turn-boundary bug.
// These run purely in Node and don't require a browser or DOM.
// =====================================================================

// --- Local copies of helpers from the userscript (pure functions) ---

function isMessagesArray(arr: unknown[]): boolean {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const sample = arr[0];
  if (!sample || typeof sample !== "object") return false;
  const keys = Object.keys(sample as Record<string, unknown>);
  return keys.includes("query") || keys.includes("query_str") ||
         keys.includes("answer") || keys.includes("role") ||
         keys.includes("message") || keys.includes("messageBlocks") ||
         keys.includes("is_user");
}

function deepSearch(obj: unknown, depth: number, visited: Set<unknown>): unknown[] | null {
  if (depth > 12 || !obj || typeof obj !== "object" || visited.has(obj)) return null;
  visited.add(obj);
  if (Array.isArray(obj) && isMessagesArray(obj)) return obj;
  if (!Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.messageBlocks) && isMessagesArray(o.messageBlocks)) return o.messageBlocks;
    if (Array.isArray(o.messages) && isMessagesArray(o.messages)) return o.messages;
  }
  const keys = Array.isArray(obj) ? (obj as unknown[]).map((_: unknown, i: number) => i) : Object.keys(obj as Record<string, unknown>);
  for (const k of keys) {
    try {
      const val = (obj as Record<string | number, unknown>)[k];
      if (val && typeof val === "object") {
        const r = deepSearch(val, depth + 1, visited);
        if (r) return r;
      }
    } catch (_) { /* skip */ }
  }
  return null;
}

interface SimplifiedMsg { query_str: string | null }

function simplifyMessages(foundMessages: Record<string, unknown>[]): SimplifiedMsg[] | null {
  try {
    return foundMessages.map(msg => {
      if (!msg) return { query_str: null };
      const textVal = msg.query_str || msg.query || msg.text || msg.content || "";
      const nestedQuery = msg.query && (typeof msg.query === "object" ? ((msg.query as Record<string, unknown>).text || (msg.query as Record<string, unknown>).query_str || "") : "");
      const nestedContent = msg.content && (typeof msg.content === "object" ? ((msg.content as Record<string, unknown>).text || "") : "");
      return {
        query_str: (typeof textVal === "string" ? textVal : "") ||
                   (typeof nestedQuery === "string" ? nestedQuery : "") ||
                   (typeof nestedContent === "string" ? nestedContent : "") ||
                   null
      };
    });
  } catch {
    return null;
  }
}

function getPromptTextFromMsg(msg: Record<string, unknown> | null): string | null {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.query_str === "string") return msg.query_str;
  if (typeof msg.query === "string") return msg.query;
  if (msg.query && typeof msg.query === "object") {
    const q = msg.query as Record<string, unknown>;
    if (typeof q.text === "string") return q.text;
    if (typeof q.query === "string") return q.query;
  }
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (msg.content && typeof msg.content === "object" && typeof (msg.content as Record<string, unknown>).text === "string") {
    return (msg.content as Record<string, unknown>).text as string;
  }
  return null;
}

// =====================================================================
describe("isMessagesArray detection", () => {
  it("detects arrays with 'query_str' key", () => {
    expect(isMessagesArray([{ query_str: "hello", answer: "world" }])).toBe(true);
  });
  it("detects arrays with 'query' key", () => {
    expect(isMessagesArray([{ query: "hello" }])).toBe(true);
  });
  it("detects arrays with 'role' key (ChatML format)", () => {
    expect(isMessagesArray([{ role: "user", content: "hi" }])).toBe(true);
  });
  it("detects arrays with 'is_user' key", () => {
    expect(isMessagesArray([{ is_user: true, text: "hi" }])).toBe(true);
  });
  it("rejects empty arrays", () => {
    expect(isMessagesArray([])).toBe(false);
  });
  it("rejects arrays of primitives", () => {
    expect(isMessagesArray(["a", "b", "c"] as unknown[])).toBe(false);
  });
  it("rejects arrays of objects without message keys", () => {
    expect(isMessagesArray([{ id: 1, name: "foo" }])).toBe(false);
  });
});

// =====================================================================
describe("deepSearch recursion", () => {
  it("finds messages at the top level", () => {
    const msgs = [{ query: "hello", answer: "world" }];
    expect(deepSearch(msgs, 0, new Set())).toBe(msgs);
  });

  it("finds messages nested inside an object", () => {
    const msgs = [{ query: "hello", answer: "world" }];
    const tree = { a: { b: { messages: msgs } } };
    expect(deepSearch(tree, 0, new Set())).toBe(msgs);
  });

  it("finds messages nested inside an array (the old bug)", () => {
    const msgs = [{ query_str: "prompt", answer: "resp" }];
    // Simulates hook.memoizedState = [snapshot] where snapshot wraps the array
    const tree = [{ data: msgs }];
    expect(deepSearch(tree, 0, new Set())).toBe(msgs);
  });

  it("finds messages at depth 12 (boundary)", () => {
    // Build a 12-level nested object
    const msgs = [{ query: "deep" }];
    let obj: Record<string, unknown> = { messages: msgs };
    for (let i = 0; i < 11; i++) {
      obj = { inner: obj };
    }
    expect(deepSearch(obj, 0, new Set())).toBe(msgs);
  });

  it("returns null at depth > 12 (safety limit)", () => {
    const msgs = [{ query: "too deep" }];
    let obj: Record<string, unknown> = { messages: msgs };
    for (let i = 0; i < 13; i++) {
      obj = { inner: obj };
    }
    expect(deepSearch(obj, 0, new Set())).toBeNull();
  });

  it("handles circular references without infinite loop", () => {
    const obj: Record<string, unknown> = { a: null };
    obj.a = obj; // circular
    expect(deepSearch(obj, 0, new Set())).toBeNull();
  });

  it("finds messages via messageBlocks shortcut", () => {
    const msgs = [{ query: "hello" }];
    const tree = { messageBlocks: msgs };
    expect(deepSearch(tree, 0, new Set())).toBe(msgs);
  });
});

// =====================================================================
describe("simplifyMessages extraction", () => {
  it("extracts query_str from flat messages", () => {
    const msgs = [
      { query_str: "What is git?", answer: "Git is..." },
      { query_str: "Explain more", answer: "Sure..." },
    ];
    const result = simplifyMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result![0].query_str).toBe("What is git?");
    expect(result![1].query_str).toBe("Explain more");
  });

  it("extracts from nested query object", () => {
    const msgs = [{ query: { text: "nested prompt" }, answer: "resp" }];
    const result = simplifyMessages(msgs);
    expect(result![0].query_str).toBe("nested prompt");
  });

  it("extracts from content field (ChatML format)", () => {
    const msgs = [{ role: "user", content: "hello from ChatML" }];
    const result = simplifyMessages(msgs);
    expect(result![0].query_str).toBe("hello from ChatML");
  });

  it("returns null for null message entries", () => {
    const msgs = [null as unknown as Record<string, unknown>];
    const result = simplifyMessages(msgs);
    expect(result![0].query_str).toBeNull();
  });
});

// =====================================================================
describe("getPromptTextFromMsg field priority", () => {
  it("prefers query_str over other fields", () => {
    expect(getPromptTextFromMsg({ query_str: "a", query: "b", text: "c" })).toBe("a");
  });
  it("falls back to query string", () => {
    expect(getPromptTextFromMsg({ query: "b", text: "c" })).toBe("b");
  });
  it("falls back to query.text for nested objects", () => {
    expect(getPromptTextFromMsg({ query: { text: "nested" } })).toBe("nested");
  });
  it("falls back to text", () => {
    expect(getPromptTextFromMsg({ text: "plain text" })).toBe("plain text");
  });
  it("falls back to content string", () => {
    expect(getPromptTextFromMsg({ content: "content text" })).toBe("content text");
  });
  it("falls back to content.text for nested objects", () => {
    expect(getPromptTextFromMsg({ content: { text: "deep content" } })).toBe("deep content");
  });
  it("returns null for empty/invalid objects", () => {
    expect(getPromptTextFromMsg(null)).toBeNull();
    expect(getPromptTextFromMsg({})).toBeNull();
  });
});

// =====================================================================
describe("splitPromptFromResponseFallback edge cases", () => {
  it("handles a turn with no citations and no sub-headings (splits after title)", () => {
    const chunk = `# Ask me anything

This is a simple response paragraph with no citations or headings.

Another paragraph of the response.`;

    const result = splitPromptFromResponseFallback(chunk, 1);
    expect(result.prompt).toBe("# Ask me anything");
    expect(result.response).toContain("This is a simple response paragraph");
    expect(result.response).toContain("Another paragraph of the response.");
  });

  it("handles a multi-paragraph prompt with a code block", () => {
    const chunk = `# Explain this code:

\`\`\`python
def hello():
    print("world")
\`\`\`

## Explanation

This code defines a simple function.[^1_1]`;

    const result = splitPromptFromResponseFallback(chunk, 1);
    // The heading "## Explanation" should trigger the split
    expect(result.prompt).toContain("# Explain this code:");
    expect(result.prompt).toContain('def hello():');
    expect(result.response).toContain("## Explanation");
    expect(result.response).toContain("simple function");
  });

  it("handles a single-paragraph chunk gracefully", () => {
    const chunk = "# Just a title with no response";
    const result = splitPromptFromResponseFallback(chunk, 1);
    expect(result.prompt).toBe("# Just a title with no response");
    expect(result.response).toBe("");
  });

  it("correctly uses turn-specific citation pattern to find boundary", () => {
    // Turn 5 should look for [^5_N] or [^N]
    const chunk = `# Tell me about cats

Cats are beloved companions worldwide.

They are independent animals.[^5_1] Cats have been domesticated for thousands of years.[^5_2]`;

    const result = splitPromptFromResponseFallback(chunk, 5);
    expect(result.prompt).toContain("# Tell me about cats");
    expect(result.prompt).toContain("Cats are beloved companions worldwide.");
    expect(result.response).toContain("[^5_1]");
  });

  it("handles chunk where every paragraph has citations (splits at first)", () => {
    const chunk = `# What is AI?

Artificial intelligence is a field of study.[^2_1]

It encompasses machine learning and deep learning.[^2_2]`;

    const result = splitPromptFromResponseFallback(chunk, 2);
    expect(result.prompt).toBe("# What is AI?");
    expect(result.response).toContain("[^2_1]");
    expect(result.response).toContain("[^2_2]");
  });
});

// =====================================================================
// Regression tests for progress prompt / toast suppression
// =====================================================================
describe("Userscript Exporter progress prompt suppression", () => {
  const getIsExportDownload = (): ((href: string, download: string) => boolean) => {
    const userscriptPath = path.join(__dirname, "../../browser-userscript/perplexity-obsidian-exporter-direct.user.js");
    const content = fs.readFileSync(userscriptPath, "utf-8");
    const match = content.match(/function isExportDownload\([\s\S]*?\}\n/);
    if (!match) {
      throw new Error("Could not find isExportDownload function in userscript");
    }
    return new Function("return (" + match[0] + ")")();
  };

  const getDismissPerplexityToastsBody = (): string => {
    const userscriptPath = path.join(__dirname, "../../browser-userscript/perplexity-obsidian-exporter-direct.user.js");
    const content = fs.readFileSync(userscriptPath, "utf-8");

    // Find the declaration - supports function declaration or arrow function assignment flexibly
    const match = content.match(/(?:function|const)\s+dismissPerplexityToasts\s*[\(=]/);
    if (!match || match.index === undefined) {
      throw new Error("Could not find dismissPerplexityToasts declaration in userscript");
    }
    const startIdx = match.index;

    // Find the opening brace of the function
    const openBraceIdx = content.indexOf("{", startIdx);
    if (openBraceIdx === -1) {
      throw new Error("Could not find opening brace");
    }

    // Count curly braces to find the matching closing brace
    let braceCount = 1;
    let endIdx = openBraceIdx + 1;
    while (braceCount > 0 && endIdx < content.length) {
      const char = content[endIdx];
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
      }
      endIdx++;
    }

    const snippet = content.slice(startIdx, endIdx);

    // Defensive shape assertion
    if (!snippet.includes("performSuppression") || !snippet.includes("textsToSuppress")) {
      throw new Error("Extracted snippet does not match expected dismissPerplexityToasts shape: " + snippet);
    }

    return snippet;
  };

  it("identifies export downloads correctly", () => {
    const isExportDownload = getIsExportDownload();

    // Positive case: markdown export download with blob URL
    expect(isExportDownload("blob:https://www.perplexity.ai/abc-123", "export.md")).toBe(true);

    // Positive case: data URL
    expect(isExportDownload("data:text/markdown;base64,abc", "")).toBe(true);
  });

  it("dismisses popover and hides/removes native Perplexity progress toasts dynamically using pure JS DOM mock", () => {
    // Escape dispatch spies
    let escapeDispatchedOnDocument = 0;
    let escapeDispatchedOnActiveEl = 0;

    const mockActiveEl = {
      dispatchEvent(event: any) {
        if (event && event.key === "Escape" && event.keyCode === 27 && event.which === 27) {
          escapeDispatchedOnActiveEl++;
        }
        return true;
      }
    };

    // Prepare mock element tree
    const mockToastsRemoved: string[] = [];

    const createMockElement = (id: string, textContent: string) => {
      return {
        id,
        textContent,
        style: { display: "block" },
        remove() {
          mockToastsRemoved.push(id);
        }
      };
    };

    // Prepare mock element tree (toast containers directly)
    const toast1Container = createMockElement("toast1-container", "Exporting thread...");
    const toast2Container = createMockElement("toast2-container", "Export succeeded");
    const unrelatedToastContainer = createMockElement("toast3-container", "Unrelated notification");

    // An element containing matching text, but not matching any toast selector
    const safeThreadMessage = createMockElement("safe-thread-message", "User discussing: Exporting thread...");

    const mockDocument = {
      activeElement: mockActiveEl,
      body: {},
      dispatchEvent(event: any) {
        if (event && event.key === "Escape" && event.keyCode === 27 && event.which === 27) {
          escapeDispatchedOnDocument++;
        }
        return true;
      },
      querySelectorAll(selector: string) {
        // Verify that only the actual toast selectors are queried
        if (selector.includes("data-sonner-toast") || selector.includes("role='status'")) {
          return [toast1Container, toast2Container, unrelatedToastContainer];
        }
        return [];
      }
    };

    // Extract the production function
    const fnText = getDismissPerplexityToastsBody();

    const mockKeyboardEvent = class {
      key: string;
      code: string;
      keyCode: number;
      which: number;
      bubbles: boolean;
      cancelable: boolean;
      constructor(type: string, dict?: any) {
        this.key = dict?.key || "";
        this.code = dict?.code || "";
        this.keyCode = dict?.keyCode || 0;
        this.which = dict?.which || 0;
        this.bubbles = !!dict?.bubbles;
        this.cancelable = !!dict?.cancelable;
      }
    };

    const dismissToastsInSandbox = new Function(
      "document",
      "KeyboardEvent",
      "setInterval",
      "clearInterval",
      "Date",
      `
        return (${fnText});
      `
    )(
      mockDocument,
      mockKeyboardEvent,
      // Pass a mock setInterval that calls the callback synchronously once for the test
      (cb: any) => { cb(); return 123; },
      clearInterval,
      Date
    );

    // Run the function
    dismissToastsInSandbox();

    // Verify that KeyboardEvents were dispatched correctly with full compatibility options
    expect(escapeDispatchedOnActiveEl).toBeGreaterThanOrEqual(1);
    expect(escapeDispatchedOnDocument).toBeGreaterThanOrEqual(1);

    // Verify that the DOM toasts are gone (both toast containers were removed/hidden)
    expect(toast1Container.style.display).toBe("none");
    expect(toast2Container.style.display).toBe("none");
    expect(mockToastsRemoved).toContain("toast1-container");
    expect(mockToastsRemoved).toContain("toast2-container");

    // The unrelated toast container was NOT suppressed or removed
    expect(unrelatedToastContainer.style.display).toBe("block");
    expect(mockToastsRemoved).not.toContain("toast3-container");

    // The safe element was NOT touched or removed (not even queried)
    expect(safeThreadMessage.style.display).toBe("block");
    expect(mockToastsRemoved).not.toContain("safe-thread-message");
  });

  it("does not identify non-export links (negative test cases)", () => {
    const isExportDownload = getIsExportDownload();

    // Negative case: download missing / non-export extension and non-blob/data href
    expect(isExportDownload("https://www.perplexity.ai/somefile.pdf", undefined as unknown as string)).toBe(false);

    // Negative case: empty download and normal HTTPS href
    expect(isExportDownload("https://www.perplexity.ai/page", "")).toBe(false);

    // Negative case: other extension like .pdf and normal HTTPS url
    expect(isExportDownload("https://www.perplexity.ai/abc-123.pdf", "file.pdf")).toBe(false);
  });
});
