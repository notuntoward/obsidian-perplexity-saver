// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (via Complexity)
// @namespace    scott-otterson-obsidian-export
// @version      7.2
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
    return [...document.querySelectorAll('[data-scope=\"popover\"][data-part=\"content\"]')].find(
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

  // Live coordinate tracker matching the button perfectly to the thread column
  function updateButtonPosition() {
    const btn = document.getElementById("pplx-obsidian-export-btn");
    if (!btn) return;

    // Target the main chat input container box via the textarea parent chain
    const inputTextArea = document.querySelector('textarea');
    const inputContainer = inputTextArea ? inputTextArea.closest('div[class*="border"]') || inputTextArea.parentElement : null;

    if (inputContainer) {
      const rect = inputContainer.getBoundingClientRect();

      // Calculate layout safety margins
      const desiredLeft = rect.right + 16;
      const maxAllowedLeft = window.innerWidth - 60; // Emergency window edge padding

      // Lock to screen boundary if the window gets too small, otherwise stay alongside the thread
      if (desiredLeft > maxAllowedLeft) {
        btn.style.left = 'auto';
        btn.style.right = '24px';
      } else {
        btn.style.right = 'auto';
        btn.style.left = `${desiredLeft}px`;
      }
    } else {
      // Clean fallback if no input box is rendered on screen yet
      btn.style.left = 'auto';
      btn.style.right = '24px';
    }
  }

  function injectButton() {
    if (document.getElementById("pplx-obsidian-export-btn")) {
      updateButtonPosition();
      return;
    }

    const btn = document.createElement("button");
    btn.id = "pplx-obsidian-export-btn";

    // Expanded icon scaling dimensions from 22 to 28 for a better visual presence
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="28" height="28" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M50 8 L72 38 L83 61 L64 85 L50 92 L36 85 L17 61 L28 38 Z" />
        <path d="M50 8 C 55 25, 50 45, 64 63" />
        <path d="M28 38 C 36 45, 40 52, 40 61" />
        <path d="M40 61 C 50 63, 58 58, 64 63" />
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

  // 1. Observe changes to the DOM layout to keep tracking accurate
  const domObserver = new MutationObserver(() => {
    injectButton();
    updateButtonPosition();
  });
  domObserver.observe(document.body, { childList: true, subtree: true });
  injectButton();

  // 2. Continuous structural layout resize tracking (handles window snaps and expansions seamlessly)
  const layoutObserver = new ResizeObserver(() => updateButtonPosition());
  layoutObserver.observe(document.body);
  window.addEventListener('resize', updateButtonPosition);

  // 3. Theme change observers
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const btn = document.getElementById("pplx-obsidian-export-btn");
    if (btn) applyNativeThemeStyles(btn);
  });

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