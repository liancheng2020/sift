import test from "node:test";
import assert from "node:assert/strict";
import { sourceUnits, chunkUnits, renderUnits, checkGrounding } from "../lib/source.js";
import { fixtureDigest } from "../scripts/fixtures.mjs";

test("preserves page/time locators and assigns plain-text paragraphs", () => {
  assert.deepEqual(sourceUnits("甲\n\n乙").map(unit => unit.locator), ["[段落 1]", "[段落 2]"]);
  assert.equal(sourceUnits("[第 2 页]\n预算为 12 万元")[0].locator, "[第 2 页]");
  assert.equal(sourceUnits("[01:20] 预算为 12 万元")[0].seconds, 80);
  assert.throws(() => sourceUnits("[01:99] 预算"), /无效/);
});

test("oversized source chunks retain their original locator without dropping text", () => {
  const units = sourceUnits(`[第 2 页] ${"a".repeat(1000)}`);
  const chunks = chunkUnits(units, 200);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().map(unit => unit.text).join(""), "a".repeat(1000));
  assert.ok(chunks.every(chunk => renderUnits(chunk).length <= 200 && chunk[0].locator === "[第 2 页]"));
});

test("rejects fabricated quotes, wrong locations and inconsistent timestamps", () => {
  const units = sourceUnits("[01:20] 预算为 12 万元\n\n[02:00] 尚未验收");
  assert.equal(checkGrounding(fixtureDigest("[01:20]", "预算为 12 万元", 80), units).valid, true);
  for (const digest of [fixtureDigest("[02:00]", "预算为 12 万元", 120), fixtureDigest("[01:20]", "预算为 99 万元", 80), fixtureDigest("[01:20]", "预算为 12 万元", 81)]) {
    assert.equal(checkGrounding(digest, units).valid, false);
  }
});

test("merge cannot invent evidence even if it occurs elsewhere in source", () => {
  const units = sourceUnits("预算为 12 万元，尚未验收");
  const digest = fixtureDigest();
  assert.equal(checkGrounding(digest, units, [digest.keyPoints[0].evidence]).valid, true);
  assert.equal(checkGrounding(fixtureDigest("[段落 1]", "尚未验收"), units, [digest.keyPoints[0].evidence]).valid, false);
});
