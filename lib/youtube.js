import youtubeDl from "youtube-dl-exec";
import { ProxyAgent } from "undici";

const LANGUAGE_PRIORITY = ["zh-Hans", "zh-CN", "zh", "zh-TW", "en"];
const MAX_STORYBOARD_IMAGES = 20;
const dispatchers = new Map();

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function resolveYoutubeProxy(env = process.env) {
  return env.YOUTUBE_PROXY_URL || env.HTTPS_PROXY || env.HTTP_PROXY || "";
}

function proxyDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!dispatchers.has(proxyUrl)) dispatchers.set(proxyUrl, new ProxyAgent(proxyUrl));
  return dispatchers.get(proxyUrl);
}

function tracksForLanguage(source, language) {
  if (source?.[language]?.length) return source[language];
  const matchingKey = Object.keys(source || {}).find((key) => key.toLowerCase() === language.toLowerCase());
  return matchingKey ? source[matchingKey] : null;
}

export function selectCaptionTrack(metadata) {
  const sources = [metadata.subtitles, metadata.automatic_captions];
  const languages = [...new Set([metadata.language, ...LANGUAGE_PRIORITY].filter(Boolean))];
  for (const language of languages) {
    for (const source of sources) {
      const tracks = tracksForLanguage(source, language);
      const track = tracks?.find((item) => item.ext === "json3");
      if (track?.url) return { ...track, language };
    }
  }

  for (const source of sources) {
    for (const [language, tracks] of Object.entries(source || {})) {
      const track = tracks.find((item) => item.ext === "json3");
      if (track?.url) return { ...track, language };
    }
  }
  return null;
}

export function parseJson3Transcript(transcript) {
  return (transcript.events || []).flatMap((event) => {
    const text = event.segs?.map((segment) => segment.utf8).join("").replace(/\n/g, " ").trim();
    return text ? [{ text: decodeEntities(text), startMs: event.tStartMs || 0 }] : [];
  });
}

export function selectStoryboardFormat(metadata) {
  return (metadata.formats || [])
    .filter((format) => format.format_note === "storyboard" && format.fragments?.length)
    .sort((left, right) => (right.width || 0) - (left.width || 0))[0] || null;
}

function sampledStoryboardFragments(format) {
  const fragments = format.fragments.map((fragment, index) => ({
    ...fragment,
    originalIndex: index,
    startSeconds: format.fragments.slice(0, index).reduce((total, item) => total + Number(item.duration || 0), 0)
  }));
  if (fragments.length <= MAX_STORYBOARD_IMAGES) return fragments;
  return Array.from({ length: MAX_STORYBOARD_IMAGES }, (_, index) => {
    const sourceIndex = Math.round(index * (fragments.length - 1) / (MAX_STORYBOARD_IMAGES - 1));
    return fragments[sourceIndex];
  });
}

export function storyboardOcrToSegments(fragments, ocrSegments, frameCount) {
  const seen = new Set();
  return (ocrSegments || []).flatMap((segment) => {
    const fragment = fragments[Number(segment.slide) - 1];
    const text = String(segment.text || "").replace(/\s+/g, " ").trim();
    if (!fragment || !text || seen.has(text)) return [];
    seen.add(text);
    const frame = Math.max(0, Math.min(frameCount - 1, Number(segment.frame) || 0));
    const startSeconds = fragment.startSeconds + frame * Number(fragment.duration || 0) / frameCount;
    return [{ text, startMs: Math.round(startSeconds * 1000) }];
  });
}

function deepSeekResponsesEndpoint(env) {
  if (env.DEEPSEEK_RESPONSES_URL) return env.DEEPSEEK_RESPONSES_URL;
  const base = (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com")
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|responses)$/, "");
  return `${base}/responses`;
}

