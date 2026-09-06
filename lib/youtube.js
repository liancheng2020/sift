import youtubeDl from "youtube-dl-exec";
import { ProxyAgent } from "undici";

const LANGUAGE_PRIORITY = ["zh-Hans", "zh-CN", "zh", "zh-TW", "en"];
const MAX_STORYBOARD_IMAGES = 20;
const YOUTUBE_ANDROID_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 30,
  hl: "zh-CN",
  gl: "US"
};
const YOUTUBE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
};
const dispatchers = new Map();

function configuredYoutubeProxy(env) {
  return (env.YOUTUBE_PROXY_URL || env.HTTPS_PROXY || env.HTTP_PROXY || "").trim();
}

function isVercelRuntime(env) {
  return env.VERCEL === "1" || Boolean(env.VERCEL_ENV);
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function parseJsonObjectAt(source, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return JSON.parse(source.slice(start, index + 1));
  }
  throw new Error("YouTube 页面中的视频信息不完整");
}

export function extractYoutubePlayerResponse(html) {
  const markers = ["var ytInitialPlayerResponse =", "ytInitialPlayerResponse =", '"ytInitialPlayerResponse":'];
  for (const marker of markers) {
    let markerIndex = html.indexOf(marker);
    while (markerIndex >= 0) {
      const objectStart = html.indexOf("{", markerIndex + marker.length);
      if (objectStart < 0) break;
      try {
        return parseJsonObjectAt(html, objectStart);
      } catch {
        markerIndex = html.indexOf(marker, markerIndex + marker.length);
      }
    }
  }
  throw new Error("无法从 YouTube 页面读取视频信息");
}

export function parsePlayerStoryboards(player) {
  const spec = player.storyboards?.playerStoryboardSpecRenderer?.spec;
  const duration = Number(player.videoDetails?.lengthSeconds || 0);
  if (!spec || !duration) return [];

  const [urlTemplate, ...levels] = spec.split("|");
  return levels.flatMap((level, levelIndex) => {
    const [width, height, imageCount, columns, rows, , nameTemplate, signature] = level.split("#");
    const count = Number(imageCount);
    const columnCount = Number(columns);
    const rowCount = Number(rows);
    const imagesPerFragment = columnCount * rowCount;
    if (!Number(width) || !Number(height) || !count || !imagesPerFragment || !nameTemplate || !signature) return [];

    const frameDuration = duration / count;
    const fragmentCount = Math.ceil(count / imagesPerFragment);
    const fragments = Array.from({ length: fragmentCount }, (_, fragmentIndex) => {
      const frames = Math.min(imagesPerFragment, count - fragmentIndex * imagesPerFragment);
      const imageName = nameTemplate.replace(/\$M/g, String(fragmentIndex));
      let url = urlTemplate
        .replace(/\$L/g, String(levelIndex))
        .replace(/\$N/g, imageName);
      const encodedSignature = encodeURIComponent(signature);
      url = url.includes("$S")
        ? url.replace(/\$S/g, encodedSignature)
        : `${url}${url.includes("?") ? "&" : "?"}sigh=${encodedSignature}`;
      return { url, duration: frameDuration * frames };
    });

    return [{
      format_note: "storyboard",
      width: Number(width),
      height: Number(height),
      columns: columnCount,
      rows: rowCount,
      fragments
    }];
  });
}

export function playerResponseToMetadata(player) {
  const subtitles = {};
  const automaticCaptions = {};
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  for (const track of tracks) {
    if (!track.baseUrl || !track.languageCode) continue;
    const target = track.kind === "asr" ? automaticCaptions : subtitles;
    const separator = track.baseUrl.includes("?") ? "&" : "?";
    target[track.languageCode] ||= [];
    target[track.languageCode].push({
      ext: "json3",
      url: `${track.baseUrl}${separator}fmt=json3`
    });
  }
  return {
    title: player.videoDetails?.title,
    channel: player.videoDetails?.author,
    language: tracks[0]?.languageCode,
    subtitles,
    automatic_captions: automaticCaptions,
    formats: parsePlayerStoryboards(player)
  };
}

export function resolveYoutubeNetworkConfig(env = process.env) {
  const configuredProxy = configuredYoutubeProxy(env);
  const vercel = isVercelRuntime(env);
  if (!configuredProxy) {
    return {
      proxyUrl: "",
      proxyConfigured: false,
      proxyIgnored: false,
      runtime: vercel ? "vercel" : "local"
    };
  }

  let parsed;
  try {
    parsed = new URL(configuredProxy);
  } catch {
    throw new Error("YOUTUBE_PROXY_URL 配置无效，必须填写完整的 HTTP(S) 代理地址");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("YOUTUBE_PROXY_URL 目前仅支持 HTTP(S) 代理");
  }

  const proxyIgnored = vercel && isLoopbackHostname(parsed.hostname);
  return {
    proxyUrl: proxyIgnored ? "" : configuredProxy,
    proxyConfigured: true,
    proxyIgnored,
    runtime: vercel ? "vercel" : "local"
  };
}

