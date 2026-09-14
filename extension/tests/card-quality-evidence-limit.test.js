const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const { checks, qualityOutput, requestPayload, verificationOutput } = require("./fixtures/quality-output.js");
const run = require("./fixtures/regressions/2026-09-03-v2.2.1-single-short-05--run-2026-09-03.json").outputs;
const material = JSON.parse(run.corpus)[0];
const context = { evidence: [{ id: "material", kind: "text", text: material.text }] };
const recorded = run.cases[0].current;

test("真实单样本的三处依据九条关联不超限，仍须独立核验，错误不能因计数修复而放行", async () => {
  const candidate = structuredClone(recorded);
  assert.equal(candidate.quality.issues[0].code, "evidence_limit"); // Original export stays failed.
  const structural = quality.validate(candidate, context, task, false);
  assert.equal(structural.passed, true);
  assert.equal(structural.evidence.length, 9);
  assert.equal(structural.evidence.at(-1).endCharacter, 83);
  assert.equal(quality.validate(candidate, context, task, true).passed, false);
  const operations = [];
  // Reviewer verdict is an authored fixture, not a claim about live detection.
  const failed = checks.map(check => check.rule === "conditions" ? { ...check, passed: false, reason: "所有调用缺少未显式传参的前提" } : check);
  const transport = { complete: async (_settings, request) => {
    const payload = requestPayload(request);
    operations.push(payload.operation);
    if (payload.operation === "review") {
      assert.equal(payload.candidate.evidence.length, 3);
      assert.deepEqual(payload.candidate.supports.example, ["c1", "c2", "c3"]);
      assert.equal(payload.candidate.checks, undefined);
    }
    return { content: JSON.stringify(verificationOutput(payload, candidate.exercise.correctIndex) || (payload.operation === "review" ? { findings: [], checks: failed } : payload.operation === "repair" ? {} : candidate)),
      finishReason: "stop", provider: { model: run.model, latencyMs: 1, usage: { totalTokens: 30 } } };
  } };
  const service = quality.createQualityService({ task, transport, getModelConfig: () => ({ model: run.model }) });
  const result = await service.run(context);
  assert.deepEqual(operations, ["generate", "solve", "review", "repair", "review"]);
  assert.equal(result.status, "needs_revision");
  assert.ok(result.quality.issues.some(issue => issue.code === "semantic_conditions"));
  assert.equal(result.quality.issues.some(issue => issue.code === "evidence_limit"), false);
  assert.equal(recorded.quality.evidence.length, 8);
});

test("八处依据可显式支持四个字段，第九处不同依据与超过三十二条关联仍阻断", () => {
  const text = Array.from({ length: 9 }, (_, i) => "依据" + i + "。").join("");
  const context = { evidence: [{ id: "material", kind: "text", text }] };
  const candidate = qualityOutput(context);
  candidate.evidence = Array.from({ length: 8 }, (_, i) => ({ id: "e" + i, evidenceId: "material", quote: "依据" + i + "。" }));
  candidate.supports = Object.fromEntries(["summary", "exercise", "boundaries", "example"].map(claim => [claim, candidate.evidence.map(ref => ref.id)]));
  const parsed = quality.parse(JSON.stringify(candidate));
  assert.equal(parsed.evidence.length, 32);
  assert.equal(quality.validate(parsed, context, task, false).passed, true);
  assert.equal(quality.validate(parsed, context, task, false).evidence.length, 32);
  parsed.evidence.push(parsed.evidence[0]);
  assert.ok(quality.validate(parsed, context, task, false).issues.some(issue => issue.code === "evidence_links_limit"));
  parsed.evidence = Array.from({ length: 9 }, (_, i) => ({ claim: i === 0 ? "summary" : "exercise", evidenceId: "material", quote: "依据" + i + "。" }));
  assert.ok(quality.validate(parsed, context, task, false).issues.some(issue => issue.code === "evidence_limit"));
});

test("第九条关系的坏引用照常阻断，不能只检查前八条或按引文文字合并不同位置", () => {
  for (const lastRef of [
    { ...recorded.evidence[8], quote: "不存在的引文" },
    { ...recorded.evidence[8], claim: "invented" },
    { claim: "example", invalidReference: { code: "unknown_reference_id", referenceId: "missing" } }
  ]) {
    const candidate = structuredClone(recorded);
    candidate.evidence[8] = lastRef;
    assert.ok(quality.validate(candidate, context, task, false).issues.some(issue => issue.code === "evidence_location"));
  }
  const candidate = qualityOutput(context);
  candidate.evidence = Array.from({ length: 9 }, (_, occurrence) => ({ claim: occurrence === 0 ? "summary" : "exercise", evidenceId: "material", quote: "相同。", occurrence }));
  const repeatedContext = { evidence: [{ id: "material", kind: "text", text: "相同。".repeat(9) }] };
  assert.ok(quality.validate(candidate, repeatedContext, task, false).issues.some(issue => issue.code === "evidence_limit"));
  const separateSources = candidate.evidence.map((_, i) => ({ id: "source" + i, kind: "text", text: "相同。" }));
  candidate.evidence.forEach((ref, i) => { ref.evidenceId = separateSources[i].id; ref.occurrence = 0; });
  assert.ok(quality.validate(candidate, { evidence: separateSources }, task, false).issues.some(issue => issue.code === "evidence_limit"));
});

test("图片同一观察支持多字段只计一次，不同观察仍受八处上限约束", () => {
  const context = { evidence: [{ id: "image", kind: "image" }] };
  const candidate = qualityOutput(context);
  candidate.evidence = ["summary", "exercise", "example"].flatMap(claim => Array.from({ length: 3 }, (_, i) => ({ claim, evidenceId: "image", observation: "可见标签" + i, quote: "" })));
  assert.equal(quality.validate(candidate, context, task, false).passed, true);
  candidate.evidence = Array.from({ length: 9 }, (_, i) => ({ claim: i === 0 ? "summary" : "exercise", evidenceId: "image", observation: "可见标签" + i, quote: "" }));
  assert.ok(quality.validate(candidate, context, task, false).issues.some(issue => issue.code === "evidence_limit"));
});
