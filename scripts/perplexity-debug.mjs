import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = path.join(root, ".perplexity-debug");
const scriptPath = path.join(root, "browser-userscript", "perplexity-obsidian-exporter-direct.user.js");

export function sessionUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["www.perplexity.ai", "perplexity.ai"].includes(url.hostname) ||
      url.port || url.username || url.password || !/^\/session\/[a-z0-9-]+\/?$/i.test(url.pathname) ||
      url.search || url.hash) {
    throw new Error("Expected an HTTPS Perplexity session URL without credentials, query or fragment.");
  }
  return url.href;
}

export function captureThread(data) {
  assert.ok(Array.isArray(data?.entries), "Thread response has no entries array.");
  return {
    entries: data.entries.map(entry => {
      // Retain conversation content, not account metadata or read/write tokens.
      const steps = JSON.parse(entry.text);
      const answer = JSON.parse(steps.at(-1).content.answer);
      return {
        uuid: entry.uuid, query_str: entry.query_str, status: entry.status,
        text: JSON.stringify([{ content: { answer: JSON.stringify({
          answer: answer.answer,
          web_results: Array.isArray(answer.web_results)
            ? answer.web_results.map(source => ({ url: source.url }))
            : answer.web_results,
        }) } }]),
      };
    }),
    has_next_page: data.has_next_page,
    next_cursor: data.next_cursor,
  };
}

export function validateImport(text, expected, parseDialog) {
  const dialog = parseDialog(text);
  assert.equal(dialog.turns.length, expected.length * 2, "Importer lost or added turns.");
  const promptBlocks = [...text.matchAll(/<!-- PPLX-ROLE: prompt -->\n([\s\S]*?)\n\n<!-- PPLX-ROLE: ai -->/g)];
  assert.equal(promptBlocks.length, expected.length, "Missing annotated prompts.");
  const comparable = value => value.replace(/\[\^\d+_\d+\]|\[\d+\]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}]/gu, "").toLowerCase();
  for (const [i, turn] of expected.entries()) {
    const prompt = dialog.turns[i * 2];
    const answer = dialog.turns[i * 2 + 1];
    assert.equal(prompt.role, "prompt", `Turn ${i + 1}: wrong prompt role.`);
    assert.equal(answer.role, "ai", `Turn ${i + 1}: wrong answer role.`);
    assert.equal(promptBlocks[i][1], turn.prompt.trim(), `Turn ${i + 1}: prompt changed.`);
    const isolated = parseDialog(`<!-- PPLX-TURN 1 -->\n<!-- PPLX-ROLE: prompt -->\n${turn.prompt}\n\n` +
      "<!-- PPLX-ROLE: ai -->\nExpected answer.\n\n<!-- PPLX-ROLE: sources -->\n(none)");
    assert.equal(prompt.rawText, isolated.turns[0]?.rawText, `Turn ${i + 1}: importer changed the prompt.`);
    assert.equal(comparable(answer.rawText), comparable(turn.response), `Turn ${i + 1}: answer changed.`);
    assert.deepEqual(
      answer.citations.map(citation => citation.url),
      turn.sources.map(source => source.url.replace(/ /g, "%20")),
      `Turn ${i + 1}: importer source list differs.`,
    );
  }
  return { turns: expected.length, sources: expected.map(turn => turn.sources.length) };
}

function productionHelper(script, name) {
  const match = script.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `Missing userscript helper: ${name}`);
  return match[0];
}

function captureScript(script) {
  const version = script.match(/@version\s+(\S+)/)?.[1];
  assert.ok(version, "Missing userscript version.");
  return `(() => {
    if (location.protocol !== "https:" ||
        !["www.perplexity.ai", "perplexity.ai"].includes(location.hostname)) return;
    const state = globalThis.__pplxDebug = { armed: false, clipboard: [], native: [], errors: [] };
    state.decode = ${productionHelper(script, "sessionTurnsFromResults")};
    globalThis.GM_info = { script: { version: ${JSON.stringify(version)} } };
    globalThis.GM_setClipboard = text => state.clipboard.push(String(text));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new Error("Real clipboard access is disabled by the test harness."); }
    } });
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (state.armed && blob instanceof Blob) {
        blob.text().then(text => {
          if (text.length > 5000000) throw new Error("Native export exceeds the 5 MB capture limit.");
          state.native.push(text);
        }).catch(error => state.errors.push(String(error)));
      }
      return create(blob);
    };
    ${script}
  })();`;
}

