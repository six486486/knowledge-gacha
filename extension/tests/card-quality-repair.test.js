const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const corpus = require("../evals/card-quality/cases.json");
const recorded = require("./fixtures/regressions/2026-09-03-v2.2.0-targeted--run-2026-09-03.json").outputs.cases;
const { checks, qualityOutput, requestPayload, verificationOutput } = require("./fixtures/quality-output.js");
const context = { evidence: [{ id: "material", kind: "text", text: "边际成本是每多生产一个单位额外增加的成本。" }] };

test("修复可明确复用请求内已有引用，失配诊断保留，省略新引文仍需重新独立核验", async () => {
  for (const missingId of [false, true]) {
  const operations = [];
  const draft = qualityOutput(context);
  draft.card.boundaries = "比较每多生产一个单位额外增加的成本。";
  if (missingId) {
    draft.evidence = [{ id: "e1", evidenceId: "material", quote: draft.evidence[0].quote }];
    draft.supports = { summary: ["e1"], exercise: ["e1"], boundaries: ["missing"] };
  }
  const service = quality.createQualityService({ task, getModelConfig: () => ({ model: "deepseek-v4-flash-vision-exp" }),
    transport: { complete: async (_settings, request) => {
      const payload = requestPayload(request);
      operations.push(payload.operation);
      let reply = verificationOutput(payload) || draft;
      if (payload.operation === "repair") {
        assert.ok(payload.issues.some(i => i.code === "evidence_boundaries"));
        assert.equal(payload.candidate.evidence.length, 1);
        assert.deepEqual(payload.candidate.supports, { summary: ["c1"], exercise: ["c1"] });
        if (missingId) assert.deepEqual(payload.candidate.invalidReferences, [{ claim: "boundaries", code: "unknown_reference_id", referenceId: "missing" }]);
        reply = { supports: { boundaries: ["c1"] }, checks };
      }
      if (payload.operation === "review") {
        assert.deepEqual(payload.candidate.supports.boundaries, ["c1"]);
        assert.equal(payload.candidate.checks, undefined);
        reply = { findings: [], checks };
      }
      return { content: JSON.stringify(reply), finishReason: "stop", provider: { model: "deepseek-v4-flash-vision-exp", latencyMs: 1 } };
    } } });
  const result = await service.run(context);
  assert.equal(result.status, "ready", JSON.stringify(result.quality));
  assert.deepEqual(operations, ["generate", "repair", "solve", "review"]);
  assert.equal(result.evidence.length, 3);
  assert.ok(result.quality.evidence.every(ref => ref.quote === draft.evidence[0].quote));
  }
});

test("未知、重名和被重定义的引用保留字段与失配原因，不退回猜测关联", () => {
  const bank = [{ id: "c1", evidenceId: "material", quote: context.evidence[0].text }];
  for (const [patch, existing, code] of [
    [{ supports: { boundaries: ["missing"] } }, bank, "unknown_reference_id"],
    [{ supports: { boundaries: ["c1"] } }, [], "unknown_reference_id"],
    [{ supports: { boundaries: ["c1"] } }, [...bank, ...bank], "duplicate_reference_id"],
    [{ evidence: [...bank, ...bank], supports: { boundaries: ["c1"] } }, [], "duplicate_reference_id"],
    [{ evidence: [{ ...bank[0], quote: "其他句子" }], supports: { boundaries: ["c1"] } }, bank, "reference_id_redefined"]
  ]) {
    const parsed = quality.parse(JSON.stringify(patch), existing);
    assert.deepEqual(parsed.evidence, [{ claim: "boundaries", invalidReference: { code, referenceId: code === "unknown_reference_id" && existing.length ? "missing" : "c1" } }]);
    const issue = quality.validate(parsed, context, task, false).issues.find(i => i.code === "evidence_location");
    assert.equal(issue.claim, "boundaries");
    assert.ok(issue.message.includes(code));
  }
  const echo = quality.parse(JSON.stringify({ evidence: bank, supports: { boundaries: ["c1"] } }), bank);
  assert.equal(echo.evidence[0].quote, bank[0].quote);
  assert.equal(echo.evidence[0].invalidReference, undefined);
});

