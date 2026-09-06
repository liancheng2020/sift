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

默认使用 DeepSeek：

```dotenv
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp

# 中国大陆网络通常需要给服务端单独配置 YouTube 代理
YOUTUBE_PROXY_URL=http://127.0.0.1:1087
```

切换到 OpenAI：

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5-mini
```

API Key 只允许写入本地 `.env`，不要提交到 Git 仓库。

### YouTube 网络配置

Chrome 能访问 YouTube，不代表 Node 服务也能访问：浏览器代理扩展只作用于浏览器。Sift 会优先读取 `YOUTUBE_PROXY_URL`，也兼容 `HTTPS_PROXY` 和 `HTTP_PROXY`。例如本地 HTTP 代理端口为 `1087`：

```dotenv
YOUTUBE_PROXY_URL=http://127.0.0.1:1087
```

修改 `.env` 后需要停止并重新运行 `npm start`。Sift 使用 `yt-dlp` 适配 YouTube 页面变化；首次 `npm install` 会下载对应平台的可执行文件。

## API

| 方法 | 路径 | 输入 |
| --- | --- | --- |
| `GET` | `/api/health` | 无 |
| `POST` | `/api/summarize/youtube` | JSON：`{ "url": "..." }` |
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
