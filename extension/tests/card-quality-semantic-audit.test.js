const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const { qualityOutput, checksFor, verificationOutput, requestPayload } = require("./fixtures/quality-output.js");
const context = { userGoal: "能判断增加一件产品是否值得", evidence: [{ id: "material", kind: "text", text: "边际成本是每多生产一个单位额外增加的成本。" }] };
const draft = () => qualityOutput(context);
function fixture(handler) {
  const requests = [];
  const api = quality.createQualityService({ task, getModelConfig: () => ({ model: "fixture" }), transport: { complete: async (_config, request) => {
    const input = requestPayload(request); requests.push(input);
    const output = handler(input, requests) ?? verificationOutput(input) ?? qualityOutput(input);
    return { content: JSON.stringify(output), finishReason: "stop", provider: { model: "fixture", latencyMs: 1 } };
  } } });
  return { api, requests };
}

test("事实审校发现错误时不能被五项全true覆盖，接收盲解结果但不接收自评和用户事实暗示", async () => {
  const original = draft(), before = JSON.stringify(original);
  const env = fixture(input => input.operation === "review" ? { checks: checksFor(input.candidate), findings: [
    { field: "exercise.misconceptions[0]", quote: original.exercise.misconceptions[0], reason: "这是明确记录的测试审校错误" }
  ] } : undefined);
  const output = await env.api.run(context, original, "review");
  assert.equal(output.status, "needs_revision");
  assert.ok(output.quality.issues.some(i => i.code === "semantic_fact" && i.field === "exercise.misconceptions.0"));
  const review = env.requests.find(r => r.operation === "review");
  assert.deepEqual(review.independentAnswer, output.generation.answerVerification);
  assert.equal(review.userGoal, undefined);
  assert.equal(review.candidate.checks, undefined);
  assert.equal(review.candidate.status, undefined, "草稿的ready状态不能作为审校的通过暗示");
  assert.ok(output.generation.answerVerification);
  assert.equal(JSON.stringify(original), before, "独立复核不能改写历史卡片和checks");
});

test("缺失或失配的事实审校失败关闭，不能把任意字段、错误索引和伪引文当作修复依据", async () => {
  const initial = draft();
  const valid = { field: "card.summary", quote: initial.card.summary, reason: "测试问题" };
  for (const findings of [undefined, null, {}, [{ ...valid, field: "__proto__.value" }], [{ ...valid, field: "exercise.misconceptions.30" }],
    [{ ...valid, quote: "候选中不存在的文字" }], [{ ...valid, reason: "" }], [null], Array(9).fill(valid)]) {
    const env = fixture(input => input.operation === "review" ? { checks: checksFor(input.candidate), findings } : undefined);
    const output = await env.api.run(context, initial, "review");
    assert.equal(output.status, "needs_revision");
    assert.equal(output.quality.issues[0].code, "SEMANTIC_REVIEW_INVALID");
  }
});

test("有效的空发现和五项核验可以通过，成功复核也不修改输入对象", async () => {
  const initial = draft(), before = JSON.stringify(initial);
  const env = fixture(() => undefined);
  assert.equal((await env.api.run(context, initial, "review")).status, "ready");
  assert.equal(JSON.stringify(initial), before);
});

test("数组级事实引用必须命中真实条目，不能用数组路径接受伪造原句", async () => {
  const original = draft();
  for (const [quote, code] of [[original.exercise.misconceptions[2], "semantic_fact"], ["这个句子不在任意误区条目中", "SEMANTIC_REVIEW_INVALID"]]) {
    const env = fixture(input => input.operation === "review" ? { checks: checksFor(input.candidate), findings: [
      { field: "exercise.misconceptions", quote, reason: "测试核验发现问题，须修复该原句" }
    ] } : undefined);
    const output = await env.api.run(context, original, "review");
    assert.equal(output.status, "needs_revision");
    assert.equal(output.quality.issues[0].code, code);
  }
});

