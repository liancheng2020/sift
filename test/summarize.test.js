import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDigest, normalizeSummaryMode, resolveProviderConfig, summarizeContent, validateDigest } from "../lib/summarize.js";

const validDigest = {
  overview: { oneLiner: "这是核心结论。", topic: "测试主题" },
  keyPoints: [{
    title: "重点",
    summary: "重点内容。",
    evidence: { locator: "[段落 1]", seconds: null, quote: "原文证据" }
  }],
  keyData: [],
  decisions: [],
  actionItems: [],
  risks: [],
  outline: [{ title: "开场", summary: "内容脉络。", locator: "[段落 1]", seconds: null }]
};

test("normalizeDigest keeps the evidence-first output shape", () => {
  assert.deepEqual(normalizeDigest({
    overview: { oneLiner: " 结论 ", topic: " 主题 " },
    keyPoints: [{
      title: " 要点 ",
      summary: " 内容 ",
      evidence: { locator: " [段落 1] ", seconds: null, quote: " 证据 " }
    }]
  }), {
    overview: { oneLiner: "结论", topic: "主题" },
    keyPoints: [{
      title: "要点",
      summary: "内容",
      evidence: { locator: "[段落 1]", seconds: null, quote: "证据" }
    }],
    keyData: [],
    decisions: [],
    actionItems: [],
    risks: [],
    outline: []
  });
});

test("validateDigest rejects missing evidence instead of silently accepting it", () => {
  const result = validateDigest({
    ...validDigest,
    keyPoints: [{ title: "重点", summary: "内容" }]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("；"), /evidence/);
});

test("validateDigest accepts a complete evidence-first digest", () => {
  assert.deepEqual(validateDigest(validDigest), { valid: true, errors: [] });
});

test("normalizes and validates summary modes", () => {
  assert.equal(normalizeSummaryMode(), "standard");
  assert.equal(normalizeSummaryMode("DEEP"), "deep");
  assert.throws(() => normalizeSummaryMode("verbose"), /仅支持/);
});

test("resolveProviderConfig defaults to DeepSeek when its key exists", () => {
  assert.deepEqual(resolveProviderConfig({ DEEPSEEK_API_KEY: "test-key" }), {
    provider: "deepseek",
    apiKey: "test-key",
    model: "deepseek-chat",
    endpoint: "https://api.deepseek.com/chat/completions"
  });
});

test("resolveProviderConfig supports explicit OpenAI selection", () => {
  const config = resolveProviderConfig({
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-test"
  });
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-test");
});

test("resolveProviderConfig expands provider base URLs", () => {
  assert.equal(
    resolveProviderConfig({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "https://api.deepseek.com/" }).endpoint,
    "https://api.deepseek.com/chat/completions"
  );
  assert.equal(
    resolveProviderConfig({ AI_PROVIDER: "openai", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.openai.com/v1" }).endpoint,
    "https://api.openai.com/v1/responses"
  );
});

test("resolveProviderConfig rejects unknown providers", () => {
  assert.throws(() => resolveProviderConfig({ AI_PROVIDER: "unknown" }), /仅支持/);
});

test("DeepSeek receives validation feedback before repairing malformed JSON", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousProvider = process.env.AI_PROVIDER;
  const requestBodies = [];
  let calls = 0;
  process.env.AI_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(calls === 1 ? { overview: {} } : validDigest) } }]
      })
    };
  };
  try {
    const result = await summarizeContent({
      text: "[段落 1] 这是一段足够用于测试摘要修复流程的原文证据。",
      title: "测试",
      sourceType: "粘贴文本"
    });
    assert.equal(result.overview.topic, "测试主题");
    assert.equal(calls, 2);
    assert.match(requestBodies[1].messages.at(-1).content, /未通过校验/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
  }
});
