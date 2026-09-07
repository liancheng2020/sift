const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  tabs: $$(".mode-button"),
  panels: $$(".input-panel"),
  status: $("#status"),
  empty: $("#empty-state"),
  digest: $("#digest"),
  digestContent: $("#digest-content"),
  resultActions: $("#result-actions"),
  text: $("#content-text"),
  title: $("#content-title"),
  url: $("#youtube-url"),
  fileInput: $("#content-file"),
  fileDrop: $("#file-drop"),
  fileSelection: $("#file-selection"),
  fileName: $("#file-name"),
  fileSize: $("#file-size"),
  count: $("#character-count"),
  system: $("#system-status"),
  systemLabel: $("#system-label"),
  summaryModes: $$("input[name='summary-mode']")
};

const sampleText = `过去一年，越来越多的软件团队开始把生成式人工智能接入研发流程。某技术团队对120名工程师进行了为期12周的内部实验，参与者可以在代码检索、测试生成和文档整理中使用AI助手。实验显示，重复性任务的平均完成时间下降了31%，但复杂故障的首次解决率只提升了8%。

负责人认为，效果差异主要来自工作流设计，而不是单纯更换模型。团队为高频任务建立了固定提示模板、工具权限和结果校验，同时要求涉及生产环境的操作必须经过人工审批。

报告也指出了三项风险：模型可能生成不存在的接口；上下文中可能包含客户信息；工程师过度依赖自动生成代码后，审查质量可能下降。因此团队没有把AI产出直接合并到主分支，而是将测试、静态检查和人工评审设为必经环节。

下一阶段，团队计划建立评测数据集，持续跟踪任务成功率、平均成本、工具调用失败率和人工返工时间，再决定是否扩大使用范围。`;

let latestResult = null;
let selectedFile = null;

function setMode(name) {
  elements.tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  elements.panels.forEach((panel) => {
    const active = panel.id === `${name}-form`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

elements.tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.tab)));

elements.text.addEventListener("input", () => {
  elements.count.textContent = `${elements.text.value.length.toLocaleString()} / 150,000`;
});

$("#sample-button").addEventListener("click", () => {
  elements.title.value = "AI 如何真正提升研发效率";
  elements.text.value = sampleText;
  elements.text.dispatchEvent(new Event("input"));
  elements.text.focus();
});

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileExtension(file) {
  return `.${file.name.split(".").pop()?.toLowerCase() || ""}`;
}

function selectFile(file) {
  selectedFile = file || null;
  const submit = $("#file-form button[type='submit']");
  elements.fileSelection.hidden = !selectedFile;
  elements.fileDrop.classList.toggle("has-file", Boolean(selectedFile));
  submit.disabled = !selectedFile;
  if (selectedFile) {
    elements.fileName.textContent = selectedFile.name;
    elements.fileSize.textContent = formatFileSize(selectedFile.size);
  }
}

elements.fileInput.addEventListener("change", () => selectFile(elements.fileInput.files?.[0]));
$("#clear-file").addEventListener("click", () => {
  elements.fileInput.value = "";
  selectFile(null);
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.fileDrop.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.fileDrop.classList.remove("dragging");
  });
}
elements.fileDrop.addEventListener("drop", (event) => selectFile(event.dataTransfer.files?.[0]));

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEmpty(message) {
  return create("p", "no-data", message);
}

function section(title, code, content) {
  const wrapper = create("section", "digest-section");
  const heading = create("div", "digest-section-heading");
  heading.append(create("span", "digest-number", code), create("h4", "", title));
  wrapper.append(heading, content);
  return wrapper;
}

function youtubeLink(meta, seconds) {
  return meta.sourceType === "youtube" && meta.videoId && Number.isInteger(seconds)
    ? `https://youtu.be/${encodeURIComponent(meta.videoId)}?t=${seconds}`
    : "";
}

function renderEvidence(evidence, meta) {
  const details = create("details", "evidence");
  details.append(create("summary", "", `查看依据 · ${evidence.locator}`));
  const body = create("div", "evidence-body");
  body.append(create("blockquote", "", evidence.quote));
  const link = youtubeLink(meta, evidence.seconds);
  if (link) {
    const jump = create("a", "evidence-jump", "从该时间播放 ↗");
    jump.href = link;
    jump.target = "_blank";
    jump.rel = "noreferrer";
    body.append(jump);
  }
  details.append(body);
  return details;
}