export function resolveYoutubeProxy(env = process.env) {
  return resolveYoutubeNetworkConfig(env).proxyUrl;
}

export function getYoutubeNetworkStatus(env = process.env) {
  try {
    const network = resolveYoutubeNetworkConfig(env);
    return {
      runtime: network.runtime,
      proxyConfigured: network.proxyConfigured,
      proxyActive: Boolean(network.proxyUrl),
      warning: network.proxyIgnored
        ? "Vercel 无法访问 127.0.0.1/localhost 代理，当前将尝试直连 YouTube"
        : null
    };
  } catch (error) {
    return {
      runtime: isVercelRuntime(env) ? "vercel" : "local",
      proxyConfigured: Boolean(configuredYoutubeProxy(env)),
      proxyActive: false,
      warning: error.message
    };
  }
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

async function fetchYoutubeResource(url, network, timeout = 20000) {
  const attempts = network.proxyUrl ? [network.proxyUrl, ""] : [""];
  const failures = [];
  for (const proxyUrl of attempts) {
    try {
      const response = await fetch(url, {
        dispatcher: proxyDispatcher(proxyUrl),
        headers: YOUTUBE_HEADERS,
        signal: AbortSignal.timeout(timeout)
      });
      if (response.ok) return response;
      failures.push(new Error(`HTTP ${response.status}`));
    } catch (error) {
      failures.push(error);
    }
  }
  throw youtubeError(new Error(failures.map((error) => error.message).join("; ")), network);
}

async function downloadStoryboardImages(fragments, network) {
  return Promise.all(fragments.map(async (fragment) => {
    const response = await fetchYoutubeResource(fragment.url, network);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 2_000_000) throw new Error("单张画面字幕素材超过 2MB 限制");
    return {
      ...fragment,
      mimeType: response.headers.get("content-type")?.split(";")[0] || "image/webp",
      buffer
    };
  }));
}

async function fetchStoryboardTranscript(metadata, env, network) {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("该视频没有公开字幕；配置 DEEPSEEK_API_KEY 后可尝试识别画面字幕");
  }
  const format = selectStoryboardFormat(metadata);
  if (!format) throw new Error("该视频没有公开字幕，也没有可用于画面识别的故事板");

  const fragments = sampledStoryboardFragments(format);
  const images = await downloadStoryboardImages(fragments, network);

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

function createYoutubeError(message, code) {
  const error = new Error(message);
  error.youtubeCode = code;
  return error;
}

function youtubeError(error, network = {}) {
  if (error.youtubeCode) return error;
  const detail = [error?.message, error?.stderr].filter(Boolean).join(" ");
  if (/no subtitles|subtitles are disabled|transcript is disabled/i.test(detail)) {
    return createYoutubeError("该视频没有可用的公开字幕", "YOUTUBE_NO_CAPTIONS");
  }
  if (/sign in|confirm you.re not a bot|cookies/i.test(detail)) {
    return createYoutubeError(
      network.runtime === "vercel"
        ? "YouTube 限制了 Vercel 的出口网络，请配置公网可访问的 HTTP(S) 代理；127.0.0.1 代理在线上不可用"
        : "YouTube 拒绝了字幕请求，请更换代理节点或稍后重试",
      "YOUTUBE_BLOCKED"
    );
  }
  if (network.proxyIgnored) {
    return createYoutubeError(
      "Vercel 无法访问 YOUTUBE_PROXY_URL 中的 127.0.0.1/localhost；已忽略该代理并尝试直连，但仍未能读取 YouTube。请删除该变量或改用公网 HTTP(S) 代理后重新部署",
      "YOUTUBE_INVALID_CLOUD_PROXY"
    );
  }
  if (/HTTP (403|429)|too many requests|forbidden/i.test(detail)) {
    return createYoutubeError(
      network.runtime === "vercel"
        ? "YouTube 拒绝了 Vercel 出口请求，请配置公网可访问的 HTTP(S) 代理后重新部署"
        : "YouTube 暂时限制了当前网络，请稍后重试或更换代理节点",
      "YOUTUBE_RATE_LIMITED"
    );
  }
  if (/timeout|timed out|connect|network|socket|unable to download|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|proxy|tunnel/i.test(detail)) {
    return createYoutubeError(
      network.proxyUrl
        ? "公网代理无法连接 YouTube，请检查代理地址、认证信息和可用性"
        : network.runtime === "vercel"
          ? "Vercel 暂时无法直连 YouTube，请配置公网可访问的 HTTP(S) 代理后重新部署"
          : "服务端无法连接 YouTube；浏览器代理不会自动作用于 Node，请配置 YOUTUBE_PROXY_URL",
      "YOUTUBE_NETWORK_ERROR"
    );
  }
  if (/ENOENT|EACCES|spawn/i.test(detail)) {
    return createYoutubeError("当前运行环境无法执行 yt-dlp，请检查部署产物和执行权限", "YOUTUBE_RUNTIME_ERROR");
  }
  return createYoutubeError(
    network.runtime === "vercel"
      ? "Vercel 暂时无法读取 YouTube 字幕；请检查函数日志，或配置公网 HTTP(S) 代理后重试"
      : "暂时无法读取 YouTube 字幕，请稍后重试",
    "YOUTUBE_UNKNOWN_ERROR"
  );
}

