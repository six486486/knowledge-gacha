const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const { qualityOutput, requestPayload, checks, checksFor, verificationOutput } = require("./fixtures/quality-output.js");
const run = require("./fixtures/regressions/2026-09-03-v2.2.2-single-short-01--run-2026-09-03.json").outputs;
const recorded = run.cases[0].current;
const context = { evidence: [{ id: "material", kind: "text", text: JSON.parse(run.corpus)[0].text }] };

function shifts(candidate, text) {
  return quality.validate(candidate, { evidence: [{ id: "material", kind: "text", text }] }, task, false).issues.filter(issue => issue.code === "conditions_strengthened");
}

test("真实缓存导出虽然模型全通过，省略修饰语的必要性结论和误区说明仍被阻断", () => {
  const before = JSON.stringify(recorded);
  assert.equal(recorded.status, "ready");
  assert.ok(recorded.checks.every(check => check.passed));
  const result = quality.validate(recorded, context, task, true);
  const issues = result.issues.filter(issue => issue.code === "conditions_strengthened");
  assert.equal(result.passed, false);
  assert.deepEqual(issues.map(issue => issue.field).sort(), ["exercise.answerExplanation", "exercise.misconceptions.3"]);
  assert.ok(issues.every(issue => issue.sourcePhrase === "可以向源站验证" && issue.outputPhrase === "需要验证"));
  assert.equal(result.evidence.length, 6);
  assert.equal(JSON.stringify(recorded), before);
});

test("一次修复未消除已知条件错误时保留问题草稿，不再付费核验或沿用全通过检查", async () => {
  const operations = [];
  const service = quality.createQualityService({ task, getModelConfig: () => ({ model: run.model }),
    transport: { complete: async (_settings, request) => {
      const payload = requestPayload(request);
      operations.push(payload.operation);
      const reply = payload.operation === "generate" ? recorded : { findings: [], checks };
      return { content: JSON.stringify(reply), finishReason: "stop", provider: { model: run.model, latencyMs: 1, usage: { totalTokens: 20 } } };
    } } });
  const result = await service.run(context);
  assert.deepEqual(operations, ["generate", "repair"]);
  assert.equal(result.status, "needs_revision");
  assert.ok(result.quality.issues.some(issue => issue.field === "exercise.misconceptions.3"));
  assert.equal(result.generation.calls.reduce((sum, call) => sum + call.usage.totalTokens, 0), 40);
});

test("省略介词修饰语检查适用于其他材料，区分完整动作、否定和错误观点引用", () => {
  const candidate = qualityOutput(context);
  for (const [source, summary] of [
    ["用户可以向管理员反馈。", "用户必须反馈。"],
    ["系统可能向用户反馈。", "系统一定反馈。"],
    ["资料可以给审核员复核。", "资料需要复核。"]
  ]) {
    candidate.card.summary = summary;
    assert.equal(shifts(candidate, source).length, 1, summary);
  }
  for (const summary of [
    "用户可以反馈。", "用户不需要反馈。", "不能说‘必须反馈’。", "误以为用户必须反馈。",
    "“必须反馈”是错误的。", "必须反馈的说法不成立。", "需要反馈表单。", "需要记录。"
  ]) {
    candidate.card.summary = summary;
    assert.equal(shifts(candidate, "用户可以向管理员反馈。").length, 0, summary);
  }
  candidate.card.summary = "特定流程必须向管理员反馈。";
  assert.equal(shifts(candidate, "用户可以向管理员反馈。特定流程必须向管理员反馈。").length, 0);
  candidate.card.summary = "特定流程必须反馈。";
  assert.equal(shifts(candidate, "用户可以向管理员反馈。特定流程必须向管理员反馈。").length, 0);
});

test("要点和误区的肯定结论参与检查，错误选项及被否定的观点不参与，修复指向完整数组", () => {
  const source = "用户可以向管理员反馈。";
  const candidate = qualityOutput(context);
  candidate.exercise.options[0] = "用户必须反馈。";
  candidate.exercise.rubric = ["用户需要反馈。"];
  candidate.exercise.misconceptions = ["用户必须反馈。", "", "误以为用户必须反馈。"];
  let issues = shifts(candidate, source);
  assert.deepEqual(issues.map(issue => issue.field).sort(), ["exercise.misconceptions.0", "exercise.rubric.0"]);
  const instructions = task.instructionsFor("repair", undefined, issues);
  const shape = JSON.parse(instructions.split("根据本次问题列出的字段结构（按实际修正填写；语义问题另补受影响字段）：")[1].split("\n")[0]);
  assert.deepEqual(Object.keys(shape.exercise).sort(), ["misconceptions", "rubric"]);
  assert.deepEqual(Object.keys(shape.supports), ["exercise"]);
  candidate.exercise.rubric = ["可以向管理员反馈。"];
  candidate.exercise.misconceptions = ["误以为用户必须反馈。", "", "不需要反馈。"];
  issues = shifts(candidate, source);
  assert.equal(issues.length, 0);
});

