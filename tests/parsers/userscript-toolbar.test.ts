// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const script = readFileSync(resolve(__dirname, "../../browser-userscript/perplexity-obsidian-exporter-direct.user.js"), "utf8");

function helper(name: string) {
  const match = script.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
  if (!match) throw new Error(`Missing production helper: ${name}`);
  return match[0];
}

interface ExportRun {
  url: string;
  cancelled: boolean;
  menuSelected: boolean;
  processing: boolean;
}

function load() {
  const location = { href: "https://www.perplexity.ai/session/test", pathname: "/session/test" };
  const names = [
    "applyNativeThemeStyles", "showToast", "updateButtonPosition", "injectButton",
    "setExportMenuVisible", "beginExport", "finishExport", "findNativeMarkdownItem",
    "findNativeMenuTrigger", "waitForNativeMarkdownItem", "exportFullThread", "start",
  ];
  const api: {
    injectButton: () => void;
    updateButtonPosition: () => void;
    start: () => void;
    exportFullThread: () => Promise<void>;
    beginExport: () => ExportRun;
    finishExport: (run: ExportRun) => void;
    showToast: (message: string, kind: string) => void;
    location: typeof location;
  } = new Function(
    "document", "window", "location", "MutationObserver", "ResizeObserver",
    "setTimeout", "clearTimeout", "requestAnimationFrame", "console",
    "let pendingExport = null; let toolbarStarted = false;\n" + names.map(helper).join("\n") +
    "\nreturn { injectButton, updateButtonPosition, start, exportFullThread, beginExport, finishExport, showToast, location };",
  )(
    document, window, location, MutationObserver,
    class { observe() {} },
    setTimeout, clearTimeout, (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16), console,
  );
  return api;
}

function button() {
  const el = document.getElementById("pplx-obsidian-export-btn");
  if (!(el instanceof HTMLButtonElement)) throw new Error("Missing export button");
  return el;
}

function nativeMenu(delay = 0) {
  const trigger = document.querySelector('button[aria-label="Session options"]');
  if (!(trigger instanceof HTMLButtonElement)) throw new Error("Missing menu trigger");
  const selected = vi.fn();
  trigger.setAttribute("aria-expanded", "false");
  trigger.onclick = () => {
    trigger.setAttribute("aria-expanded", "true");
    const render = () => {
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      const item = document.createElement("div");
      item.setAttribute("role", "menuitem");
      item.textContent = "Export as Markdown";
      item.onclick = () => { selected(); menu.remove(); trigger.setAttribute("aria-expanded", "false"); };
      menu.append(item);
      document.body.append(menu);
    };
    if (delay) setTimeout(render, delay);
    else render();
  };
  return selected;
}