function sanitizedErrorDetail(error, network) {
  const fields = [error?.code, error?.exitCode, error?.message, error?.stderr].filter(Boolean);
  let detail = fields.join(" ");
  if (network.proxyUrl) detail = detail.replaceAll(network.proxyUrl, "[proxy]");
  return detail
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/g, "https://***:***@")
    .slice(0, 1200) || "no error details";
}

async function fetchYoutubePageMetadata(videoId, network) {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=zh-CN`;
  const response = await fetchYoutubeResource(url, network);
  const html = await response.text();
  return playerResponseToMetadata(extractYoutubePlayerResponse(html));
}

async function fetchYoutubePlayerMetadata(videoId, network) {
  const attempts = network.proxyUrl ? [network.proxyUrl, ""] : [""];
  const failures = [];
  for (const proxyUrl of attempts) {
    try {
      const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        dispatcher: proxyDispatcher(proxyUrl),
        headers: {
          ...YOUTUBE_HEADERS,
          "Content-Type": "application/json",
          "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
        },
        body: JSON.stringify({
          context: { client: YOUTUBE_ANDROID_CLIENT },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`InnerTube HTTP ${response.status}`);
      const player = await response.json();
      if (player.playabilityStatus?.status !== "OK" || !player.videoDetails) {
        throw new Error(player.playabilityStatus?.reason || "InnerTube 未返回可用的视频信息");
      }
      return playerResponseToMetadata(player);
    } catch (error) {
      failures.push(error);
    }
  }
  throw youtubeError(new Error(failures.map((error) => error.message).join("; ")), network);
}

function hasTranscriptSource(metadata) {
  return Boolean(selectCaptionTrack(metadata) || selectStoryboardFormat(metadata));
}

async function fetchYoutubeMetadata(videoId, network) {
  const attempts = network.proxyUrl ? [network.proxyUrl, ""] : [""];
  const failures = [];
  for (const proxyUrl of attempts) {
    try {
      const metadata = await youtubeDl(`https://www.youtube.com/watch?v=${videoId}`, {
        dumpSingleJson: true,
        skipDownload: true,
        noPlaylist: true,
        noWarnings: true,
        socketTimeout: 20,
        retries: 1,
        proxy: proxyUrl || undefined
      });
      return { metadata, network: { ...network, proxyUrl } };
    } catch (error) {
      failures.push(error);
    }
  }

  console.warn(
    "[youtube] yt-dlp metadata failed; falling back to page parsing:",
    failures.map((error) => sanitizedErrorDetail(error, network)).join(" | ")
  );
  try {
    const metadata = await fetchYoutubePageMetadata(videoId, network);
    if (hasTranscriptSource(metadata)) return { metadata, network };
    console.warn("[youtube] watch page metadata has no captions or storyboards; trying InnerTube");
  } catch (error) {
    console.error("[youtube] page metadata fallback failed:", sanitizedErrorDetail(error, network));
    failures.push(error);
  }

  try {
    const metadata = await fetchYoutubePlayerMetadata(videoId, network);
    return { metadata, network };
  } catch (error) {
    console.error("[youtube] InnerTube metadata fallback failed:", sanitizedErrorDetail(error, network));
    failures.push(error);
  }

  const combinedError = new Error(failures.map((error) => error.message || error.stderr).join("; "));
  throw youtubeError(combinedError, network);
}

export async function fetchYoutubeTranscript(videoId, env = process.env) {
  const configuredNetwork = resolveYoutubeNetworkConfig(env);
  const { metadata, network } = await fetchYoutubeMetadata(videoId, configuredNetwork);

  const track = selectCaptionTrack(metadata);
  if (!track) {
    const storyboard = await fetchStoryboardTranscript(metadata, env, network);
    return {
      title: metadata.title,
      author: metadata.channel || metadata.uploader,
      ...storyboard
    };
  }
  const response = await fetchYoutubeResource(track.url, network);

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
