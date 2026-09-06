import { basename, extname } from "node:path";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import WordExtractor from "word-extractor";
import { normalizeText } from "./content.js";

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 150_000;
export const ACCEPTED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".txt", ".md"]);

const wordExtractor = new WordExtractor();

export function validateFileInput({ filename, buffer }) {
  const safeName = basename(filename || "");
  const extension = extname(safeName).toLowerCase();
  if (!safeName || !ACCEPTED_EXTENSIONS.has(extension)) {
    throw new Error("文件格式不支持，请上传 PDF、DOC、DOCX、TXT 或 Markdown 文件");
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("上传的文件为空");
  if (buffer.length > MAX_FILE_SIZE) throw new Error("文件超过 20MB 限制");
  return { safeName, extension };
}

export function validateExtractedFileText({ filename, fileType, text }) {
  const safeName = basename(String(filename || "")).slice(0, 200);
  const normalizedType = String(fileType || "").trim().toUpperCase();
  if (!safeName || normalizedType !== "PDF" || extname(safeName).toLowerCase() !== ".pdf") {
    throw new Error("浏览器解析接口仅支持 PDF 文件");
  }
  const normalizedText = normalizeText(String(text || ""));
  if (normalizedText.length < 80) throw new Error("PDF 可提取内容太短，可能是扫描件或图片型 PDF");
  if (normalizedText.length > MAX_TEXT_LENGTH) throw new Error("PDF 内容过长，请控制在 15 万字符以内");
  return { filename: safeName, fileType: normalizedType, text: normalizedText };
}

export async function parseUploadedFile({ filename, buffer }, parsers = {}) {
  const { safeName, extension } = validateFileInput({ filename, buffer });
  let rawText = "";

  if (extension === ".txt" || extension === ".md") {
    rawText = buffer.toString("utf8");
  } else if (extension === ".pdf") {
    const parsePdf = parsers.pdf || (async (input) => {
      const result = await extractText(new Uint8Array(input));
      return { text: (Array.isArray(result.text) ? result.text : [result.text]).join("\n") };
    });
    rawText = (await parsePdf(buffer)).text;
  } else if (extension === ".docx") {
    const parseDocx = parsers.docx || ((input) => mammoth.extractRawText({ buffer: input }));
    rawText = (await parseDocx(buffer)).value;
  } else {
    const parseDoc = parsers.doc || ((input) => wordExtractor.extract(input));
    rawText = (await parseDoc(buffer)).getBody();
  }

  const text = normalizeText(rawText || "");
  if (text.length < 80) throw new Error("文件可提取内容太短，请至少提供 80 个字符");
  if (text.length > MAX_TEXT_LENGTH) throw new Error("文件内容过长，请控制在 15 万字符以内");

  return {
    filename: safeName,
    extension,
    fileType: extension.slice(1).toUpperCase(),
    text
  };
}
