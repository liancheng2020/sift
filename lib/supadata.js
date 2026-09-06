const DEFAULT_BASE_URL = "https://api.supadata.ai/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 240_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const transcriptCache = new Map();

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

export function resolveSupadataConfig(env = process.env) {
  const apiKey = (env.SUPADATA_API_KEY || "").trim();
  const requested = (env.YOUTUBE_TRANSCRIPT_PROVIDER || "").trim().toLowerCase();
  return {
    apiKey,
    enabled: Boolean(apiKey) && requested !== "direct",
    baseUrl: (env.SUPADATA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    requestTimeoutMs: toPositiveInt(env.SUPADATA_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    pollIntervalMs: toPositiveInt(env.SUPADATA_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    pollTimeoutMs: toPositiveInt(env.SUPADATA_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS),
    cacheTtlMs: toPositiveInt(env.SUPADATA_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS)
  };
}

export function clearSupadataTranscriptCache() {
  transcriptCache.clear();
}

function supadataError(message, code) {
  const error = new Error(message);
  error.youtubeCode = code;
  return error;
}

function mapHttpError(status, body) {
  const code = body?.error || "";
  if (status === 401 || code === "unauthorized") {
    return supadataError("Supadata API Key 无效，请检查服务端 SUPADATA_API_KEY 配置", "SUPADATA_UNAUTHORIZED");
  }
  if (status === 402 || code === "upgrade-required") {
    return supadataError("Supadata 转写额度不足，请升级套餐或等待额度重置", "SUPADATA_QUOTA_EXCEEDED");
  }
  if (status === 404 || code === "not-found") {
    return supadataError("视频不可访问或已被删除", "YOUTUBE_VIDEO_UNAVAILABLE");
  }
  if (status === 429 || code === "limit-exceeded") {
    return supadataError("Supadata 请求频率超限，请稍后重试", "SUPADATA_RATE_LIMITED");
  }
  if (status === 400 || code === "invalid-request") {
    return supadataError("视频链接无效或暂不支持解析", "SUPADATA_INVALID_REQUEST");
  }
  return supadataError(`Supadata 服务暂时不可用（HTTP ${status}），请稍后重试`, "SUPADATA_ERROR");
}

async function supadataGet(path, config) {
  let response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      headers: { "x-api-key": config.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw supadataError("Supadata 请求超时，请稍后重试", "SUPADATA_ERROR");
    }
    throw supadataError("无法连接 Supadata 服务，请稍后重试", "SUPADATA_ERROR");
  }
  const data = await response.json().catch(() => null);
  if (response.status === 206) return { unavailable: true };
  if (!response.ok) throw mapHttpError(response.status, data);
  return { data };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollTranscriptJob(jobId, config) {
  const deadline = Date.now() + config.pollTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);
    const { data } = await supadataGet(`/transcript/${encodeURIComponent(jobId)}`, config);
    if (data?.status === "completed" && data.content) return data.content;
    if (data?.status === "failed") {
      throw supadataError("暂时无法生成该视频的字幕", "YOUTUBE_TRANSCRIPT_UNAVAILABLE");
    }
  }
  throw supadataError("语音转写超时，请稍后重试", "SUPADATA_TIMEOUT");
}

async function requestTranscript(videoUrl, mode, config) {
  const query = new URLSearchParams({ url: videoUrl, mode, text: "false", chunkSize: "1500" });
  const result = await supadataGet(`/transcript?${query}`, config);
  if (result.unavailable) return result;
  if (result.data?.jobId) return { data: await pollTranscriptJob(result.data.jobId, config) };
  return result;
}

export function normalizeSupadataTranscript(data, mode) {
  const content = data?.content;
  const segments = typeof content === "string"
    ? (content.trim() ? [{ text: content.trim(), startMs: 0 }] : [])
    : (Array.isArray(content) ? content : []).flatMap((chunk) => {
      const text = String(chunk?.text || "").replace(/\s+/g, " ").trim();
      const startMs = Number(chunk?.offset);
      return text && Number.isFinite(startMs) && startMs >= 0 ? [{ text, startMs: Math.round(startMs) }] : [];
    });
  if (!segments.length) {
    throw supadataError("暂时无法生成该视频的字幕", "YOUTUBE_TRANSCRIPT_UNAVAILABLE");
  }
  return {
    title: "",
    author: "",
    language: data?.lang || "",
    segments,
    extractionMethod: mode === "native" ? "supadata_native" : "supadata_auto"
  };
}

export async function fetchSupadataTranscript(videoId, env = process.env, onProgress = () => {}) {
  const config = resolveSupadataConfig(env);
  if (!config.enabled) {
    throw supadataError("服务端未配置 SUPADATA_API_KEY", "SUPADATA_NOT_CONFIGURED");
  }

  const cached = transcriptCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.transcript, cached: true };
  }
  transcriptCache.delete(videoId);

  const videoUrl = `https://youtu.be/${videoId}`;
  let mode = "native";
  let result = await requestTranscript(videoUrl, mode, config);
  if (result.unavailable) {
    onProgress("transcribing");
    mode = "auto";
    result = await requestTranscript(videoUrl, mode, config);
  }
  if (result.unavailable) {
    throw supadataError("暂时无法生成该视频的字幕", "YOUTUBE_TRANSCRIPT_UNAVAILABLE");
  }

  const transcript = normalizeSupadataTranscript(result.data, mode);
  transcriptCache.set(videoId, { expiresAt: Date.now() + config.cacheTtlMs, transcript });
  return transcript;
}
