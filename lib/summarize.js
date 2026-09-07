import { chunkSourceText } from "./content.js";

const EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["locator", "seconds", "quote"],
  properties: {
    locator: { type: "string" },
    seconds: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    quote: { type: "string", maxLength: 160 }
  }
};

export const EMPTY_DIGEST = Object.freeze({
  overview: { oneLiner: "", topic: "" },
  keyPoints: [],
  keyData: [],
  decisions: [],
  actionItems: [],
  risks: [],
  outline: []
});

export const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "keyPoints", "keyData", "decisions", "actionItems", "risks", "outline"],
  properties: {
    overview: {
      type: "object",
      additionalProperties: false,
      required: ["oneLiner", "topic"],
      properties: { oneLiner: { type: "string" }, topic: { type: "string" } }
    },
    keyPoints: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "evidence"],
        properties: { title: { type: "string" }, summary: { type: "string" }, evidence: EVIDENCE_SCHEMA }
      }
    },
    keyData: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "context", "evidence"],
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          context: { type: "string" },
          evidence: EVIDENCE_SCHEMA
        }
      }
    },
    decisions: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "evidence"],
        properties: { statement: { type: "string" }, evidence: EVIDENCE_SCHEMA }
      }
    },
    actionItems: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task", "owner", "deadline", "evidence"],
        properties: {
          task: { type: "string" },
          owner: { anyOf: [{ type: "string" }, { type: "null" }] },
          deadline: { anyOf: [{ type: "string" }, { type: "null" }] },
          evidence: EVIDENCE_SCHEMA
        }
      }
    },
    risks: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "evidence"],
        properties: { description: { type: "string" }, evidence: EVIDENCE_SCHEMA }
      }
    },
    outline: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "locator", "seconds"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          locator: { type: "string" },
          seconds: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }
        }
      }
    }
  }
};

const MODE_CONFIG = Object.freeze({
  concise: { label: "简洁", keyPoints: 3, outline: 4, maxTokens: 2600 },
  standard: { label: "标准", keyPoints: 5, outline: 6, maxTokens: 4200 },
  deep: { label: "深度", keyPoints: 8, outline: 10, maxTokens: 6000 }
});

const DIGEST_EXAMPLE = {
  overview: { oneLiner: "一句话说明内容的核心结论。", topic: "核心主题" },
  keyPoints: [{
    title: "要点标题",
    summary: "完整但简洁的事实摘要。",
    evidence: { locator: "[1:25]", seconds: 85, quote: "能够直接支撑该要点的原文短句" }
  }],
  keyData: [],
  decisions: [],
  actionItems: [],
  risks: [],
  outline: [{ title: "章节标题", summary: "本段内容概述。", locator: "[1:25]", seconds: 85 }]
};

const INSTRUCTIONS = `你是一名严谨的中文内容分析编辑。只根据提供的原文总结，不猜测、不补充外部知识、不提供投资建议。
必须只输出一个合法 JSON 对象，不要输出 Markdown 代码块或解释文字。JSON 字段必须严格遵循目标 Schema。
要求：
1. overview.oneLiner 是一句自然、明确的核心结论，overview.topic 是不超过 16 个汉字的主题。
2. keyPoints 中每条只表达一个重要事实；title 便于扫读，summary 说明完整。
3. keyData 只保留会影响理解或结论的数字、日期、比例、金额和指标。
4. decisions 仅记录原文明示的已做决定；actionItems 仅记录明确的后续任务，未给出负责人或期限时对应字段为 null。
5. risks 仅记录原文明示的风险、限制、争议或不确定性，不能自行追加通用风险。
6. 每条要点、数据、决定、行动和风险都必须带 evidence。quote 必须是原文中的简短原句，不超过 160 字，不能改写或编造。
7. YouTube 的 locator 使用原文时间标记，seconds 换算为非负整数；文件和普通文本使用 [段落 N]，seconds 为 null。
8. outline 按原文顺序组织。YouTube 作为章节时间轴，文件和文本作为内容脉络。
9. 原文没有的数据、决定、行动或风险必须使用空数组，禁止用“原文未提及”凑数。
10. 合并分段摘要时必须保留原有 quote、locator 和 seconds，不能生成分段摘要里不存在的新证据。`;

