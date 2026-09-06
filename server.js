import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { extractVideoId, normalizeText, numberParagraphs, transcriptToTimedText } from "./lib/content.js";
import { MAX_FILE_SIZE, parseUploadedFile } from "./lib/file.js";
import { resolveProviderConfig, summarizeContent } from "./lib/summarize.js";
import { fetchYoutubeTranscript, getYoutubeNetworkStatus } from "./lib/youtube.js";

const port = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL(".", import.meta.url));
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("请求内容超过 2MB 限制");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

function uploadedFile(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: request.headers, limits: { files: 1, fileSize: MAX_FILE_SIZE } });
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
        youtube: getYoutubeNetworkStatus()
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
      const payload = await body(request);
      const videoId = extractVideoId(payload.url || "");
      const transcript = await fetchYoutubeTranscript(videoId);
      if (!transcript.segments.length) return json(response, 422, { error: "该视频没有可用字幕" });
      const text = transcriptToTimedText(transcript.segments);
      const visualTranscript = transcript.extractionMethod === "storyboard_ocr";
      const summary = await summarizeContent({
        text,
        title: transcript.title || `YouTube ${videoId}`,
        sourceType: visualTranscript ? "YouTube 画面字幕" : "YouTube 字幕"
      });
      return json(response, 200, {
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
      });
    }

    if (request.method === "POST" && pathname === "/api/summarize/file") {
      const upload = await uploadedFile(request);
      const parsed = await parseUploadedFile(upload);
      const summary = await summarizeContent({
        text: numberParagraphs(parsed.text),
        title: parsed.filename,
        sourceType: `${parsed.fileType} 文件`
      });
      return json(response, 200, {
        summary,
        meta: {
          title: parsed.filename,
          sourceType: "file",
          fileType: parsed.fileType,
          characters: parsed.text.length
        }
      });
    }

    const staticPath = pathname === "/" ? "/index.html" : pathname;
    if (staticPath.includes("..")) return json(response, 400, { error: "无效路径" });
    const file = await readFile(join(root, "public", staticPath));
    response.writeHead(200, { "Content-Type": mimeTypes[extname(staticPath)] || "application/octet-stream" });
    response.end(file);
  } catch (error) {
    const badRequest = /有效|支持|太短|过长|超过|为空|上传|选择|配置|multipart/.test(error.message);
    const youtubeFailure = error.youtubeCode?.startsWith("YOUTUBE_");
    const status = error.code === "ENOENT"
      ? 404
      : error.youtubeCode === "YOUTUBE_NO_CAPTIONS"
        ? 422
        : youtubeFailure
          ? 502
          : badRequest
            ? 400
            : 500;
    json(response, status, {
      error: status === 404 ? "页面不存在" : error.message || "处理失败",
      ...(error.youtubeCode ? { code: error.youtubeCode } : {})
    });
  }
}).listen(port, () => console.log(`Sift running at http://localhost:${port}`));