test("事实错误进入原有一次修复流程，暂停后保留问题，不重新解题或审校已有阶段", async () => {
  let allowRepair = false;
  let reviews = 0;
  const env = fixture(input => {
    if (input.operation === "review") return { checks: checksFor(input.candidate), findings: ++reviews === 1
      ? [{ field: "card.example.text", quote: input.candidate.card.example.text, reason: "本测试要求换一个示例" }] : [] };
    if (input.operation === "repair") {
      assert.ok(input.issues.some(i => i.code === "semantic_fact"));
      if (!allowRepair) throw Object.assign(new Error("budget"), { code: "EVAL_BUDGET_REACHED", sent: false });
      return { card: { example: { type: "example", text: "补充的测试示例。", origin: "authored" } } };
    }
  });
  const paused = await env.api.run(context);
  assert.equal(paused.generation.resume.reviewIssues.length, 1);
  assert.equal(paused.generation.resume.reviewed, true);
  allowRepair = true;
  const resumed = await env.api.run(context, paused, "resume");
  assert.equal(resumed.status, "ready", JSON.stringify(resumed.quality));
  assert.deepEqual(env.requests.map(r => r.operation), ["generate", "solve", "review", "repair", "repair", "review"]);
  assert.equal(reviews, 2);
});

test("修复明确报告材料不足时停止后续请求，既有草稿与原检查状态不变", async () => {
  const original = draft(), before = JSON.stringify(original);
  const pending = { ...original, generation: { resume: { independentReview: true, repairUsed: false, reviewed: false, reviewIssues: [] } } };
  const env = fixture(input => {
    if (input.operation === "review") return { checks: checksFor(input.candidate), findings: [
      { field: "card.summary", quote: input.candidate.card.summary, reason: "本测试的来源不足以支持该结论" }
    ] };
    if (input.operation === "repair") return { status: "insufficient_material", issues: ["需要补充可靠的规则依据"] };
  });
  const output = await env.api.run(context, pending, "resume");
  assert.equal(output.status, "insufficient_material");
  assert.equal(output.quality.passed, false);
  assert.deepEqual(output.issues, ["需要补充可靠的规则依据"]);
  assert.deepEqual(env.requests.map(r => r.operation), ["solve", "review", "repair"]);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(pending.card, original.card);
});

test("只有未获原文支持的变量非严格阈值被拦截，明确规则、数字比较与否定引述保持有效", () => {
  const base = "响应生成后经过的时间是 age；max-age 指定可视为新鲜的时长。";
  for (const [source, text, bad] of [
    [base, "当 age 不超过 max-age 时响应新鲜。", true],
    [base, "当age<=max-age时响应新鲜。", true],
    [base, "当max-age≥age时响应新鲜。", true],
    [base, "当前45≤60，因此本例低于阈值。", false],
    [base, "当前age < max-age。", false],
    [base, "不能推出 age ≤ max-age。", false],
    [base, "age≤max-age的规则不成立。", false],
    [base, "某新例子中x<=y。", false],
    [base + "本模拟系统明确规定 age 小于等于 max-age 时可用。", "age≤max-age时可用。", false],
    [base + "本模拟系统明确规定 max-age 不小于 age 时可用。", "age≤max-age时可用。", false],
    [base + "不能认为 age ≤ max-age。", "age≤max-age时可用。", true]
  ]) {
    const candidate = draft(); candidate.exercise.answerExplanation = text;
    const result = quality.validate(candidate, { evidence: [{ id: "material", kind: "text", text: context.evidence[0].text + source }] }, task, true);
    assert.equal(result.issues.some(i => i.code === "boundary_unverified"), bad, text);
  }
});

test("合法的Python条件表达式、推导式和字符串不得当成单行复合语句", () => {
  for (const [text, bad] of [
    ["def f(x): return x if x else 0", false],
    ["def f(xs): return [x for x in xs if x > 0]", false],
    ["def f(): return '; if x: test'", false],
    ["def f(x): return x # if x: only a comment", false],
    ["def f(x): x += 1; return x", false],
    ["def f(x): if x: return x", true],
    ["def f(x): x += 1; if x: return x", true],
    ["def f(xs): for x in xs: print(x)", true],
    ["def f(x):\n    if x:\n        return x", false]
  ]) {
    const candidate = draft(); candidate.card.example.text = text;
    const result = quality.validate(candidate, context, task, true);
    assert.equal(result.issues.some(i => i.code === "code_format"), bad, text);
  }
});

test("错误字段类型由原结构校验报告，新检查不因数组或对象内容抛出异常", () => {
  for (const value of [null, {}, ["age <= max-age"], 42]) {
    const candidate = draft();
    candidate.card.example.text = value;
    candidate.exercise.answerExplanation = value;
    assert.doesNotThrow(() => quality.validate(candidate, context, task, true));
    assert.equal(quality.validate(candidate, context, task, true).passed, false);
  }
});
