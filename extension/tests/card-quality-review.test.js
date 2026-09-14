const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const runner = require("../evals/card-quality/paired-runner.js");
const baseline = require("../evals/card-quality/baseline-v1.cjs");
const corpus = require("../evals/card-quality/cases.json");
const { checks, qualityOutput, requestPayload, verificationOutput } = require("./fixtures/quality-output.js");
const prior = require("./fixtures/regressions/2026-09-03-v2.1.2-quick--run-2026-09-03.json").outputs;
const context = { evidence: [{ id: "material", kind: "text", text: "边际成本是每多生产一个单位额外增加的成本。" }], materialLength: 24 };
const config = { model: runner.MODEL, temperature: 0.3 };

function linkedOutput() {
  const result = qualityOutput(context);
  const ref = { ...result.evidence[0], id: "e1" };
  delete ref.claim;
  result.evidence = [ref];
  result.supports = { summary: ["e1"], exercise: ["e1"], boundaries: [], example: [] };
  delete result.checks;
  return result;
}

function fixture(reply) {
  const requests = [];
  let generated;
  const transport = { complete: async (_settings, request) => {
    const payload = requestPayload(request);
    requests.push(payload);
    const response = verificationOutput(payload, generated?.exercise?.correctIndex) || reply(payload, requests.length);
    if (response?.exercise) generated = response;
    return { content: JSON.stringify(response), finishReason: "stop",
      provider: { model: config.model, latencyMs: 1, usage: { totalTokens: 30 } } };
  } };
  const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
  return { requests, transport, service };
}

test("引用表显式关联解释和练习，首次生成无需补引用，核验只收到必要内容", async () => {
  const env = fixture(payload => {
    if (payload.operation !== "review") return linkedOutput();
    assert.deepEqual(Object.keys(payload.candidate).sort(), ["card", "evidence", "exercise", "supports"]);
    assert.equal(payload.relatedCards, undefined);
    assert.equal(payload.request, undefined);
    assert.equal(payload.candidate.evidence.length, 1);
    assert.equal(payload.candidate.evidence[0].quote, "每多生产一个单位额外增加的成本");
    assert.deepEqual(payload.candidate.supports, { summary: ["c1"], exercise: ["c1"] });
    return { findings: [], checks };
  });
  const result = await env.service.run({ ...context, relatedCards: [{ id: "old", summary: "不能用旧卡自证" }] });
  assert.equal(result.status, "ready");
  assert.deepEqual(env.requests.map(p => p.operation), ["generate", "solve", "review"]);
  assert.equal(result.generation.reviewMode, "separate");
  assert.equal(result.evidence.length, 2);
  assert.ok(result.quality.evidence.every(ref => context.evidence[0].text.slice(ref.startCharacter, ref.endCharacter) === ref.quote));
});

test("引用关联不能推断、越权改字段或指向重名及不存在的引用", () => {
  for (const mutate of [
    c => { delete c.supports.exercise; },
    c => { c.supports.exercise = ["missing"]; },
    c => { c.supports.exercise = "e1"; },
    c => { c.evidence.push({ ...c.evidence[0] }); },
    c => { c.evidence[0].claim = "exercise"; },
    c => { c.supports.invented = ["e1"]; },
    c => { c.evidence[0].quote = "材料没有这句话"; },
    c => { c.evidence = [{ id: "e1", kind: "text", text: context.evidence[0].text }]; }
  ]) {
    const output = linkedOutput(); mutate(output);
    const candidate = quality.parse(JSON.stringify(output));
    assert.equal(quality.validate(candidate, context, task, false).passed, false);
  }
  const output = linkedOutput();
  output.card.boundaries = "新增成本不能直接等同总成本";
  assert.ok(quality.validate(quality.parse(JSON.stringify(output)), context, task, false).issues.some(i => i.code === "evidence_boundaries"));
  output.supports.boundaries = ["e1"];
  assert.equal(quality.validate(quality.parse(JSON.stringify(output)), context, task, false).passed, true);
});

test("历史缓存卡把正确选项填成误区时在本地阻断，不静默删除错误文字", () => {
  const sample = corpus.find(c => c.id === "short-01");
  const candidate = structuredClone(prior.cases.find(c => c.id === sample.id).current);
  const original = structuredClone(candidate.exercise.misconceptions);
  const result = quality.validate(candidate, { evidence: [{ id: "material", kind: "text", text: sample.text }] }, task, false);
  assert.ok(result.issues.some(i => i.code === "correct_option_misconception"));
  assert.deepEqual(candidate.exercise.misconceptions, original);
});

