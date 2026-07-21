// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (via Complexity)
// @namespace    scott-otterson-obsidian-export
// @version      7.6
// @description  Opens Complexity's export popover, ensures Markdown format, clicks Copy, wraps clipboard content with frontmatter tag + visible link.  This intended to be used as a tampermonkey script.
// @match        https://www.perplexity.ai/*
// @match        https://perplexity.ai/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";
  console.log("[PPLX Obsidian exporter] userscript started", location.href);

  function findExportTrigger() {
    const paths = [...document.querySelectorAll('svg[viewBox="0 0 24 24"] path[d^="M14 3v4a1 1 0 0 0 1 1h4"]')];
    for (const p of paths) {
      const btn = p.closest('button[data-scope="popover"][data-part="trigger"]');
      if (btn) return btn;
    }
    return null;
  }

  function findPopoverContent() {
    return [...document.querySelectorAll('[data-scope=\"popover\"][data-part=\"content\"]')].find(
      (el) => el.getBoundingClientRect().width > 0 && /choose format/i.test(el.textContent)
    );
  }

  // Unlike findPopoverContent(), this doesn't require "choose format" text,
  // so it also catches a stuck/leftover popover wrapper that a previous run
  // left open but emptied (e.g. after an interrupted or non-standard close).
  function anyPopoverOpen() {
    return [...document.querySelectorAll('[data-scope="popover"]')].some(
      (el) => el.getBoundingClientRect().width > 0
    );
  }

  function findButtonByText(root, pattern) {
    return [...root.querySelectorAll("button")].find((b) => pattern.test(b.textContent.trim()));
  }

  function wrapMarkdown(rawMd, url) {
    return `[Perplexity](${url})\n${rawMd.trim()}\n`;
  }

  // Polls for the popover instead of relying on one fixed delay, since
  // Complexity's popover render/animation time can vary.
  async function waitForPopover(timeoutMs = 2000, intervalMs = 75) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const popover = findPopoverContent();
      if (popover) return popover;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  // Diagnostic helper: when the expected popover can't be found, dump every
  // visible element that looks popover/dialog-like so the selector can be
  // fixed against Complexity's actual current markup. Open DevTools console
  // (F12) before clicking the export button to see this output.
  function logPopoverDebugInfo() {
    const candidates = [...document.querySelectorAll(
      '[data-scope="popover"], [role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]'
    )].filter((el) => el.getBoundingClientRect().width > 0);

    console.log(`[PPLX Obsidian exporter] popover debug: ${candidates.length} candidate element(s) visible`);
    candidates.forEach((el, i) => {
      console.log(
        `[PPLX Obsidian exporter] candidate #${i}`,
        {
          tag: el.tagName,
          dataScope: el.getAttribute("data-scope"),
          dataPart: el.getAttribute("data-part"),
          role: el.getAttribute("role"),
          textPreview: el.textContent.trim().slice(0, 200),
          el,
        }
      );
    });
    if (candidates.length === 0) {
      console.log("[PPLX Obsidian exporter] no popover/dialog-like elements found in the DOM at all.");
    }
  }

  // Complexity's export menu is a Zag.js/Ark-UI style popover
  // (data-scope="popover"). Those components close on a real Escape
  // keypress or an outside pointerdown, not on a synthetic click(). Using
  // document.body.click() to dismiss it can leave the popover's internal
  // open state (and its positioning wrapper) stuck, which then shows up as
  // a stray empty box and makes the trigger stop working until a full page
  // reload. Dispatch a real Escape keydown instead so the component's own
  // dismiss logic runs.
  async function closePopover() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
  }

  async function exportFullThread() {
    // Self-heal: if a previous run left the popover open/stuck (even an
    // emptied/leftover one with no "choose format" text), close it first
    // instead of requiring the user to reload the page.
    if (anyPopoverOpen()) {
      await closePopover();
    }

    const trigger = findExportTrigger();
    if (!trigger) {
      alert("Couldn't find the export icon. Complexity's UI may have changed.");
      return;
    }
    trigger.click();

    const popover = await waitForPopover();
    if (!popover) {
      logPopoverDebugInfo();
      alert(
        'Popover with "Choose format" not found after clicking the icon. ' +
        "Open DevTools (F12) → Console for a debug dump of what was actually on the page."
      );
      return;
    }

    const copyBtn = findButtonByText(popover, /^copy$/i);
    if (!copyBtn) {
      alert('"Copy" button not found in the export popover.');
      return;
    }

    copyBtn.click();
    await new Promise((r) => setTimeout(r, 300));

    let rawMd = null;
    try {
      rawMd = await navigator.clipboard.readText();
    } catch (e) {
      alert("Couldn't read clipboard — grant clipboard-read permission if Chrome prompts, then retry.");
      return;
    }

    if (!rawMd) {
      alert("Clipboard was empty after clicking Copy.");
      return;
    }

    console.log(
      `[PPLX Obsidian exporter] clipboard content from Complexity's Copy button is ${rawMd.length} chars`,
      { rawMd }
    );

    const finalMd = wrapMarkdown(rawMd, window.location.href);
    GM_setClipboard(finalMd, "text");
    GM_notification({
      title: "Obsidian Export Ready",
      text: "Thread Markdown copied to clipboard.",
      timeout: 2000,
    });

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

    // Optimized viewBox scale and path alignment to securely fill out the circle wrapper
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

    btn.onclick = exportFullThread;
    btn.title = "Export Thread to Obsidian (Markdown)";

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