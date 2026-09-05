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

export function chunkText(input, maxLength = 12000) {
  const text = normalizeText(input);
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = "";
  for (const paragraph of text.split(/\n\n+/)) {
    if (paragraph.length > maxLength) {
      if (current) chunks.push(current);
      for (let index = 0; index < paragraph.length; index += maxLength) chunks.push(paragraph.slice(index, index + maxLength));
      current = "";
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength) { chunks.push(current); current = paragraph; } else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks;
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
