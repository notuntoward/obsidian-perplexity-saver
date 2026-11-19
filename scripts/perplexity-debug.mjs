import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const userscriptPath = fileURLToPath(new URL("../browser-userscript/perplexity-obsidian-exporter-direct.user.js", import.meta.url));
const threadHosts = new Set(["perplexity.ai", "www.perplexity.ai"]);
const assetDomains = ["perplexity.ai", "pplx.ai", "pplx-res.cloudinary.com", "challenges.cloudflare.com"];
class DebugRunError extends Error {}

const smokeUrl = "https://www.perplexity.ai/search/local-debug-smoke";
const smokeMarkdown = `# Synthetic question

Second prompt paragraph.

Synthetic answer with citation.[^1]

Another answer paragraph.

[^1]: https://example.invalid/source

---

# Synthetic follow-up

Second answer.`;
const smokeHtml = `<!doctype html><main>
<h1>Synthetic export fixture</h1>
<button id="export">Export as Markdown</button>
<script>
document.getElementById("export").onclick = () => {
  const anchor = document.createElement("a");
  anchor.href = "data:text/markdown," + encodeURIComponent(${JSON.stringify(smokeMarkdown)});
  anchor.download = "fixture.md";
  anchor.click();
};
</script></main>`;

export function validateThreadUrl(input) {
  const url = new URL(input);
  if (url.protocol !== "https:" || !threadHosts.has(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/(?:search|page)\/[^/]+\/?$/.test(url.pathname)) {
    throw new DebugRunError("Provide an HTTPS Perplexity thread URL without credentials, query, fragment, or a custom port.");
  }
  return url;
}

export function requestDecision(input, method, navigation, thread) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.port || url.username || url.password) return "scheme-or-authority";
  if (method !== "GET" && method !== "HEAD") return "method";
  if (navigation) {
    return threadHosts.has(url.hostname) &&
      url.pathname.replace(/\/$/, "") === thread.pathname.replace(/\/$/, "") &&
      !url.search && !url.hash ? null : "navigation";
  }
  return assetDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    ? null : "host";
}

/**
 * @param {Pick<import("playwright").Route, "fetch" | "fulfill" | "request">} route
 * @param {(reason: string) => Promise<void>} block
 */
export async function forwardWithoutRedirects(route, block) {
  // Playwright routes only the first request in a redirect chain.
  let response;
  try {
    response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
  } catch {
    await block("upstream");
    return;
  }
  try {
    const status = response.status();
    if (status >= 300 && status < 400 && status !== 304) {
      await block("redirect");
    } else if (route.request().isNavigationRequest() && response.headers()["cf-mitigated"] === "challenge") {
      await block("challenge");
    } else {
      await route.fulfill({ response });
    }
  } finally {
    await response.dispose();
  }
}

export function installClipboardSink() {
  const sink = { writes: 0, text: "" };
  const writeText = text => {
    sink.text = String(text);
    sink.writes++;
  };
  Object.defineProperty(globalThis, "__perplexityDebugClipboard", { value: sink });
  Object.defineProperty(globalThis, "GM_setClipboard", { value: writeText });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async text => writeText(text) },
  });
}

