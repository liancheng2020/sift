import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  clearSupadataTranscriptCache,
  fetchSupadataTranscript,
  normalizeSupadataTranscript,
  resolveSupadataConfig
} from "../lib/supadata.js";

const TEST_ENV = {
  SUPADATA_API_KEY: "test-key",
  SUPADATA_POLL_INTERVAL_MS: "1",
  SUPADATA_POLL_TIMEOUT_MS: "60"
};

const jsonResponse = (status, data) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" }
});

const transcriptPayload = {
  content: [
    { text: "大家好，欢迎收看", offset: 1200, duration: 1500, lang: "zh" },
    { text: "今天介绍结构化摘要", offset: 3000, duration: 2000, lang: "zh" }
  ],
  lang: "zh",
  availableLangs: ["zh", "en"]
};

function mockFetch(t, handler) {
  const calls = [];
  const stub = mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options);
  });
  t.after(() => stub.mock.restore());
  return calls;
}

test("resolveSupadataConfig enables Supadata when an API key is present", () => {
  assert.equal(resolveSupadataConfig({ SUPADATA_API_KEY: "key" }).enabled, true);
  assert.equal(resolveSupadataConfig({}).enabled, false);
  assert.equal(resolveSupadataConfig({ SUPADATA_API_KEY: "key", YOUTUBE_TRANSCRIPT_PROVIDER: "direct" }).enabled, false);
  assert.equal(resolveSupadataConfig({ SUPADATA_API_KEY: "key", YOUTUBE_TRANSCRIPT_PROVIDER: "supadata" }).enabled, true);
});

test("native captions succeed synchronously and map to { text, startMs }", async (t) => {
  clearSupadataTranscriptCache();
  const calls = mockFetch(t, (url) => {
    assert.match(url, /mode=native/);
    return jsonResponse(200, transcriptPayload);
  });
  const transcript = await fetchSupadataTranscript("nativeOk123", TEST_ENV);
  assert.equal(calls.length, 1);
  assert.equal(transcript.language, "zh");
  assert.equal(transcript.extractionMethod, "supadata_native");
  assert.deepEqual(transcript.segments, [
    { text: "大家好，欢迎收看", startMs: 1200 },
    { text: "今天介绍结构化摘要", startMs: 3000 }
  ]);
});

test("falls back to mode=auto when native captions are unavailable", async (t) => {
  clearSupadataTranscriptCache();
  const calls = mockFetch(t, (url) => {
    if (url.includes("mode=native")) return jsonResponse(206, { error: "transcript-unavailable" });
    if (url.includes("mode=auto")) return jsonResponse(200, transcriptPayload);
    throw new Error(`unexpected request: ${url}`);
  });
  const stages = [];
  const transcript = await fetchSupadataTranscript("autoOk12345", TEST_ENV, (stage) => stages.push(stage));
  assert.equal(calls.length, 2);
  assert.deepEqual(stages, ["transcribing"]);
  assert.equal(transcript.extractionMethod, "supadata_auto");
  assert.equal(transcript.segments.length, 2);
});

test("async transcription job is polled until completion", async (t) => {
  clearSupadataTranscriptCache();
  let polls = 0;
  const calls = mockFetch(t, (url) => {
    if (url.includes("mode=native")) return jsonResponse(206, { error: "transcript-unavailable" });
    if (url.includes("mode=auto")) return jsonResponse(202, { jobId: "job-1" });
    if (url.includes("/transcript/job-1")) {
      polls += 1;
      return polls < 2
        ? jsonResponse(200, { id: "job-1", status: "active" })
        : jsonResponse(200, { id: "job-1", status: "completed", content: transcriptPayload, error: null });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const transcript = await fetchSupadataTranscript("asyncOk1234", TEST_ENV);
  assert.equal(calls.length, 4);
  assert.equal(transcript.extractionMethod, "supadata_auto");
  assert.equal(transcript.segments[0].startMs, 1200);
});

test("polling that never completes times out with a clear error", async (t) => {
  clearSupadataTranscriptCache();
  mockFetch(t, (url) => {
    if (url.includes("mode=native")) return jsonResponse(206, { error: "transcript-unavailable" });
    if (url.includes("mode=auto")) return jsonResponse(202, { jobId: "job-slow" });
    if (url.includes("/transcript/job-slow")) return jsonResponse(200, { id: "job-slow", status: "queued" });
    throw new Error(`unexpected request: ${url}`);
  });
  await assert.rejects(
    fetchSupadataTranscript("slowJob1234", TEST_ENV),
    (error) => error.youtubeCode === "SUPADATA_TIMEOUT" && /转写超时/.test(error.message)
  );
});

test("provider failures surface distinct error codes", async (t) => {
  clearSupadataTranscriptCache();
  mockFetch(t, () => jsonResponse(401, { error: "unauthorized", message: "Unauthorized" }));
  await assert.rejects(
    fetchSupadataTranscript("badKey12345", TEST_ENV),
    (error) => error.youtubeCode === "SUPADATA_UNAUTHORIZED"
  );

  clearSupadataTranscriptCache();
  mockFetch(t, () => jsonResponse(402, { error: "upgrade-required", message: "Upgrade required" }));
  await assert.rejects(
    fetchSupadataTranscript("noQuota1234", TEST_ENV),
    (error) => error.youtubeCode === "SUPADATA_QUOTA_EXCEEDED" && /额度不足/.test(error.message)
  );
});

test("a failed transcription job reports that no transcript can be generated", async (t) => {
  clearSupadataTranscriptCache();
  mockFetch(t, (url) => {
    if (url.includes("mode=native")) return jsonResponse(206, { error: "transcript-unavailable" });
    if (url.includes("mode=auto")) return jsonResponse(202, { jobId: "job-fail" });
    if (url.includes("/transcript/job-fail")) {
      return jsonResponse(200, { id: "job-fail", status: "failed", error: { message: "asr failed" } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  await assert.rejects(
    fetchSupadataTranscript("failJob1234", TEST_ENV),
    (error) => error.youtubeCode === "YOUTUBE_TRANSCRIPT_UNAVAILABLE" && /暂时无法生成该视频的字幕/.test(error.message)
  );
});

test("repeat requests for the same videoId hit the cache", async (t) => {
  clearSupadataTranscriptCache();
  const calls = mockFetch(t, () => jsonResponse(200, transcriptPayload));
  const first = await fetchSupadataTranscript("cached12345", TEST_ENV);
  const second = await fetchSupadataTranscript("cached12345", TEST_ENV);
  assert.equal(calls.length, 1);
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.deepEqual(second.segments, first.segments);
});

test("missing API key disables the provider", async () => {
  clearSupadataTranscriptCache();
  await assert.rejects(
    fetchSupadataTranscript("noKey123456", {}),
    (error) => error.youtubeCode === "SUPADATA_NOT_CONFIGURED"
  );
});

test("normalizeSupadataTranscript rejects empty transcripts without fabricating content", () => {
  assert.throws(
    () => normalizeSupadataTranscript({ content: [], lang: "en" }, "native"),
    /暂时无法生成该视频的字幕/
  );
});