test("历史排序、事务和图片自评全通过仍需独立核验，核验失败后不能被修复自评放行", async () => {
  // These reviewer verdicts are test fixtures derived from the recorded review,
  // not proof that a real model can detect the same errors.
  for (const id of ["short-03", "short-08", "image-02"]) {
    const sample = corpus.find(c => c.id === id);
    const candidate = structuredClone(prior.cases.find(c => c.id === id).current);
    assert.ok(candidate.checks.every(c => c.passed));
    if (id === "short-03") candidate.card.summary = candidate.card.summary.replace("应先按次要键排序", "可以先按次要键排序"); // Isolate the wrong intermediate result from the newer condition guard.
    if (id === "image-02") candidate.card.learningObjective = "能判断图中的锁状态与磁盘页面状态"; // Isolate semantic rejection from the existing prefix error.
    const failed = checks.map(c => c.rule === (id === "short-03" ? "coherence" : "grounding")
      ? { ...c, passed: false, reason: id === "short-03" ? "答案依据中的第一次排序结果错误" : "素材不能支持该状态或日志机制" } : c);
    const env = fixture(payload => {
      if (payload.operation === "review") {
        assert.equal(payload.candidate.checks, undefined);
        assert.equal(payload.candidate.quality, undefined);
        assert.equal(payload.candidate.generation, undefined);
        return { findings: [], checks: failed };
      }
      return candidate;
    });
    const ctx = { materialLength: sample.text.length, userGoal: sample.userGoal,
      evidence: sample.text ? [{ id: "material", kind: "text", text: sample.text }] : [{ id: "image", kind: "image" }],
      image: sample.imagePath ? { dataUrl: "data:image/gif;base64,fixture" } : undefined };
    const result = await env.service.run(ctx);
    assert.deepEqual(env.requests.map(p => p.operation), id === "image-02" ? ["observe_image", "generate", "repair"] : id === "short-03" ? ["generate", "repair"] : ["generate", "solve", "review", "repair", "review"]);
    assert.equal(result.status, "needs_revision");
    assert.ok(result.quality.issues.some(i => id === "image-02" ? ["image_claim_unverified", "evidence_location"].includes(i.code) : id === "short-03" ? i.code === "generated_trace_unverified" : i.code.startsWith("semantic_")));
  }
});

test("独立核验漏项、重复矛盾或残留问题均不能用全 true 自评替代", async () => {
  for (const verdict of [
    { findings: [], checks: checks.slice(0, 4) },
    { findings: [], checks: [...checks, { rule: "grounding", passed: false, reason: "仍有错误" }] },
    { findings: [], checks, issues: ["答案仍需修正"] }
  ]) {
    const env = fixture(payload => payload.operation === "review" ? verdict : { ...linkedOutput(), checks });
    const result = await env.service.run(context);
    assert.equal(result.status, "needs_revision");
    assert.equal(env.requests.filter(p => p.operation === "repair").length, 1);
    assert.equal(env.requests.filter(p => p.operation === "review").length, 2);
  }
});

test("预算在独立核验后、修复前用尽时保留判定，续跑不再付费核验原草稿", async () => {
  const env = fixture((payload, count) => payload.operation === "review"
    ? { findings: [], checks: count === 3 ? checks.map(c => c.rule === "conditions" ? { ...c, passed: false, reason: "题目未限定条件" } : c) : checks }
    : linkedOutput());
  const cases = [corpus[0]];
  const options = { cases, task, baseline, config, transport: env.transport, service: env.service, mode: "current" };
  // Keep the fixture's quote within this test material.
  cases[0] = { ...cases[0], text: context.evidence[0].text };
  const report = await runner.run({ ...options, limits: { maxRequests: 3, maxTokens: 1000 } });
  assert.equal(report.status, "budget_reached");
  assert.equal(report.failure.operation, "repair");
  assert.equal(report.cases[0].currentAttempts[0].generation.resume.reviewed, true);
  await runner.run({ ...options, report, limits: { maxRequests: 5, maxTokens: 1000 } });
  assert.equal(report.status, "awaiting_ai_review");
  assert.deepEqual(env.requests.map(p => p.operation), ["generate", "solve", "review", "repair", "review"]);
  assert.equal(report.cases[0].current.status, "ready");
  assert.equal(report.budget.requestsUsed, 5);
  assert.equal(report.budget.knownTokens, 150);
});

test("定向集先检查曾截断样本，只跑五份且与快速集和旧任务隔离", async () => {
  const cases = runner.selectCases(corpus, "targeted");
  assert.deepEqual(cases.map(c => c.id), ["short-05", "short-01", "short-03", "short-08", "image-02"]);
  const report = runner.createReport(cases, task, baseline, config.model, "targeted");
  assert.equal(runner.canResume(report, cases, task, baseline, config.model, "quick"), false);
  assert.equal(runner.canResume(prior, JSON.parse(prior.corpus), task, baseline, config.model, "quick"), false);
  assert.equal(runner.exportBundle(report, cases, () => 0).blindReview.length, 5);
  assert.deepEqual(runner.MODES.targeted, { label: "定向检查", maxRequests: 31, maxTokens: 70000 });
});