export async function runDebug({ url: input, scenario, offline = false }) {
  const thread = validateThreadUrl(input);
  if (offline && thread.href !== smokeUrl) throw new DebugRunError("Offline mode only serves the synthetic smoke fixture.");
  const source = await readFile(userscriptPath, "utf8");
  const report = {
    mode: offline ? "offline-smoke" : "anonymous",
    userscriptSha256: createHash("sha256").update(source).digest("hex"),
    consoleCounts: {},
    pageErrors: 0,
    blockedRequests: {},
    canceledDownloads: 0,
    closedPopups: 0,
    clipboard: { writes: 0, characters: 0 },
  };
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 15_000 });
  let deadline;
  try {
    const work = async () => {
      const context = await browser.newContext({
        acceptDownloads: false,
        offline,
        serviceWorkers: "block",
        permissions: [],
      });
      let blockedThreadReason;
      await context.route("**/*", async route => {
        const request = route.request();
        const navigation = request.isNavigationRequest();
        const block = async reason => {
          report.blockedRequests[reason] = (report.blockedRequests[reason] || 0) + 1;
          if (navigation && request.url() === thread.href) blockedThreadReason = reason;
          await route.abort("blockedbyclient");
        };
        const reason = requestDecision(request.url(), request.method(), navigation, thread);
        if (reason) {
          await block(reason);
        } else if (offline) {
          if (navigation) {
            await route.fulfill({ contentType: "text/html", body: smokeHtml });
          } else {
            await route.abort("blockedbyclient");
          }
        } else {
          await forwardWithoutRedirects(route, block);
        }
      });
      await context.routeWebSocket("**/*", socket => {
        report.blockedRequests.websocket = (report.blockedRequests.websocket || 0) + 1;
        socket.close();
      });
      await context.addInitScript(installClipboardSink);
      const page = await context.newPage();
      const pendingActions = [];
      let actionFailed = false;
      const trackAction = promise => pendingActions.push(promise.catch(() => { actionFailed = true; }));
      context.on("page", popup => {
        report.closedPopups++;
        trackAction(popup.close());
      });
      page.on("download", download => {
        report.canceledDownloads++;
        trackAction(download.cancel());
      });
      page.on("console", message => {
        const level = message.type();
        report.consoleCounts[level] = (report.consoleCounts[level] || 0) + 1;
      });
      page.on("pageerror", () => { report.pageErrors++; });
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(30_000);
      const response = await page.goto(thread.href, { waitUntil: "domcontentloaded" }).catch(error => {
        if (blockedThreadReason === "redirect") {
          throw new DebugRunError("A redirect was blocked. Use the approved final thread URL directly, or stop if sign-in is required.");
        }
        if (blockedThreadReason === "challenge") {
          throw new DebugRunError("Perplexity returned a browser challenge; stopping without attempting to bypass it.");
        }
        if (blockedThreadReason === "upstream") throw new DebugRunError("The approved thread request failed or timed out.");
        throw error;
      });
      if (!response?.ok()) throw new DebugRunError("Thread did not load successfully; stop for authentication, challenge, or HTTP failure.");
      if (requestDecision(page.url(), "GET", true, thread)) {
        throw new DebugRunError("The page left the approved thread before userscript injection.");
      }
      await page.evaluate(source);
      if (scenario) await scenario({ page });
      report.clipboard = await page.evaluate(() => ({
        writes: globalThis.__perplexityDebugClipboard.writes,
        characters: globalThis.__perplexityDebugClipboard.text.length,
      }));
      await Promise.all(pendingActions);
      if (actionFailed) throw new DebugRunError("Could not close a popup or cancel a download; the browser has been closed.");
      return report;
    };
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new DebugRunError("Debug run exceeded its 60-second deadline.")), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === "--self-test") {
    const report = await runDebug({
      url: smokeUrl,
      offline: true,
      scenario: async ({ page }) => {
        await page.locator("#export").click();
        await page.waitForFunction(() => globalThis.__perplexityDebugClipboard.writes > 0);
        const correct = await page.evaluate(() => {
          const text = globalThis.__perplexityDebugClipboard.text;
          const expected = [
            "<!-- PPLX-TURN 1 -->\n<!-- PPLX-ROLE: prompt -->\n# Synthetic question\n\nSecond prompt paragraph.",
            "<!-- PPLX-ROLE: ai -->\nSynthetic answer with citation.[^1]\n\nAnother answer paragraph.",
            "<!-- PPLX-ROLE: sources -->\n[^1]: https://example.invalid/source",
            "<!-- PPLX-TURN 2 -->\n<!-- PPLX-ROLE: prompt -->\n# Synthetic follow-up",
            "<!-- PPLX-ROLE: ai -->\nSecond answer.",
            "<!-- PPLX-ROLE: sources -->\n(none)",
          ].join("\n\n");
          const headerEnd = text.indexOf("\n\n---\n\n");
          return text.startsWith(`[Perplexity](${location.href})`) &&
            headerEnd !== -1 && text.slice(headerEnd + 7) === expected;
        });
        if (!correct) throw new DebugRunError("Synthetic export content was not preserved.");
        const blocked = await page.evaluate(async () => {
          const attempts = [
            fetch("https://outside.invalid/blocked", { mode: "no-cors" }),
            fetch("/api/debug-smoke", { method: "POST" }),
          ];
          const results = await Promise.allSettled(attempts);
          return results.every(result => result.status === "rejected");
        });
        if (!blocked) throw new DebugRunError("Synthetic network restrictions did not reject both requests.");
      },
    });
    if (report.blockedRequests.host !== 1 || report.blockedRequests.method !== 1 ||
        report.pageErrors || report.clipboard.writes !== 1 || report.canceledDownloads) {
      throw new DebugRunError("Smoke test did not verify route enforcement without page errors.");
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!args.length || args[0] === "--help") {
    console.log("Usage: node scripts/perplexity-debug.mjs <approved-thread-url> [trusted-scenario.mjs]\n       node scripts/perplexity-debug.mjs --self-test");
    return;
  }
  if (args.length > 2) throw new DebugRunError("Expected a thread URL and optional trusted local scenario.");
  validateThreadUrl(args[0]);
  let scenario;
  if (args[1]) {
    const scenarioPath = path.resolve(args[1]);
    if (path.extname(scenarioPath) !== ".mjs") throw new DebugRunError("Scenario must be a trusted local .mjs file.");
    scenario = (await import(pathToFileURL(scenarioPath).href)).default;
    if (typeof scenario !== "function") throw new DebugRunError("Scenario must export a default async function.");
  }
  console.log(JSON.stringify(await runDebug({ url: args[0], scenario }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const message = error instanceof DebugRunError ? error.message
      : error instanceof Error && /Executable doesn't exist/.test(error.message) ? "Chromium is missing; run npx playwright install chromium."
      : "Browser or scenario failed. Raw errors are withheld because they may contain private content; use a minimal local reproduction.";
    console.error(`Debug run failed: ${message}`);
    process.exitCode = 1;
  });
}