const ROOT_KEYS = Object.keys(EMPTY_DIGEST);

export function normalizeSummaryMode(value) {
  const mode = String(value || "standard").trim().toLowerCase();
  if (!MODE_CONFIG[mode]) throw new Error("摘要深度仅支持 concise、standard 或 deep");
  return mode;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateKeys(value, required, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} 必须是对象`);
    return false;
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${path} 缺少字段 ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) errors.push(`${path} 包含未知字段 ${key}`);
  }
  return true;
}

function validateText(value, path, errors, { nullable = false, maxLength } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} 必须是非空字符串`);
  } else if (maxLength && value.length > maxLength) {
    errors.push(`${path} 不能超过 ${maxLength} 字`);
  }
}

function validateEvidence(value, path, errors) {
  if (!validateKeys(value, ["locator", "seconds", "quote"], path, errors)) return;
  validateText(value.locator, `${path}.locator`, errors);
  validateText(value.quote, `${path}.quote`, errors, { maxLength: 160 });
  if (value.seconds !== null && (!Number.isInteger(value.seconds) || value.seconds < 0)) {
    errors.push(`${path}.seconds 必须是非负整数或 null`);
  }
}

function validateList(value, path, errors, maxItems, validateItem) {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return;
  }
  if (value.length > maxItems) errors.push(`${path} 最多包含 ${maxItems} 项`);
  value.forEach((item, index) => validateItem(item, `${path}[${index}]`, errors));
}

export function validateDigest(value) {
  const errors = [];
  if (!validateKeys(value, ROOT_KEYS, "摘要", errors)) return { valid: false, errors };

  if (validateKeys(value.overview, ["oneLiner", "topic"], "overview", errors)) {
    validateText(value.overview.oneLiner, "overview.oneLiner", errors);
    validateText(value.overview.topic, "overview.topic", errors);
  }

  validateList(value.keyPoints, "keyPoints", errors, 8, (item, path) => {
    if (!validateKeys(item, ["title", "summary", "evidence"], path, errors)) return;
    validateText(item.title, `${path}.title`, errors);
    validateText(item.summary, `${path}.summary`, errors);
    validateEvidence(item.evidence, `${path}.evidence`, errors);
  });
  if (Array.isArray(value.keyPoints) && value.keyPoints.length === 0) {
    errors.push("keyPoints 至少需要 1 项");
  }

  validateList(value.keyData, "keyData", errors, 10, (item, path) => {
    if (!validateKeys(item, ["label", "value", "context", "evidence"], path, errors)) return;
    validateText(item.label, `${path}.label`, errors);
    validateText(item.value, `${path}.value`, errors);
    validateText(item.context, `${path}.context`, errors);
    validateEvidence(item.evidence, `${path}.evidence`, errors);
  });

  validateList(value.decisions, "decisions", errors, 6, (item, path) => {
    if (!validateKeys(item, ["statement", "evidence"], path, errors)) return;
    validateText(item.statement, `${path}.statement`, errors);
    validateEvidence(item.evidence, `${path}.evidence`, errors);
  });

  validateList(value.actionItems, "actionItems", errors, 8, (item, path) => {
    if (!validateKeys(item, ["task", "owner", "deadline", "evidence"], path, errors)) return;
    validateText(item.task, `${path}.task`, errors);
    validateText(item.owner, `${path}.owner`, errors, { nullable: true });
    validateText(item.deadline, `${path}.deadline`, errors, { nullable: true });
    validateEvidence(item.evidence, `${path}.evidence`, errors);
  });

  validateList(value.risks, "risks", errors, 6, (item, path) => {
    if (!validateKeys(item, ["description", "evidence"], path, errors)) return;
    validateText(item.description, `${path}.description`, errors);
    validateEvidence(item.evidence, `${path}.evidence`, errors);
  });

  validateList(value.outline, "outline", errors, 10, (item, path) => {
    if (!validateKeys(item, ["title", "summary", "locator", "seconds"], path, errors)) return;
    validateText(item.title, `${path}.title`, errors);
    validateText(item.summary, `${path}.summary`, errors);
    validateText(item.locator, `${path}.locator`, errors);
    if (item.seconds !== null && (!Number.isInteger(item.seconds) || item.seconds < 0)) {
      errors.push(`${path}.seconds 必须是非负整数或 null`);
    }
  });

  return { valid: errors.length === 0, errors };
}