async function loadImporter() {
  const bundle = await build({
    entryPoints: [path.join(root, "src", "parsers", "perplexity.ts")],
    bundle: true, write: false, format: "esm", platform: "node",
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`)).parsePerplexityDialog;
}

function fixtureHtml(native) {
  const literal = JSON.stringify(native).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><main>
    <button aria-label="Session options">Options</button>
    <form><div contenteditable="true" role="textbox"></div></form>
    </main><script>
    document.querySelector("button").onclick = () => {
      const menu = document.createElement("div"); menu.setAttribute("role", "menu");
      const item = document.createElement("button"); item.setAttribute("role", "menuitem");
      item.textContent = "Export as Markdown";
      item.onclick = () => {
        const anchor = document.createElement("a");
        anchor.download = "replay.md";
        anchor.href = URL.createObjectURL(new Blob([${literal}], { type: "text/markdown" }));
        anchor.click(); menu.remove();
      };
      menu.append(item); document.body.append(menu);
    };
    </script>`;
}

async function exercise(context, url, script, parseDialog, directory, replay) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const evidence = { schema: 1, url, scriptSha256: createHash("sha256").update(script).digest("hex"), pages: [], native: null };
  const diagnostics = { console: [], pageErrors: [], failedRequests: [], downloads: [], captureErrors: [] };
  const pending = [];
  const threadPath = "/rest/thread/" + new URL(url).pathname.split("/")[2];
  let armed = false;
  page.on("console", message => {
    if (message.text().includes("[PPLX") && diagnostics.console.length < 100) {
      diagnostics.console.push({ level: message.type(), text: message.text().slice(0, 12000) });
    }
  });
  page.on("pageerror", error => {
    if (diagnostics.pageErrors.length < 30) diagnostics.pageErrors.push(error.message.slice(0, 1000));
  });
  page.on("requestfailed", request => {
    if (diagnostics.failedRequests.length < 30) {
      const target = new URL(request.url());
      diagnostics.failedRequests.push({ url: target.origin + target.pathname, error: request.failure()?.errorText });
    }
  });
  page.on("download", download => {
    diagnostics.downloads.push(download.suggestedFilename());
    pending.push(download.cancel().catch(error => diagnostics.captureErrors.push(String(error))));
  });
  page.on("response", response => {
    const target = new URL(response.url());
    if (armed && target.origin === new URL(url).origin && target.pathname === threadPath &&
        target.searchParams.get("from_first") === "true") {
      const record = { cursor: target.searchParams.get("cursor"), status: response.status() };
      evidence.pages.push(record);
      pending.push((async () => {
        if (response.ok()) record.body = captureThread(await response.json());
      })().catch(error => diagnostics.captureErrors.push(String(error))));
    }
  });
  if (replay) {
    await page.route("**/*", async route => {
      const target = new URL(route.request().url());
      if (target.href === url) {
        await route.fulfill({ contentType: "text/html", body: fixtureHtml(replay.native) });
      } else if (target.origin === new URL(url).origin && target.pathname === threadPath) {
        const saved = replay.pages.find(item => item.cursor === target.searchParams.get("cursor"));
        if (!saved) {
          diagnostics.captureErrors.push("Replay has no response for this pagination cursor.");
          await route.abort("blockedbyclient");
          return;
        }
        await route.fulfill({ status: saved.status, contentType: "application/json", body: JSON.stringify(saved.body ?? {}) });
      } else {
        await route.abort("blockedbyclient");
      }
    });
  }
  await page.addInitScript({ content: captureScript(script) });
  let result;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (new URL(page.url()).pathname !== new URL(url).pathname ||
        /just a moment|verify you are human/i.test(await page.title())) {
      throw new Error("Session unavailable: use the login command to sign in or handle browser verification manually.");
    }
    // The injected button can appear before Perplexity's client-side app has loaded.
    await page.locator('main button[aria-label="Session options"], main button[aria-label="Thread options"]')
      .waitFor({ state: "visible", timeout: 45000 });
    const button = page.locator("#pplx-obsidian-export-btn");
    await button.waitFor({ state: "visible" });
    await page.evaluate(() => { globalThis.__pplxDebug.armed = true; });
    armed = true;
    await button.click();
    await page.waitForFunction(() => {
      const state = globalThis.__pplxDebug;
      const toast = document.querySelector("#pplx-clip-toast");
      return state.clipboard.length || (toast && /unchanged|failed|timed out|saving.*file|could not/i.test(toast.textContent));
    }, null, { timeout: 75000 });
    await Promise.all(pending);
    const captured = await page.evaluate(() => ({
      clipboard: globalThis.__pplxDebug.clipboard,
      native: globalThis.__pplxDebug.native,
      errors: globalThis.__pplxDebug.errors,
      toast: document.querySelector("#pplx-clip-toast")?.textContent,
    }));
    evidence.native = captured.native.at(-1) ?? null;
    assert.deepEqual(captured.errors, [], "Native export capture failed.");
    assert.deepEqual(diagnostics.captureErrors, [], "Thread response capture failed.");
    assert.equal(captured.clipboard.length, 1,
      `Export did not produce exactly one captured clipboard write. ${captured.toast ?? ""}`);
    assert.equal(diagnostics.downloads.length, 0, "Export fell back to an unexpected download.");
    assert.ok(evidence.pages.length, "No structured thread response was captured.");
    assert.ok(evidence.native, "No native Markdown was captured.");
    const entries = evidence.pages.flatMap(record => record.body?.entries ?? []);
    const expected = await page.evaluate(data => globalThis.__pplxDebug.decode(data), entries);
    const summary = validateImport(captured.clipboard[0], expected, parseDialog);
    await writeFile(path.join(directory, "clipboard.md"), captured.clipboard[0]);
    result = { success: true, ...summary };
  } catch (error) {
    result = { success: false, error: String(error) };
    // Error evidence is local and private; never include cookies or request headers.
    await Promise.all(pending);
    const captured = await page.evaluate(() => ({
      native: globalThis.__pplxDebug?.native ?? [],
      clipboard: globalThis.__pplxDebug?.clipboard ?? [],
      toast: document.querySelector("#pplx-clip-toast")?.textContent,
    })).catch(captureError => ({ native: [], clipboard: [], captureError: String(captureError) }));
    evidence.native = captured.native.at(-1) ?? null;
    diagnostics.pageState = {
      url: page.url(), toast: captured.toast, clipboardWrites: captured.clipboard.length,
      captureError: captured.captureError,
    };
    if (captured.clipboard.length) await writeFile(path.join(directory, "clipboard.md"), captured.clipboard.at(-1));
    await page.screenshot({ path: path.join(directory, "failure.png") }).catch(
      captureError => diagnostics.captureErrors.push(String(captureError)),
    );
  } finally {
    await writeFile(path.join(directory, "replay.json"), JSON.stringify(evidence, null, 2));
    await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...result, diagnostics }, null, 2));
    await page.close();
  }
  return result;
}

