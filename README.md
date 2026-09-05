# Sift

面向多种内容来源的结构化摘要工具。输入 YouTube 视频、PDF/Word 文档或一段长文本，统一生成忠于原文、可返回原始位置核对的中文摘要。

> 从海量内容中，留下真正重要的信息。

## v0.1 能力

- 支持 YouTube 普通视频、Shorts 和直播回放链接，读取公开视频字幕并保留时间戳。
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

编辑 `.env`，填入自己的 DeepSeek API Key，然后加载配置并启动：

```bash
set -a
source .env
set +a
npm start
```

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
```

切换到 OpenAI：

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5-mini
```

API Key 只允许写入本地 `.env`，不要提交到 Git 仓库。

## API

| 方法 | 路径 | 输入 |
| --- | --- | --- |
| `GET` | `/api/health` | 无 |
| `POST` | `/api/summarize/youtube` | JSON：`{ "url": "..." }` |
| `POST` | `/api/summarize/file` | multipart/form-data：字段名 `file` |
| `POST` | `/api/summarize/text` | JSON：`{ "title": "...", "text": "..." }` |

## v0.1 边界

- YouTube 依赖视频已有的公开字幕，暂不包含音频转写。
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
