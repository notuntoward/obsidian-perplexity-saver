// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (Standard Interface)
// @namespace    scott-otterson-obsidian-export
// @version      8.0
// @description  Clicks standard Perplexity three-dots menu, selects "Export as Markdown", and writes metadata to clipboard so the Obsidian plugin can complete the import.
// @match        https://www.perplexity.ai/*
// @match        https://perplexity.ai/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";
  console.log("[PPLX Obsidian exporter] standard userscript started", location.href);

  function isLikelyThreeDots(btn) {
    const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
    if (label.includes('more') || label.includes('option') || label.includes('menu') || label.includes('ellipsis') || label.includes('action') || label.includes('three')) {
      return true;
    }
    const text = btn.textContent.trim();
    if (/^[^a-zA-Z0-9\s]{1,4}$/.test(text)) {
      return true;
    }
    const html = btn.innerHTML.toLowerCase();
    if (html.includes('ellipsis') || html.includes('dots') || html.includes('more-horizontal') || html.includes('more-vertical') || html.includes('dots-horizontal') || html.includes('lucide-more')) {
      return true;
    }
    // Check for aria-haspopup
    const hasPopup = (btn.getAttribute('aria-haspopup') || '').toLowerCase();
    if (hasPopup === 'menu' || hasPopup === 'true') {
      return true;
    }
    const svgs = btn.querySelectorAll('svg');
    for (const svg of svgs) {
      if (svg.querySelectorAll('circle').length >= 3) {
        return true;
      }
      if (svg.innerHTML.includes('circle')) {
        return true;
      }
    }
    // Highly specific to Perplexity's layout buttons
    const className = btn.className || '';
    if (className.includes('aspect-[9/8]')) {
      return true;
    }
    return false;
  }

  function isInsideTurn(btn) {
    return btn.closest('div[class*="turn"], div[class*="message"], div[class*="bubble"], div[class*="answer"], div[class*="response"]') !== null;
  }

  function isInsideSidebar(btn) {
    return btn.closest('aside, nav, [class*="sidebar"], [class*="nav"]') !== null;
  }

  function findThreeDotsTrigger() {
    const buttons = [...document.querySelectorAll('button')].filter(btn => {
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    console.log(`[PPLX Obsidian exporter] Found ${buttons.length} visible buttons on page.`);

    // Strategy A: Find the "Share" button first (which is in the same header group)
    const shareBtn = buttons.find(btn => {
      if (isInsideTurn(btn) || isInsideSidebar(btn)) return false;
      const text = (btn.textContent || '').trim().toLowerCase();
      const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
      return text.includes('share') || label.includes('share');
    });

    if (shareBtn) {
      console.log("[PPLX Obsidian exporter] Found Share button as anchor:", shareBtn);
      let container = shareBtn.parentElement;
      for (let i = 0; i < 4 && container; i++) {
        const descendantButtons = [...container.querySelectorAll('button')].filter(btn => btn !== shareBtn && !isInsideTurn(btn) && !isInsideSidebar(btn));
        if (descendantButtons.length > 0) {
          const likelyBtn = descendantButtons.find(btn => isLikelyThreeDots(btn));
          if (likelyBtn) {
            return {
              element: likelyBtn,
              strategy: "Exact match (detected likely three-dots button inside Share button's ancestor container hierarchy)",
              exact: true
            };
          }
        }
        container = container.parentElement;
      }
    }

    // Strategy B: Filter out sidebar & turn buttons, and look for likely three-dots in the upper part of viewport
    const mainHeaderCandidates = buttons.filter(btn => {
      if (isInsideTurn(btn) || isInsideSidebar(btn)) return false;

      const rect = btn.getBoundingClientRect();
      const isInHeaderArea = rect.top >= 0 && rect.top <= 120;
      const isOnRightSide = rect.right > (window.innerWidth / 2);

      return isInHeaderArea && isOnRightSide && isLikelyThreeDots(btn);
    });

    if (mainHeaderCandidates.length > 0) {
      console.log("[PPLX Obsidian exporter] Found main header candidates via Strategy B:", mainHeaderCandidates);
      return {
        element: mainHeaderCandidates[0],
        strategy: "Exact match (detected likely three-dots button in upper-right viewport header area)",
        exact: true
      };
    }

    // Strategy C: Global search of likely three-dots button (excluding turns/sidebar)
    const globalCandidates = buttons.filter(btn => {
      return !isInsideTurn(btn) && !isInsideSidebar(btn) && isLikelyThreeDots(btn);
    });

    if (globalCandidates.length > 0) {
      console.log("[PPLX Obsidian exporter] Found global candidates via Strategy C:", globalCandidates);
      return {
        element: globalCandidates[0],
        strategy: "Exact match (globally detected likely three-dots button outside turns and sidebar)",
        exact: true
      };
    }

    return null;
  }

  function findPopoverContent() {
    const candidates = [...document.querySelectorAll(
      '[data-scope="popover"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], .radix-popper-content-wrapper, div[style*="position: fixed"], div[style*="position: absolute"], div[class*="popover"], div[class*="menu"], div[class*="dialog"], div[class*="dropdown"]'
    )];
    let found = candidates.find(el => el.getBoundingClientRect().width > 0 && /Export as Markdown/i.test(el.textContent));
    if (found) return found;

    const allDivs = [...document.querySelectorAll('div, section')];
    return allDivs.find(el => el.getBoundingClientRect().width > 0 && /Export as Markdown/i.test(el.textContent) && (window.getComputedStyle(el).position === 'fixed' || window.getComputedStyle(el).position === 'absolute' || el.style.position === 'fixed' || el.style.position === 'absolute'));
  }

  function anyPopoverOpen() {
    return [...document.querySelectorAll('[data-scope="popover"]')].some(
      (el) => el.getBoundingClientRect().width > 0
    );
  }

  function findExportAsMarkdownOption(root) {
    const elements = [...(root || document).querySelectorAll('button, [role="menuitem"], div, span')];
    return elements.find(el => {
      if (!el.textContent) return false;
      const text = el.textContent.trim();
      return /Export as Markdown/i.test(text) && el.getBoundingClientRect().width > 0;
    });
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

  function simulateClick(element) {
    if (!element) return;
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    eventTypes.forEach((eventType) => {
      let ev;
      if (eventType.startsWith("pointer") && typeof PointerEvent !== "undefined") {
        ev = new PointerEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1,
          isPrimary: true,
        });
      } else {
        ev = new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1,
        });
      }
      element.dispatchEvent(ev);
    });
  }

  async function waitForPopover(timeoutMs = 3000, intervalMs = 75) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const popover = findPopoverContent();
      if (popover) return popover;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  async function waitForExportOption(timeoutMs = 3500, intervalMs = 75) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const opt = findExportAsMarkdownOption(document);
      if (opt) return opt;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  function logPopoverDebugInfo() {
    const candidates = [...document.querySelectorAll(
      '[data-scope="popover"], [role="dialog"], [role="menu"], [data-radix-popper-content-wrapper], .radix-popper-content-wrapper, div[class*="popover"], div[class*="menu"], div[class*="dialog"], div[class*="dropdown"]'
    )].filter((el) => el.getBoundingClientRect().width > 0);

    // Limit logged candidate count to 15 to avoid polluting user's console
    const loggedCount = Math.min(candidates.length, 15);
    console.log(`[PPLX Obsidian exporter] popover debug: ${candidates.length} candidate element(s) visible. Displaying top ${loggedCount}.`);
    candidates.slice(0, loggedCount).forEach((el, i) => {
      console.log(
        `[PPLX Obsidian exporter] candidate #${i}`,
        {
          tag: el.tagName,
          dataScope: el.getAttribute("data-scope"),
          dataPart: el.getAttribute("data-part"),
          role: el.getAttribute("role"),
          textPreview: el.textContent.trim().slice(0, 200),
        }
      );
    });
  }

  async function closePopover() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
  }

  async function exportFullThread() {
    console.log("[PPLX Obsidian exporter] Starting exportFullThread workflow...");
    const btn = document.getElementById("pplx-obsidian-export-btn");
    const originalBackground = btn ? btn.style.background : "";

    if (btn) {
      btn.disabled = true;
      btn.style.background = "#7F6DF2";
      btn.style.opacity = "0.7";
      btn.style.cursor = "not-allowed";
    }

    try {
      if (anyPopoverOpen()) {
        console.log("[PPLX Obsidian exporter] Detected open popover, closing first...");
        await closePopover();
      }

      console.log("[PPLX Obsidian exporter] Looking for three-dots menu trigger...");
      const match = findThreeDotsTrigger();
      if (!match) {
        alert("Couldn't find the three-dots menu icon. Perplexity's UI may have changed.");
        return;
      }

      console.log("[PPLX Obsidian exporter] Found trigger:", match.strategy, match.element);

      if (!match.exact) {
        try {
          GM_notification({
            title: "Perplexity Saver: Approximate Match",
            text: `Matched button approximately using: ${match.strategy}`,
            timeout: 6000,
          });
        } catch (err) {
          console.warn("[PPLX Obsidian exporter] GM_notification failed:", err);
        }

        const confirmMsg = `Perplexity Saver Warning:\n\n` +
                           `The three-dots menu icon was not matched exactly.\n` +
                           `Approximate match used:\n"${match.strategy}"\n\n` +
                           `Would you like to proceed with the export?`;
        if (!confirm(confirmMsg)) {
          console.log("[PPLX Obsidian exporter] Export cancelled by user due to approximate match confirmation refusal.");
          return;
        }
      }

      const trigger = match.element;

      // Set clipboard metadata *before* starting the export to make it available to the watcher
      const metadata = {
        url: window.location.href,
        timestamp: formatTimestamp(new Date()),
        clickTime: Date.now()
      };
      const metadataStr = `__PPLX_EXPORT_METADATA__:${JSON.stringify(metadata)}`;

      console.log("[PPLX Obsidian exporter] Setting metadata into clipboard:", metadataStr);
      try {
        if (typeof GM_setClipboard !== "undefined") {
          GM_setClipboard(metadataStr, "text");
        } else {
          await navigator.clipboard.writeText(metadataStr);
        }
        console.log("[PPLX Obsidian exporter] Clipboard metadata write completed successfully.");
      } catch (err) {
        console.error("[PPLX Obsidian exporter] Failed to write metadata to clipboard:", err);
        alert("Perplexity Saver Error: Failed to write export metadata to clipboard. Please grant clipboard permissions.");
        return;
      }

      console.log("[PPLX Obsidian exporter] Simulating click on three-dots trigger...");
      simulateClick(trigger);

      // Try finding the export option directly on the document (very robust fallback)
      console.log("[PPLX Obsidian exporter] Waiting for 'Export as Markdown' option to appear...");
      let exportBtn = await waitForExportOption();
      if (!exportBtn) {
        console.log("[PPLX Obsidian exporter] Option not found globally, waiting for popover container fallback...");
        // Fallback: wait for the standard popover container and then find the option inside it
        const popover = await waitForPopover(1500);
        if (popover) {
          exportBtn = findExportAsMarkdownOption(popover);
        }
      }

      if (!exportBtn) {
        console.warn("[PPLX Obsidian exporter] 'Export as Markdown' option not found.");
        logPopoverDebugInfo();
        alert(
          'Popover menu option "Export as Markdown" not found after clicking the three-dots icon. ' +
          "Open DevTools (F12) → Console for a debug dump of what was actually on the page."
        );
        return;
      }

      console.log("[PPLX Obsidian exporter] Clicking 'Export as Markdown' button:", exportBtn);
      simulateClick(exportBtn);

      try {
        GM_notification({
          title: "Perplexity Saver",
          text: "Exporting thread... check Obsidian for progress.",
          timeout: 3000,
        });
      } catch (err) {
        console.warn("[PPLX Obsidian exporter] GM_notification failed:", err);
      }

      await new Promise((r) => setTimeout(r, 500));
      console.log("[PPLX Obsidian exporter] Closing popover...");
      await closePopover();
      console.log("[PPLX Obsidian exporter] Export workflow successfully completed.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.background = originalBackground;
        btn.style.opacity = "";
        btn.style.cursor = "pointer";
      }
    }
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

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("[PPLX Obsidian exporter] Floating button clicked. Initiating export workflow...");
      exportFullThread().catch((err) => {
        console.error("[PPLX Obsidian exporter] exportFullThread error:", err);
        alert("Perplexity Saver Error during export: " + err.toString());
      });
    }, true);

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