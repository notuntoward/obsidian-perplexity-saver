import { describe, expect, it, vi } from "vitest";
import { forwardWithoutRedirects, installClipboardSink, requestDecision, validateThreadUrl } from "../scripts/perplexity-debug.mjs";
import { runInNewContext } from "node:vm";

describe("anonymous Perplexity debugging boundaries", () => {
  const thread = validateThreadUrl("https://www.perplexity.ai/search/example-thread");

  it("rejects authentication URLs, credentials, tracking parameters and lookalike hosts", () => {
    for (const url of [
      "https://accounts.google.com/",
      "https://www.perplexity.ai.evil.example/search/thread",
      "http://www.perplexity.ai/search/thread",
      "https://user:password@www.perplexity.ai/search/thread",
      "https://www.perplexity.ai:9222/search/thread",
      "https://www.perplexity.ai/search/thread?token=secret",
      "https://www.perplexity.ai/search/thread#secret",
      "https://www.perplexity.ai/settings",
    ]) {
      expect(() => validateThreadUrl(url)).toThrow();
    }
  });

  it("permits thread canonicalization and assets but blocks other navigation and mutations", () => {
    expect(requestDecision("https://perplexity.ai/search/example-thread/", "GET", true, thread)).toBeNull();
    expect(requestDecision("https://www.perplexity.ai/_next/static/script.js", "GET", false, thread)).toBeNull();
    expect(requestDecision("https://challenges.cloudflare.com/widget.js", "GET", false, thread)).toBeNull();
    expect(requestDecision("https://accounts.google.com/", "GET", true, thread)).toBe("navigation");
    expect(requestDecision("https://www.perplexity.ai/search/another-thread", "GET", true, thread)).toBe("navigation");
    expect(requestDecision(thread.href + "?token=secret", "GET", true, thread)).toBe("navigation");
    expect(requestDecision("https://www.perplexity.ai/api/query", "POST", false, thread)).toBe("method");
    expect(requestDecision("http://127.0.0.1:27124/lit-note", "GET", false, thread)).toBe("scheme-or-authority");
    expect(requestDecision("https://perplexity.ai.evil.example/script.js", "GET", false, thread)).toBe("host");
  });

  it("intercepts both userscript and native clipboard writes without touching the host clipboard", async () => {
    const isolated = runInNewContext(`(${installClipboardSink.toString()})(); ({
      writeGrant: GM_setClipboard,
      writeNative: navigator.clipboard.writeText,
      sink: __perplexityDebugClipboard,
    })`, { navigator: {} });

    isolated.writeGrant("grant output");
    expect(isolated.sink.writes).toBe(1);
    expect(isolated.sink.text).toBe("grant output");
    await isolated.writeNative("native output");
    expect(isolated.sink.writes).toBe(2);
    expect(isolated.sink.text).toBe("native output");
  });

  it.each([
    { status: 302, headers: { location: "https://accounts.google.com/" }, blocked: "redirect" },
    { status: 200, headers: { "cf-mitigated": "challenge" }, blocked: "challenge" },
    { status: 200, headers: {}, blocked: null },
  ])("enforces the upstream navigation response policy ($status, $blocked)", async ({ status, headers, blocked }) => {
    const response = { status: () => status, headers: () => headers, dispose: vi.fn() };
    const route = {
      fetch: vi.fn().mockResolvedValue(response),
      fulfill: vi.fn(),
      request: vi.fn().mockReturnValue({ isNavigationRequest: () => true }),
    };
    const block = vi.fn();

    await forwardWithoutRedirects(route, block);

    expect(route.fetch).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
    if (blocked) {
      expect(block).toHaveBeenCalledWith(blocked);
      expect(route.fulfill).not.toHaveBeenCalled();
    } else {
      expect(block).not.toHaveBeenCalled();
      expect(route.fulfill).toHaveBeenCalledWith({ response });
    }
    expect(response.dispose).toHaveBeenCalledOnce();
  });
});
