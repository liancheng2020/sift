import test from "node:test";
import assert from "node:assert/strict";
import { parseUploadedFile } from "../lib/file.js";
import { pdfFixture, docxFixture, syntheticText } from "../scripts/fixtures.mjs";

test("actual PDF parser preserves original page numbers", async () => {
  const parsed = await parseUploadedFile({ filename: "synthetic.pdf", buffer: pdfFixture(["Internal pilot budget: 120000 CNY. Pending acceptance; not public revenue.", "Owner Lin Qing must submit acceptance report before November 15, 2026."]) });
  assert.match(parsed.text, /\[第 1 页\]/);
  assert.match(parsed.text, /\[第 2 页\]/);
  assert.match(parsed.text, /120000/);
});

test("actual DOCX parser extracts a synthetic Word file", async () => {
  const parsed = await parseUploadedFile({ filename: "synthetic.docx", buffer: docxFixture(syntheticText) });
  assert.equal(parsed.text, syntheticText);
});
