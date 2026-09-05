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
  systemLabel: $("#system-label")
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

function renderStringList(items, emptyMessage) {
  if (!items?.length) return renderEmpty(emptyMessage);
  const list = create("ol", "signal-list");
  items.forEach((item, index) => {
    const row = create("li");
    row.append(create("span", "list-index", String(index + 1).padStart(2, "0")), create("p", "", item));
    list.append(row);
  });
  return list;
}

function renderEntities(items) {
  if (!items?.length) return renderEmpty("没有识别到需要单独列出的公司、行业或人物。");
  const grid = create("div", "entity-grid");
  items.forEach((item) => {
    const card = create("article", "entity-card");
    const top = create("div", "entity-top");
    top.append(create("strong", "", item.name), create("span", "", item.type || "实体"));
    card.append(top, create("p", "", item.context));
    grid.append(card);
  });
  return grid;
}

function renderKeyData(items) {
  if (!items?.length) return renderEmpty("原文没有包含影响结论的关键数据。");
  const grid = create("div", "data-grid");
  items.forEach((item) => {
    const card = create("article", "data-card");
    card.append(create("span", "", item.label), create("strong", "", item.value), create("p", "", item.context));
    grid.append(card);
  });
  return grid;
}

function renderViewpoints(items) {
  if (!items?.length) return renderEmpty("原文没有提出需要展开的重要观点。");
  const list = create("div", "viewpoint-list");
  items.forEach((item) => {
    const card = create("article", "viewpoint-card");
    card.append(create("strong", "", item.statement), create("p", "", item.reason));
    list.append(card);
  });
  return list;
}

function renderAnchors(items, meta) {
  if (!items?.length) return renderEmpty("当前摘要没有返回可用的原文定位。");
  const list = create("div", "anchor-list");
  items.forEach((item) => {
    const tag = meta.sourceType === "youtube" && Number.isInteger(item.seconds) && meta.videoId ? "a" : "div";
    const row = create(tag, "anchor-row");
    if (tag === "a") {
      row.href = `https://youtu.be/${encodeURIComponent(meta.videoId)}?t=${item.seconds}`;
      row.target = "_blank";
      row.rel = "noreferrer";
    }
    row.append(create("span", "anchor-locator", item.locator), create("p", "", item.label), create("span", "anchor-arrow", tag === "a" ? "↗" : "•"));
    list.append(row);
  });
  return list;
}

function renderDigest(data) {
  latestResult = data;
  const { summary, meta = {} } = data;
  $("#source-badge").textContent = meta.sourceType === "youtube" ? "YOUTUBE" : meta.sourceType === "file" ? meta.fileType || "FILE" : "TEXT";
  $("#digest-title").textContent = meta.title || "内容摘要";
  const metaParts = [meta.author, meta.fileType, meta.language?.toUpperCase(), `${Number(meta.characters || 0).toLocaleString()} 字符`].filter(Boolean);
  $("#digest-meta").textContent = metaParts.join(" / ");
  elements.digestContent.replaceChildren();

  const conclusion = create("blockquote", "conclusion");
  conclusion.append(create("span", "", "ONE-LINE SIGNAL"), create("p", "", summary.conclusion || "暂未生成有效结论。"));
  elements.digestContent.append(
    conclusion,
    section("核心内容", "01", renderStringList(summary.coreContent, "没有提取到核心内容。")),
    section("涉及的公司、行业和人物", "02", renderEntities(summary.entities)),
    section("关键数据", "03", renderKeyData(summary.keyData)),
    section("重要观点及理由", "04", renderViewpoints(summary.viewpoints)),
    section("风险或争议", "05", renderStringList(summary.risks, "原文没有明确提出风险或争议。")),
    section("原文定位", "06", renderAnchors(summary.sourceAnchors, meta))
  );

  elements.empty.hidden = true;
  elements.digest.hidden = false;
  elements.resultActions.hidden = false;
}

function summaryToMarkdown({ summary, meta = {} }) {
  const lines = [`# ${meta.title || "内容摘要"}`, "", `> ${summary.conclusion || "暂未生成有效结论。"}`, ""];
  const addList = (title, items, formatter = (item) => item) => {
    lines.push(`## ${title}`, "", ...(items?.length ? items.map((item) => `- ${formatter(item)}`) : ["- 无"]), "");
  };
  addList("核心内容", summary.coreContent);
  addList("涉及的公司、行业和人物", summary.entities, (item) => `**${item.name}**（${item.type || "实体"}）：${item.context}`);
  addList("关键数据", summary.keyData, (item) => `**${item.label}：${item.value}** — ${item.context}`);
  addList("重要观点及理由", summary.viewpoints, (item) => `**${item.statement}**：${item.reason}`);
  addList("风险或争议", summary.risks);
  addList("原文定位", summary.sourceAnchors, (item) => `**${item.locator}**：${item.label}`);
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

async function submitSummary({ form, endpoint, payload, requestBody }) {
  const button = form.querySelector("button[type='submit']");
  const label = button.querySelector(".button-label");
  const idleLabel = label.textContent;
  button.disabled = true;
  label.textContent = "正在分析内容";
  elements.empty.hidden = true;
  elements.digest.hidden = true;
  elements.resultActions.hidden = true;
  setFeedback("loading", "正在读取来源并构建结构化摘要，长内容可能需要一些时间……");
  try {
    const options = { method: "POST" };
    if (requestBody) {
      options.body = requestBody;
    } else {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(endpoint, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("服务返回了无法识别的响应"); }
    if (!response.ok) throw new Error(data.error || "请求失败");
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
    label.textContent = idleLabel;
  }
}

$("#youtube-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitSummary({ form: event.currentTarget, endpoint: "/api/summarize/youtube", payload: { url: elements.url.value.trim() } });
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
  const formData = new FormData();
  formData.append("file", selectedFile);
  submitSummary({ form: event.currentTarget, endpoint: "/api/summarize/file", requestBody: formData });
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
