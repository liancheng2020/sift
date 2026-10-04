import { chunkSourceText, normalizeText } from "./content.js";
import { WorkflowError } from "./errors.js";

const MARKER = /^\[(段落\s+\d+|第\s*\d+\s*页|\d{1,2}:\d{2}(?::\d{2})?)\]\s*/gm;
const matchText = value => value.normalize("NFC").replace(/\s+/g, " ").trim();

export function sourceUnits(input) {
  const text = normalizeText(input);
  const matches = [...text.matchAll(MARKER)];
  if (!matches.length) return text.split(/\n\n+/).filter(Boolean).map((value, index) => ({ locator: `[段落 ${index + 1}]`, seconds: null, text: value }));
  const units = [];
  if (matches[0].index > 0 && text.slice(0, matches[0].index).trim()) {
    units.push({ locator: "[段落 0]", seconds: null, text: text.slice(0, matches[0].index).trim() });
  }
  for (const [index, marker] of matches.entries()) {
    const value = text.slice(marker.index + marker[0].length, matches[index + 1]?.index ?? text.length).trim();
    if (!value) continue;
    const parts = marker[1].split(":");
    const timed = parts.length > 1;
    if (timed && parts.slice(1).some(part => Number(part) > 59)) throw new WorkflowError("原文时间标记无效", "INVALID_SOURCE_LOCATOR", 400);
    units.push({ locator: `[${marker[1]}]`, seconds: timed ? parts.reduce((sum, part) => sum * 60 + Number(part), 0) : null, text: value });
  }
  return units;
}

export function chunkUnits(units, maxLength = 12000) {
  if (!Number.isInteger(maxLength) || maxLength < 100) throw new Error("分块长度至少为 100");
  const chunks = [];
  let current = [];
  let length = 0;
  for (const unit of units) {
    for (const text of chunkSourceText(unit.text, { maxLength: maxLength - unit.locator.length - 4 })) {
      const part = { ...unit, text };
      const size = unit.locator.length + text.length + 3;
      if (current.length && length + size > maxLength) { chunks.push(current); current = []; length = 0; }
      current.push(part); length += size;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export const renderUnits = units => units.map(unit => `${unit.locator} ${unit.text}`).join("\n\n");

export function checkGrounding(digest, units, allowedEvidence) {
  const errors = [], excerpts = [];
  for (const key of ["keyPoints", "keyData", "decisions", "actionItems", "risks"]) {
    digest[key].forEach((item, index) => {
      const evidence = item.evidence;
      const unit = units.find(unit => unit.locator === evidence.locator && unit.seconds === evidence.seconds && matchText(unit.text).includes(matchText(evidence.quote)));
      if (!unit) errors.push(`${key}[${index}] 引文与定位不匹配原文`);
      if (allowedEvidence && !allowedEvidence.some(previous => previous.locator === evidence.locator && previous.seconds === evidence.seconds && previous.quote === evidence.quote)) {
        errors.push(`${key}[${index}] 合并时新增或改写了分段证据`);
      }
      if (unit && !excerpts.some(item => item.locator === evidence.locator && item.quote === evidence.quote)) {
        const source = matchText(unit.text), position = source.indexOf(matchText(evidence.quote));
        excerpts.push({ locator: evidence.locator, quote: evidence.quote, excerpt: source.slice(Math.max(0, position - 100), position + evidence.quote.length + 160) });
      }
    });
  }
  for (const [index, item] of digest.outline.entries()) {
    if (!units.some(unit => unit.locator === item.locator && unit.seconds === item.seconds)) errors.push(`outline[${index}] 定位不存在或时间不一致`);
  }
  return { valid: !errors.length, errors, excerpts,
    quoteCount: ["keyPoints", "keyData", "decisions", "actionItems", "risks"].reduce((sum, key) => sum + digest[key].length, 0) };
}

export const digestEvidence = digest => ["keyPoints", "keyData", "decisions", "actionItems", "risks"].flatMap(key => digest[key].map(item => item.evidence));
