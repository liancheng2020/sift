import test from "node:test";
import assert from "node:assert/strict";
import { summarizeContentDetailed } from "../lib/summarize.js";
import { fixtureDigest, syntheticText } from "../scripts/fixtures.mjs";

const env = { AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-key" };
const response = (digest, extra = {}) => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(digest) } }], usage: { prompt_tokens: 100, completion_tokens: 20 }, ...extra }) });
const run = (options = {}, text = syntheticText) => summarizeContentDetailed({ text }, { env, ...options });

test("returns actual usage and source contexts without claiming semantic truth", async () => {
  const result = await run({ fetchImpl: async () => response(fixtureDigest()) });
  assert.equal(result.trace.calls.length, 1);
  assert.equal(result.trace.inputTokens, 100);
  assert.equal(result.grounding.semanticVerified, false);
  assert.match(result.sourceExcerpts[0].excerpt, /12 万元/);
});

test("repairs ungrounded evidence once and accounts for both calls", async () => {
  let count = 0;
  const result = await run({ fetchImpl: async () => response(++count === 1 ? fixtureDigest("[段落 1]", "凭空捏造") : fixtureDigest()) });
  assert.equal(count, 2);
  assert.equal(result.trace.inputTokens, 200);
  assert.equal(result.trace.calls[0].status, "failed");
});

test("bounded repair rejects permanently invalid evidence", async () => {
  let count = 0;
  await assert.rejects(run({ fetchImpl: async () => { count++; return response(fixtureDigest("[段落 1]", "不存在")); } }), { code: "SUMMARY_INVALID_OUTPUT" });
  assert.equal(count, 2);
});

for (const [status, code] of [[401, "MODEL_AUTH_FAILED"], [429, "MODEL_RATE_LIMITED"], [404, "MODEL_NOT_FOUND"]]) {
  test(`HTTP ${status} yields a sanitized typed error without retry`, async () => {
    let count = 0;
    await assert.rejects(run({ fetchImpl: async () => { count++; return { ok: false, status, json: async () => ({ secret: "DO_NOT_LEAK" }) }; } }), error => error.code === code && !error.message.includes("DO_NOT_LEAK"));
    assert.equal(count, 1);
  });
}

test("truncation and refusal do not trigger JSON repair", async () => {
  await assert.rejects(run({ fetchImpl: async () => response({}, { choices: [{ finish_reason: "length" }] }) }), { code: "SUMMARY_TRUNCATED" });
  await assert.rejects(run({ fetchImpl: async () => response({}, { choices: [{ message: { refusal: "no" } }] }) }), { code: "MODEL_REFUSAL" });
});

test("unknown token usage remains null rather than invented zero", async () => {
  const result = await run({ fetchImpl: async () => response(fixtureDigest(), { usage: undefined }) });
  assert.equal(result.trace.inputTokens, null);
  assert.equal(result.trace.cost, null);
});

test("deadline, cancellation and call budget stop work", async () => {
  await assert.rejects(run({ deadline: Date.now() - 1, fetchImpl: async () => { throw Error("must not call"); } }), { code: "WORKFLOW_TIMEOUT" });
  await assert.rejects(run({ signal: AbortSignal.abort(), fetchImpl: async () => { throw Error("must not call"); } }), { code: "REQUEST_CANCELLED" });
  await assert.rejects(run({ maxCalls: 0 }), { code: "WORKFLOW_CALL_LIMIT" });
  await assert.rejects(run({ env: {} }), { code: "MODEL_NOT_CONFIGURED" });
});

test("split and merge preserve original paragraph indices", async () => {
  let calls = 0;
  const text = `${"a".repeat(90)}预算为 12 万元\n\n${"b".repeat(90)}尚未验收`;
  const result = await run({ chunkLength: 150, fetchImpl: async () => response(++calls === 2 ? fixtureDigest("[段落 2]", "尚未验收") : fixtureDigest()) }, text);
  assert.equal(result.trace.chunkCount, 2);
  assert.equal(result.trace.calls.length, 3);
  assert.match(result.trace.calls.at(-1).stage, /merge/);
});

test("OpenAI Responses adapter follows the same grounding contract", async () => {
  const result = await run({ env: { AI_PROVIDER: "openai", OPENAI_API_KEY: "synthetic" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify(fixtureDigest()) }] }], usage: { input_tokens: 60, output_tokens: 10 } }) }) });
  assert.equal(result.trace.provider, "openai");
  assert.equal(result.trace.outputTokens, 10);
});

test("cancellation propagates to an in-flight model request", async () => {
  const controller = new AbortController();
  await assert.rejects(run({ signal: controller.signal, fetchImpl: async (_url, options) => {
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  } }), { code: "REQUEST_CANCELLED" });
});
