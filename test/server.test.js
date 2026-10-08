import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixtureDigest, syntheticText } from "../scripts/fixtures.mjs";
import { WorkflowError } from "../lib/errors.js";
process.env.SIFT_TEST_MODE = "1";
const { createApp, default: vercelHandler } = await import("../server.js");

test("Vercel entry exports a request handler for the homepage and API", async t => {
  assert.equal(typeof vercelHandler, "function");
  const server = createServer(vercelHandler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, type] of [["/", "text/html"], ["/api/health", "application/json"]]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), new RegExp(type), path);
    await response.arrayBuffer();
  }
});

async function withServer(t, summarize) {
  const app = createApp({ summarize });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return `http://127.0.0.1:${app.address().port}`;
}
const summary = () => ({ summary: fixtureDigest(), trace: { calls: [] }, grounding: { semanticVerified: false }, sourceExcerpts: [] });

test("text endpoint returns trace and forwards cancellation signal", async t => {
  const base = await withServer(t, async (input, options) => {
    assert.equal(input.text, syntheticText);
    assert.ok(options.signal instanceof AbortSignal);
    return summary();
  });
  const result = await fetch(`${base}/api/summarize/text`, { method: "POST", body: JSON.stringify({ text: syntheticText }) });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).meta.grounding.semanticVerified, false);
});

test("invalid JSON and wrong field types fail before the model", async t => {
  const base = await withServer(t, async () => { assert.fail("must not call model"); });
  for (const body of ["{", "[]", "null", '{"text":123}']) {
    const result = await fetch(`${base}/api/summarize/text`, { method: "POST", body });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).code, "INVALID_REQUEST");
  }
});

test("browser PDF endpoint preserves page locators", async t => {
  const base = await withServer(t, async input => { assert.match(input.text, /^\[第 2 页\]/); return summary(); });
  const result = await fetch(`${base}/api/summarize/file-text`, { method: "POST", body: JSON.stringify({ filename: "fixture.pdf", fileType: "PDF", text: `[第 2 页]\n${syntheticText}` }) });
  assert.equal(result.status, 200);
});

test("multipart accepts one TXT file and rejects extra files", async t => {
  const base = await withServer(t, async () => summary());
  for (const count of [1, 2]) {
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append("file", new Blob([syntheticText]), `fixture-${i}.txt`);
    const response = await fetch(`${base}/api/summarize/file`, { method: "POST", body: form });
    assert.equal(response.status, count === 1 ? 200 : 413);
  }
});

test("model errors remain typed at the HTTP boundary", async t => {
  const base = await withServer(t, async () => { throw new WorkflowError("模型服务限流，请稍后重试", "MODEL_RATE_LIMITED", 503); });
  const response = await fetch(`${base}/api/summarize/text`, { method: "POST", body: JSON.stringify({ text: syntheticText }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MODEL_RATE_LIMITED");
});

test("text requests cannot bypass the shared per-instance rate limit", async t => {
  const base = await withServer(t, async () => summary());
  for (let i = 0; i < 12; i++) {
    const response = await fetch(`${base}/api/summarize/text`, { method: "POST", body: JSON.stringify({ text: syntheticText }) });
    assert.equal(response.status, 200);
  }
  const response = await fetch(`${base}/api/summarize/file-text`, { method: "POST", body: "{}" });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, "REQUEST_RATE_LIMITED");
});
