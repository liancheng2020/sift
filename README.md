# Sift

面向多种内容来源的结构化摘要工具。输入 YouTube 视频、PDF/Word 文档或一段长文本，统一生成忠于原文、可返回原始位置核对的中文摘要。

> 从海量内容中，留下真正重要的信息。

## v0.1 能力

- 支持 YouTube 普通视频、Shorts 和直播回放链接，优先读取公开字幕；无公开字幕时使用 DeepSeek Vision 识别画面中的硬字幕。
- 支持最大 20MB 的 PDF、DOC、DOCX、TXT、Markdown 文件。
- 支持粘贴最多 15 万字符的文章、Newsletter、访谈或邮件正文。
- 自动分段处理长内容，并对分段结果合并去重。
- 默认接入 DeepSeek，也可通过环境变量切换到 OpenAI。
- 使用 JSON 模式、Schema 指令和服务端归一化，稳定返回七类信息。
- 支持一键复制和导出 Markdown。
- 文件、文本和字幕仅在内存中处理，不写入数据库或日志。
- Vercel 出口被 YouTube 限制时，可通过可选的 Sift Browser Helper 使用用户本机网络读取内容。

统一输出：

1. 一句话结论
2. 核心内容
3. 涉及的公司、行业、产品和人物
4. 关键数据
5. 重要观点及理由
6. 风险或争议
7. 视频时间戳或文档段落定位

## 安装与运行

```bash
npm install
cp .env.example .env
```

编辑 `.env`，填入自己的 DeepSeek API Key，然后启动：

```bash
npm start
```

服务启动时会自动加载项目根目录下的 `.env`。

打开 <http://localhost:3000>。

运行测试：

```bash
npm test
```

## 模型配置

最小可运行配置只需要选择 Provider，并填写对应的 API Key。默认使用 DeepSeek：

```dotenv
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp
```

切换到 OpenAI：

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5-mini
```

环境变量说明：

| 变量 | 是否必填 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `AI_PROVIDER` | 建议填写 | `deepseek` | 摘要模型提供方，仅支持 `deepseek`、`openai` |
| `DEEPSEEK_API_KEY` | 使用 DeepSeek 时必填 | 无 | DeepSeek 摘要；无公开字幕时的 YouTube 画面识别也依赖它 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-chat` | DeepSeek 摘要模型 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | DeepSeek API 基础地址，也支持填写完整的 `/chat/completions` 地址 |
| `DEEPSEEK_VISION_MODEL` | 否 | `deepseek-v4-flash-vision-exp` | YouTube 画面字幕识别模型 |
| `DEEPSEEK_RESPONSES_URL` | 否 | 由 `DEEPSEEK_BASE_URL` 推导 | 画面识别使用的完整 Responses API 地址 |
| `OPENAI_API_KEY` | 使用 OpenAI 时必填 | 无 | OpenAI 摘要凭证 |
| `OPENAI_MODEL` | 否 | `gpt-5-mini` | OpenAI 摘要模型 |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | OpenAI API 基础地址，也支持填写完整的 `/responses` 地址 |
| `YOUTUBE_PROXY_URL` | 视网络而定 | 无 | Node.js 访问 YouTube 使用的公网 HTTP(S) 代理，优先级最高 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 否 | 无 | `YOUTUBE_PROXY_URL` 未配置时的代理回退 |
| `PORT` | 否 | `3000` | Web 服务监听端口 |

当 `AI_PROVIDER=openai` 时，普通摘要只需要 `OPENAI_API_KEY`；如果还要处理没有公开字幕的 YouTube 视频，则需要额外配置 `DEEPSEEK_API_KEY` 和可用的视觉模型。

API Key 只允许写入本地 `.env`，不要提交到 Git 仓库。

### YouTube 网络配置

Chrome 能访问 YouTube，不代表 Node 服务也能访问：浏览器代理扩展只作用于浏览器。Sift 会优先读取 `YOUTUBE_PROXY_URL`，也兼容 `HTTPS_PROXY` 和 `HTTP_PROXY`。

本地开发可以使用本机代理，例如 HTTP 代理端口为 `1087`：

```dotenv
YOUTUBE_PROXY_URL=http://127.0.0.1:1087
```

Vercel、Railway 等云端运行环境中的 `127.0.0.1` 和 `localhost` 只指向云端实例自身，无法连接你电脑上的代理。部署到 Vercel 时应删除本机代理变量并先尝试直连；若 YouTube 限制了 Vercel 出口网络，则配置公网可访问的 HTTP(S) 代理：

```dotenv
YOUTUBE_PROXY_URL=https://user:password@proxy.example.com:8443
```

Sift 检测到 Vercel 配置了 loopback 代理时会忽略它并尝试直连，`/api/health` 的 `youtube` 字段会显示代理是否启用及配置警告。公网代理失败时也会自动尝试一次直连。

如果 Vercel 直连仍被 YouTube 风控，而用户自己的 Chrome 可以访问 YouTube，可安装仓库中的专用浏览器助手：

1. 打开 `chrome://extensions/` 并启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本项目的 `browser-helper` 文件夹。
3. 刷新 Sift 页面后重新提交视频链接。

此时 Chrome 负责读取公开字幕；没有公开字幕时，助手会提交低分辨率故事板，由服务端识别画面硬字幕。助手只响应 Sift 生产地址和本地开发地址，不会把 YouTube Cookie 或账号信息发给 Sift。已安装的 ChatGPT/Codex 插件没有 Sift 所需的网页通信协议和 YouTube 域名权限，不能替代该助手。

修改本地 `.env` 后需要停止并重新运行 `npm start`；修改 Vercel 环境变量后必须重新部署，新变量不会作用于既有部署。Sift 使用 `yt-dlp` 适配 YouTube 页面变化；首次 `npm install` 会下载对应平台的可执行文件。

## API

| 方法 | 路径 | 输入 |
| --- | --- | --- |
| `GET` | `/api/health` | 无 |
| `POST` | `/api/summarize/youtube` | JSON：`{ "url": "..." }` |
| `POST` | `/api/summarize/youtube-browser` | 浏览器助手内部接口：YouTube 链接和已提取内容 |
| `POST` | `/api/summarize/file` | multipart/form-data：字段名 `file` |
| `POST` | `/api/summarize/text` | JSON：`{ "title": "...", "text": "..." }` |

## v0.1 边界

- YouTube 无公开字幕时会尝试识别故事板中的硬字幕；没有画面字幕的纯语音视频仍需要后续接入音频转写服务。
- 每次处理一个来源，不保存历史记录，也不合并多个来源。
- `.doc` 使用兼容解析器；复杂排版、扫描版 PDF 和图片中的文字可能无法提取。
- 内容会发送至配置的模型服务，请勿提交无权处理的敏感内容。

## Roadmap

- `v0.2`：YouTube 频道地址与最新视频批量摘要
- `v0.3`：邮件文件与更完整的文档解析
- `v0.4`：Gmail 指定邮件自动读取
- `v1.0`：历史记录、定时生成和多来源合并

## License

MIT
