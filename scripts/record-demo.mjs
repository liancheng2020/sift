// Real production workflow. Consumes configured transcript/model quota once.
// npm install && npx playwright install chromium && node scripts/record-demo.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const site = "https://sift-navy-six.vercel.app/";
const source = process.argv[2] || "https://www.youtube.com/watch?v=hwP7WQkmECE";
const output = fileURLToPath(new URL("../docs/media/", import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), "sift-recording-"));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.RECORDING_BROWSER ? { executablePath: process.env.RECORDING_BROWSER } : {}), ...(process.env.RECORDING_PROXY ? { proxy: { server: process.env.RECORDING_PROXY } } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: scratch, size: { width: 1440, height: 1000 } }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const video = page.video();
let completed = false;
try {
  await page.goto(site, { waitUntil: "networkidle" });
  const caption = async text => {
    console.log(text);
    await page.evaluate(text => {
      let el = document.getElementById("recording-caption");
      if (!el) { el = document.createElement("div"); el.id = "recording-caption"; document.body.append(el); }
      el.textContent = text;
      el.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:9999;background:#172b25f5;color:#e3fff2;border:1px solid #8bbba5;border-radius:12px;padding:12px 24px;font:600 18px/1.5 'Segoe UI',sans-serif;pointer-events:none;width:max-content;max-width:95vw";
    }, text);
    await delay(2500);
  };
  await caption("01 / Sift 线上实录：把 YouTube 视频整理成有依据的中文摘要");
  await page.locator("#youtube-url").fill(source);
  await page.locator('label:has(input[name="summary-mode"][value="concise"])').click();
  assert.ok(await page.locator('input[value="concise"]').isChecked());
  await caption("02 / 粘贴公开视频链接，选择简洁摘要，启动内容分析");
  await page.locator('#youtube-form button[type="submit"]').click();
  const started = Date.now();
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (await page.locator("#digest").isVisible()) { ready = true; break; }
    const message = await page.locator("#status").textContent();
    if (i % 10 === 0) console.log("Progress: " + message);
    if (await page.locator('#youtube-form button[type="submit"]').isEnabled()) throw new Error("Analysis ended without result: " + message);
    await delay(2000);
  }
  assert.ok(ready, "YouTube summary must finish within five minutes");
  console.log("Actual processing seconds: " + ((Date.now() - started) / 1000).toFixed(1));
  console.log("Video title: " + await page.locator("#digest-title").innerText());
  console.log("Source metadata: " + await page.locator("#digest-meta").innerText());
  assert.equal(await page.locator("#source-badge").innerText(), "YOUTUBE");
  await page.locator("#digest").evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 30));
  await caption("03 / 真实解析结果：一句话结论、重点摘要与原文依据");
  await page.screenshot({ path: path.join(output, "sift-youtube-poster.png") });
  await delay(3500);
  await page.locator("#digest-content").evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top + 500));
  await caption("04 / 查看结构化重点；带时间定位的信息可回到原视频核验");
  await page.locator("#digest-content").evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().bottom - 850));
  await delay(3500);
  await page.locator("#download-button").scrollIntoViewIfNeeded();
  await caption("05 / 一键导出 Markdown，保存到自己的笔记或知识库");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download-button").click();
  const download = await downloadEvent;
  const downloaded = path.join(scratch, "summary.md");
  await download.saveAs(downloaded);
  assert.ok((await readFile(downloaded, "utf8")).length > 200, "Exported summary is non-empty");
  await caption("Sift · YouTube / 文档 / 文本 → 结构化摘要 · 重要信息请核对原文");
  completed = true;
} finally {
  await context.close();
  try {
    if (completed) await video.saveAs(path.join(output, "sift-youtube-demo.webm"));
  } finally {
    await browser.close();
    console.log("Raw recording and export retained at " + scratch);
  }
}