describe("Direct exporter controls ported from the Complexity workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false, media: "(prefers-color-scheme: dark)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true),
    })));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = this.tagName === "FORM"
        ? { left: 100, right: 700, top: 600, bottom: 700, width: 600, height: 100 }
        : { left: 0, right: 100, top: 0, bottom: 30, width: 100, height: 30 };
      return { ...rect, x: rect.left, y: rect.top, toJSON: () => rect };
    });
    document.documentElement.classList.remove("dark");
    document.body.innerHTML = '<main><button aria-label="Session options">Options</button><form><div contenteditable="true" role="textbox"></div></form></main>';
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("initializes its own blob registry and unlocks after successful exports and read failures", async () => {
    document.body.innerHTML = '<main><div data-message-bubble="right">Full prompt</div></main>';
    const clipboard = vi.fn();
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const read = vi.fn(async () => "An answer with no web search.");
    vi.stubGlobal("GM_setClipboard", clipboard);
    vi.stubGlobal("ResizeObserver", class { observe() {} });
    vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:export" });
    const windowListeners = vi.spyOn(window, "addEventListener");
    const documentListeners = vi.spyOn(document, "addEventListener");
    const bubble = document.querySelector("[data-message-bubble]")!;
    Object.defineProperty(bubble, "__reactFiber$test", { enumerable: true, value: {
      memoizedProps: { placeholderResults: [{
        uuid: "turn", query_str: "Full prompt", status: "COMPLETED",
        blocks: [{ workflow_block: {
          status: "WORKFLOW_COMPLETED",
          steps: [{ items: [{
            type: "WORKFLOW_ITEM_TEXT", variant: "answer",
            payload: { text_payload: { text: "An answer with no web search.", is_streaming: false } },
          }] }],
        } }, { web_result_block: { web_results: [] } }],
      }] },
    } });
    try {
      new Function("location", script)({ href: "https://www.perplexity.ai/session/test", pathname: "/session/test" });
      const control = button();
      const exportBlob = () => {
        const blob = new Blob(["native"]);
        Object.defineProperty(blob, "text", { value: read });
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(blob);
        anchor.download = "Assessment.md";
        anchor.click();
      };
      exportBlob();
      await vi.advanceTimersByTimeAsync(0);
      expect(console.error).not.toHaveBeenCalled();
      expect(clipboard).toHaveBeenCalledOnce();
      expect(clipboard.mock.calls[0][0]).toContain("<!-- PPLX-ROLE: prompt -->\nFull prompt");
      expect(control.disabled).toBe(false);
      expect(control.getAttribute("aria-busy")).toBe("false");
      expect(download).not.toHaveBeenCalled();

      read.mockRejectedValueOnce(new Error("Cannot read blob"));
      exportBlob();
      await vi.advanceTimersByTimeAsync(0);
      expect(download).toHaveBeenCalledOnce();
      expect(control.disabled).toBe(false);
      expect(clipboard).toHaveBeenCalledOnce();
      expect(document.querySelector("#pplx-clip-toast")?.textContent).toContain("saving native file");

      exportBlob();
      await vi.advanceTimersByTimeAsync(0);
      expect(clipboard).toHaveBeenCalledTimes(2);
      expect(control.disabled).toBe(false);
    } finally {
      for (const [name, listener, options] of windowListeners.mock.calls) {
        window.removeEventListener(name, listener, options);
      }
      for (const [name, listener, options] of documentListeners.mock.calls) {
        document.removeEventListener(name, listener, options);
      }
    }
  });
  it("injects one accessible Obsidian icon button without submitting the composer", () => {
    const api = load();
    api.injectButton();
    api.injectButton();
    expect(document.querySelectorAll("#pplx-obsidian-export-btn")).toHaveLength(1);
    expect(button().type).toBe("button");
    expect(button().getAttribute("aria-label")).toBe("Copy for Obsidian");
    expect(button().querySelector("svg")).not.toBeNull();
    expect(button().title).toContain("Obsidian");
  });

  it("automatically opens the native menu, waits for it, and selects Markdown once", async () => {
    const selected = nativeMenu(150);
    const api = load();
    api.injectButton();
    const first = api.exportFullThread();
    expect(button().disabled).toBe(true);
    await api.exportFullThread();
    await vi.advanceTimersByTimeAsync(250);
    await first;
    expect(selected).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(true);
    expect(document.getElementById("pplx-clip-toast")?.textContent).toContain("Preparing");
    api.finishExport(api.beginExport());
    expect(button().disabled).toBe(false);
  });

  it("hides the native menu while the automated export drives it, then restores it", async () => {
    const selected = nativeMenu(150);
    const api = load();
    api.injectButton();
    const run = api.exportFullThread();
    // Drives the menu invisibly: the popup must not flash on screen.
    expect(document.body.classList.contains("pplx-export-menu-hidden")).toBe(true);
    expect(document.getElementById("pplx-export-menu-style")?.textContent).toContain("visibility:hidden");
    await vi.advanceTimersByTimeAsync(250);
    await run;
    expect(selected).toHaveBeenCalledOnce();
    expect(document.body.classList.contains("pplx-export-menu-hidden")).toBe(true);
    api.finishExport(api.beginExport());
    expect(document.body.classList.contains("pplx-export-menu-hidden")).toBe(false);
  });

  it("uses an already open export menu rather than toggling it closed", async () => {
    const selected = nativeMenu();
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Session options"]')!;
    trigger.click();
    const click = vi.spyOn(trigger, "click");
    const api = load();
    api.injectButton();
    await api.exportFullThread();
    expect(selected).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });

  it("supports a thread options trigger on legacy search routes", async () => {
    const selected = nativeMenu();
    document.querySelector('button[aria-label="Session options"]')!.setAttribute("aria-label", "Thread options");
    const api = load();
    api.location.pathname = "/search/test";
    api.location.href = "https://www.perplexity.ai/search/test";
    await api.exportFullThread();
    expect(selected).toHaveBeenCalledOnce();
  });

  it("reports a missing trigger, restores the control and allows retry", async () => {
    const api = load();
    api.injectButton();
    document.querySelector('button[aria-label="Session options"]')!.remove();
    await api.exportFullThread();
    expect(button().disabled).toBe(false);
    expect(document.getElementById("pplx-clip-toast")?.textContent).toContain("native export menu");
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", '<button aria-label="Session options">Options</button>');
    const selected = nativeMenu();
    await api.exportFullThread();
    expect(selected).toHaveBeenCalledOnce();
  });

  it("times out a missing menu, dismisses it with Escape, and restores the control", async () => {
    const api = load();
    api.injectButton();
    const trigger = document.querySelector('button[aria-label="Session options"]')!;
    trigger.addEventListener("click", () => trigger.setAttribute("aria-expanded", "true"));
    const escape = vi.fn();
    document.addEventListener("keydown", escape, { once: true });
    const run = api.exportFullThread();
    await vi.advanceTimersByTimeAsync(2100);
    await run;
    expect(escape.mock.calls[0][0].key).toBe("Escape");
    expect(button().disabled).toBe(false);
    expect(document.getElementById("pplx-clip-toast")?.textContent).toContain("Markdown");
  });

  it("ends a stalled download with an error instead of leaving a permanent busy button", async () => {
    nativeMenu();
    const api = load();
    api.injectButton();
    await api.exportFullThread();
    await vi.advanceTimersByTimeAsync(60000);
    expect(button().disabled).toBe(false);
    expect(document.getElementById("pplx-clip-toast")?.textContent).toContain("timed out");
  });

  it("positions beside the composer and above it when there is no horizontal room", () => {
    const api = load();
    api.injectButton();
    expect(button().style.left).toBe("712px");
    vi.stubGlobal("innerWidth", 720);
    api.updateButtonPosition();
    expect(parseFloat(button().style.left)).toBeLessThanOrEqual(664);
    expect(parseFloat(button().style.bottom)).toBeGreaterThanOrEqual(window.innerHeight - 600 + 12);
  });

  it("hides outside conversation routes and cancels capture on navigation", () => {
    const api = load();
    api.injectButton();
    const run = api.beginExport();
    api.location.pathname = "/";
    api.location.href = "https://www.perplexity.ai/";
    api.updateButtonPosition();
    expect(button().hidden).toBe(true);
    expect(run.cancelled).toBe(true);
    expect(button().disabled).toBe(false);
    expect(document.getElementById("pplx-clip-toast")?.textContent).toContain("changed");
  });

  it("ports light/dark styling and purple hover feedback without rendering message HTML", () => {
    const api = load();
    api.injectButton();
    const light = button().style.background;
    button().dispatchEvent(new MouseEvent("mouseenter"));
    expect(button().style.background).toBe("rgb(127, 109, 242)");
    button().dispatchEvent(new MouseEvent("mouseleave"));
    expect(button().style.background).toBe(light);
    document.documentElement.classList.add("dark");
    api.injectButton();
    expect(button().style.background).not.toBe(light);
    api.showToast("<img src=x onerror=alert(1)>", "error");
    const toast = document.getElementById("pplx-clip-toast")!;
    expect(toast.querySelector("img")).toBeNull();
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.style.background).toBe(button().style.background);
  });

  it("restores the button after native blob processing, including read and processing failures", async () => {
    const api = load();
    api.injectButton();
    const originalClick = vi.fn();
    const clipboardCopy = vi.fn(async () => true);
    const blobs = new Map<string, { text: () => Promise<string> }>();
    const capture: (href: string, anchor: HTMLAnchorElement) => Promise<void> = new Function(
      "pendingExport", "beginExport", "finishExport", "blobRegistry", "fetch",
      "copyText", "OrigAnchorClick", "showToast", "dismissPerplexityToasts", "location",
      helper("handleCandidateHref") + "\nreturn handleCandidateHref;",
    )(
      null, api.beginExport, api.finishExport, blobs, vi.fn(),
      clipboardCopy, originalClick, api.showToast, vi.fn(), api.location,
    );
    const anchor = document.createElement("a");
    blobs.set("blob:success", { text: async () => "Native Markdown" });
    await capture("blob:success", anchor);
    expect(clipboardCopy).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(false);
    expect(blobs.size).toBe(0);
    expect(originalClick).not.toHaveBeenCalled();

    blobs.set("blob:unreadable", { text: async () => { throw new Error("Cannot read blob"); } });
    await capture("blob:unreadable", anchor);
    expect(originalClick).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(false);
    expect(blobs.size).toBe(0);
    expect(document.getElementById("pplx-clip-toast")?.textContent).toContain("saving native file");

    clipboardCopy.mockResolvedValueOnce(false);
    blobs.set("blob:verification-failed", { text: async () => "Native Markdown" });
    await capture("blob:verification-failed", anchor);
    expect(originalClick).toHaveBeenCalledTimes(2);
    expect(button().disabled).toBe(false);
  });

  it("does not copy if navigation occurs while the native blob is being read", async () => {
    const api = load();
    const clipboardCopy = vi.fn();
    const originalClick = vi.fn();
    const blobs = new Map([["blob:late", { text: async () => {
      api.location.href = "https://www.perplexity.ai/session/other";
      return "Old conversation";
    } }]]);
    const capture: (href: string, anchor: HTMLAnchorElement) => Promise<void> = new Function(
      "pendingExport", "beginExport", "finishExport", "blobRegistry", "fetch",
      "copyText", "OrigAnchorClick", "showToast", "dismissPerplexityToasts", "location",
      helper("handleCandidateHref") + "\nreturn handleCandidateHref;",
    )(
      null, api.beginExport, api.finishExport, blobs, vi.fn(),
      clipboardCopy, originalClick, api.showToast, vi.fn(), api.location,
    );
    await capture("blob:late", document.createElement("a"));
    expect(clipboardCopy).not.toHaveBeenCalled();
    expect(originalClick).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(false);
  });

  it("coalesces layout updates, follows theme changes and reinjects a removed button once", async () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe() {}
    });
    const addListener = vi.spyOn(window, "addEventListener");
    const api = load();
    api.start();
    api.start();
    expect(callbacks).toHaveLength(2);
    expect(addListener.mock.calls.filter(([name]) => name === "resize")).toHaveLength(1);
    const light = button().style.background;
    document.documentElement.classList.add("dark");
    callbacks[1]();
    callbacks[1]();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(16);
    expect(button().style.background).not.toBe(light);
    button().remove();
    callbacks[0]();
    callbacks[0]();
    await vi.advanceTimersByTimeAsync(16);
    expect(document.querySelectorAll("#pplx-obsidian-export-btn")).toHaveLength(1);
    for (const [name, listener, options] of addListener.mock.calls) {
      window.removeEventListener(name, listener, options);
    }
  });
});
