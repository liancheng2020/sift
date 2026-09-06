import test from "node:test";
import assert from "node:assert/strict";
import {
  extractYoutubePlayerResponse,
  getYoutubeNetworkStatus,
  parseJson3Transcript,
  parsePlayerStoryboards,
  playerResponseToMetadata,
  resolveYoutubeNetworkConfig,
  resolveYoutubeProxy,
  selectCaptionTrack,
  selectStoryboardFormat,
  storyboardOcrToSegments
} from "../lib/youtube.js";

test("resolveYoutubeProxy prefers the dedicated YouTube proxy", () => {
  assert.equal(resolveYoutubeProxy({
    YOUTUBE_PROXY_URL: "http://127.0.0.1:1087",
    HTTPS_PROXY: "http://127.0.0.1:9999"
  }), "http://127.0.0.1:1087");
  assert.equal(resolveYoutubeProxy({ HTTPS_PROXY: "http://127.0.0.1:1087" }), "http://127.0.0.1:1087");
});

test("Vercel ignores loopback proxies and reports a warning", () => {
  const env = { VERCEL: "1", YOUTUBE_PROXY_URL: "http://127.0.0.1:1087" };
  assert.deepEqual(resolveYoutubeNetworkConfig(env), {
    proxyUrl: "",
    proxyConfigured: true,
    proxyIgnored: true,
    runtime: "vercel"
  });
  assert.equal(getYoutubeNetworkStatus(env).proxyActive, false);
  assert.match(getYoutubeNetworkStatus(env).warning, /Vercel 无法访问/);
});

test("Vercel accepts a publicly reachable HTTP proxy", () => {
  const config = resolveYoutubeNetworkConfig({
    VERCEL_ENV: "production",
    YOUTUBE_PROXY_URL: "https://user:password@proxy.example.com:8443"
  });
  assert.equal(config.proxyUrl, "https://user:password@proxy.example.com:8443");
  assert.equal(config.proxyIgnored, false);
  assert.equal(config.runtime, "vercel");
});

test("rejects unsupported YouTube proxy protocols", () => {
  assert.throws(
    () => resolveYoutubeNetworkConfig({ YOUTUBE_PROXY_URL: "socks5://127.0.0.1:1080" }),
    /仅支持 HTTP\(S\) 代理/
  );
});

test("extractYoutubePlayerResponse reads balanced JSON from the watch page", () => {
  const player = {
    videoDetails: { title: "包含 { 大括号 } 的标题", author: "测试频道" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } }
  };
  const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`;
  assert.deepEqual(extractYoutubePlayerResponse(html), player);
});

test("playerResponseToMetadata separates manual and automatic captions", () => {
  const metadata = playerResponseToMetadata({
    videoDetails: { title: "测试视频", author: "测试频道" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "zh-CN", baseUrl: "https://example.com/manual?lang=zh-CN" },
          { languageCode: "en", baseUrl: "https://example.com/auto?lang=en", kind: "asr" }
        ]
      }
    }
  });
  assert.equal(metadata.title, "测试视频");
  assert.equal(metadata.channel, "测试频道");
  assert.equal(metadata.subtitles["zh-CN"][0].url, "https://example.com/manual?lang=zh-CN&fmt=json3");
  assert.equal(metadata.automatic_captions.en[0].url, "https://example.com/auto?lang=en&fmt=json3");
});

test("parsePlayerStoryboards creates timed fragments from the watch page spec", () => {
  const formats = parsePlayerStoryboards({
    videoDetails: { lengthSeconds: "1902" },
    storyboards: {
      playerStoryboardSpecRenderer: {
        spec: "https://i.ytimg.com/storyboard_L$L/$N.jpg?sigh=$S|320#180#192#3#3#10000#M$M#signature"
      }
    }
  });
  assert.equal(formats.length, 1);
  assert.equal(formats[0].width, 320);
  assert.equal(formats[0].fragments.length, 22);
  assert.equal(formats[0].fragments[0].url, "https://i.ytimg.com/storyboard_L0/M0.jpg?sigh=signature");
  assert.equal(formats[0].fragments[0].duration, 89.15625);
  assert.equal(formats[0].fragments[21].duration, 29.71875);
});

test("parsePlayerStoryboards appends signatures used by Android player responses", () => {
  const formats = parsePlayerStoryboards({
    videoDetails: { lengthSeconds: "100" },
    storyboards: {
      playerStoryboardSpecRenderer: {
        spec: "https://i.ytimg.com/sb/video/storyboard3_L$L/$N.jpg?sqp=value==|160#90#25#5#5#10000#M$M#rs$signature"
      }
    }
  });
  assert.equal(
    formats[0].fragments[0].url,
    "https://i.ytimg.com/sb/video/storyboard3_L0/M0.jpg?sqp=value==&sigh=rs%24signature"
  );
});

test("selectCaptionTrack prefers Chinese JSON3 subtitles", () => {
  const selected = selectCaptionTrack({
    subtitles: {
      en: [{ ext: "json3", url: "https://example.com/en" }],
      "zh-CN": [{ ext: "vtt", url: "https://example.com/zh-vtt" }, { ext: "json3", url: "https://example.com/zh" }]
    }
  });
  assert.equal(selected.language, "zh-CN");
  assert.equal(selected.url, "https://example.com/zh");
});

test("selectCaptionTrack prefers the video's original language", () => {
  const selected = selectCaptionTrack({
    language: "en",
    subtitles: {
      "zh-CN": [{ ext: "json3", url: "https://example.com/zh" }],
      en: [{ ext: "json3", url: "https://example.com/en" }]
    }
  });
  assert.equal(selected.language, "en");
  assert.equal(selected.url, "https://example.com/en");
});

test("selectCaptionTrack falls back to automatic captions", () => {
  const selected = selectCaptionTrack({
    automatic_captions: { en: [{ ext: "json3", url: "https://example.com/auto" }] }
  });
  assert.equal(selected.language, "en");
  assert.equal(selected.url, "https://example.com/auto");
});

test("parseJson3Transcript keeps text and timestamps", () => {
  assert.deepEqual(parseJson3Transcript({
    events: [
      { tStartMs: 1200, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
      { tStartMs: 2400 },
      { tStartMs: 3600, segs: [{ utf8: "A &amp; B\n" }] }
    ]
  }), [
    { text: "Hello world", startMs: 1200 },
    { text: "A & B", startMs: 3600 }
  ]);
});

test("selectStoryboardFormat chooses the highest resolution storyboard", () => {
  const selected = selectStoryboardFormat({ formats: [
    { format_note: "storyboard", width: 160, fragments: [{ url: "small" }] },
    { format_note: "video", width: 1920, fragments: [{ url: "video" }] },
    { format_note: "storyboard", width: 320, fragments: [{ url: "large" }] }
  ] });
  assert.equal(selected.width, 320);
});

test("storyboardOcrToSegments converts slide and frame into timestamps", () => {
  const fragments = [
    { startSeconds: 0, duration: 90 },
    { startSeconds: 90, duration: 90 }
  ];
  assert.deepEqual(storyboardOcrToSegments(fragments, [
    { slide: 1, frame: 2, text: " 第一条 " },
    { slide: 2, frame: 4, text: "第二条" },
    { slide: 2, frame: 5, text: "第二条" }
  ], 9), [
    { text: "第一条", startMs: 20000 },
    { text: "第二条", startMs: 130000 }
  ]);
});