class DigestValidationError extends Error {
  constructor(errors) {
    super(`模型返回的摘要未通过结构校验：${errors.slice(0, 6).join("；")}`);
    this.name = "DigestValidationError";
    this.validationErrors = errors;
  }
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanEvidence(value = {}) {
  return {
    locator: cleanText(value.locator),
    seconds: Number.isInteger(value.seconds) && value.seconds >= 0 ? value.seconds : null,
    quote: cleanText(value.quote)
  };
}

export function normalizeDigest(value) {
  const digest = isObject(value) ? value : {};
  const list = (key) => Array.isArray(digest[key]) ? digest[key] : [];
  return {
    overview: {
      oneLiner: cleanText(digest.overview?.oneLiner),
      topic: cleanText(digest.overview?.topic)
    },
    keyPoints: list("keyPoints").slice(0, 8).map((item) => ({
      title: cleanText(item?.title),
      summary: cleanText(item?.summary),
      evidence: cleanEvidence(item?.evidence)
    })),
    keyData: list("keyData").slice(0, 10).map((item) => ({
      label: cleanText(item?.label),
      value: cleanText(item?.value),
      context: cleanText(item?.context),
      evidence: cleanEvidence(item?.evidence)
    })),
    decisions: list("decisions").slice(0, 6).map((item) => ({
      statement: cleanText(item?.statement),
      evidence: cleanEvidence(item?.evidence)
    })),
    actionItems: list("actionItems").slice(0, 8).map((item) => ({
      task: cleanText(item?.task),
      owner: item?.owner === null ? null : cleanText(item?.owner) || null,
      deadline: item?.deadline === null ? null : cleanText(item?.deadline) || null,
      evidence: cleanEvidence(item?.evidence)
    })),
    risks: list("risks").slice(0, 6).map((item) => ({
      description: cleanText(item?.description),
      evidence: cleanEvidence(item?.evidence)
    })),
    outline: list("outline").slice(0, 10).map((item) => ({
      title: cleanText(item?.title),
      summary: cleanText(item?.summary),
      locator: cleanText(item?.locator),
      seconds: Number.isInteger(item?.seconds) && item.seconds >= 0 ? item.seconds : null
    }))
  };
}

function parseJsonOutput(output, mode = "standard") {
  const cleaned = String(output || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!cleaned) throw new DigestValidationError(["模型未返回摘要内容"]);
  let value;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new DigestValidationError(["返回内容不是合法 JSON"]);
  }
  const validation = validateDigest(value);
  if (!validation.valid) throw new DigestValidationError(validation.errors);
  const digest = normalizeDigest(value);
  digest.keyPoints = digest.keyPoints.slice(0, MODE_CONFIG[mode].keyPoints);
  digest.outline = digest.outline.slice(0, MODE_CONFIG[mode].outline);
  return digest;
}

function resolveEndpoint(baseUrl, defaultBaseUrl, path) {
  const value = (baseUrl || defaultBaseUrl).replace(/\/+$/, "");
  return value.endsWith(path) ? value : `${value}${path}`;
}

export function resolveProviderConfig(env = process.env) {
  const requested = env.AI_PROVIDER?.trim().toLowerCase();
  const provider = requested || (env.DEEPSEEK_API_KEY ? "deepseek" : env.OPENAI_API_KEY ? "openai" : "deepseek");
  if (!new Set(["deepseek", "openai"]).has(provider)) throw new Error("AI_PROVIDER 仅支持 deepseek 或 openai");
  if (provider === "deepseek") {
    return {
      provider,
      apiKey: env.DEEPSEEK_API_KEY || "",
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
      endpoint: resolveEndpoint(env.DEEPSEEK_BASE_URL, "https://api.deepseek.com", "/chat/completions")
    };
  }
  return {
    provider,
    apiKey: env.OPENAI_API_KEY || "",
    model: env.OPENAI_MODEL || "gpt-5-mini",
    endpoint: resolveEndpoint(env.OPENAI_BASE_URL, "https://api.openai.com/v1", "/responses")
  };
}

