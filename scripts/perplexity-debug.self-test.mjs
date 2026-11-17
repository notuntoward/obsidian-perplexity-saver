import assert from "node:assert/strict";
import { captureThread, runCases, sessionUrl, validateImport } from "./perplexity-debug.mjs";

const url = "https://www.perplexity.ai/session/synthetic-offline-test";
assert.equal(sessionUrl(url), url);
for (const invalid of ["https://example.com/session/test", `${url}?token=private`, "http://www.perplexity.ai/session/test"]) {
  assert.throws(() => sessionUrl(invalid));
}
const entry = (id, prompt, answer, sources) => ({
  uuid: id, query_str: prompt, status: "completed", read_write_token: "do-not-save",
  text: JSON.stringify([{ content: { answer: JSON.stringify({
    answer, web_results: sources.map(url => ({ url, private_metadata: "do-not-save" })),
    private_metadata: "do-not-save",
  }) } }]),
});
const first = captureThread({
  entries: [entry("first", "A full prompt.\n\nIts hidden last paragraph.", "B&O and $1 million.[1]",
    ["https://example.com/page?a=1&amp;b=2"])],
  has_next_page: true, next_cursor: "second-page", read_write_token: "do-not-save",
});
const second = captureThread({
  entries: [entry("second", "<q>A quoted passage.</q> Explain.", "A second answer without sources.", [])],
  has_next_page: false, next_cursor: null,
});
assert.ok(!JSON.stringify(first).includes("do-not-save"), "Capture leaked non-conversation metadata.");
assert.throws(() => captureThread({ entries: [{ text: "not JSON" }] }));
const replay = {
  schema: 1, url,
  pages: [{ cursor: null, status: 200, body: first }, { cursor: "second-page", status: 200, body: second }],
  native: "B\\&O and $1 million.[^1_1]\n\n" +
    '<span style="display:none"></span>\n\n<div align="center">⁂</div>\n\n' +
    "[^1_1]: https://example.com/page?a=1\\&b=2\n\n---\n\n" +
    'A second answer without sources.\n\n<span style="display:none"></span>\n\n<div align="center">⁂</div>\n\n',
};
const [success] = await runCases([url], replay);
assert.equal(success.success, true, success.error);
assert.deepEqual(success.sources, [1, 0]);

const [failure] = await runCases([url], { ...replay, native: replay.native.replace("second answer", "WRONG answer") });
assert.equal(failure.success, false, "Runner accepted a corrupted native answer.");
assert.match(failure.error, /clipboard/i);

assert.throws(() => validateImport("not annotated", [{ prompt: "missing", response: "answer", sources: [] }],
  () => ({ turns: [] })), /turns/);
console.log("Offline debugging self-test passed: pagination, private captures, import preservation and rejected corruption.");
