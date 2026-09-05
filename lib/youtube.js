function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function extractPlayerResponse(html) {
  const marker = "var ytInitialPlayerResponse = ";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("无法读取YouTube视频信息");
  const jsonStart = start + marker.length;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = jsonStart; index < html.length; index += 1) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return JSON.parse(html.slice(jsonStart, index + 1));
  }
  throw new Error("YouTube视频信息格式无法识别");
}

export async function fetchYoutubeTranscript(videoId) {
  let response;
  try {
    response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0 Sift/0.1", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error("无法连接 YouTube，请检查当前网络或代理设置");
  }
  if (!response.ok) throw new Error("无法访问YouTube视频");
  const player = extractPlayerResponse(await response.text());
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error("该视频没有可用的公开字幕");
  const track = tracks.find((item) => item.languageCode?.startsWith("zh")) || tracks.find((item) => item.languageCode === "en") || tracks[0];
  let transcriptResponse;
  try {
    transcriptResponse = await fetch(`${track.baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error("字幕下载超时，请稍后重试");
  }
  if (!transcriptResponse.ok) throw new Error("字幕下载失败");
  const transcript = await transcriptResponse.json();
  const segments = (transcript.events || []).flatMap((event) => {
    const text = event.segs?.map((segment) => segment.utf8).join("").replace(/\n/g, " ").trim();
    return text ? [{ text: decodeEntities(text), startMs: event.tStartMs || 0 }] : [];
  });
  return { title: player.videoDetails?.title, author: player.videoDetails?.author, language: track.languageCode, segments };
}
