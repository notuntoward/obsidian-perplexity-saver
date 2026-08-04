import { describe, it, expect } from "vitest";
import * as fs from "fs";

// Let's implement the core userscript matching functions locally for testing
const TURN_DIVIDER_RE = /\n[ \t]*---[ \t]*\n+(?=#\s)/g;

function stripAllWS(s: string) {
  return (s || "").replace(/\s+/g, "");
}

function stripForMatch(text: string) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildComparableWithMap(text: string) {
  let stripped = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/[a-zA-Z0-9]/.test(c)) {
      stripped += c.toLowerCase();
      map.push(i);
    }
  }
  return { stripped, map };
}

function stripLogo(text: string) {
  const patterns = [
    /<img\b[^>]*\bsrc=["'][^"']*(?:pplx[-_]?full[-_]?logo|perplexity[-_]?logo)[^"']*["'][^>]*\/?>\s*/gi,
    /!\[[^\]]*\]\([^)]*(?:pplx[-_]?full[-_]?logo|perplexity[-_]?logo)[^)]*\)\s*/gi,
    /<img\b[^>]*\bsrc=["'][^"']*r2cdn\.perplexity\.ai[^"']*["'][^>]*\/?>\s*/gi,
  ];
  let removed = false;
  let result = text;
  for (const p of patterns) {
    const matches = result.match(p);
    if (matches && matches.length) {
      removed = true;
      result = result.replace(p, "");
    }
  }
  result = result.replace(/^\s+/, "");
  return { result, removed };
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
  if (!candidates.length) return -1;
  return Math.min(...candidates);
}

function splitSources(responsePart: string) {
  const bibStart = findBibliographyStart(responsePart, 0);
  if (bibStart === -1) {
    return { body: responsePart.trim(), sources: "" };
  }
  const body = responsePart.slice(0, bibStart).trim();
  let sourcesRaw = responsePart.slice(bibStart);
  sourcesRaw = sourcesRaw.replace(/<span style="display:none">[\s\S]*?<\/span>/g, "");
  sourcesRaw = sourcesRaw.replace(/<div align="center">\s*⁂\s*<\/div>/g, "");
  sourcesRaw = sourcesRaw.trim();
  return { body, sources: sourcesRaw };
}

function splitPromptFromResponse(chunkText: string, domPromptText: string, turnNum: number, title: string) {
  const { body: chunkBody, sources } = splitSources(chunkText);

  const headingMatch = chunkBody.match(/^#{1,6}[^\n]*\n+/);
  const startIdx = headingMatch ? headingMatch[0].length : 0;
  const bodyContent = chunkBody.slice(startIdx);

  const domPromptStripped = stripAllWS(domPromptText);
  const titleStripped = stripAllWS(title || "");
  if (titleStripped && domPromptStripped === titleStripped) {
    return {
      prompt: chunkBody.slice(0, startIdx).trim(),
      response: bodyContent.trim(),
      sources
    };
  }

  const { stripped: strippedBody, map: bodyMap } = buildComparableWithMap(chunkBody);
  const strippedDomPrompt = stripForMatch(domPromptText);

  if (!strippedDomPrompt) {
    return null;
  }

  const idxStripped = strippedBody.indexOf(strippedDomPrompt);
  if (idxStripped === -1) {
    return null;
  }

  const promptEndStrippedIdx = idxStripped + strippedDomPrompt.length;
  const originalEndIdx = bodyMap[promptEndStrippedIdx - 1] + 1;

  // Scan forward for the first alphanumeric character of the response
  const remainingText = chunkBody.slice(originalEndIdx);
  const firstAlphanumRelIdx = remainingText.search(/[a-zA-Z0-9]/);
  const splitIdx = firstAlphanumRelIdx === -1 ? originalEndIdx : originalEndIdx + firstAlphanumRelIdx;

  const promptPart = chunkBody.slice(0, splitIdx).trim();
  const responsePart = chunkBody.slice(splitIdx).trim();

  if (!promptPart || !responsePart) {
    return null;
  }

  return {
    prompt: promptPart,
    response: responsePart,
    sources
  };
}

describe("Userscript Exporter parser alignment", () => {
  it("perfectly aligns and splits Turn 4 where tampermonkey v5.8 failed", () => {
    const inputPath = "/tmp/file_attachments/fails tampermonkey and complexity/input perp 2.md";
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

  it("perfectly aligns and splits Turn 1, 2, 3 as well", () => {
    const rawContent = fs.readFileSync("/tmp/file_attachments/fails tampermonkey and complexity/input perp 2.md", "utf-8");
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
});