test("本轮缓存被核验全通过的条件加强可由文字规则阻断，原始导出不被改写", () => {
  const sample = corpus.find(c => c.id === "short-01");
  const candidate = structuredClone(recorded.find(c => c.id === sample.id).current);
  const before = JSON.stringify(candidate);
  assert.equal(candidate.status, "ready");
  assert.ok(candidate.checks.every(c => c.passed));
  const result = quality.validate(candidate, { evidence: [{ id: "material", kind: "text", text: sample.text }] }, task, true);
  const shifts = result.issues.filter(i => i.code === "conditions_strengthened");
  assert.equal(result.passed, false);
  assert.deepEqual(shifts.map(i => i.field).sort(), ["card.example.text", "exercise.answerExplanation"]);
  assert.ok(shifts.every(i => i.sourcePhrase === "可以向源站验证" && i.outputPhrase === "需要向源站验证"));
  assert.equal(JSON.stringify(candidate), before);
});

test("条件文字检查覆盖其他材料，同时避开否定句、错误选项和来源明确支持的强表述", () => {
  function shifts(source, summary, other) {
    const candidate = qualityOutput(context);
    Object.assign(candidate, other);
    candidate.card.summary = summary;
    return quality.validate(candidate, { evidence: [{ id: "material", kind: "text", text: source }] }, task, false).issues.filter(i => i.code === "conditions_strengthened");
  }
  for (const [source, summary] of [["可以重新计算。", "必须重新计算。"], ["可能出现误差。", "一定出现误差。"], ["可能会出现误差。", "必然会出现误差。"]]) {
    assert.equal(shifts(source, summary).length, 1);
  }
  for (const summary of ["可以重新计算。", "不需要重新计算。", "并非必须重新计算。", "不能说‘必须重新计算’。", "“必须重新计算”是错误的。"] ) {
    assert.equal(shifts("可以重新计算。", summary).length, 0, summary);
  }
  assert.equal(shifts("通常可以重新计算。发生错误时必须重新计算。", "发生错误时必须重新计算。").length, 0);
  const exercise = qualityOutput(context).exercise;
  exercise.options[0] = "必须重新计算。"; // Wrong option: not an asserted conclusion.
  assert.equal(shifts("可以重新计算。", "按条件选择是否重算。", { exercise }).length, 0);
});

test("修复指引依据实际问题列出示例和误区字段，识别目标不再导致无效修复", () => {
  const instructions = task.instructionsFor("repair", undefined, [
    { code: "example" }, { code: "correct_option_misconception" },
    { code: "conditions_strengthened", field: "exercise.answerExplanation" }, { code: "evidence_location", claim: "boundaries" }
  ]);
  const shape = JSON.parse(instructions.split("根据本次问题列出的字段结构（按实际修正填写；语义问题另补受影响字段）：")[1].split("\n")[0]);
  assert.deepEqual(Object.keys(shape.card), ["example"]);
  assert.deepEqual(Object.keys(shape.exercise), ["misconceptions", "answerExplanation"]);
  assert.deepEqual(Object.keys(shape.supports), ["example", "exercise", "boundaries"]);
  assert.ok(instructions.includes("没有新增引用则省略evidence"));
  const candidate = structuredClone(recorded.find(c => c.id === "image-02").current);
  assert.ok(candidate.card.learningObjective.startsWith("能识别"));
  const result = quality.validate(candidate, { evidence: [{ id: "image", kind: "image" }] }, task, false);
  assert.equal(result.issues.some(i => i.code === "objective"), false);
  assert.equal(result.issues.some(i => i.code === "example"), true);
  assert.equal(result.passed, false);
});