function renderKeyPoints(items, meta) {
  const list = create("div", "key-point-list");
  items.forEach((item, index) => {
    const card = create("article", "key-point-card");
    const heading = create("div", "key-point-heading");
    heading.append(create("span", "list-index", String(index + 1).padStart(2, "0")), create("h5", "", item.title));
    card.append(heading, create("p", "", item.summary), renderEvidence(item.evidence, meta));
    list.append(card);
  });
  return list;
}

function renderKeyData(items, meta) {
  const grid = create("div", "data-grid");
  items.forEach((item) => {
    const card = create("article", "data-card");
    card.append(
      create("span", "", item.label),
      create("strong", "", item.value),
      create("p", "", item.context),
      renderEvidence(item.evidence, meta)
    );
    grid.append(card);
  });
  return grid;
}

function renderGroundedList(items, meta, describe, extra) {
  const list = create("div", "grounded-list");
  items.forEach((item) => {
    const card = create("article", "grounded-card");
    card.append(create("p", "", describe(item)));
    const tags = extra?.(item)?.filter(Boolean) || [];
    if (tags.length) {
      const metaRow = create("div", "action-meta");
      tags.forEach((tag) => metaRow.append(create("span", "", tag)));
      card.append(metaRow);
    }
    card.append(renderEvidence(item.evidence, meta));
    list.append(card);
  });
  return list;
}

function renderOutline(items, meta) {
  const list = create("div", "timeline-list");
  items.forEach((item, index) => {
    const link = youtubeLink(meta, item.seconds);
    const row = create(link ? "a" : "div", "timeline-row");
    if (link) {
      row.href = link;
      row.target = "_blank";
      row.rel = "noreferrer";
    }
    const marker = create("div", "timeline-marker");
    marker.append(create("span", "", String(index + 1).padStart(2, "0")), create("i"));
    const content = create("div", "timeline-content");
    const title = create("div", "timeline-title");
    title.append(create("strong", "", item.title), create("span", "", item.locator));
    content.append(title, create("p", "", item.summary));
    row.append(marker, content);
    list.append(row);
  });
  return list;
}

function normalizeSummaryForView(value) {
  const summary = value && typeof value === "object" ? value : {};
  if (summary.overview && Array.isArray(summary.keyPoints)) return summary;

  const anchors = Array.isArray(summary.sourceAnchors) ? summary.sourceAnchors : [];
  const evidenceFor = (index, quote) => {
    const anchor = anchors[index] || anchors[0] || {};
    return {
      locator: anchor.locator || "旧版摘要",
      seconds: Number.isInteger(anchor.seconds) ? anchor.seconds : null,
      quote: String(quote || anchor.label || "旧版接口未返回原文引文").slice(0, 160)
    };
  };
  const coreContent = Array.isArray(summary.coreContent) ? summary.coreContent : [];
  const viewpoints = Array.isArray(summary.viewpoints) ? summary.viewpoints : [];
  return {
    overview: {
      oneLiner: summary.conclusion || "接口返回了旧版摘要，请重启服务后重新生成。",
      topic: "兼容旧版输出"
    },
    keyPoints: [
      ...coreContent.map((item, index) => ({
        title: `重点 ${index + 1}`,
        summary: item,
        evidence: evidenceFor(index, item)
      })),
      ...viewpoints.map((item, index) => ({
        title: item.statement || `观点 ${index + 1}`,
        summary: item.reason || item.statement,
        evidence: evidenceFor(coreContent.length + index, item.reason || item.statement)
      }))
    ].slice(0, 8),
    keyData: (Array.isArray(summary.keyData) ? summary.keyData : []).map((item, index) => ({
      label: item.label,
      value: item.value,
      context: item.context || "",
      evidence: evidenceFor(index, item.context || `${item.label}：${item.value}`)
    })),
    decisions: [],
    actionItems: [],
    risks: (Array.isArray(summary.risks) ? summary.risks : []).map((item, index) => ({
      description: item,
      evidence: evidenceFor(index, item)
    })),
    outline: anchors.map((item) => ({
      title: item.label || "原文定位",
      summary: item.label || "",
      locator: item.locator,
      seconds: Number.isInteger(item.seconds) ? item.seconds : null
    }))
  };
}