async function requestJson(endpoint, options, provider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(endpoint, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `${provider} 模型服务请求失败（HTTP ${response.status}）`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`${provider} 模型请求超时，请稍后重试`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function systemPrompt(mode) {
  const config = MODE_CONFIG[mode];
  return `${INSTRUCTIONS}

本次摘要深度：${config.label}。keyPoints 最多 ${config.keyPoints} 条，outline 最多 ${config.outline} 条。
目标 JSON Schema：
${JSON.stringify(DIGEST_SCHEMA)}
JSON 输出示例：
${JSON.stringify(DIGEST_EXAMPLE)}`;
}

async function callDeepSeek(config, text, context, mode) {
  const messages = [
    { role: "system", content: systemPrompt(mode) },
    { role: "user", content: `${context}\n\n原文：\n${text}` }
  ];
  let previousOutput = "";
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const data = await requestJson(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: MODE_CONFIG[mode].maxTokens,
        stream: false,
        temperature: 0.1
      })
    }, "DeepSeek");
    previousOutput = data.choices?.[0]?.message?.content || "";
    try {
      return parseJsonOutput(previousOutput, mode);
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        messages.push(
          { role: "assistant", content: previousOutput || "{}" },
          {
            role: "user",
            content: `上一次 JSON 未通过校验：${error.validationErrors?.slice(0, 8).join("；") || error.message}。请修正后只返回完整 JSON，不能省略字段。`
          }
        );
      }
    }
  }
  throw lastError;
}

async function callOpenAI(config, text, context, mode) {
  const data = await requestJson(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      instructions: systemPrompt(mode),
      input: `${context}\n\n原文：\n${text}`,
      text: { format: { type: "json_schema", name: "sift_digest", strict: true, schema: DIGEST_SCHEMA } }
    })
  }, "OpenAI");
  const output = data.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  return parseJsonOutput(output, mode);
}

async function callModel(config, text, context, mode) {
  return config.provider === "deepseek"
    ? callDeepSeek(config, text, context, mode)
    : callOpenAI(config, text, context, mode);
}

function chunkRange(chunk) {
  const markers = [...chunk.matchAll(/\[(?:段落\s+\d+|\d{1,2}:\d{2}(?::\d{2})?)\]/g)].map((match) => match[0]);
  if (!markers.length) return "未标记范围";
  return markers.length === 1 ? markers[0] : `${markers[0]} 至 ${markers.at(-1)}`;
}

export async function summarizeContent({ text, title = "未命名内容", sourceType = "text", summaryMode = "standard" }) {
  const config = resolveProviderConfig();
  if (!config.apiKey) {
    const keyName = config.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`服务端尚未配置 ${keyName}`);
  }
  const mode = normalizeSummaryMode(summaryMode);
  const chunks = chunkSourceText(text, { sourceType });
  if (!chunks.length) throw new Error("没有可供总结的正文内容");
  const context = `来源类型：${sourceType}\n标题：${title}`;
  if (chunks.length === 1) return callModel(config, chunks[0], context, mode);

  const partials = [];
  for (let index = 0; index < chunks.length; index += 1) {
    partials.push(await callModel(
      config,
      chunks[index],
      `${context}\n第 ${index + 1}/${chunks.length} 段，原文范围：${chunkRange(chunks[index])}。只保留本段可直接举证的重要事实。`,
      mode
    ));
  }
  return callModel(
    config,
    partials.map((item) => JSON.stringify(item)).join("\n\n---\n\n"),
    `${context}\n以下是分段结构化摘要。请合并、去重，并严格保留分段结果中的证据原文和定位。`,
    mode
  );
}
