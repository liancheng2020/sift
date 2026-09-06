import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJson3Transcript,
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
