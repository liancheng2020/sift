import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { extractVideoId, normalizeText, transcriptToTimedText } from "./lib/content.js";
import { MAX_FILE_SIZE, parseUploadedFile, validateExtractedFileText } from "./lib/file.js";
import { normalizeSummaryMode, resolveProviderConfig, summarizeContentDetailed } from "./lib/summarize.js";
import { WorkflowError } from "./lib/errors.js";
import { resolveSupadataConfig } from "./lib/supadata.js";
import { fetchYoutubeTranscriptAuto, fetchYoutubeTranscriptFromBrowser, getYoutubeNetworkStatus } from "./lib/youtube.js";

const port = Number(process.env.PORT || 3000);
const MAX_VIDEO_DURATION_MS = Math.max(1, Number(process.env.YOUTUBE_MAX_DURATION_MINUTES || 60)) * 60_000;
const YOUTUBE_RATE_LIMIT_MAX = Math.max(1, Number(process.env.YOUTUBE_RATE_LIMIT_MAX || 12));
const YOUTUBE_RATE_WINDOW_MS = Math.max(1000, Number(process.env.YOUTUBE_RATE_WINDOW_MS || 600_000));
const root = fileURLToPath(new URL(".", import.meta.url));
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function body(request, maxBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new WorkflowError(`请求内容超过 ${Math.round(maxBytes / 1_000_000)}MB 限制`, "REQUEST_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
  catch { throw new WorkflowError("请求 JSON 格式不正确", "INVALID_REQUEST", 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new WorkflowError("请求内容必须为 JSON 对象", "INVALID_REQUEST", 400);
  for (const key of ["text", "title", "url", "filename", "fileType", "summaryMode"]) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") throw new WorkflowError(`${key} 必须为文本`, "INVALID_REQUEST", 400);
  }
  return payload;
}

function codedError(message, code) {
  const error = new Error(message);
  error.youtubeCode = code;
  return error;
}

function summaryModeFrom(request, payload = {}) {
  return normalizeSummaryMode(payload.summaryMode || request.headers["x-sift-summary-mode"]);
}

function readingMinutes(characters) {
  return Math.max(1, Math.ceil(characters / 500));
}

function checkSummaryRateLimit(request, buckets) {
  const forwarded = process.env.VERCEL || process.env.VERCEL_ENV ? request.headers["x-forwarded-for"]?.split(",")[0]?.trim() : "";
  const ip = forwarded || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (buckets.get(ip) || []).filter((time) => now - time < YOUTUBE_RATE_WINDOW_MS);
  if (recent.length >= YOUTUBE_RATE_LIMIT_MAX) {
    throw new WorkflowError("请求过于频繁，请稍后再试", "REQUEST_RATE_LIMITED", 429);
  }
  recent.push(now);
  buckets.set(ip, recent);
  if (buckets.size > 5000) buckets.clear();
}

async function summarizeYoutube(videoId, transcript, summaryMode, summarize, options) {
  if (!transcript.segments.length) throw new Error("该视频没有可用字幕或画面文字");
  const lastSegment = transcript.segments.reduce((last, segment) => segment.startMs > last.startMs ? segment : last);
  if (lastSegment?.startMs > MAX_VIDEO_DURATION_MS) {
    throw codedError(
      `视频时长超过 ${Math.round(MAX_VIDEO_DURATION_MS / 60_000)} 分钟上限，请选择更短的视频`,
      "YOUTUBE_DURATION_LIMIT"
    );
  }
  const text = transcriptToTimedText(transcript.segments);
  const visualTranscript = transcript.extractionMethod?.includes("storyboard_ocr");
  const result = await summarize({
      text,
      title: transcript.title || `YouTube ${videoId}`,
      sourceType: visualTranscript ? "YouTube 画面字幕" : "YouTube 字幕",
      summaryMode
    }, options);
  return {
    summary: result.summary,
    meta: {
      trace: result.trace, grounding: result.grounding, sourceExcerpts: result.sourceExcerpts,
      title: transcript.title,
      author: transcript.author,
      language: transcript.language,
      sourceType: "youtube",
      videoId,
      extractionMethod: transcript.extractionMethod,
      characters: text.length,
      summaryMode,
      sourceMinutes: Math.max(1, Math.ceil((lastSegment.startMs || 0) / 60_000))
    }
  };
}

async function summarizeFileContent({ filename, fileType, text }, summaryMode, summarize, options) {
  const result = await summarize({
    text,
    title: filename,
    sourceType: `${fileType} 文件`,
    summaryMode
  }, options);
  return {
    summary: result.summary,
    meta: {
      trace: result.trace, grounding: result.grounding, sourceExcerpts: result.sourceExcerpts,
      title: filename,
      sourceType: "file",
      fileType,
      characters: text.length,
      summaryMode,
      readingMinutes: readingMinutes(text.length)
    }
  };
}

function uploadedFile(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
      headers: request.headers,
      defParamCharset: "utf8",
      limits: { files: 1, fileSize: MAX_FILE_SIZE, fields: 0, parts: 2 }
    });
    } catch {
      reject(new Error("请使用 multipart/form-data 上传文件"));
      return;
    }

    let file = null;
    let exceeded = false;
    parser.on("filesLimit", () => { exceeded = true; });
    parser.on("fieldsLimit", () => { exceeded = true; });
    parser.on("partsLimit", () => { exceeded = true; });
    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "file" || file) {
        stream.resume();
        return;
      }
      const chunks = [];
      file = { filename: info.filename, mimeType: info.mimeType, chunks };
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { exceeded = true; });
      stream.on("error", reject);
    });
    parser.on("error", reject);
    parser.on("finish", () => {
      if (exceeded) return reject(new WorkflowError("每次仅支持一个文件，大小不能超过 20MB", "UPLOAD_LIMIT", 413));
      if (!file) return reject(new Error("请选择需要上传的文件"));
      resolve({ filename: file.filename, mimeType: file.mimeType, buffer: Buffer.concat(file.chunks) });
    });
    request.on("aborted", () => reject(new Error("文件上传已中断")));
    request.pipe(parser);
  });
}

