import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDigest, resolveProviderConfig } from "../lib/summarize.js";

test("normalizeDigest keeps the stable v0.1 output shape", () => {
  assert.deepEqual(normalizeDigest({ conclusion: " 结论 ", coreContent: ["要点"], risks: "无" }), {
    conclusion: "结论",
    coreContent: ["要点"],
    entities: [],
    keyData: [],
    viewpoints: [],
    risks: [],
    sourceAnchors: []
  });
});

test("normalizeDigest removes incomplete structured items", () => {
  const result = normalizeDigest({
    entities: [{ name: "OpenAI", type: "公司", context: "模型提供方" }, { name: "无上下文" }],
    sourceAnchors: [{ label: "结论依据", locator: "02:10", seconds: 130 }, { label: "无定位" }]
  });
  assert.equal(result.entities.length, 1);
  assert.equal(result.sourceAnchors.length, 1);
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
