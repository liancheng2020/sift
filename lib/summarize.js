import { chunkText } from "./content.js";

export const EMPTY_DIGEST = Object.freeze({
  conclusion: "",
  coreContent: [],
  entities: [],
  keyData: [],
  viewpoints: [],
  risks: [],
  sourceAnchors: []
});

const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["conclusion", "coreContent", "entities", "keyData", "viewpoints", "risks", "sourceAnchors"],
  properties: {
    conclusion: { type: "string" },
    coreContent: { type: "array", items: { type: "string" }, maxItems: 6 },
    entities: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "context"],
        properties: { name: { type: "string" }, type: { type: "string" }, context: { type: "string" } }
      }
    },
    keyData: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "context"],
        properties: { label: { type: "string" }, value: { type: "string" }, context: { type: "string" } }
      }
    },
    viewpoints: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "reason"],
        properties: { statement: { type: "string" }, reason: { type: "string" } }
      }
    },
    risks: { type: "array", items: { type: "string" }, maxItems: 6 },
    sourceAnchors: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "locator", "seconds"],
        properties: {
          label: { type: "string" },
          locator: { type: "string" },
          seconds: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }
        }
      }
    }
  }
};

const INSTRUCTIONS = `你是一名严谨的中文内容分析编辑。只根据提供的原文总结，不猜测、不补充外部知识、不提供投资建议。
必须只输出一个合法 JSON 对象，不要输出 Markdown 代码块或解释文字。JSON 字段必须严格遵循提供的结构。
要求：
1. conclusion 是一句自然、明确的中文结论。
2. coreContent 提炼最多6条互不重复的核心信息。
3. entities 只列出原文明示的重要公司、行业、产品或人物，并说明其在原文中的作用。
4. keyData 只保留对结论有意义的数字、日期、比例、金额或指标。
5. viewpoints 中 statement 是重要观点，reason 必须是原文给出的理由或依据。
6. risks 记录原文明示的风险、限制、争议或不确定性，不能自行追加通用风险。
7. sourceAnchors 选择最能支撑结论的原文定位。YouTube 使用原文时间标记并换算 seconds；文件和普通文本使用段落编号且 seconds 为 null。
8. 原文没有的信息必须使用空数组，禁止用“原文未提及”凑数。`;

function parseJsonOutput(output) {
  const cleaned = String(output || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!cleaned) throw new Error("模型未返回摘要内容");
  try {
    return normalizeDigest(JSON.parse(cleaned));
  } catch {
    throw new Error("模型返回的摘要格式无效，请重新生成");
  }
}

export function normalizeDigest(value) {
  const digest = value && typeof value === "object" ? value : {};
  const list = (key) => Array.isArray(digest[key]) ? digest[key] : [];
  return {
    conclusion: typeof digest.conclusion === "string" ? digest.conclusion.trim() : "",
    coreContent: list("coreContent").filter((item) => typeof item === "string" && item.trim()).slice(0, 6),
    entities: list("entities").filter((item) => item?.name && item?.context).slice(0, 10),
    keyData: list("keyData").filter((item) => item?.label && item?.value).slice(0, 10),
    viewpoints: list("viewpoints").filter((item) => item?.statement && item?.reason).slice(0, 6),
    risks: list("risks").filter((item) => typeof item === "string" && item.trim()).slice(0, 6),
    sourceAnchors: list("sourceAnchors").filter((item) => item?.label && item?.locator).slice(0, 8)
  };
}

export function resolveProviderConfig(env = process.env) {
  const requested = env.AI_PROVIDER?.trim().toLowerCase();
  const provider = requested || (env.DEEPSEEK_API_KEY ? "deepseek" : env.OPENAI_API_KEY ? "openai" : "deepseek");
  if (!new Set(["deepseek", "openai"]).has(provider)) {
    throw new Error("AI_PROVIDER 仅支持 deepseek 或 openai");
  }
  if (provider === "deepseek") {
    return {
      provider,
      apiKey: env.DEEPSEEK_API_KEY || "",
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
      endpoint: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/chat/completions"
    };
  }
  return {
    provider,
    apiKey: env.OPENAI_API_KEY || "",
    model: env.OPENAI_MODEL || "gpt-5-mini",
    endpoint: env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses"
  };
}

async function requestJson(endpoint, options, provider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(endpoint, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error?.message || `${provider} 模型服务请求失败（HTTP ${response.status}）`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`${provider} 模型请求超时，请稍后重试`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callDeepSeek(config, text, context) {
  const data = await requestJson(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: `${INSTRUCTIONS}\n\n目标 JSON Schema：\n${JSON.stringify(DIGEST_SCHEMA)}` },
        { role: "user", content: `${context}\n\n原文：\n${text}` }
      ],
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1
    })
  }, "DeepSeek");
  return parseJsonOutput(data.choices?.[0]?.message?.content);
}

async function callOpenAI(config, text, context) {
  const data = await requestJson(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      instructions: INSTRUCTIONS,
      input: `${context}\n\n原文：\n${text}`,
      text: { format: { type: "json_schema", name: "omni_digest", strict: true, schema: DIGEST_SCHEMA } }
    })
  }, "OpenAI");
  const output = data.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  return parseJsonOutput(output);
}

async function callModel(config, text, context) {
  return config.provider === "deepseek"
    ? callDeepSeek(config, text, context)
    : callOpenAI(config, text, context);
}

export async function summarizeContent({ text, title = "未命名内容", sourceType = "text" }) {
  const config = resolveProviderConfig();
  if (!config.apiKey) {
    const keyName = config.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`服务端尚未配置 ${keyName}`);
  }
  const chunks = chunkText(text);
  const context = `来源类型：${sourceType}\n标题：${title}`;
  if (chunks.length === 1) return callModel(config, chunks[0], context);
  const partials = [];
  for (let index = 0; index < chunks.length; index += 1) {
    partials.push(await callModel(config, chunks[index], `${context}\n第${index + 1}/${chunks.length}段，请保留重要事实并去除重复。`));
  }
  return callModel(config, partials.map((item) => JSON.stringify(item)).join("\n\n---\n\n"), `${context}\n以下是分段结构化摘要，请合并、去重并保留有效来源定位。`);
}
