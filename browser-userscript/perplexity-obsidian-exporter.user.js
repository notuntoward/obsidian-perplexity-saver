// ==UserScript==
// @name         Perplexity → Obsidian Markdown Exporter (via Complexity)
// @namespace    scott-otterson-obsidian-export
// @version      5.1
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
    // Changed \n\n to \n to remove the extra blank line in Obsidian
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

    // Confirm Markdown is selected (it's the default per screenshot), then click Copy
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
      title: "Copied for Obsidian",
      text: "Full thread Markdown + tag + link is on your clipboard.",
      timeout: 2500,
    });

    // Close the popover
    document.body.click();
  }

  function injectButton() {
    if (document.getElementById("pplx-obsidian-export-btn")) return;
    const btn = document.createElement("button");
    btn.id = "pplx-obsidian-export-btn";
    btn.textContent = "📋 Copy for Obsidian";
    btn.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:99999;padding:10px 14px;" +
      "background:#20808D;color:#fff;border:none;border-radius:8px;font-size:13px;" +
      "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);";
    btn.onclick = exportFullThread;
    btn.title = "Click: export full thread via Complexity's Markdown export, copy for Obsidian.";
    document.body.appendChild(btn);
  }

  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();
