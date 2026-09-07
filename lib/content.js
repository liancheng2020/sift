const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

export function extractVideoId(input) {
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error("请输入有效的 YouTube 视频链接"); }
  if (!YOUTUBE_HOSTS.has(url.hostname)) throw new Error("目前仅支持 YouTube 链接");
  const videoId = url.hostname === "youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]
    : url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) throw new Error("无法从链接中识别视频 ID");
  return videoId;
}

export function normalizeText(input) {
  return input.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function splitLongUnit(unit, maxLength) {
  if (unit.length <= maxLength) return [unit];
  const sentences = unit.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [unit];
  const parts = [];
  let current = "";
  const pushRaw = (value) => {
    for (let index = 0; index < value.length; index += maxLength) {
      parts.push(value.slice(index, index + maxLength));
    }
  };
  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      if (current) parts.push(current);
      pushRaw(sentence);
      current = "";
      continue;
    }
    if (current && current.length + sentence.length > maxLength) {
      parts.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function chunkSourceText(input, { maxLength = 12000, sourceType = "text" } = {}) {
  const text = normalizeText(input);
  if (!text || text.length <= maxLength) return text ? [text] : [];
  const lineAware = sourceType === "youtube" || /^\[\d{1,2}:\d{2}(?::\d{2})?\]/m.test(text);
  const separator = lineAware ? "\n" : "\n\n";
  const units = text.split(lineAware ? /\n+/ : /\n\n+/).flatMap((unit) => splitLongUnit(unit, maxLength));
  const chunks = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}${separator}${unit}` : unit;
    if (candidate.length > maxLength) {
      if (current) chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function chunkText(input, maxLength = 12000) {
  return chunkSourceText(input, { maxLength });
}

export function transcriptToText(items) {
  return normalizeText(items.map((item) => item.text).join(" "));
}

export function formatTimestamp(startMs = 0) {
  const totalSeconds = Math.max(0, Math.floor(startMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteValue = hours ? String(minutes).padStart(2, "0") : String(minutes);
  return hours
    ? `${hours}:${minuteValue}:${String(seconds).padStart(2, "0")}`
    : `${minuteValue}:${String(seconds).padStart(2, "0")}`;
}

export function transcriptToTimedText(items) {
  return normalizeText(
    items.map((item) => `[${formatTimestamp(item.startMs)}] ${item.text}`).join("\n")
  );
}

export function numberParagraphs(input) {
  return normalizeText(input)
    .split(/\n\n+/)
    .map((paragraph, index) => `[段落 ${index + 1}] ${paragraph}`)
    .join("\n\n");
}
