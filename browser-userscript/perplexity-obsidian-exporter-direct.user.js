// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (Direct & Robust)
// @namespace    scott-otterson-obsidian-export-direct
// @version      8.0
// @description  Robustly exports Perplexity conversations to Obsidian Markdown format by intercepting native markdown downloads and aligning prompt-response boundaries via text-mapping.
// @match        https://www.perplexity.ai/*
// @match        https://perplexity.ai/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";
  console.log("[PPLX Obsidian Exporter Direct] Userscript started", location.href);

  // Keep track of blobs created for download interception
  const blobRegistry = new Map();
  const OrigCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = OrigCreateObjectURL(obj);
    try {
      if (obj instanceof Blob) blobRegistry.set(url, obj);
    } catch (_) {}
    return url;
  };

  function getSearchRoot() {
    return document.querySelector("main") || document.body;
  }

  function showToast(msg, isError) {
    let t = document.getElementById("pplx-clip-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "pplx-clip-toast";
      t.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        z-index: 999999; padding: 10px 16px; border-radius: 8px;
        font: 13px sans-serif; color: #fff; transition: opacity 0.3s;
        pointer-events: none; max-width: 80vw; text-align: center;
      `;
      document.body.appendChild(t);
    }
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
    let tz = "";
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZoneName: "short",
      }).formatToParts(d);
      const tzPart = parts.find((p) => p.type === "timeZoneName");
      if (tzPart) tz = ` ${tzPart.value}`;
    } catch (_) {
      const offsetMin = -d.getTimezoneOffset();
      const sign = offsetMin >= 0 ? "+" : "-";
      const oh = Math.floor(Math.abs(offsetMin) / 60);
      const om = Math.abs(offsetMin) % 60;
      tz = ` UTC${sign}${pad(oh)}:${pad(om)}`;
    }
    return `${date} ${time}${tz}`;
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

  function findToggleButtons(label) {
    const lower = label.toLowerCase();
    const root = getSearchRoot();
    const candidates = [...root.querySelectorAll('button, [role="button"], span, a, div')];
    const matches = candidates.filter((el) => {
      const text = (el.textContent || "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const matchesText = text.includes(lower) && text.length <= lower.length + 15;
      const matchesAria = aria.includes(lower);
      return (matchesText || matchesAria) && el.getBoundingClientRect().width > 0;
    });
    const strict = matches.filter((el) => el.tagName === "BUTTON" || el.getAttribute("role") === "button");
    const pool = strict.length ? strict : matches;
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
    let round = 0;
    while (round < MAX_ROUNDS) {
      const toggles = findToggleButtons("show more").sort(docOrder);
      const fresh = toggles.filter((btn) => !allClicked.has(btn));
      console.log(
        `[PPLX Obsidian Exporter] Expand round ${round + 1}: found ${toggles.length} toggle(s), ${fresh.length} new.`,
        fresh
      );
      if (!fresh.length) break;
      fresh.forEach((btn) => {
        allClicked.add(btn);
        clickToggle(btn);
      });
      await new Promise((r) => setTimeout(r, 250));
      round++;
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

  function findPromptElement(titleText, afterNode) {
    const target = stripForMatch(titleText);
    if (!target) return null;

    const root = getSearchRoot();
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
    return bestEl;
  }

  function getCleanText(el) {
    if (!el) return "";
    let text = el.textContent || "";
    text = text.replace(/Show\s*(more|less)/gi, "");
    return text.trim();
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
    if (!candidates.length) return -1;
    return Math.min(...candidates);
  }

  function splitSources(responsePart) {
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

    const idxStripped = strippedBody.indexOf(strippedDomPrompt);
    if (idxStripped === -1) {
      console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: strippedDomPrompt not found in strippedBody.`);
      return null;
    }

    const promptEndStrippedIdx = idxStripped + strippedDomPrompt.length;
    const originalEndIdx = bodyMap[promptEndStrippedIdx - 1] + 1;

    const promptPart = chunkBody.slice(0, originalEndIdx).trim();
    const responsePart = chunkBody.slice(originalEndIdx).trim();

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
    const startsWithH1 = /^#\s+\S/m.test(chunkBody);
    const hasResponseHeading = /^##\s+\S/m.test(chunkBody);
    const firstBlankMatch = chunkBody.match(/\n\s*\n/);

    if ((startsWithH1 || hasResponseHeading) && firstBlankMatch && firstBlankMatch.index !== undefined) {
      const promptPart = chunkBody.slice(0, firstBlankMatch.index).trim();
      const responsePart = chunkBody.slice(firstBlankMatch.index + firstBlankMatch[0].length).trim();
      return { prompt: promptPart, response: responsePart, sources };
    }

    if (startsWithH1) {
      const firstNewline = chunkBody.indexOf("\n");
      if (firstNewline !== -1) {
        return {
          prompt: chunkBody.slice(0, firstNewline).trim(),
          response: chunkBody.slice(firstNewline).trim(),
          sources
        };
      }
    }
    return null;
  }

  function annotateConversation(fullText, toggles) {
    const chunks = fullText.split(TURN_DIVIDER_RE).filter((c) => c.trim().length > 0);
    console.log(`[PPLX Obsidian Exporter] Split into ${chunks.length} chunk(s) via TURN_DIVIDER_RE.`);

    const warnings = [];
    const out = [];
    let lastMatchedNode = null;

    chunks.forEach((chunk, idx) => {
      const turnNum = idx + 1;
      const titleMatch = chunk.match(/^#\s+(.+?)\s*(?:\n|$)/);
      const title = titleMatch ? titleMatch[1].trim() : null;

      let split = null;
      let domEl = null;

      if (title) {
        domEl = findPromptElement(title, lastMatchedNode);

        console.log(
          `[PPLX Obsidian Exporter] Turn ${turnNum}: title="${title.slice(0, 80)}" domEl=${domEl ? "FOUND" : "NOT FOUND"}`
        );

        if (domEl) {
          const domPromptText = getCleanText(domEl);
          console.log(`[PPLX Obsidian Exporter] Turn ${turnNum}: matched prompt element with text length:`, domPromptText.length);
          split = splitPromptFromResponse(chunk, domPromptText, turnNum, title);
        }
      } else {
        console.warn(`[PPLX Obsidian Exporter] Turn ${turnNum}: could not extract a title heading from chunk.`);
      }

      if (split) {
        lastMatchedNode = domEl;
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
    });

    return { text: out.join("\n\n"), warnings };
  }

  async function copyText(text) {
    const toggles = await expandAllPrompts();

    const { result: logoStripped, removed } = stripLogo(text);

    const { text: annotated, warnings } = annotateConversation(logoStripped, toggles);
    if (warnings.length) {
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
    }
  }

  const OrigAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const href = this.href || "";
      const looksLikeExport =
        (this.download && /\.(md|markdown|txt)$/i.test(this.download)) ||
        href.startsWith("blob:") ||
        href.startsWith("data:");
      if (looksLikeExport) {
        handleCandidateHref(href, this);
        return;
      }
    } catch (err) {
      console.error("[PPLX Obsidian Exporter] Intercept error:", err);
    }
    return OrigAnchorClick.call(this);
  };

  async function closePopover() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
  }

  async function triggerNativeExport() {
    showToast("Opening export menu...", false);

    // 1. Find the native options/share/more button
    const candidates = [...document.querySelectorAll('button, [role="button"]')];
    let menuBtn = null;

    for (const btn of candidates) {
      const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").toLowerCase();
      const text = (btn.textContent || "").toLowerCase();

      if (
        label.includes("options") ||
        label.includes("more") ||
        label.includes("thread options") ||
        label.includes("share") ||
        text.includes("share")
      ) {
        if (btn.getBoundingClientRect().width > 0) {
          menuBtn = btn;
          break;
        }
      }
    }

    if (!menuBtn) {
      // Fallback: look for 3-dots SVGs
      for (const btn of candidates) {
        const svg = btn.querySelector("svg");
        if (svg) {
          const html = svg.innerHTML.toLowerCase();
          if (html.includes("circle") || html.includes("dot")) {
            if (btn.getBoundingClientRect().width > 0) {
              menuBtn = btn;
              break;
            }
          }
        }
      }
    }

    if (!menuBtn) {
      showToast("Menu button not found. Please click '...' -> 'Export as Markdown' manually.", true);
      return;
    }

    clickToggle(menuBtn);
    await new Promise((r) => setTimeout(r, 200));

    // 2. Locate the "Export as Markdown" option inside the popup
    const menuOptions = [...document.querySelectorAll('button, [role="menuitem"], a, span, div')];
    let exportOption = null;
    for (const opt of menuOptions) {
      const text = (opt.textContent || "").trim();
      if (/Export as Markdown/i.test(text) || /Download/i.test(text) || (/Export/i.test(text) && /Markdown/i.test(text))) {
        if (opt.getBoundingClientRect().width > 0) {
          exportOption = opt;
          break;
        }
      }
    }

    if (!exportOption) {
      await closePopover();
      showToast("Export option not found. Please click 'Export as Markdown' manually.", true);
      return;
    }

    clickToggle(exportOption);
    await new Promise((r) => setTimeout(r, 150));
    await closePopover();
  }

  function applyNativeThemeStyles(btn) {
    if (!btn) return;

    const isDark = document.documentElement.classList.contains('dark') ||
                   document.body.classList.contains('dark') ||
                   window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (isDark) {
      btn.style.background = "rgba(30, 30, 30, 0.75)";
      btn.style.borderColor = "rgba(255, 255, 255, 0.12)";
      btn.style.color = "rgba(255, 255, 255, 0.75)";
      btn.style.boxShadow = "0 4px 14px rgba(0, 0, 0, 0.4)";
    } else {
      btn.style.background = "rgba(255, 255, 255, 0.85)";
      btn.style.borderColor = "rgba(0, 0, 0, 0.08)";
      btn.style.color = "rgba(0, 0, 0, 0.65)";
      btn.style.boxShadow = "0 4px 14px rgba(0, 0, 0, 0.08)";
    }
  }

  function updateButtonPosition() {
    const btn = document.getElementById("pplx-obsidian-export-btn");
    if (!btn) return;

    const BTN_WIDTH = 44;
    const MARGIN = 12;

    const inputEl = document.getElementById('ask-input');
    const referenceEl = inputEl?.closest('form') || inputEl?.parentElement?.parentElement;

    if (!referenceEl) {
      btn.style.right = '24px';
      btn.style.left = 'auto';
      return;
    }

    const rect = referenceEl.getBoundingClientRect();
    const desiredLeft = rect.right + MARGIN;
    const maxLeft = window.innerWidth - BTN_WIDTH - MARGIN;
    const finalLeft = Math.min(desiredLeft, maxLeft);

    btn.style.right = 'auto';
    btn.style.left = `${finalLeft}px`;
  }

  function injectButton() {
    if (document.getElementById("pplx-obsidian-export-btn")) {
      updateButtonPosition();
      return;
    }

    const btn = document.createElement("button");
    btn.id = "pplx-obsidian-export-btn";

    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="5 6 90 90" width="30" height="30" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M34 38 L22 63 L41 84 L60 88 L72 61 L64 39 L53 25 C51 22, 47 22, 45 25 Z" />
        <path d="M49 23 C42 41, 44 51, 64 64" />
        <path d="M34 38 C34 47, 40 54, 38 68" />
        <path d="M38 68 C44 63, 54 62, 64 64" />
      </svg>
    `;

    btn.style.cssText = `
      position: fixed;
      bottom: 120px;
      z-index: 99999;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: 50%;
      cursor: pointer;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: background 0.2s, color 0.2s, border-color 0.2s, box-shadow 0.2s, transform 0.2s;
    `;

    applyNativeThemeStyles(btn);

    btn.onmouseenter = () => {
      btn.style.background = "#7F6DF2";
      btn.style.color = "#FFFFFF";
      btn.style.borderColor = "#6D5BD0";
      btn.style.transform = "translateY(-2px)";
      btn.style.boxShadow = "0 6px 16px rgba(127, 109, 242, 0.4)";
    };

    btn.onmouseleave = () => {
      btn.style.transform = "translateY(0)";
      applyNativeThemeStyles(btn);
    };

    btn.onclick = triggerNativeExport;
    btn.title = "Export Thread to Obsidian (Annotated)";

    document.body.appendChild(btn);
    updateButtonPosition();
  }

  function start() {
    const domObserver = new MutationObserver(() => {
      injectButton();
      updateButtonPosition();
    });

    domObserver.observe(document.body, { childList: true, subtree: true });

    injectButton();

    const layoutObserver = new ResizeObserver(updateButtonPosition);
    layoutObserver.observe(document.body);

    window.addEventListener("resize", updateButtonPosition);

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const btn = document.getElementById("pplx-obsidian-export-btn");
      if (btn) applyNativeThemeStyles(btn);
    });

    const themeClassObserver = new MutationObserver((mutations) => {
      if (mutations.some(m => m.attributeName === "class")) {
        const btn = document.getElementById("pplx-obsidian-export-btn");
        if (btn) applyNativeThemeStyles(btn);
      }
    });

    themeClassObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"]
    });

    themeClassObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener("DOMContentLoaded", start, { once: true });
  }

})();