test("已通过的 short-05 输出仍通过本地检查且保留全部九条关联", () => {
  const prior = require("./fixtures/regressions/2026-09-03-v2.2.2-single-short-05--run-2026-09-03.json").outputs;
  // Historical review format stays unchanged; this regression concerns local
  // condition checks and citation preservation, not the new reviewer contract.
  const result = quality.validate(prior.cases[0].current, { evidence: [{ id: "material", kind: "text", text: JSON.parse(prior.corpus)[0].text }] }, task, false);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
  assert.equal(result.evidence.length, 9);
});

test("真实误区描述不再误报，修复后进入独立核验；没有核验仍不能放行", async () => {
  const latest = require("./fixtures/regressions/2026-09-03-v2.2.3-single-short-01--run-2026-09-03.json").outputs.cases[0].current;
  const before = JSON.stringify(latest);
  assert.equal(latest.quality.issues[0].field, "exercise.misconceptions.3");
  const structural = quality.validate(latest, context, task, false);
  assert.equal(structural.passed, true, JSON.stringify(structural.issues));
  assert.equal(structural.evidence.length, 6);
  assert.equal(quality.validate(latest, context, task, true).passed, false);
  // Reconstruct the two recorded initial errors; the first full response was
  // not exported. The review verdict is a fixture, not a real-model result.
  const first = structuredClone(latest);
  first.card.example.text = first.card.example.text.replace("可以向源站验证", "需要向源站验证");
  first.exercise.answerExplanation = first.exercise.answerExplanation.replace("可以向源站验证", "需要验证");
  const operations = [];
  const service = quality.createQualityService({ task, getModelConfig: () => ({ model: run.model }),
    transport: { complete: async (_settings, request) => {
      const payload = requestPayload(request);
      operations.push(payload.operation);
      if (payload.operation === "repair") {
        assert.deepEqual(payload.issues.map(issue => issue.field).sort(), ["card.example.text", "exercise.answerExplanation"]);
      }
      const reply = verificationOutput(payload, latest.exercise.correctIndex) || (payload.operation === "generate" ? first : payload.operation === "repair" ? latest : { findings: [], checks: checksFor(payload.candidate) });
      return { content: JSON.stringify(reply), finishReason: "stop", provider: { model: run.model, latencyMs: 1, usage: { totalTokens: 20 } } };
    } } });
  const result = await service.run(context);
  assert.deepEqual(operations, ["generate", "repair", "solve", "review"]);
  assert.equal(result.status, "ready");
  assert.equal(JSON.stringify(latest), before);
});

test("只豁免误区字段中被转述的认识，不豁免后续错误纠正或其他字段中的同一句话", () => {
  const candidate = qualityOutput(context);
  const source = "用户可以向管理员反馈。";
  for (const description of ["认为用户需要反馈，但反馈是可选的。", "以为用户必须反馈。", "将反馈理解为义务，认为用户需要反馈。"] ) {
    candidate.exercise.misconceptions = [description, "", ""];
    assert.equal(shifts(candidate, source).length, 0, description);
  }
  for (const description of [
    "用户需要反馈。", "认为用户需要反馈，但用户仍需要反馈。", "以为反馈是可选的。用户必须反馈。"
  ]) {
    candidate.exercise.misconceptions = [description, "", ""];
    assert.deepEqual(shifts(candidate, source).map(issue => issue.field), ["exercise.misconceptions.0"], description);
  }
  candidate.exercise.misconceptions = ["认为用户需要反馈，但反馈是可选的。", "", ""];
  candidate.card.summary = "认为用户需要反馈。";
  candidate.exercise.answerExplanation = "认为用户需要反馈。";
  candidate.exercise.rubric = ["认为用户需要反馈。"];
  assert.deepEqual(shifts(candidate, source).map(issue => issue.field).sort(), ["card.summary", "exercise.answerExplanation", "exercise.rubric.0"]);
});
