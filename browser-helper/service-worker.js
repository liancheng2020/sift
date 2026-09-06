const LANGUAGE_PRIORITY = ["zh-Hans", "zh-CN", "zh", "zh-TW", "en"];
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 750_000;
// Base64 adds roughly 33%, so keep the JSON request below Vercel's body limit.
const MAX_TOTAL_BYTES = 2_700_000;

function extractVideoId(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0];
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(hostname)) throw new Error("只允许读取 YouTube 链接");
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?]+)/);
  if (!match?.[1]) throw new Error("无法识别 YouTube 视频 ID");
  return match[1];
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

function extractPlayerResponse(html) {
  for (const marker of ["var ytInitialPlayerResponse =", "ytInitialPlayerResponse =", '"ytInitialPlayerResponse":']) {
    let markerIndex = html.indexOf(marker);
    while (markerIndex >= 0) {
      const objectStart = html.indexOf("{", markerIndex + marker.length);
      if (objectStart < 0) break;
      try { return parseJsonObjectAt(html, objectStart); } catch { markerIndex = html.indexOf(marker, markerIndex + marker.length); }
    }
  }
  throw new Error("无法从 YouTube 页面读取视频信息");
}

function decodeEntities(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function selectCaptionTrack(player) {
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  for (const language of LANGUAGE_PRIORITY) {
    const track = tracks.find((item) => item.languageCode?.toLowerCase() === language.toLowerCase());
    if (track?.baseUrl) return track;
  }
  return tracks.find((track) => track.baseUrl) || null;
}

function parseTranscript(transcript) {
  return (transcript.events || []).flatMap((event) => {
    const text = event.segs?.map((segment) => segment.utf8).join("").replace(/\n/g, " ").trim();
    return text ? [{ text: decodeEntities(text), startMs: event.tStartMs || 0 }] : [];
  });
}

function parseStoryboards(player) {
  const spec = player.storyboards?.playerStoryboardSpecRenderer?.spec;
  const duration = Number(player.videoDetails?.lengthSeconds || 0);
  if (!spec || !duration) return [];
  const [urlTemplate, ...levels] = spec.split("|");
  return levels.flatMap((level, levelIndex) => {
    const [width, height, imageCount, columns, rows, , nameTemplate, signature] = level.split("#");
    const count = Number(imageCount);
    const perImage = Number(columns) * Number(rows);
    if (!Number(width) || !Number(height) || !count || !perImage || !nameTemplate || !signature) return [];
    const frameDuration = duration / count;
    let startSeconds = 0;
    const fragments = Array.from({ length: Math.ceil(count / perImage) }, (_, index) => {
      const frames = Math.min(perImage, count - index * perImage);
      let url = urlTemplate.replace(/\$L/g, String(levelIndex)).replace(/\$N/g, nameTemplate.replace(/\$M/g, String(index)));
      const encodedSignature = encodeURIComponent(signature);
      url = url.includes("$S") ? url.replace(/\$S/g, encodedSignature) : `${url}${url.includes("?") ? "&" : "?"}sigh=${encodedSignature}`;
      const fragment = { url, startSeconds, duration: frameDuration * frames };
      startSeconds += fragment.duration;
      return fragment;
    });
    return [{ width: Number(width), height: Number(height), columns: Number(columns), rows: Number(rows), fragments }];
  });
}

function selectStoryboard(player) {
  const formats = parseStoryboards(player);
  return formats
    .filter((format) => format.fragments.length <= MAX_IMAGES)
    .sort((left, right) => right.width - left.width)[0]
    || formats.sort((left, right) => left.fragments.length - right.fragments.length || right.width - left.width)[0];
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function downloadStoryboards(format) {
  const fragments = format.fragments.length <= MAX_IMAGES
    ? format.fragments
    : Array.from({ length: MAX_IMAGES }, (_, index) => format.fragments[Math.round(index * (format.fragments.length - 1) / (MAX_IMAGES - 1))]);
  let totalBytes = 0;
  const images = [];
  for (const fragment of fragments) {
    const response = await fetch(fragment.url, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`读取 YouTube 故事板失败（HTTP ${response.status}）`);
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("单张 YouTube 故事板图片过大");
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("YouTube 故事板图片总大小超过限制");
    images.push({
      startSeconds: fragment.startSeconds,
      duration: fragment.duration,
      mimeType: response.headers.get("content-type")?.split(";")[0] || "image/webp",
      data: bytesToBase64(buffer)
    });
  }
  return { rows: format.rows, columns: format.columns, images };
}

async function extractYoutubeSource(url) {
  const videoId = extractVideoId(url);
  if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("YouTube 视频 ID 无效");
  const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=zh-CN`, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`浏览器读取 YouTube 失败（HTTP ${response.status}）`);
  const player = extractPlayerResponse(await response.text());
  if (player.playabilityStatus?.status !== "OK") throw new Error(player.playabilityStatus?.reason || "当前视频不可读取");
  const common = { videoId, title: player.videoDetails?.title, author: player.videoDetails?.author };
  const track = selectCaptionTrack(player);
  if (track) {
    const separator = track.baseUrl.includes("?") ? "&" : "?";
    const transcriptResponse = await fetch(`${track.baseUrl}${separator}fmt=json3`, { credentials: "include", cache: "no-store" });
    if (transcriptResponse.ok) {
      const segments = parseTranscript(await transcriptResponse.json());
      if (segments.length) return { ...common, language: track.languageCode, segments };
    }
  }
  const storyboard = selectStoryboard(player);
  if (!storyboard) throw new Error("视频没有公开字幕，也没有可读取的故事板");
  return { ...common, language: "zh", storyboard: await downloadStoryboards(storyboard) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SIFT_EXTRACT_YOUTUBE") return false;
  extractYoutubeSource(message.url)
    .then((payload) => sendResponse({ payload }))
    .catch((error) => sendResponse({ error: error.message || "浏览器读取 YouTube 失败" }));
  return true;
});
