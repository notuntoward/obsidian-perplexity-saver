// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (Direct & Robust)
// @namespace    scott-otterson-obsidian-export-direct
// @version      8.4
// @description  Robustly exports Perplexity conversations to Obsidian Markdown format by intercepting native markdown downloads and aligning prompt-response boundaries via text-mapping.
// @match        https://www.perplexity.ai/*
// @match        https://perplexity.ai/*
// @grant        none
// @sandbox      raw
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";
  console.log("[PPLX Obsidian Exporter Direct] Userscript active. Click '...' -> 'Export as Markdown' to copy.");

  // Keep track of blobs created for download interception
  const blobRegistry = new Map();
  const OrigCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = OrigCreateObjectURL(obj);
    try {
      if (obj instanceof Blob) {
        blobRegistry.set(url, obj);
      }
    } catch (_) {}
    return url;
  };

  function getSearchRoot() {
    return document.querySelector("main") || document.body;
  }

  function showToast(msg, isError) {
    const t = document.getElementById("pplx-clip-toast") || (() => {
      const el = document.createElement("div");
      el.id = "pplx-clip-toast";
      el.style.cssText = `
        position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
        z-index: 999999; padding: 14px 22px; border-radius: 10px;
        font: 15px sans-serif; font-weight: 500; color: #fff; transition: opacity 0.3s;
        pointer-events: none; max-width: 80vw; text-align: center;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
      `;
      document.body.appendChild(el);
      return el;
    })();

    t.style.background = isError ? "#c0392b" : "#2e7d32";
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => (t.style.opacity = "0"), 3800);
  }

  function formatTimestamp(d) {
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const getTz = () => {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZoneName: "short",
        }).formatToParts(d);
        const tzPart = parts.find((p) => p.type === "timeZoneName");
        return tzPart ? ` ${tzPart.value}` : "";
      } catch (_) {
        const offsetMin = -d.getTimezoneOffset();
        const sign = offsetMin >= 0 ? "+" : "-";
        const oh = Math.floor(Math.abs(offsetMin) / 60);
        const om = Math.abs(offsetMin) % 60;
        return ` UTC${sign}${pad(oh)}:${pad(om)}`;
      }
    };

    return `${date} ${time}${getTz()}`;
  }

  function buildHeader() {
    const ts = formatTimestamp(new Date());
    return `[Perplexity](${location.href}) · *${ts}*\n\n---\n\n`;
  }

  function stripLogo(text) {
    const patterns = [
      /<img\b[^>]*\bsrc=["'][^"']*(?:pplx[-_]?full[-_]?logo|perplexity[-_]?logo)[^"']*["'][^>]*\/?>\s*/gi,
      /!\[[^\]]*\]\([^)]*(?:pplx[-_]?full[-_]?logo|perplexity[-_]?logo)[^)]*\)\s*/gi,
      /<img\b[^>]*\bsrc=["'][^"']*r2cdn\.perplexity\.ai[^"']*["'][^>]*\/?>\s*/gi,
    ];
    const result = patterns.reduce((acc, p) => acc.replace(p, ""), text).trimStart();
    return { result, removed: result !== text.trimStart() };
  }

  function findToggleButtons(pattern) {
    const root = getSearchRoot();
    const candidates = [...root.querySelectorAll('button, [role="button"], span, a, div')];
    const matches = candidates.filter((el) => {
      const text = (el.textContent || "").trim();
      const aria = (el.getAttribute("aria-label") || "");
      
      // Exclude non-thread controls (tables, sidebars, query actions, etc.)
      const excludePattern = /table|pane|sidebar|menu|option|action|notification|download|share|copy|rewrite|helpful|feedback/i;
      if (excludePattern.test(text) || excludePattern.test(aria)) {
        return false;
      }
      
      let isMatch = false;
      if (pattern instanceof RegExp) {
        isMatch = pattern.test(text) || pattern.test(aria);
      } else {
        const lower = pattern.toLowerCase();
        isMatch = text.toLowerCase().includes(lower) || aria.toLowerCase().includes(lower);
        if (isMatch && text.length > lower.length + 15) {
          isMatch = false;
        }
      }
      return isMatch && el.getBoundingClientRect().width > 0;
    });
    const strict = matches.filter((el) => el.tagName === "BUTTON" || el.getAttribute("role") === "button");
    const pool = strict.length > 0 ? strict : matches;
    const innermost = pool.filter((el) => !pool.some((other) => other !== el && other.contains(el)));

    return innermost.map((el) => {
      const interactive = el.closest('button, [role="button"], [tabindex], a');
      return interactive || el;
    });
  }

  function docOrder(a, b) {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function clickToggle(btn) {
    try {
      const rect = btn.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((type) => {
        try {
          const Ctor = type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
          btn.dispatchEvent(new Ctor(type, opts));
        } catch (_) {}
      });
      if (typeof btn.click === "function") {
        btn.click();
      } else {
        btn.dispatchEvent(new MouseEvent("click", opts));
      }
    } catch (err) {
      console.warn("[PPLX Obsidian Exporter] Toggle click failed:", err, btn);
    }
  }

  async function expandAllPrompts() {
    const MAX_ROUNDS = 6;
    const allClicked = new Set();
    const expandRegex = /show\s*(?:\d+\s*)?more|more\s*queries|show\s*queries|show\s*previous|view\s*more|expand/i;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const toggles = findToggleButtons(expandRegex).sort(docOrder);
      const fresh = toggles.filter((btn) => !allClicked.has(btn));
      console.log(
        `[PPLX Obsidian Exporter] Expand round ${round + 1}: found ${toggles.length} toggle(s), ${fresh.length} new.`,
        fresh
      );
      if (fresh.length === 0) {
        break;
      }
      fresh.forEach((btn) => {
        allClicked.add(btn);
        clickToggle(btn);
      });
      await new Promise((r) => setTimeout(r, 250));
    }
    return [...allClicked];
  }

  function collapseAllPrompts() {
    findToggleButtons("show less").forEach((btn) => clickToggle(btn));
  }

  const TURN_DIVIDER_RE = /\n[ \t]*---[ \t]*\n+(?=#\s)/g;

  function stripAllWS(s) {
    return (s || "").replace(/\s+/g, "");
  }

  function stripForMatch(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function buildComparableWithMap(text) {
    let stripped = "";
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (/[a-zA-Z0-9]/.test(c)) {
        stripped += c.toLowerCase();
        map.push(i);
      }
    }
    return { stripped, map };
  }

  function containsAiResponse(el) {
    if (!el) return false;
    const isQuery = el.closest(".group\\/query");
    if (isQuery) {
      return false;
    }
    if (el.querySelector(".prose, .markdown")) {
      return true;
    }
    const buttons = el.querySelectorAll("button, [role='button']");
    for (const btn of buttons) {
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      const text = (btn.textContent || "").toLowerCase();
      if (
        aria.includes("rewrite") || text.includes("rewrite") ||
        aria.includes("copy answer") || text.includes("copy answer") ||
        aria.includes("view sources") || text.includes("view sources")
      ) {
        return true;
      }
    }
    return false;
  }

  function getThreadMessagesFromReact() {
    // --- Helper: check if an array looks like a thread messages list ---
    function isMessagesArray(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const sample = arr[0];
      if (!sample || typeof sample !== "object") return false;
      const keys = Object.keys(sample);
      return keys.includes("query") || keys.includes("query_str") ||
             keys.includes("answer") || keys.includes("role") ||
             keys.includes("message") || keys.includes("messageBlocks") ||
             keys.includes("is_user");
    }

    // --- Helper: recursively search a plain JS object tree for a messages array ---
    function deepSearch(obj, depth, visited) {
      if (depth > 12 || !obj || typeof obj !== "object" || visited.has(obj)) return null;
      visited.add(obj);
      if (isMessagesArray(obj)) return obj;
      if (!Array.isArray(obj)) {
        if (Array.isArray(obj.messageBlocks) && isMessagesArray(obj.messageBlocks)) return obj.messageBlocks;
        if (Array.isArray(obj.messages) && isMessagesArray(obj.messages)) return obj.messages;
      }
      const keys = Array.isArray(obj) ? obj.map((_, i) => i) : Object.keys(obj);
      for (const k of keys) {
        try {
          const val = obj[k];
          if (val && typeof val === "object") {
            const r = deepSearch(val, depth + 1, visited);
            if (r) return r;
          }
        } catch (_) {}
      }
      return null;
    }

    // ===============================================================
    // Strategy 1: Walk the React Fiber tree via child/sibling and
    //             inspect every hook's memoizedState for each fiber.
    // ===============================================================
    let rootFiber = null;
    const nextEl = document.getElementById("__next") || document.body;
    for (const key in nextEl) {
      if (key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")) {
        rootFiber = nextEl[key];
        break;
      }
    }

    if (rootFiber) {
      // Walk up to the true root fiber (the HostRoot)
      let hostRoot = rootFiber;
      while (hostRoot.return) hostRoot = hostRoot.return;

      const fiberVisited = new Set();
      let fiberResult = null;
      let fibersScanned = 0;

      function scanHooks(fiber) {
        // Walk the hooks linked list on this fiber
        let hook = fiber.memoizedState;
        let hookIdx = 0;
        while (hook && typeof hook === "object" && hookIdx < 50) {
          hookIdx++;
          // For useSyncExternalStore / useState / useReducer, the value lives in
          // hook.memoizedState.  It could be the messages array directly, or an
          // object/array wrapping it.
          const val = hook.memoizedState;
          if (val && typeof val === "object") {
            const visited = new Set();
            const r = deepSearch(val, 0, visited);
            if (r) return r;
          }
          // Also check queue.lastRenderedState (useState/useReducer)
          if (hook.queue && hook.queue.lastRenderedState) {
            const visited = new Set();
            const r = deepSearch(hook.queue.lastRenderedState, 0, visited);
            if (r) return r;
          }
          hook = hook.next;
        }
        // For class components, check stateNode.state
        if (fiber.stateNode && typeof fiber.stateNode === "object" && fiber.stateNode.state) {
          const visited = new Set();
          const r = deepSearch(fiber.stateNode.state, 0, visited);
          if (r) return r;
        }
        return null;
      }

      function walkFiber(fiber) {
        if (!fiber || fiberVisited.has(fiber) || fiberResult) return;
        fiberVisited.add(fiber);
        fibersScanned++;
        if (fibersScanned > 5000) return; // safety cap

        fiberResult = scanHooks(fiber);
        if (fiberResult) return;

        walkFiber(fiber.child);
        if (fiberResult) return;
        walkFiber(fiber.sibling);
      }

      walkFiber(hostRoot);

      if (fiberResult) {
        return simplifyMessages(fiberResult);
      }
    }

    // ===============================================================
    // Strategy 2: Check window.__NEXT_DATA__ for SSR-delivered thread data.
    // ===============================================================
    try {
      if (window.__NEXT_DATA__) {
        const visited = new Set();
        const r = deepSearch(window.__NEXT_DATA__, 0, visited);
        if (r) return simplifyMessages(r);
      }
    } catch (_) {}

    // ===============================================================
    // Strategy 3: Scan window-level properties for Zustand stores.
    //             A Zustand store has .getState() returning an object.
    // ===============================================================
    try {
      const windowKeys = Object.getOwnPropertyNames(window);
      for (const wk of windowKeys) {
        try {
          const wv = window[wk];
          if (wv && typeof wv === "object" && typeof wv.getState === "function") {
            const state = wv.getState();
            if (state && typeof state === "object") {
              const visited = new Set();
              const r = deepSearch(state, 0, visited);
              if (r) {
                return simplifyMessages(r);
              }
            }
          }
        } catch (_) {}
      }
    } catch (_) {}

    return null;
  }

  function simplifyMessages(foundMessages) {
    try {
      const simplified = foundMessages.map(msg => {
        if (!msg) return null;
        const textVal = msg.query_str || msg.query || msg.text || msg.content || "";
        const nestedQuery = msg.query && (typeof msg.query === "object" ? (msg.query.text || msg.query.query_str || "") : "");
        const nestedContent = msg.content && (typeof msg.content === "object" ? (msg.content.text || "") : "");
        return {
          query_str: (typeof textVal === "string" ? textVal : "") || 
                     (typeof nestedQuery === "string" ? nestedQuery : "") || 
                     (typeof nestedContent === "string" ? nestedContent : "") || 
                     null
        };
      });
      console.log("[PPLX Obsidian Exporter] Extracted simplified messages:", simplified);
      return simplified;
    } catch (e) {
      console.error("Error simplifying messages:", e);
      return null;
    }
  }

  function getPromptTextFromMsg(msg) {
    if (!msg || typeof msg !== "object") return null;
    if (typeof msg.query_str === "string") return msg.query_str;
    if (typeof msg.query === "string") return msg.query;
    if (msg.query && typeof msg.query === "object") {
      if (typeof msg.query.text === "string") return msg.query.text;
      if (typeof msg.query.query === "string") return msg.query.query;
    }
    if (typeof msg.text === "string") return msg.text;
    if (typeof msg.content === "string") return msg.content;
    if (msg.content && typeof msg.content === "object" && typeof msg.content.text === "string") return msg.content.text;
    return null;
  }

  function findReactMessageForChunk(reactMsgs, title, turnNum) {
    if (!reactMsgs || !title) return null;
    const target = stripForMatch(title);
    const directMsg = reactMsgs[turnNum - 1];
    if (directMsg) {
      const pText = getPromptTextFromMsg(directMsg);
      if (pText && stripForMatch(pText).startsWith(target)) {
        return directMsg;
      }
    }
    for (const msg of reactMsgs) {
      const pText = getPromptTextFromMsg(msg);
      if (pText && stripForMatch(pText).startsWith(target)) {
        return msg;
      }
    }
    return null;
  }

  function findPromptElement(titleText, afterNode, turnNum) {
    const target = stripForMatch(titleText);
    if (!target) return null;

    const root = getSearchRoot();

    // Log all query elements found by CSS selector
    const queryEls = [...root.querySelectorAll(".group\\/query")];

    if (turnNum !== undefined && queryEls[turnNum - 1]) {
      const el = queryEls[turnNum - 1];
      const text = stripForMatch(el.textContent || "");
      const isMatch = text === target || (text.length > target.length && text.startsWith(target));
      if (isMatch) {
        console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: matched query container via index.`);
        return el;
      }
    }

    // Fallback to text candidate scanning
    const candidates = [...root.querySelectorAll("div, p, span, section, article")];

    let bestEl = null;
    for (const el of candidates) {
      if (afterNode) {
        const pos = afterNode.compareDocumentPosition(el);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      }

      const text = stripForMatch(el.textContent || "");
      if (text === target || (text.length > target.length && text.startsWith(target))) {
        if (!bestEl || bestEl.contains(el)) {
          bestEl = el;
        }
      }
    }

    if (bestEl) {
      let current = bestEl;
      while (current && current.parentElement && current.parentElement !== root) {
        const hasAi = containsAiResponse(current.parentElement);
        if (hasAi) {
          break; // Stop climbing if parent wraps both prompt and response
        }
        current = current.parentElement;
      }
      bestEl = current;
    }

    return bestEl;
  }

  function getCleanText(el) {
    if (!el) return "";
    let text = el.textContent || "";
    text = text.replace(/Show\s*(more|less)/gi, "");
    return text.trim();
  }

  function getFullPromptText(el) {
    if (!el) return "";
    
    const isQueryContainer = el.classList.contains("group/query") || el.matches(".group\\/query");

    if (isQueryContainer) {
      const clean = getCleanText(el);
      return clean;
    }

    const textParts = [];
    let sib = el;
    while (sib) {
      const hasAi = containsAiResponse(sib);
      if (hasAi) {
        break; // Stop if we hit the AI response element or container
      }
      const text = getCleanText(sib);
      if (text) {
        textParts.push(text);
      }
      sib = sib.nextElementSibling;
    }
    const full = textParts.join("\n\n").trim();
    return full;
  }

  function findBibliographyStart(text, fromIdx) {
    const spanRe = /<span style="display:none">/;
    const footnoteRe = /\n\s*\[\^[^\]]+\]:\s/;
    const rest = text.slice(fromIdx);
    const spanMatch = spanRe.exec(rest);
    const footnoteMatch = footnoteRe.exec(rest);
    const candidates = [];
    if (spanMatch) candidates.push(fromIdx + spanMatch.index);
    if (footnoteMatch) candidates.push(fromIdx + footnoteMatch.index);
    return candidates.length > 0 ? Math.min(...candidates) : -1;
  }

  function splitSources(responsePart) {
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

  function findPromptEnd(strippedBody, strippedDomPrompt) {
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
          console.log(`[PPLX Obsidian Exporter] Matched prompt end using trailing suffix of length ${len}: "${suffix}"`);
          return sIdx + len;
        }
      }
    }

    return -1;
  }

  function splitPromptFromResponse(chunkText, domPromptText, turnNum, title) {
    const { body: chunkBody, sources } = splitSources(chunkText);

    const headingMatch = chunkBody.match(/^#{1,6}[^\n]*\n+/);
    const startIdx = headingMatch ? headingMatch[0].length : 0;
    const bodyContent = chunkBody.slice(startIdx);

    const domPromptStripped = stripAllWS(domPromptText);
    const titleStripped = stripAllWS(title || "");
    if (titleStripped && domPromptStripped === titleStripped) {
      console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: fast path — title equals DOM prompt.`);
      return {
        prompt: chunkBody.slice(0, startIdx).trim(),
        response: bodyContent.trim(),
        sources
      };
    }

    const { stripped: strippedBody, map: bodyMap } = buildComparableWithMap(chunkBody);
    const strippedDomPrompt = stripForMatch(domPromptText);

    if (!strippedDomPrompt) {
      console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: strippedDomPrompt is empty.`);
      return null;
    }

    const promptEndStrippedIdx = findPromptEnd(strippedBody, strippedDomPrompt);
    if (promptEndStrippedIdx === -1) {
      console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: strippedDomPrompt not found in strippedBody.`);
      return null;
    }

    const originalEndIdx = bodyMap[promptEndStrippedIdx - 1] + 1;

    // Scan forward for the first alphanumeric character of the response
    const remainingText = chunkBody.slice(originalEndIdx);
    const firstAlphanumRelIdx = remainingText.search(/[a-zA-Z0-9]/);
    const splitIdx = firstAlphanumRelIdx === -1 ? originalEndIdx : originalEndIdx + firstAlphanumRelIdx;

    const promptPart = chunkBody.slice(0, splitIdx).trim();
    const responsePart = chunkBody.slice(splitIdx).trim();

    if (!promptPart || !responsePart) {
      console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: split yielded empty prompt or response.`);
      return null;
    }

    return {
      prompt: promptPart,
      response: responsePart,
      sources
    };
  }

  function splitPromptFromResponseFallback(chunkText, turnNum) {
    const { body: chunkBody, sources } = splitSources(chunkText);
    const paragraphs = chunkBody.split(/\n\s*\n/);
    if (paragraphs.length <= 1) {
      return { prompt: chunkBody, response: "", sources };
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

    if (firstResponseParaIdx !== -1) {
      const promptPart = paragraphs.slice(0, firstResponseParaIdx).join("\n\n").trim();
      const responsePart = paragraphs.slice(firstResponseParaIdx).join("\n\n").trim();
      console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: fallback split via citation/heading match at paragraph ${firstResponseParaIdx}`);
      return { prompt: promptPart, response: responsePart, sources };
    }

    // Default fallback if no citations or subheadings found: split after first paragraph
    const promptPart = paragraphs[0].trim();
    const responsePart = paragraphs.slice(1).join("\n\n").trim();
    return { prompt: promptPart, response: responsePart, sources };
  }

  function annotateConversation(fullText, toggles) {
    const chunks = fullText.split(TURN_DIVIDER_RE).filter((c) => c.trim().length > 0);
    console.log(`[PPLX Obsidian Exporter] Split into ${chunks.length} chunk(s) via TURN_DIVIDER_RE.`);

    const warnings = [];
    const out = [];
    let lastMatchedNode = null;

    let reactMsgs = null;
    try {
      reactMsgs = getThreadMessagesFromReact();
    } catch (err) {
      console.warn("[PPLX Obsidian Exporter] Error getting react messages:", err);
    }

    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      const turnNum = idx + 1;
      const titleMatch = chunk.match(/^#\s+(.+?)\s*(?:\n|$)/);
      const title = titleMatch ? titleMatch[1].trim() : null;

      let split = null;
      let domEl = null;

      // 1. Try React messages state first (works for virtualized/collapsed/deleted turns)
      if (title && reactMsgs) {
        const msg = findReactMessageForChunk(reactMsgs, title, turnNum);
        if (msg) {
          const promptText = getPromptTextFromMsg(msg);
          if (promptText) {
            console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: found matching prompt text in React state (length=${promptText.length}).`);
            split = splitPromptFromResponse(chunk, promptText, turnNum, title);
          }
        }
      }

      // 2. Fallback to DOM element scanning
      if (!split && title) {
        domEl = findPromptElement(title, lastMatchedNode, turnNum);

        console.log(
          `[PPLX Obsidian Exporter] Turn ${turnNum}: title="${title.slice(0, 80)}" domEl=${domEl ? "FOUND" : "NOT FOUND"}`
        );

        if (domEl) {
          const domPromptText = getFullPromptText(domEl);
          console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: matched prompt element with text length:`, domPromptText.length);
          split = splitPromptFromResponse(chunk, domPromptText, turnNum, title);
        }
      } else if (!title) {
        console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: could not extract a title heading from chunk.`);
      }

      if (split) {
        if (domEl) {
          lastMatchedNode = domEl;
        }
        out.push(
          `<!-- PPLX-TURN ${turnNum} -->\n` +
          `<!-- PPLX-ROLE: prompt -->\n${split.prompt}\n\n` +
          `<!-- PPLX-ROLE: ai -->\n${split.response}\n\n` +
          `<!-- PPLX-ROLE: sources -->\n${split.sources || "(none)"}`
        );
      } else {
        const fallbackSplit = splitPromptFromResponseFallback(chunk, turnNum);
        if (fallbackSplit) {
          out.push(
            `<!-- PPLX-TURN ${turnNum} -->\n` +
            `<!-- PPLX-ROLE: prompt -->\n${fallbackSplit.prompt}\n\n` +
            `<!-- PPLX-ROLE: ai -->\n${fallbackSplit.response}\n\n` +
            `<!-- PPLX-ROLE: sources -->\n${fallbackSplit.sources || "(none)"}`
          );
        } else {
          warnings.push(turnNum);
          out.push(
            `<!-- PPLX-TURN ${turnNum} -->\n` +
            `<!-- PPLX-ROLE: unknown (prompt/response boundary not detected) -->\n${chunk.trim()}`
          );
        }
      }
    }

    return { text: out.join("\n\n"), warnings };
  }

  async function copyText(text) {
    const toggles = await expandAllPrompts();

    const { result: logoStripped } = stripLogo(text);

    const { text: annotated, warnings } = annotateConversation(logoStripped, toggles);
    if (warnings.length > 0) {
      showToast(
        `Turn(s) ${warnings.join(", ")} boundaries unresolved — copied with fallback.`,
        true
      );
    }

    collapseAllPrompts();

    const full = buildHeader() + annotated;
    if (typeof GM_setClipboard !== "undefined") {
      GM_setClipboard(full, "text");
      showToast("Copied annotated export to clipboard (no file saved)");
      return true;
    }
    try {
      await navigator.clipboard.writeText(full);
      showToast("Copied annotated export to clipboard (no file saved)");
      return true;
    } catch (err) {
      console.error("[PPLX Obsidian Exporter] Clipboard write failed:", err);
      showToast("Clipboard write failed — saving file instead", true);
      return false;
    }
  }

  function isExportDownload(href, download) {
    return (download && /\.(md|markdown|txt)$/i.test(download)) ||
           (href && (href.startsWith("blob:") || href.startsWith("data:")));
  }

  function dismissPerplexityToasts() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  }

  async function handleCandidateHref(href, anchorEl) {
    let text = null;
    try {
      if (href.startsWith("blob:") && blobRegistry.has(href)) {
        text = await blobRegistry.get(href).text();
      } else if (href.startsWith("blob:")) {
        const resp = await fetch(href);
        text = await resp.text();
      } else if (href.startsWith("data:")) {
        const commaIdx = href.indexOf(",");
        const meta = href.slice(5, commaIdx);
        const raw = href.slice(commaIdx + 1);
        text = meta.includes("base64") ? atob(raw) : decodeURIComponent(raw);
      }
    } catch (err) {
      console.error("[PPLX Obsidian Exporter] Failed to read blob/data URL:", err);
      showToast("Could not read export content — saving file instead", true);
      OrigAnchorClick.call(anchorEl);
      return;
    }

    if (text === null) {
      OrigAnchorClick.call(anchorEl);
      return;
    }

    const success = await copyText(text);
    if (!success) {
      OrigAnchorClick.call(anchorEl);
    } else {
      dismissPerplexityToasts();
    }
  }

  const OrigAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const href = this.href || "";
      const looksLikeExport = isExportDownload(href, this.download);
      if (looksLikeExport) {
        handleCandidateHref(href, this);
        dismissPerplexityToasts();
        return;
      }
    } catch (err) {
      console.error("[PPLX Obsidian Exporter] Intercept error:", err);
    }
    return OrigAnchorClick.call(this);
  };

})();