function renderDigest(data) {
  const { summary: rawSummary, meta = {} } = data;
  const summary = normalizeSummaryForView(rawSummary);
  latestResult = { ...data, summary };
  $("#source-badge").textContent = meta.sourceType === "youtube" ? "YOUTUBE" : meta.sourceType === "file" ? meta.fileType || "FILE" : "TEXT";
  $("#digest-title").textContent = meta.title || "内容摘要";
  const extractionLabels = {
    storyboard_ocr: "画面字幕识别",
    browser_captions: "浏览器字幕",
    browser_storyboard_ocr: "浏览器画面识别",
    supadata_native: "云端字幕",
    supadata_auto: "AI 语音转写"
  };
  const extractionLabel = extractionLabels[meta.extractionMethod];
  const modeLabels = { concise: "简洁摘要", standard: "标准摘要", deep: "深度摘要" };
  const duration = meta.sourceType === "youtube" && meta.sourceMinutes
    ? `约 ${meta.sourceMinutes} 分钟视频`
    : meta.readingMinutes ? `约 ${meta.readingMinutes} 分钟阅读` : "";
  const metaParts = [
    meta.author,
    meta.fileType,
    meta.language?.toUpperCase(),
    extractionLabel,
    modeLabels[meta.summaryMode],
    duration,
    `${Number(meta.characters || 0).toLocaleString()} 字符`
  ].filter(Boolean);
  $("#digest-meta").textContent = metaParts.join(" / ");
  elements.digestContent.replaceChildren();

  const conclusion = create("blockquote", "conclusion");
  const signalTop = create("div", "conclusion-top");
  signalTop.append(create("span", "", "ONE-LINE SIGNAL"), create("b", "", summary.overview.topic));
  conclusion.append(signalTop, create("p", "", summary.overview.oneLiner));
  elements.digestContent.append(conclusion);

  let sectionIndex = 1;
  const appendSection = (title, items, renderer) => {
    if (!items?.length) return;
    elements.digestContent.append(section(title, String(sectionIndex++).padStart(2, "0"), renderer(items, meta)));
  };
  appendSection("重点摘要", summary.keyPoints, renderKeyPoints);
  appendSection("关键数据", summary.keyData, renderKeyData);
  appendSection("已做决定", summary.decisions, (items) => renderGroundedList(items, meta, (item) => item.statement));
  appendSection("后续行动", summary.actionItems, (items) => renderGroundedList(
    items,
    meta,
    (item) => item.task,
    (item) => [item.owner && `负责人：${item.owner}`, item.deadline && `期限：${item.deadline}`]
  ));
  appendSection("风险与限制", summary.risks, (items) => renderGroundedList(items, meta, (item) => item.description));
  appendSection(meta.sourceType === "youtube" ? "视频时间轴" : "内容脉络", summary.outline, renderOutline);

  elements.empty.hidden = true;
  elements.digest.hidden = false;
  elements.resultActions.hidden = false;
}

function summaryToMarkdown({ summary, meta = {} }) {
  const lines = [`# ${meta.title || "内容摘要"}`, "", `> ${summary.overview.oneLiner}`, "", `主题：${summary.overview.topic}`, ""];
  const evidence = (item) => `（依据：${item.evidence.locator}「${item.evidence.quote}」）`;
  const addList = (title, items, formatter = (item) => item) => {
    if (items?.length) lines.push(`## ${title}`, "", ...items.map((item) => `- ${formatter(item)}`), "");
  };
  addList("重点摘要", summary.keyPoints, (item) => `**${item.title}**：${item.summary} ${evidence(item)}`);
  addList("关键数据", summary.keyData, (item) => `**${item.label}：${item.value}** — ${item.context} ${evidence(item)}`);
  addList("已做决定", summary.decisions, (item) => `${item.statement} ${evidence(item)}`);
  addList("后续行动", summary.actionItems, (item) => `${item.task}${item.owner ? `；负责人：${item.owner}` : ""}${item.deadline ? `；期限：${item.deadline}` : ""} ${evidence(item)}`);
  addList("风险与限制", summary.risks, (item) => `${item.description} ${evidence(item)}`);
  addList(meta.sourceType === "youtube" ? "视频时间轴" : "内容脉络", summary.outline, (item) => `**${item.locator} ${item.title}**：${item.summary}`);
  return lines.join("\n");
}

