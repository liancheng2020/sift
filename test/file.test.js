import test from "node:test";
import assert from "node:assert/strict";
import { parseUploadedFile, validateExtractedFileText, validateFileInput } from "../lib/file.js";

const enoughText = "这是一段用于验证多来源文件摘要解析能力的测试内容。".repeat(8);

test("parseUploadedFile reads UTF-8 text files", async () => {
  const result = await parseUploadedFile({ filename: "report.txt", buffer: Buffer.from(enoughText) });
  assert.equal(result.filename, "report.txt");
  assert.equal(result.fileType, "TXT");
  assert.match(result.text, /多来源文件摘要/);
});

test("parseUploadedFile dispatches PDF and Word formats", async () => {
  const pdf = await parseUploadedFile(
    { filename: "report.pdf", buffer: Buffer.from("fake") },
    { pdf: async () => ({ text: enoughText }) }
  );
  const docx = await parseUploadedFile(
    { filename: "report.docx", buffer: Buffer.from("fake") },
    { docx: async () => ({ value: enoughText }) }
  );
  const doc = await parseUploadedFile(
    { filename: "report.doc", buffer: Buffer.from("fake") },
    { doc: async () => ({ getBody: () => enoughText }) }
  );
  assert.deepEqual([pdf.fileType, docx.fileType, doc.fileType], ["PDF", "DOCX", "DOC"]);
});

test("validateFileInput rejects unsupported formats and empty files", () => {
  assert.throws(() => validateFileInput({ filename: "image.png", buffer: Buffer.from("x") }), /格式不支持/);
  assert.throws(() => validateFileInput({ filename: "empty.txt", buffer: Buffer.alloc(0) }), /文件为空/);
});

test("parseUploadedFile rejects content that is too short", async () => {
  await assert.rejects(
    parseUploadedFile({ filename: "short.md", buffer: Buffer.from("内容太短") }),
    /至少提供 80 个字符/
  );
});

test("validateExtractedFileText accepts browser-extracted PDF text", () => {
  const result = validateExtractedFileText({
    filename: "../report.pdf",
    fileType: "pdf",
    text: enoughText
  });
  assert.equal(result.filename, "report.pdf");
  assert.equal(result.fileType, "PDF");
  assert.match(result.text, /多来源文件摘要/);
});

test("validateExtractedFileText rejects non-PDF and image-only content", () => {
  assert.throws(
    () => validateExtractedFileText({ filename: "report.docx", fileType: "DOCX", text: enoughText }),
    /仅支持 PDF/
  );
  assert.throws(
    () => validateExtractedFileText({ filename: "scan.pdf", fileType: "PDF", text: "图片" }),
    /扫描件或图片型 PDF/
  );
});
