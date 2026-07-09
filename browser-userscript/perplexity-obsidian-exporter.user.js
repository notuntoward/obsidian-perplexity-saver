// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (via Complexity)
// @namespace    scott-otterson-obsidian-export
// @version      5.5
// @description  Opens Complexity's export popover, ensures Markdown format, clicks Copy, wraps clipboard content with frontmatter tag + visible link
// @match        https://www.perplexity.ai/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  function findExportTrigger() {
    const paths = [...document.querySelectorAll('svg[viewBox="0 0 24 24"] path[d^="M14 3v4a1 1 0 0 0 1 1h4"]')];
    for (const p of paths) {
      const btn = p.closest('button[data-scope="popover"][data-part="trigger"]');
      if (btn) return btn;
    }
    return null;
  }

  function findPopoverContent() {
    return [...document.querySelectorAll('[data-scope="popover"][data-part="content"]')].find(
      (el) => el.getBoundingClientRect().width > 0 && /choose format/i.test(el.textContent)
    );
  }

  function findButtonByText(root, pattern) {
    return [...root.querySelectorAll("button")].find((b) => pattern.test(b.textContent.trim()));
  }

  function wrapMarkdown(rawMd, url) {
    return `[Perplexity](${url})\n${rawMd.trim()}\n`;
  }

  async function exportFullThread() {
    const trigger = findExportTrigger();
    if (!trigger) {
      alert("Couldn't find the export icon. Complexity's UI may have changed.");
      return;
    }
    trigger.click();

    await new Promise((r) => setTimeout(r, 300));
    const popover = findPopoverContent();
    if (!popover) {
      alert('Popover with "Choose format" not found after clicking the icon.');
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

    const finalMd = wrapMarkdown(rawMd, window.location.href);
    GM_setClipboard(finalMd, "text");
    GM_notification({
      title: "Obsidian Export Ready",
      text: "Thread Markdown copied to clipboard.",
      timeout: 2000,
    });

    document.body.click();
  }

  // Extracted to be accessible by theme change observers
  function applyNativeThemeStyles(btn) {
    if (!btn) return;

    const isDark = document.documentElement.classList.contains('dark') ||
                   document.body.classList.contains('dark') ||
                   window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (isDark) {
      // Dark Mode: Low-profile translucency matching Perplexity's secondary utility icons
      btn.style.background = "rgba(255, 255, 255, 0.07)";
      btn.style.borderColor = "rgba(255, 255, 255, 0.05)";
      btn.style.color = "rgba(255, 255, 255, 0.6)";
      btn.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.2)";
    } else {
      // Light Mode: Clean, muted profile
      btn.style.background = "rgba(0, 0, 0, 0.05)";
      btn.style.borderColor = "rgba(0, 0, 0, 0.02)";
      btn.style.color = "rgba(0, 0, 0, 0.5)";
      btn.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.05)";
    }
  }

  function injectButton() {
    if (document.getElementById("pplx-obsidian-export-btn")) return;

    const btn = document.createElement("button");
    btn.id = "pplx-obsidian-export-btn";

    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2L3 10.5 12 22l9-11.5L12 2z"></path>
        <path d="M12 2v20"></path>
      </svg>
    `;

    // Positioned vertically higher (bottom: 120px) to clear the expanding text box
    btn.style.cssText = `
      position: fixed;
      bottom: 120px;
      right: 24px;
      z-index: 99999;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: 50%;
      cursor: pointer;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    `;

    // Apply baseline layout styles initially
    applyNativeThemeStyles(btn);

    // Hover interactions bring out the vivid Obsidian branding
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
  }

  // 1. Existing observer to inject the button if navigating via single-page app routing
  const domObserver = new MutationObserver(() => injectButton());
  domObserver.observe(document.body, { childList: true, subtree: true });
  injectButton();

  // 2. Listen for OS-level theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const btn = document.getElementById("pplx-obsidian-export-btn");
    if (btn) applyNativeThemeStyles(btn);
  });

  // 3. Listen for Perplexity changing the class on <html> or <body> (site-specific theme toggle)
  const themeClassObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === 'class') {
        const btn = document.getElementById("pplx-obsidian-export-btn");
        if (btn) applyNativeThemeStyles(btn);
      }
    }
  });

  themeClassObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  themeClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

})();