async function downloadStoryboardImages(fragments, proxyUrl) {
  return Promise.all(fragments.map(async (fragment) => {
    const response = await fetch(fragment.url, {
      dispatcher: proxyDispatcher(proxyUrl),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`画面字幕素材下载失败（HTTP ${response.status}）`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 2_000_000) throw new Error("单张画面字幕素材超过 2MB 限制");
    return {
      ...fragment,
      mimeType: response.headers.get("content-type")?.split(";")[0] || "image/webp",
      buffer
    };
  }));
}

async function fetchStoryboardTranscript(metadata, env, proxyUrl) {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("该视频没有公开字幕；配置 DEEPSEEK_API_KEY 后可尝试识别画面字幕");
  }
  const format = selectStoryboardFormat(metadata);
  if (!format) throw new Error("该视频没有公开字幕，也没有可用于画面识别的故事板");

  const fragments = sampledStoryboardFragments(format);
  let images;
  try {
    images = await downloadStoryboardImages(fragments, proxyUrl);
  } catch (error) {
    throw youtubeError(error, proxyUrl);
  }

  const rows = Number(format.rows || 1);
  const columns = Number(format.columns || 1);
  const frameCount = rows * columns;
  const content = [{
    type: "input_text",
    text: `以下是一个没有公开字幕的 YouTube 视频故事板，共 ${images.length} 张。每张图由 ${columns} 列 × ${rows} 行画面组成，frame 按从左到右、从上到下编号 0-${frameCount - 1}。只识别画面底部清晰可见的字幕；连续重复内容去重，不要猜测看不清的文字。返回 JSON。`
  }];
  images.forEach((image, index) => {
    content.push({
      type: "input_text",
      text: `slide=${index + 1}, startSeconds=${Math.round(image.startSeconds)}`
    }, {
      type: "input_image",
      detail: "original",
      image_url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`
    });
  });

  let response;
  try {
    response = await fetch(deepSeekResponsesEndpoint(env), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: env.DEEPSEEK_VISION_MODEL || "deepseek-v4-flash-vision-exp",
        input: [{ role: "user", content }],
        reasoning: { effort: "none" },
        text: {
          format: {
            type: "json_schema",
            name: "storyboard_transcript",
            schema: {
              type: "object",
              properties: {
                segments: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      slide: { type: "integer" },
                      frame: { type: "integer" },
                      text: { type: "string" }
                    },
                    required: ["slide", "frame", "text"],
                    additionalProperties: false
                  }
                }
              },
              required: ["segments"],
              additionalProperties: false
            }
          }
        },
        max_output_tokens: 12000,
        temperature: 0.1
      }),
      signal: AbortSignal.timeout(120000)
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("画面字幕识别超时，请稍后重试");
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `画面字幕识别失败（HTTP ${response.status}）`);
  const output = data.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("画面字幕识别返回了无法解析的结果");
  }
  const segments = storyboardOcrToSegments(fragments, result.segments, frameCount);
  if (!segments.length) throw new Error("该视频没有公开字幕，画面中也未识别到清晰文字");
  return { language: "zh", segments, extractionMethod: "storyboard_ocr" };
}

function youtubeError(error, proxyUrl) {
  const detail = [error?.message, error?.stderr].filter(Boolean).join(" ");
  if (/no subtitles|subtitles are disabled|transcript is disabled/i.test(detail)) {
    return new Error("该视频没有可用的公开字幕");
  }
  if (/sign in|confirm you.re not a bot|cookies/i.test(detail)) {
    return new Error("YouTube 拒绝了字幕请求，请更换代理节点或稍后重试");
  }
  if (/timeout|timed out|connect|network|socket|unable to download/i.test(detail)) {
    return new Error(proxyUrl
      ? "通过代理连接 YouTube 失败，请确认代理端口仍然可用"
      : "服务端无法连接 YouTube；浏览器代理不会自动作用于 Node，请配置 YOUTUBE_PROXY_URL");
  }
  return new Error("暂时无法读取 YouTube 字幕，请稍后重试");
}

export async function fetchYoutubeTranscript(videoId, env = process.env) {
  const proxyUrl = resolveYoutubeProxy(env);
  let metadata;
  try {
    metadata = await youtubeDl(`https://www.youtube.com/watch?v=${videoId}`, {
      dumpSingleJson: true,
      skipDownload: true,
      noPlaylist: true,
      noWarnings: true,
      proxy: proxyUrl || undefined
    });
  } catch (error) {
    throw youtubeError(error, proxyUrl);
  }

  const track = selectCaptionTrack(metadata);
  if (!track) {
    const storyboard = await fetchStoryboardTranscript(metadata, env, proxyUrl);
    return {
      title: metadata.title,
      author: metadata.channel || metadata.uploader,
      ...storyboard
    };
  }
  let response;
  try {
    response = await fetch(track.url, {
      dispatcher: proxyDispatcher(proxyUrl),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    throw youtubeError(error, proxyUrl);
  }
  if (!response.ok) throw new Error(`字幕下载失败（HTTP ${response.status}）`);

  const raw = await response.text();
  if (!raw.trim()) throw new Error("YouTube 返回了空字幕，请更换代理节点或稍后重试");

  let transcript;
  try {
    transcript = JSON.parse(raw);
  } catch {
    throw new Error("YouTube 返回了无法识别的字幕格式");
  }

  return {
    title: metadata.title,
    author: metadata.channel || metadata.uploader,
    language: track.language,
    segments: parseJson3Transcript(transcript),
    extractionMethod: "captions"
  };
}