export async function runCases(urls, replay, headed = false) {
  const script = await readFile(scriptPath, "utf8");
  const parseDialog = await loadImporter();
  const runs = path.join(privateDir, "runs");
  await mkdir(runs, { recursive: true });
  const runDir = await mkdtemp(path.join(runs, new Date().toISOString().replace(/[:.]/g, "-") + "-"));
  const browser = replay ? await chromium.launch({ channel: "chrome", headless: !headed }) : null;
  const context = replay
    ? await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" })
    : await chromium.launchPersistentContext(path.join(privateDir, "profile"), {
      channel: "chrome", headless: !headed, acceptDownloads: true, serviceWorkers: "block",
    });
  const results = [];
  try {
    for (const [i, url] of urls.entries()) {
      const directory = path.join(runDir, String(i + 1));
      await mkdir(directory);
      const result = await exercise(context, url, script, parseDialog, directory, replay);
      results.push({ url, ...result });
      console.log(`${result.success ? "PASS" : "FAIL"} ${i + 1}/${urls.length}: ${
        result.success ? `${result.turns} turns; sources ${result.sources.join("/")}` : result.error
      }`);
    }
    await writeFile(path.join(runDir, "summary.json"), JSON.stringify(results, null, 2));
    console.log(`Private evidence: ${runDir}`);
  } finally {
    await context.close();
    if (browser) await browser.close();
  }
  return results;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "init") {
    const file = path.join(privateDir, "corpus.json");
    await mkdir(privateDir, { recursive: true });
    let existing = [];
    try { existing = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.ok(Array.isArray(existing), "Corpus must be an array of session URLs.");
    const urls = [...new Set([...existing, ...args].map(sessionUrl))];
    await writeFile(file, JSON.stringify(urls, null, 2) + "\n");
    console.log(`Private corpus: ${file} (${urls.length} dialogs)`);
  } else if (command === "login") {
    await mkdir(privateDir, { recursive: true });
    const context = await chromium.launchPersistentContext(path.join(privateDir, "profile"), {
      channel: "chrome", headless: false,
      args: ["--window-position=80,80", "--window-size=1280,900"],
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto("https://www.perplexity.ai/", { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      console.log("Sign into Perplexity in this dedicated browser, then close that browser window. Login window expires after 10 minutes.");
      const deadline = Date.now() + 600000;
      while (context.pages().length) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Login window timed out after ten minutes.");
        await Promise.race(context.pages().map(tab => tab.waitForEvent("close", { timeout: remaining })));
      }
    } finally { await context.close(); }
  } else if (command === "run" || command === "replay") {
    const headed = args.includes("--headed");
    const values = args.filter(value => value !== "--headed");
    let replay;
    let urls;
    if (command === "replay") {
      assert.equal(values.length, 1, "Usage: replay <private replay.json> [--headed]");
      replay = JSON.parse(await readFile(path.resolve(values[0]), "utf8"));
      assert.equal(replay.schema, 1, "Unsupported replay schema.");
      assert.ok(typeof replay.native === "string" && Array.isArray(replay.pages) && replay.pages.length,
        "Replay needs captured native Markdown and thread responses; inspect result.json for capture errors.");
      urls = [sessionUrl(replay.url)];
    } else {
      urls = values.length ? values.map(sessionUrl) : JSON.parse(await readFile(path.join(privateDir, "corpus.json"), "utf8"));
      assert.ok(Array.isArray(urls) && urls.length, "Initialize a nonempty private corpus first.");
      urls = urls.map(sessionUrl);
    }
    const results = await runCases(urls, replay, headed);
    if (results.some(result => !result.success)) process.exitCode = 1;
  } else {
    console.log("Usage: npm run debug:perplexity -- init [session URLs...]\n" +
      "       npm run debug:perplexity -- login\n" +
      "       npm run debug:perplexity -- run [session URLs...] [--headed]\n" +
      "       npm run debug:perplexity -- replay <private replay.json> [--headed]");
    if (command && command !== "--help") process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
