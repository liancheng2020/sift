import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { summarizeContentDetailed } from "../lib/summarize.js";
import { parseUploadedFile } from "../lib/file.js";
import { WorkflowError } from "../lib/errors.js";
import { syntheticText, pdfFixture, docxFixture } from "./fixtures.mjs";

const directory = new URL("../artifacts/", import.meta.url);
await mkdir(directory, { recursive: true });
const report = { date: new Date().toISOString(), syntheticOnly: true, maxCalls: 10, calls: 0, cases: [] };
const pdf = await parseUploadedFile({ filename: "synthetic.pdf", buffer: pdfFixture([
  "Internal pilot budget is 120000 CNY and includes 30 employees. Acceptance is pending.",
  "Lin Qing must submit the report by November 15, 2026. Missing data is a risk. Do not release before acceptance."
]) });
const word = await parseUploadedFile({ filename: "synthetic.docx", buffer: docxFixture(syntheticText) });
const cases = [
  { id: "text", text: syntheticText, expected: [/12\s*万|120[,.]?000/, /30/, /验收/], sourceType: "text" },
  { id: "pdf-pages", text: pdf.text, expected: [/12\s*万|120[,.]?000/, /30/], sourceType: "PDF", locator: "[第 " },
  { id: "word", text: word.text, expected: [/12\s*万|120[,.]?000/, /验收/], sourceType: "DOCX" },
  { id: "timed-subtitles", text: `[00:00] ${syntheticText}\n\n[01:20] 本期再次提醒：试点结论不可外推，待验收后再考虑公开。`, expected: [/12\s*万|120[,.]?000/, /验收/], sourceType: "YouTube 字幕", locator: "[00:" },
  { id: "long-map-reduce", text: `${syntheticText}\n\n${"这是内部试点的背景说明，必须以验收为准，不得扩展结论。".repeat(180)}\n\n项目最终核验结果：预算维持 12 万元，验收仍未通过。`, expected: [/12\s*万|120[,.]?000/, /验收/], sourceType: "text", chunkLength: 3000 }
];

// The cap includes all requests, including repairs and merge stages across cases.
const fetchImpl = async (...args) => {
  if (report.calls >= report.maxCalls) throw new WorkflowError("Evaluation model-call cap reached", "EVALUATION_CALL_LIMIT");
  report.calls++;
  return fetch(...args);
};
for (const entry of cases) {
  const row = { id: entry.id, sourceType: entry.sourceType, status: "failed" };
  try {
    const result = await summarizeContentDetailed({ text: entry.text, title: "合成试点评测", sourceType: entry.sourceType, summaryMode: "concise" }, { fetchImpl, chunkLength: entry.chunkLength, timeoutMs: 120000 });
    const output = JSON.stringify(result.summary);
    row.checks = { schema: true, quotesMatched: result.grounding.verifiedQuotes === result.grounding.totalQuotes,
      requiredFacts: entry.expected.every(pattern => pattern.test(output)),
      originalLocator: !entry.locator || result.sourceExcerpts.some(item => item.locator.startsWith(entry.locator)) };
    row.status = Object.values(row.checks).every(Boolean) ? "passed" : "failed";
    row.result = result;
  } catch (error) {
    row.error = { code: error.code || "EVALUATION_FAILED", message: error.message };
    row.trace = error.workflowTrace;
  }
  report.cases.push(row);
  await writeFile(new URL("model-evaluation.json", directory), JSON.stringify(report, null, 2));
  console.log(`${row.id}: ${row.status} (cumulative model calls: ${report.calls})`);
  if (report.calls >= report.maxCalls) break;
}
report.completed = report.cases.length === cases.length;
report.passed = report.completed && report.cases.every(row => row.status === "passed");
await writeFile(new URL("model-evaluation.json", directory), JSON.stringify(report, null, 2));
console.log(`Report: artifacts/model-evaluation.json; passed=${report.passed}; calls=${report.calls}/10`);
if (!report.passed) process.exitCode = 1;
