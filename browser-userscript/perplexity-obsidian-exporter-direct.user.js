// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (Direct & Robust)
// @namespace    scott-otterson-obsidian-export-direct
// @version      8.8
// @description  Robustly exports Perplexity conversations to Obsidian Markdown format by intercepting native markdown downloads and aligning prompt-response boundaries via text-mapping.
// @match        https://www.perplexity.ai/*
// @match        https://perplexity.ai/*
// @grant        GM_setClipboard
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
        try {
          dismissPerplexityToasts();
        } catch (_) {}
      }
    } catch (_) {}
    return url;
  };

  function getSearchRoot() {
    return document.querySelector("main") || document.body;
  }

  // Toast state:
  //   "progress" — a status shown mid-export (e.g. "Preparing export...").
  //                Never auto-hides on its own; stays up until replaced by
  //                either another progress update or a final result.
  //   "success" / "error" — a final result. Auto-hides after a delay, but
  //                that delay is much longer than the original 3.8s so a
  //                user glancing away for a moment doesn't miss it.
  function showToast(msg, kind) {
    const t = document.getElementById("pplx-clip-toast") || (() => {
      const el = document.createElement("div");
      el.id = "pplx-clip-toast";
      el.style.cssText = `
        position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);
        z-index: 999999; padding: 20px 32px; border-radius: 12px;
        font: 18px/1.4 sans-serif; font-weight: 600; color: #fff; transition: opacity 0.3s;
        pointer-events: none; max-width: 80vw; text-align: center;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
        border: 2px solid rgba(255, 255, 255, 0.25);
      `;
      document.body.appendChild(el);
      return el;
    })();

    const colors = {
      progress: "#1565c0", // blue — work is actively happening, do not navigate away
      success: "#2e7d32", // green — done, safe to leave the page
      error: "#c0392b",
    };
    const icons = { progress: "⏳", success: "✅", error: "⚠️" };
    t.style.background = colors[kind] || colors.error;
    t.textContent = `${icons[kind] || icons.error} ${msg}`;
    t.style.opacity = "1";
    clearTimeout(t._hideTimer);
    if (kind !== "progress") {
      // Final result: auto-hide, but only after a delay generous enough
      // that a user who glanced away for a second or two still sees it.
      t._hideTimer = setTimeout(() => (t.style.opacity = "0"), 6000);
    }
    // A "progress" toast is intentionally left up with no timer — it is
    // always expected to be replaced by a later showToast() call once the
    // export actually finishes (success or error), never left dangling.
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
    const expandRegex = /show\s*(?:\d+\s*)?more|more\s*queries|show\s*queries|show\s*previous|view\s*more|read\s*more|expand/i;
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

  const TURN_DIVIDER_RE = /\n[ \t]*---[ \t]*\n+(?=(?:```.*\n)?#\s)/g;

  function stripAllWS(s) {
    return (s || "").replace(/\s+/g, "");
  }

  function stripHtmlTags(text) {
    return (text || "").replace(/<\/?q>/gi, "");
  }

  function stripForMatch(text) {
    return stripHtmlTags(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function unwrapFencedHeading(text) {
    let trimmed = (text || "").trim();
    if (trimmed.startsWith("```")) {
      // 1. Try greedy match when full string is wrapped in backticks (safely preserving nested code blocks)
      let match = trimmed.match(/^```(\S*)\r?\n([\s\S]*)\r?\n```$/);
      if (match) {
        const inside = match[2].trim();
        if (inside.startsWith("#")) {
          return inside;
        }
      }

      // 2. Try matching leading fenced heading block followed by trailing text (skipping inner code blocks inside unclosed <q> tags)
      const lines = trimmed.split("\n");
      let fenceEndIdx = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith("```")) {
          const candidateInside = lines.slice(1, i).join("\n").trim();
          if (candidateInside.startsWith("#")) {
            if (candidateInside.includes("<q>") && !candidateInside.includes("</q>")) {
              continue; // skip inner code blocks inside <q>...</q>
            }
            fenceEndIdx = i;
            break;
          }
        }
      }

      if (fenceEndIdx !== -1) {
        const inside = lines.slice(1, fenceEndIdx).join("\n").trim();
        const rest = lines.slice(fenceEndIdx + 1).join("\n").trim();
        return rest ? `${inside}\n\n${rest}` : inside;
      }

      // 3. Fallback: match without closing backticks (e.g. unclosed fence at EOF)
      match = trimmed.match(/^```(\S*)\r?\n([\s\S]*)$/);
      if (match) {
        const inside = match[2].trim();
        if (inside.startsWith("#")) {
          return inside;
        }
      }
    }
    return trimmed;
  }


  function buildComparableWithMap(text) {
    let stripped = "";
    const map = [];
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
    console.log(
      `[PPLX Diag] Turn ${turnNum}: findReactMessageForChunk — reactMsgs.length=${reactMsgs.length}, target(len=${target.length})="${target.slice(0, 60)}"`
    );

    const directMsg = reactMsgs[turnNum - 1];
    if (directMsg) {
      const pText = getPromptTextFromMsg(directMsg);
      const pStripped = pText ? stripForMatch(pText) : "";
      console.log(
        `[PPLX Diag] Turn ${turnNum}: direct index [${turnNum - 1}] pText(len=${pText ? pText.length : 0})="${(pText || "").slice(0, 80)}" startsWithTarget=${pText ? pStripped.startsWith(target) : false}`
      );
      if (pText && pStripped.startsWith(target)) {
        console.log(`[PPLX Diag] Turn ${turnNum}: MATCHED via direct index [${turnNum - 1}].`);
        return directMsg;
      }
    } else {
      console.log(`[PPLX Diag] Turn ${turnNum}: no reactMsgs entry at direct index [${turnNum - 1}].`);
    }

    for (let mi = 0; mi < reactMsgs.length; mi++) {
      const msg = reactMsgs[mi];
      const pText = getPromptTextFromMsg(msg);
      if (pText && stripForMatch(pText).startsWith(target)) {
        console.log(
          `[PPLX Diag] Turn ${turnNum}: MATCHED via full-array scan at index [${mi}] (expected [${turnNum - 1}]). pText(len=${pText.length})="${pText.slice(0, 80)}"`
        );
        return msg;
      }
    }
    console.log(`[PPLX Diag] Turn ${turnNum}: NO react message matched title at all. Falling back to DOM strategy.`);
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

      // Skip candidates that live inside the AI response body (e.g. an echoed
      // heading that repeats the query verbatim). The query bubble is never
      // rendered inside the response's prose/markdown container, so matching
      // text found there is always a false positive that would swallow part
      // of the AI response into the "prompt" text.
      if (el.closest(".prose, .markdown")) continue;

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

  // Perplexity renders per-turn UI chrome (a timestamp badge, a "Completed N
  // steps"/"Searching ..."/"Checking ..." research-trace summary, and/or a
  // trailing "N sources" badge) inside the SAME DOM container as the user's
  // query text. None of that is text the user typed, but a plain
  // `.textContent` read slurps it in right after the real prompt, which
  // corrupts every downstream comparison against the markdown title/body
  // (confirmed via [PPLX Diag] logging: every turn's domPromptText ended in
  // one of these patterns, e.g. "...saftety2:55 PM\n\nSearching public
  // safety data" or "...road networks\n\n23 sources"). Truncate at the
  // earliest such marker so only the genuine typed prompt remains.
  function stripTrailingStatusChrome(text) {
    if (!text) return text;
    // All three patterns are anchored to the END of the string (`$`).
    // These previously matched anywhere in the text and took the
    // EARLIEST match, which truncated real prompt prose containing an
    // ordinary clock time ("what happened at 9:30 AM") or the phrase
    // "completed N steps" used in conversation, not as UI chrome. Only a
    // TRAILING occurrence is ever actual chrome.
    const patterns = [
      // Timestamp badge, e.g. "2:39 PM". No leading \b: Perplexity
      // concatenates this directly against the query text with no
      // separator (e.g. "...saftety2:55 PM"), so there is no word
      // boundary between the trailing letter and the leading digit.
      /\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/i,
      /\bCompleted\s+\d+\s+steps?\s*$/i, // research-trace summary
      /\n\s*\d+\s+sources?\s*$/i, // trailing source-count badge
    ];
    let cutIdx = -1;
    for (const p of patterns) {
      const m = p.exec(text);
      if (m && (cutIdx === -1 || m.index < cutIdx)) {
        cutIdx = m.index;
      }
    }
    if (cutIdx === -1) return text;
    console.log(
      `[PPLX Diag] stripTrailingStatusChrome: truncating at idx=${cutIdx}, removed="${text.slice(cutIdx, cutIdx + 60)}..."`
    );
    return text.slice(0, cutIdx).trim();
  }

  function getCleanText(el) {
    if (!el) return "";
    let text = el.textContent || "";
    text = text.replace(/Show\s*(more|less)/gi, "");
    // Anchored to the end: this is a toggle LABEL that gets glued onto the
    // real prompt text (e.g. "...education.Read less" / "...Read more").
    // An unanchored/global replace would also delete a legitimate
    // occurrence of the phrase "read more" inside the user's own prompt
    // (e.g. "Read more about X and summarize").
    text = text.replace(/\s*Read\s*more\s*$/i, "");
    text = stripTrailingStatusChrome(text);
    return text.trim();
  }

  // Matches Perplexity's research-trace/status UI text — the kind of
  // thing that ends up glued onto domPromptText from a separate DOM
  // sibling that stripTrailingStatusChrome() (which only sees one node at
  // a time) can't reach. Deliberately narrow: only recognizable status
  // shapes (gerund research-action phrases, "N sources" badges, step-trace
  // summaries, bare timestamps) count, so ordinary multi-line prompt text
  // that happens to start with the title is never misclassified as chrome.
  const STATUS_CHROME_RE = new RegExp(
    "^(?:" +
      "\\d+\\s+sources?" + // "23 sources"
      "|completed\\s+\\d+\\s+steps?" + // "Completed 2 steps"
      "|\\d{1,2}:\\d{2}\\s*(?:AM|PM)" + // "2:55 PM"
      // Research-status phrase, e.g. "Searching public safety data",
      // "Checking traffic-car statistics". Deliberately narrow: capped
      // length and NO sentence-terminating punctuation (`.`, `?`, `!`,
      // `,`, `;`, `:`), so a real prompt continuation that happens to
      // start with one of these common verbs (e.g. "Looking at 2024 data
      // only, which state is cheaper?" or "Reading level should stay
      // simple and keep it under 400 words.") is never misclassified as
      // chrome — genuine Perplexity status lines are short noun-phrase
      // fragments with no punctuation, never full sentences.
      "|(?:searching|checking|reading|analyzing|researching|browsing|looking|gathering|verifying|reviewing|comparing|calculating|summarizing|investigating|examining|scanning|querying|fetching|retrieving|compiling|collecting|cross[- ]?checking|double[- ]?checking|pulling)\\b[^\\n.?!,;:]{0,60}" +
      ")\\s*$",
    "i"
  );

  /**
   * True when domPromptText is exactly `title` followed by a trailing
   * remainder that matches a known UI-chrome shape (whitespace-flexibly
   * matched, so differences in blank lines between title and the DOM text
   * don't matter). Used to decide whether it's safe to trust the title as
   * the full prompt even though domPromptText != title verbatim.
   */
  function isKnownStatusChromeSuffix(title, domPromptText) {
    if (!title || !domPromptText) return false;
    const escapedTitle = title.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
    const prefixRe = new RegExp("^\\s*" + escapedTitle, "i");
    const m = prefixRe.exec(domPromptText);
    if (!m) return false;
    const rawSuffix = domPromptText.slice(m[0].length).trim();
    if (!rawSuffix) return false;
    // The suffix is frequently MULTIPLE chrome fragments from separate DOM
    // siblings joined with a blank line — e.g. a "Checking ..." research
    // step summary followed by a "N sources" badge (confirmed via [PPLX
    // Diag] sibling-level logging: sibling[1]="Checking the claim about
    // Roman and modern road networks", sibling[2]="23 sources"). Testing
    // the whole suffix as one string against STATUS_CHROME_RE fails
    // because its gerund alternative stops at the first newline. Instead,
    // split on blank lines and require every resulting segment to
    // independently match a known chrome shape.
    const segments = rawSuffix
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return false;
    return segments.every((seg) => STATUS_CHROME_RE.test(seg));
  }

  function getFullPromptText(el) {
    if (!el) return "";

    const isQueryContainer = el.classList.contains("group/query") || el.matches(".group\\/query");

    if (isQueryContainer) {
      console.log(
        `[PPLX Diag] getFullPromptText: isQueryContainer path. RAW el.textContent(len=${(el.textContent || "").length})="${el.textContent}"`
      );
      const clean = getCleanText(el);
      return clean;
    }

    const textParts = [];
    let sib = el;
    let sibIdx = 0;
    while (sib) {
      const hasAi = containsAiResponse(sib);
      if (hasAi) {
        console.log(`[PPLX Diag] getFullPromptText: sibling[${sibIdx}] containsAiResponse=true, stopping walk.`);
        break; // Stop if we hit the AI response element or container
      }
      const rawSibText = sib.textContent || "";
      const text = getCleanText(sib);
      console.log(
        `[PPLX Diag] getFullPromptText: sibling[${sibIdx}] tag=${sib.tagName} rawLen=${rawSibText.length} raw="${rawSibText.slice(0, 120)}" cleanedLen=${text.length} cleaned="${text.slice(0, 120)}"`
      );
      if (text) {
        textParts.push(text);
      }
      sib = sib.nextElementSibling;
      sibIdx++;
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

    const domPromptStripped = stripAllWS(stripHtmlTags(domPromptText));
    const titleStripped = stripAllWS(stripHtmlTags(title || ""));
    console.log(
      `[PPLX Diag] Turn ${turnNum}: splitPromptFromResponse — domPromptText(len=${domPromptText.length})="${domPromptText.slice(0, 60)}"...${domPromptText.slice(-40)}", title(len=${(title || "").length})="${(title || "").slice(0, 60)}"`
    );
    console.log(
      `[PPLX Diag] Turn ${turnNum}: domPromptStripped.length=${domPromptStripped.length}, titleStripped.length=${titleStripped.length}, equal=${domPromptStripped === titleStripped}`
    );
    // Perplexity's own H1 heading is generated verbatim from the user's
    // typed query, so domPromptText should always start with it. In
    // practice domPromptText frequently has a research-trace status line
    // ("Searching ...", "Checking ...") or a "N sources" badge glued on
    // after the real prompt text, living in a separate DOM node that
    // stripTrailingStatusChrome() (applied per sibling) can't see. Rather
    // than accepting ANY short trailing remainder as chrome — which would
    // also wrongly discard real multi-line prompt content that merely
    // starts with the title (e.g. "Explain links\n\nGo to Google to
    // search.") — require the remainder to actually match a known chrome
    // shape: a gerund research-status phrase, a source-count badge, a
    // step-trace summary, or a timestamp.
    const isTitlePlusChrome = titleStripped && isKnownStatusChromeSuffix(title, domPromptText);
    if (isTitlePlusChrome) {
      console.log(
        `[PPLX Diag] Turn ${turnNum}: domPromptText is title + a recognized UI-chrome suffix — treating as title-plus-chrome fast path.`
      );
    }

    if (!chunkBody.startsWith("```") && titleStripped && (domPromptStripped === titleStripped || isTitlePlusChrome)) {
      console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: fast path — title equals DOM prompt (or title + trailing UI chrome).`);
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
      console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: strippedDomPrompt is empty.`);
      return null;
    }

    const promptEndStrippedIdx = findPromptEnd(strippedBody, strippedDomPrompt);
    if (promptEndStrippedIdx === -1) {
      console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: strippedDomPrompt not found in strippedBody.`);
      return null;
    }
    console.log(
      `[PPLX Diag] Turn ${turnNum}: findPromptEnd matched at strippedIdx=${promptEndStrippedIdx} of strippedBody.length=${strippedBody.length}. ` +
      `Stripped context around match: "...${strippedBody.slice(Math.max(0, promptEndStrippedIdx - 30), promptEndStrippedIdx)}[[SPLIT]]${strippedBody.slice(promptEndStrippedIdx, promptEndStrippedIdx + 30)}..."`
    );

    let originalEndIdx = bodyMap[promptEndStrippedIdx - 1] + 1;
    console.log(
      `[PPLX Diag] Turn ${turnNum}: originalEndIdx=${originalEndIdx} of chunkBody.length=${chunkBody.length}. ` +
      `Original context around split: "...${chunkBody.slice(Math.max(0, originalEndIdx - 40), originalEndIdx)}[[SPLIT]]${chunkBody.slice(originalEndIdx, originalEndIdx + 40)}..."`
    );

    // If chunkBody starts with a codeblock and there is a closing ``` after originalEndIdx
    // but before the response starts, we can consume it as part of the split so that
    // promptPart is a complete fenced code block.
    if (chunkBody.startsWith("```")) {
      const remaining = chunkBody.slice(originalEndIdx);
      const closeMatch = remaining.match(/^([ \t]*\n)*[ \t]*```/);
      if (closeMatch) {
        originalEndIdx += closeMatch[0].length;
      }
    }

    // Scan forward for the first alphanumeric character of the response
    const remainingText = chunkBody.slice(originalEndIdx);
    const firstAlphanumRelIdx = remainingText.search(/[a-zA-Z0-9]/);
    const splitIdx = firstAlphanumRelIdx === -1 ? originalEndIdx : originalEndIdx + firstAlphanumRelIdx;

    let promptPart = chunkBody.slice(0, splitIdx).trim();
    const responsePart = chunkBody.slice(splitIdx).trim();

    if (!promptPart || !responsePart) {
      console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: split yielded empty prompt or response.`);
      return null;
    }

    promptPart = unwrapFencedHeading(promptPart);

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
      console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: fallback split via citation/heading match at paragraph ${firstResponseParaIdx}`);
    } else {
      // Default fallback if no citations or subheadings found: split after first paragraph
      promptPart = paragraphs[0].trim();
      responsePart = paragraphs.slice(1).join("\n\n").trim();
    }

    promptPart = unwrapFencedHeading(promptPart);

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
      const titleMatch = chunk.match(/^(?:```.*\n)?#\s+(.+?)\s*(?:\n|$)/);
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
            if (!split) {
              console.log(`[PPLX Diag] Turn ${turnNum}: React-derived promptText did NOT yield a split — falling through to DOM strategy.`);
            }
          } else {
            console.log(`[PPLX Diag] Turn ${turnNum}: React message matched but getPromptTextFromMsg returned null — falling through to DOM strategy.`);
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
          let domPromptText = getFullPromptText(domEl);
          console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: matched prompt element with text length:`, domPromptText.length);

          // getFullPromptText can legitimately come back empty: this happens
          // when the matched "prompt" element is itself already the AI
          // response wrapper (e.g. a search-style first turn with no
          // separate query bubble in the DOM, where the query text only
          // exists as the echoed heading inside the answer). In that case
          // there is no genuine query text to extract from the DOM at all,
          // so fall back to the heading text we already parsed from the
          // markdown itself — it is always correct and lets
          // splitPromptFromResponse take its exact-match fast path instead
          // of falling through to the much less reliable paragraph/citation
          // heuristic, which can misclassify the AI's own intro paragraph
          // as part of the prompt.
          if (!domPromptText) {
            console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: DOM prompt text was empty (matched element is itself the AI response) — using title text as the prompt instead.`);
            domPromptText = title;
          }

          split = splitPromptFromResponse(chunk, domPromptText, turnNum, title);
        }
      } else if (!title) {
        console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: could not extract a title heading from chunk.`);
      }

      if (split) {
        console.log(
          `[PPLX Diag] Turn ${turnNum}: FINAL split — prompt tail(40)="...${split.prompt.slice(-40)}", response head(60)="${split.response.slice(0, 60)}..."`
        );
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
        console.log(`[PPLX Diag] Turn ${turnNum}: both react and DOM strategies failed to produce a split — using paragraph/citation fallback heuristic.`);
        const fallbackSplit = splitPromptFromResponseFallback(chunk, turnNum);
        if (fallbackSplit) {
          console.log(
            `[PPLX Diag] Turn ${turnNum}: FALLBACK split — prompt tail(40)="...${fallbackSplit.prompt.slice(-40)}", response head(60)="${fallbackSplit.response.slice(0, 60)}..."`
          );
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

  // Attempt the clipboard write with a layered fallback, since no single
  // method is reliable in every environment:
  //   1. GM_setClipboard (Tampermonkey's own bridge, granted via
  //      "@grant GM_setClipboard") is not subject to the page's own
  //      focus/user-activation restrictions, so it is preferred whenever
  //      available.
  //   2. navigator.clipboard.writeText() is the fallback for setups where
  //      GM_setClipboard isn't available (e.g. a different userscript
  //      manager, or a Tampermonkey install where the grant hasn't taken
  //      effect yet). It IS subject to focus/user-activation limits: if the
  //      document loses focus, or too much time elapses since the original
  //      click, the browser can silently no-op or reject the write — which
  //      previously surfaced as Obsidian's importer reporting an "empty
  //      clipboard" error despite this script showing a success toast.
  // Both attempts are wrapped individually so a thrown error from the
  // preferred method doesn't prevent trying the fallback.
  async function writeToClipboard(full) {
    if (typeof GM_setClipboard !== "undefined") {
      try {
        GM_setClipboard(full, "text");
        return { success: true, method: "GM_setClipboard" };
      } catch (err) {
        console.warn("[PPLX Obsidian Exporter] GM_setClipboard failed, falling back:", err);
      }
    }
    try {
      await navigator.clipboard.writeText(full);
      return { success: true, method: "navigator.clipboard" };
    } catch (err) {
      console.error("[PPLX Obsidian Exporter] navigator.clipboard.writeText failed:", err);
      return { success: false, error: err };
    }
  }

  async function copyText(text) {
    // Fallback progress feedback: if the earlier click-detection on the
    // "Export as Markdown" menu item missed (e.g. the menu is rendered in
    // a shadow DOM or uses an unexpected structure), at least show the
    // progress toast once our anchor-click interceptor actually fires and
    // we begin the real work.
    showToast("Preparing export — please wait, don't leave this page yet...", "progress");

    const toggles = await expandAllPrompts();

    const { result: logoStripped } = stripLogo(text);

    const { text: annotated, warnings } = annotateConversation(logoStripped, toggles);

    collapseAllPrompts();

    const full = buildHeader() + annotated;

    // Sanity check: if the assembled export is suspiciously small (e.g. the
    // annotation pipeline produced next to nothing), do not report success
    // — an empty or near-empty clipboard is exactly the failure mode this
    // is meant to catch before the user ever leaves the page.
    const MIN_PLAUSIBLE_LENGTH = 40;
    if (full.trim().length < MIN_PLAUSIBLE_LENGTH) {
      console.error("[PPLX Obsidian Exporter] Assembled export text is suspiciously short:", full);
      showToast("Export produced little/no content — saving file instead", "error");
      return false;
    }

    const result = await writeToClipboard(full);
    if (!result.success) {
      showToast("Clipboard write failed — saving file instead", "error");
      return false;
    }

    const warningSuffix = warnings.length > 0
      ? ` (turn(s) ${warnings.join(", ")} boundaries unresolved — used fallback split)`
      : "";
    showToast(`Copied to clipboard — safe to leave this page now${warningSuffix}`, "success");
    return true;
  }

  function isExportDownload(href, download) {
    return (download && /\.(md|markdown|txt)$/i.test(download)) ||
           (href && (href.startsWith("blob:") || href.startsWith("data:")));
  }

  function dismissPerplexityToasts() {
    // 1. Dispatch Escape keydown and keyup events on document and active element with full backwards-compatibility options
    const createEvent = (type) => {
      const e = new KeyboardEvent(type, {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true
      });
      try {
        Object.defineProperty(e, "keyCode", { get: () => 27, configurable: true });
        Object.defineProperty(e, "which", { get: () => 27, configurable: true });
      } catch (_) {}
      return e;
    };

    try {
      const activeEl = document.activeElement || document.body || document;
      activeEl.dispatchEvent(createEvent("keydown"));
      activeEl.dispatchEvent(createEvent("keyup"));
      if (activeEl !== document) {
        document.dispatchEvent(createEvent("keydown"));
        document.dispatchEvent(createEvent("keyup"));
      }
    } catch (e) {
      console.warn("[PPLX Obsidian Exporter] KeyboardEvent dispatch failed:", e);
    }

    // 2. Scan the DOM for progress texts inside toast containers and hide them via CSS (without removing DOM nodes to prevent React crashes)
    const textsToSuppress = [
      "exporting thread",
      "export succeeded",
      "exporting...",
      "exporting",
      "export failed",
      "export completed",
      "export ready",
      "exporting conversation",
      "exporting chat"
    ];

    const hideElement = (el) => {
      if (!el) return;
      try {
        if (el.style) {
          if (typeof el.style.setProperty === "function") {
            el.style.setProperty("display", "none", "important");
            el.style.setProperty("opacity", "0", "important");
            el.style.setProperty("visibility", "hidden", "important");
            el.style.setProperty("pointer-events", "none", "important");
          }
          el.style.display = "none";
        }
      } catch (_) {}
    };

    const performSuppression = () => {
      try {
        const toastContainers = document.querySelectorAll(
          "[data-sonner-toast], [data-radix-toast], [role='status'], [role='alert'], [role='region'], [role='log'], [aria-live], .toast, .notification, [class*='toast'], [class*='Toast'], [class*='notification'], [class*='Notification'], [class*='snackbar'], [class*='Snackbar'], [class*='banner'], ol[aria-label] li, ul[aria-label] li, div[class*='fixed'], div[class*='absolute'], div[class*='sticky']"
        );

        for (const container of toastContainers) {
          if (!container) continue;

          // Never touch root elements or whole document
          if (container === document.body || container === document.documentElement || container.id === "__next" || container.id === "app") {
            continue;
          }

          // Do not touch actual chat turn messages or markdown prose paragraphs
          if (typeof container.closest === "function" && container.closest("[data-message-author-role], .prose, [data-testid='user-message'], [data-testid='assistant-message']")) {
            continue;
          }

          const text = (container.textContent || "").toLowerCase();
          // Toasts are small notification items; skip large content blocks
          if (text.length > 400) continue;

          if (textsToSuppress.some(t => text.includes(t.toLowerCase()))) {
            const card = (typeof container.closest === "function" && container.closest(
              "[data-sonner-toast], [data-radix-toast], [role='status'], [role='alert'], [role='region'], [role='log'], .toast, .notification, [class*='toast'], [class*='Toast'], [class*='notification'], [class*='Notification'], li, div[class*='fixed'], div[class*='absolute'], div[class*='sticky'], div[class*='shadow'], div[class*='rounded']"
            )) || container;

            if (card !== document.body && card !== document.documentElement && card.id !== "__next" && card.id !== "app") {
              hideElement(card);
            }
            if (card !== container) {
              hideElement(container);
            }
          }
        }
      } catch (e) {
        console.warn("[PPLX Obsidian Exporter] DOM suppression failed:", e);
      }
    };

    // Run immediately
    performSuppression();

    // Setup MutationObserver for real-time suppression of dynamically injected toasts
    try {
      if (typeof MutationObserver !== "undefined" && document.body) {
        const observer = new MutationObserver(() => {
          performSuppression();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          try {
            observer.disconnect();
          } catch (_) {}
        }, 10000);
      }
    } catch (_) {}

    // Poll for the next 10 seconds to suppress asynchronously spawned toasts
    const start = Date.now();
    const interval = setInterval(() => {
      performSuppression();
      if (Date.now() - start > 10000) {
        clearInterval(interval);
      }
    }, 50);
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
      showToast("Could not read export content — saving file instead", "error");
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

  // Listen for clicks on the "Export as Markdown" menu item so we can show
  // a progress toast the instant the user initiates an export — well before
  // Perplexity finishes generating the markdown blob and clicks the
  // download anchor our code intercepts. We walk up from the clicked element
  // because the menu item text and the clickable element may be different
  // nodes (text in a child span, etc.).
  try {
    document.addEventListener("click", (e) => {
      let node = e.target;
      while (node && node !== document.body && node !== document.documentElement) {
        const text = ((node.textContent || "")).toLowerCase();
        if (
          text.includes("export as markdown") ||
          text.includes("export markdown") ||
          text.includes("download markdown")
        ) {
          showToast("Preparing export — please wait, don't leave this page yet...", "progress");
          break;
        }
        node = node.parentElement;
      }
    }, true);
  } catch (_) {}

  // Listen for Enter key on inputs containing export commands to trigger suppression immediately
  try {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT" || activeEl.isContentEditable)) {
          const val = (activeEl.value || activeEl.textContent || "").toLowerCase();
          if (val.includes("export")) {
            dismissPerplexityToasts();
          }
        }
      }
    }, true);
  } catch (_) {}

  // Proactively run toast suppression & setup global observer immediately on userscript load
  try {
    dismissPerplexityToasts();
  } catch (_) {}

})();