function setFeedback(type, message) {
  elements.status.hidden = false;
  elements.status.className = `feedback ${type}`;
  elements.status.replaceChildren();
  if (type === "loading") {
    elements.status.append(create("span", "loading-pulse"), create("div", "", message));
  } else {
    elements.status.append(create("strong", "", type === "error" ? "分析未完成" : "处理完成"), create("p", "", message));
  }
}

async function parseApiResponse(response) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) {
    const error = new Error(
      data?.error
        || (response.status === 413
          ? "文件超过平台上传限制，请选择更小的文件"
          : `服务暂时不可用（HTTP ${response.status}），请稍后重试`)
    );
    error.code = data?.code;
    throw error;
  }
  if (!data) throw new Error("服务返回了无法识别的响应");
  return data;
}

function selectedSummaryMode() {
  return elements.summaryModes.find((input) => input.checked)?.value || "standard";
}

function requestHeaders(summaryMode, json = true) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "X-Sift-Summary-Mode": summaryMode
  };
}

async function summarizePdfLocally(file, summaryMode) {
  setFeedback("loading", "正在浏览器中解析 PDF，文件不会上传到服务器……");
  const { extractPdfText } = await import("/pdf-parser.js");
  const text = await extractPdfText(file, ({ page, total }) => {
    setFeedback("loading", `正在浏览器中解析 PDF（${page}/${total} 页）……`);
  });
  setFeedback("loading", "PDF 解析完成，正在生成结构化摘要……");
  return parseApiResponse(await fetch("/api/summarize/file-text", {
    method: "POST",
    headers: requestHeaders(summaryMode),
    body: JSON.stringify({ filename: file.name, fileType: "PDF", text, summaryMode })
  }));
}

function requestBrowserYoutubeSource(url) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let acknowledged = false;
    const detectionTimer = setTimeout(() => {
      if (!acknowledged) finish(reject, new Error("Vercel 出口已被 YouTube 限制，且未检测到 Sift Browser Helper。请先安装仓库 browser-helper 目录中的浏览器助手。"));
    }, 2_000);
    const operationTimer = setTimeout(() => {
      finish(reject, new Error("浏览器读取 YouTube 超时，请检查当前网络后重试。"));
    }, 45_000);
    function finish(callback, value) {
      clearTimeout(detectionTimer);
      clearTimeout(operationTimer);
      window.removeEventListener("message", receive);
      callback(value);
    }
    function receive(event) {
      const message = event.data;
      if (event.source !== window || event.origin !== location.origin || message?.source !== "sift-browser-helper" || message.requestId !== requestId) return;
      if (message.type === "SIFT_HELPER_ACK") {
        acknowledged = true;
        clearTimeout(detectionTimer);
        return;
      }
      if (message.error) finish(reject, new Error(message.error));
      else finish(resolve, message.payload);
    }
    window.addEventListener("message", receive);
    window.postMessage({ source: "sift-page", type: "SIFT_EXTRACT_YOUTUBE", requestId, url }, location.origin);
  });
}

const YOUTUBE_STAGE_MESSAGES = {
  captions: "正在读取视频字幕……",
  transcribing: "未发现公开字幕，正在生成语音转写，长视频可能需要几分钟……",
  summarizing: "正在生成结构化摘要……"
};

async function postYoutubeSummary(url, summaryMode) {
  const response = await fetch("/api/summarize/youtube", {
    method: "POST",
    headers: requestHeaders(summaryMode),
    body: JSON.stringify({ url, summaryMode })
  });
  if (!(response.headers.get("content-type") || "").includes("x-ndjson")) {
    return parseApiResponse(response);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let failure = null;
  const handleLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.stage && YOUTUBE_STAGE_MESSAGES[event.stage]) {
      setFeedback("loading", YOUTUBE_STAGE_MESSAGES[event.stage]);
    } else if (event.error) {
      failure = Object.assign(new Error(event.error), { code: event.code });
    } else if (event.result) {
      result = event.result;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(handleLine);
  }
  handleLine(buffer);
  if (failure) throw failure;
  if (!result) throw new Error("服务返回了无法识别的响应");
  return result;
}

async function recoverYoutubeWithBrowser(error, url, summaryMode) {
  const recoverable = new Set(["YOUTUBE_BLOCKED", "YOUTUBE_INVALID_CLOUD_PROXY", "YOUTUBE_NETWORK_ERROR", "YOUTUBE_RUNTIME_ERROR"]);
  if (!recoverable.has(error.code)) throw error;
  setFeedback("loading", "云端访问 YouTube 受限，正在尝试通过本机浏览器读取内容……");
  const source = await requestBrowserYoutubeSource(url);
  setFeedback("loading", "浏览器读取完成，正在生成结构化摘要……");
  return parseApiResponse(await fetch("/api/summarize/youtube-browser", {
    method: "POST",
    headers: requestHeaders(summaryMode),
    body: JSON.stringify({ url, source, summaryMode })
  }));
}