export function createApp({ summarize = summarizeContentDetailed } = {}) {
  const rateBuckets = new Map();
  return createServer(async (request, response) => {
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    const options = { signal: controller.signal };
    if (process.env.VERCEL || process.env.VERCEL_ENV) options.deadline = Date.now() + 50_000;
    try {
      const pathname = request.url.split("?")[0];
      if (request.method === "POST" && pathname.startsWith("/api/summarize/")) checkSummaryRateLimit(request, rateBuckets);
      if (pathname === "/api/health") {
        const config = resolveProviderConfig();
        return json(response, 200, {
          ok: true,
          provider: config.provider,
          model: config.model,
          modelConfigured: Boolean(config.apiKey),
          providers: {
            deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
            openai: Boolean(process.env.OPENAI_API_KEY)
          },
          youtube: {
            ...getYoutubeNetworkStatus(),
            transcriptProvider: resolveSupadataConfig().enabled ? "supadata" : "direct"
          }
        });
      }

      if (request.method === "POST" && pathname === "/api/summarize/text") {
        const payload = await body(request);
        const summaryMode = summaryModeFrom(request, payload);
        const text = normalizeText(payload.text || "");
        if (text.length < 80) return json(response, 400, { error: "内容太短，请至少输入 80 个字符" });
        if (text.length > 150_000) return json(response, 400, { error: "内容过长，请控制在 15 万字符以内" });
        const result = await summarize({
          text,
          title: payload.title,
          sourceType: "粘贴文本",
          summaryMode
        }, options);
        return json(response, 200, {
          summary: result.summary,
          meta: {
            trace: result.trace, grounding: result.grounding, sourceExcerpts: result.sourceExcerpts,
            title: payload.title?.trim() || "粘贴文本摘要",
            sourceType: "text",
            characters: text.length,
            summaryMode,
            readingMinutes: readingMinutes(text.length)
          }
        });
      }

      if (request.method === "POST" && pathname === "/api/summarize/youtube") {
        const payload = await body(request);
        const summaryMode = summaryModeFrom(request, payload);
        const videoId = extractVideoId(payload.url || "");
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache"
        });
        const send = (event) => response.write(`${JSON.stringify(event)}\n`);
        send({ stage: "captions" });
        const transcript = await fetchYoutubeTranscriptAuto(videoId, process.env, (stage) => send({ stage }), options);
        send({ stage: "summarizing" });
        send({ result: await summarizeYoutube(videoId, transcript, summaryMode, summarize, options) });
        return response.end();
      }

      if (request.method === "POST" && pathname === "/api/summarize/youtube-browser") {
        const payload = await body(request, 4_000_000);
        const summaryMode = summaryModeFrom(request, payload);
        const videoId = extractVideoId(payload.url || "");
        const transcript = await fetchYoutubeTranscriptFromBrowser(payload.source);
        if (transcript.videoId !== videoId) throw new Error("浏览器助手返回的视频与请求链接不一致");
        return json(response, 200, await summarizeYoutube(videoId, transcript, summaryMode, summarize, options));
      }

      if (request.method === "POST" && pathname === "/api/summarize/file-text") {
        const payload = await body(request);
        const summaryMode = summaryModeFrom(request, payload);
        const parsed = validateExtractedFileText(payload);
        return json(response, 200, await summarizeFileContent(parsed, summaryMode, summarize, options));
      }

      if (request.method === "POST" && pathname === "/api/summarize/file") {
        const summaryMode = summaryModeFrom(request);
        const upload = await uploadedFile(request);
        console.info(`[file] 上传完成: ${upload.buffer.length} bytes`);
        const parsed = await parseUploadedFile(upload);
        console.info(`[file] 解析完成: ${parsed.fileType}, ${parsed.text.length} 字符`);
        const result = await summarizeFileContent(parsed, summaryMode, summarize, options);
        console.info("[file] 摘要完成");
        return json(response, 200, result);
      }

      const staticPath = pathname === "/" ? "/index.html" : pathname;
      if (staticPath.includes("..")) return json(response, 400, { error: "无效路径" });
      const file = await readFile(join(root, "public", staticPath));
      response.writeHead(200, { "Content-Type": mimeTypes[extname(staticPath)] || "application/octet-stream" });
      response.end(file);
    } catch (error) {
      const badRequest = /有效|支持|太短|过长|超过|为空|上传|选择|配置|multipart/.test(error.message);
      const code = error.youtubeCode || (error instanceof WorkflowError ? error.code : undefined);
      const youtubeFailure = code?.startsWith("YOUTUBE_") || code?.startsWith("SUPADATA_");
      const unprocessable = new Set([
        "YOUTUBE_NO_CAPTIONS",
        "YOUTUBE_DURATION_LIMIT",
        "YOUTUBE_TRANSCRIPT_UNAVAILABLE"
      ]);
      const status = error.statusCode
        || (error.code === "ENOENT" ? 404
          : code === "YOUTUBE_VIDEO_UNAVAILABLE" ? 404
            : code === "SUPADATA_INVALID_REQUEST" ? 400
              : code === "SUPADATA_QUOTA_EXCEEDED" ? 402
              : code === "SUPADATA_NOT_CONFIGURED" || code === "SUPADATA_UNAUTHORIZED" ? 500
                : code === "SUPADATA_RATE_LIMITED" ? 503
                  : code === "SUPADATA_TIMEOUT" ? 504
                    : unprocessable.has(code) ? 422
                      : youtubeFailure ? 502
                        : badRequest ? 400
                          : 500);
      const payload = {
        error: status === 404 && !code ? "页面不存在" : error.message || "处理失败",
        ...(code ? { code } : {})
      };
      if (response.headersSent) {
        response.write(`${JSON.stringify(payload)}\n`);
        return response.end();
      }
      json(response, status, payload);
    }
  });
}

const app = createApp();
if (process.env.SIFT_TEST_MODE !== "1") app.listen(port, () => console.log(`Sift running at http://localhost:${port}`));
export default app;
