import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { extractVideoId, normalizeText, numberParagraphs, transcriptToTimedText } from "./lib/content.js";
import { MAX_FILE_SIZE, parseUploadedFile, validateExtractedFileText } from "./lib/file.js";
import { resolveProviderConfig, summarizeContent } from "./lib/summarize.js";
import { resolveSupadataConfig } from "./lib/supadata.js";
import { fetchYoutubeTranscriptAuto, fetchYoutubeTranscriptFromBrowser, getYoutubeNetworkStatus } from "./lib/youtube.js";

process.on("unhandledRejection", (reason) => {
  console.error("[sift] unhandled rejection:", reason instanceof Error ? reason.stack || reason.message : String(reason));
});
process.on("uncaughtException", (error) => {
  console.error("[sift] uncaught exception:", error.stack || error.message);
});

const port = Number(process.env.PORT || 3000);
const MAX_VIDEO_DURATION_MS = Math.max(1, Number(process.env.YOUTUBE_MAX_DURATION_MINUTES || 60)) * 60_000;
const YOUTUBE_RATE_LIMIT_MAX = Math.max(1, Number(process.env.YOUTUBE_RATE_LIMIT_MAX || 12));
const YOUTUBE_RATE_WINDOW_MS = Math.max(1000, Number(process.env.YOUTUBE_RATE_WINDOW_MS || 600_000));
const youtubeRateBuckets = new Map();
const root = fileURLToPath(new URL(".", import.meta.url));
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8"
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
    if (size > maxBytes) throw new Error(`请求内容超过 ${Math.round(maxBytes / 1_000_000)}MB 限制`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

function codedError(message, code) {
  const error = new Error(message);
  error.youtubeCode = code;
  return error;
}

function checkYoutubeRateLimit(request) {
  const ip = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (youtubeRateBuckets.get(ip) || []).filter((time) => now - time < YOUTUBE_RATE_WINDOW_MS);
  if (recent.length >= YOUTUBE_RATE_LIMIT_MAX) {
    const error = new Error("请求过于频繁，请稍后再试");
    error.statusCode = 429;
    throw error;
  }
  recent.push(now);
  youtubeRateBuckets.set(ip, recent);
  if (youtubeRateBuckets.size > 5000) youtubeRateBuckets.clear();
}

async function summarizeYoutube(videoId, transcript) {
  if (!transcript.segments.length) throw new Error("该视频没有可用字幕或画面文字");
  const lastSegment = transcript.segments[transcript.segments.length - 1];
  if (lastSegment?.startMs > MAX_VIDEO_DURATION_MS) {
    throw codedError(
      `视频时长超过 ${Math.round(MAX_VIDEO_DURATION_MS / 60_000)} 分钟上限，请选择更短的视频`,
      "YOUTUBE_DURATION_LIMIT"
    );
  }
  const text = transcriptToTimedText(transcript.segments);
  const visualTranscript = transcript.extractionMethod?.includes("storyboard_ocr");
  let summary;
  try {
    summary = await summarizeContent({
      text,
      title: transcript.title || `YouTube ${videoId}`,
      sourceType: visualTranscript ? "YouTube 画面字幕" : "YouTube 字幕"
    });
  } catch (error) {
    throw codedError(`模型摘要失败：${error.message}`, "SUMMARY_FAILED");
  }
  return {
    summary,
    meta: {
      title: transcript.title,
      author: transcript.author,
      language: transcript.language,
      sourceType: "youtube",
      videoId,
      extractionMethod: transcript.extractionMethod,
      characters: text.length
    }
  };
}

async function summarizeFileContent({ filename, fileType, text }) {
  const summary = await summarizeContent({
    text: numberParagraphs(text),
    title: filename,
    sourceType: `${fileType} 文件`
  });
  return {
    summary,
    meta: {
      title: filename,
      sourceType: "file",
      fileType,
      characters: text.length
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
      limits: { files: 1, fileSize: MAX_FILE_SIZE }
    });
    } catch {
      reject(new Error("请使用 multipart/form-data 上传文件"));
      return;
    }

    let file = null;
    let exceeded = false;
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
      if (exceeded) return reject(new Error("文件超过 20MB 限制"));
      if (!file) return reject(new Error("请选择需要上传的文件"));
      resolve({ filename: file.filename, mimeType: file.mimeType, buffer: Buffer.concat(file.chunks) });
    });
    request.on("aborted", () => reject(new Error("文件上传已中断")));
    request.pipe(parser);
  });
}

createServer(async (request, response) => {
  try {
    const pathname = request.url.split("?")[0];
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
      const text = normalizeText(payload.text || "");
      if (text.length < 80) return json(response, 400, { error: "内容太短，请至少输入 80 个字符" });
      if (text.length > 150_000) return json(response, 400, { error: "内容过长，请控制在 15 万字符以内" });
      const summary = await summarizeContent({ text: numberParagraphs(text), title: payload.title, sourceType: "粘贴文本" });
      return json(response, 200, {
        summary,
        meta: { title: payload.title?.trim() || "粘贴文本摘要", sourceType: "text", characters: text.length }
      });
    }

    if (request.method === "POST" && pathname === "/api/summarize/youtube") {
      checkYoutubeRateLimit(request);
      const payload = await body(request);
      const videoId = extractVideoId(payload.url || "");
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      const send = (event) => response.write(`${JSON.stringify(event)}\n`);
      send({ stage: "captions" });
      const transcript = await fetchYoutubeTranscriptAuto(videoId, process.env, (stage) => send({ stage }));
      send({ stage: "summarizing" });
      send({ result: await summarizeYoutube(videoId, transcript) });
      return response.end();
    }

    if (request.method === "POST" && pathname === "/api/summarize/youtube-browser") {
      checkYoutubeRateLimit(request);
      const payload = await body(request, 4_000_000);
      const videoId = extractVideoId(payload.url || "");
      const transcript = await fetchYoutubeTranscriptFromBrowser(payload.source);
      if (transcript.videoId !== videoId) throw new Error("浏览器助手返回的视频与请求链接不一致");
      return json(response, 200, await summarizeYoutube(videoId, transcript));
    }

    if (request.method === "POST" && pathname === "/api/summarize/file-text") {
      const payload = await body(request);
      const parsed = validateExtractedFileText(payload);
      return json(response, 200, await summarizeFileContent(parsed));
    }

    if (request.method === "POST" && pathname === "/api/summarize/file") {
      const upload = await uploadedFile(request);
      console.info(`[file] 上传完成: ${upload.buffer.length} bytes`);
      const parsed = await parseUploadedFile(upload);
      console.info(`[file] 解析完成: ${parsed.fileType}, ${parsed.text.length} 字符`);
      const result = await summarizeFileContent(parsed);
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
    const code = error.youtubeCode;
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
}).listen(port, () => console.log(`Sift running at http://localhost:${port}`));