async function submitSummary({ form, endpoint, payload, requestBody, perform, recover }) {
  const button = form.querySelector("button[type='submit']");
  const label = button.querySelector(".button-label");
  const idleLabel = label.textContent;
  const summaryMode = selectedSummaryMode();
  button.disabled = true;
  elements.summaryModes.forEach((input) => { input.disabled = true; });
  label.textContent = "正在分析内容";
  elements.empty.hidden = true;
  elements.digest.hidden = true;
  elements.resultActions.hidden = true;
  setFeedback("loading", "正在读取来源并构建结构化摘要，长内容可能需要一些时间……");
  try {
    let data;
    try {
      data = perform ? await perform(summaryMode) : await parseApiResponse(await fetch(endpoint, {
        method: "POST",
        ...(requestBody
          ? { headers: requestHeaders(summaryMode, false), body: requestBody }
          : { headers: requestHeaders(summaryMode), body: JSON.stringify({ ...payload, summaryMode }) })
      }));
    } catch (error) {
      if (!recover) throw error;
      data = await recover(error, summaryMode);
    }
    elements.status.hidden = true;
    renderDigest(data);
    if (window.matchMedia("(max-width: 820px)").matches) {
      $(".result-column").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    elements.empty.hidden = false;
    setFeedback("error", error.message || "处理失败，请稍后重试。");
  } finally {
    button.disabled = false;
    elements.summaryModes.forEach((input) => { input.disabled = false; });
    label.textContent = idleLabel;
  }
}

$("#youtube-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = elements.url.value.trim();
  submitSummary({
    form: event.currentTarget,
    perform: (summaryMode) => postYoutubeSummary(url, summaryMode),
    recover: (error, summaryMode) => recoverYoutubeWithBrowser(error, url, summaryMode)
  });
});

$("#file-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selectedFile) {
    setFeedback("error", "请先选择需要分析的文件。");
    return;
  }
  if (selectedFile.size > 20 * 1024 * 1024) {
    setFeedback("error", "文件超过 20MB 限制。");
    return;
  }
  const extension = fileExtension(selectedFile);
  if (extension !== ".pdf" && selectedFile.size > 4 * 1024 * 1024) {
    setFeedback("error", "Vercel 在线版的 Word/TXT/Markdown 文件请控制在 4MB 以内。");
    return;
  }
  const formData = new FormData();
  formData.append("file", selectedFile);
  submitSummary({
    form: event.currentTarget,
    ...(extension === ".pdf"
      ? { perform: (summaryMode) => summarizePdfLocally(selectedFile, summaryMode) }
      : { endpoint: "/api/summarize/file", requestBody: formData })
  });
});

$("#text-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (elements.text.value.trim().length < 80) {
    setFeedback("error", "内容太短，请至少输入 80 个字符。");
    return;
  }
  submitSummary({
    form: event.currentTarget,
    endpoint: "/api/summarize/text",
    payload: { title: elements.title.value.trim(), text: elements.text.value }
  });
});

$("#copy-button").addEventListener("click", async (event) => {
  if (!latestResult) return;
  await navigator.clipboard.writeText(summaryToMarkdown(latestResult));
  const previous = event.currentTarget.textContent;
  event.currentTarget.textContent = "已复制";
  setTimeout(() => { event.currentTarget.textContent = previous; }, 1600);
});

$("#download-button").addEventListener("click", () => {
  if (!latestResult) return;
  const blob = new Blob([summaryToMarkdown(latestResult)], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${(latestResult.meta?.title || "sift-digest").replace(/[\\/:*?"<>|]/g, "-")}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    elements.system.classList.add(data.modelConfigured ? "online" : "warning");
    const provider = data.provider === "deepseek" ? "DeepSeek" : "OpenAI";
    elements.systemLabel.textContent = data.modelConfigured ? `${provider} 在线` : `等待 ${provider} API Key`;
  } catch {
    elements.system.classList.add("offline");
    elements.systemLabel.textContent = "服务连接失败";
  }
}

checkHealth();
