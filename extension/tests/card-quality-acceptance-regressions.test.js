const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const { qualityOutput, checksFor, verificationOutput, requestPayload } = require("./fixtures/quality-output.js");
const context = { userGoal: "能判断增量成本", evidence: [{ id: "material", kind: "text", text: "边际成本是每多生产一个单位额外增加的成本。" }] };
const draft = () => structuredClone(qualityOutput(context));
const parse = value => quality.parse(JSON.stringify(value));
const result = (value, ctx = context) => quality.validate(parse(value), ctx, task, true);

test("真实已通过但错误的Python、缓存、闭包和概率输出被新本地校验阻断，原始记录不变", () => {
  const records = require("./fixtures/acceptance-content-regressions.json");
  const expected = { "invalid-python": "code_format", "cache-paraphrase": "conditions_strengthened", "counter-answer": "numeric_answer_mismatch", "bayes-arithmetic": "numeric_calculation" };
  for (const item of records.filter(item => expected[item.id])) {
    const before = JSON.stringify(item);
    assert.equal(item.candidate.status, "ready");
    assert.ok(item.candidate.checks.every(check => check.passed));
    assert.ok(result(item.candidate, item.context).issues.some(issue => issue.code === expected[item.id]), item.id);
    assert.equal(JSON.stringify(item), before);
  }
});

test("显式索引的误区说明可乱序，重复、越界、漏项及正确项的错误解释均被拒绝", () => {
  const base = draft();
  const indexed = [{ index: 2, explanation: "混淆固定支出" }, { index: 0, explanation: "漏扣新增成本" }];
  base.exercise.misconceptions = indexed;
  assert.deepEqual(parse(base).exercise.misconceptions, ["漏扣新增成本", "", "混淆固定支出"]);
  assert.equal(result(base).passed, true);
  for (const values of [[indexed[0]], [...indexed, indexed[0]], [...indexed, { index: 3, explanation: "越界" }],
    [...indexed, { index: 1, explanation: "不能把正确答案当成错误" }], [{ index: "2", explanation: "字符串索引" }, indexed[1]]]) {
    base.exercise.misconceptions = values;
    assert.equal(result(base).passed, false, JSON.stringify(values));
  }
});

test("核验字符串布尔值不能绕过门槛，错误信息说明结构问题", () => {
  for (const value of ["true", "false", 1, null]) {
    const base = draft(); base.checks[0].passed = value;
    const issues = result(base).issues;
    assert.ok(issues.some(issue => issue.code === "semantic_grounding" && /布尔值/.test(issue.message)));
  }
  const prompt = task.instructionsFor("review");
  assert.ok(!prompt.includes('"passed":"true | false"'));
});

function service(handler) {
  const requests = [];
  const api = quality.createQualityService({ task, getModelConfig: () => ({ model: "fixture" }), transport: { complete: async (_, request) => {
    const payload = requestPayload(request); requests.push({ payload, request });
    return { content: JSON.stringify(await handler(payload)), finishReason: "stop", provider: { model: "fixture", latencyMs: 1 } };
  } } });
  return { api, requests };
}
function solved(payload, indices) {
  const value = verificationOutput(payload);
  value.optionJudgments.forEach(item => { item.valid = indices.includes(item.index); });
  return value;
}

for (const indices of [[], [0], [1, 2]]) {
  test("独立解题有效选项 " + JSON.stringify(indices) + " 与单选答案冲突时不被全通过核验覆盖", async () => {
    const f = service(payload => payload.operation === "generate" ? draft() : payload.operation === "solve" ? solved(payload, indices) :
      payload.operation === "repair" ? {} : { findings: [], checks: checksFor(payload.candidate) });
    const output = await f.api.run(context);
    assert.equal(output.status, "needs_revision");
    assert.ok(output.quality.issues.some(issue => issue.code === "independent_answer_mismatch"));
    assert.deepEqual(f.requests.map(item => item.payload.operation), ["generate", "solve", "repair"]);
    const input = f.requests[1].payload;
    assert.deepEqual(Object.keys(input).sort(), ["operation", "options", "question", "sources", "type"]);
    assert.equal(input.candidate, undefined);
    assert.equal(input.correctIndex, undefined);
    assert.equal(input.answer, undefined);
  });
}

test("独立解题逐项核对选项全文与索引，不能混淆人物编号或隐式转换类型", async () => {
  for (const mutate of [v => { v.optionJudgments[0].option = "另一选项"; }, v => { v.optionJudgments[0].valid = "true"; },
    v => { v.optionJudgments[0].index = 1; }, v => { v.optionJudgments.pop(); }]) {
    const f = service(payload => {
      if (payload.operation !== "solve") return draft();
      const value = solved(payload, [1]); mutate(value); return value;
    });
    const output = await f.api.run(context);
    assert.equal(output.status, "needs_revision");
    assert.equal(output.quality.issues[0].code, "ANSWER_REVIEW_INVALID");
    assert.equal(f.requests.length, 2);
  }
});

test("换题后重新独立解题，同题只修答案时复用已有解题结论", async () => {
  for (const changedQuestion of [true, false]) {
    const base = draft();
    base.exercise.correctIndex = 0; base.exercise.answer = base.exercise.options[0];
    base.exercise.misconceptions = ["", "Mock 错误索引", "Mock 错误项"];
    const f = service(payload => {
      if (payload.operation === "generate") return base;
      if (payload.operation === "solve") return solved(payload, [1]);
      if (payload.operation === "review") return { findings: [], checks: checksFor(payload.candidate) };
      const exercise = draft().exercise;
      if (changedQuestion) exercise.question += "请给出数值。";
      return { exercise };
    });
    const output = await f.api.run(context);
    assert.equal(output.status, "ready");
    assert.equal(f.requests.filter(item => item.payload.operation === "solve").length, changedQuestion ? 2 : 1);
  }
});

const imageContext = { userGoal: "能识别Disk所在区域", evidence: [{ id: "image", kind: "image" }], image: { dataUrl: "data:image/png;base64,fixture" } };
const observations = ["左侧标有User Space", "右侧标有Disk", "右侧有蓝色矩形"];
function imageDraft() {
  const value = draft();
  value.card = { title: "图中区域", learningObjective: "能识别Disk的位置", knowledgeType: "fact", summary: "右侧标有Disk。", boundaries: "" };
  value.exercise = { type: "recall", question: "Disk在哪侧？", answer: "右侧", answerExplanation: "图中文字位于右侧。", rubric: ["指出右侧"] };
  value.evidence = ["summary", "exercise"].map(claim => ({ claim, evidenceId: "image", quote: "", observation: observations[1] }));
  value.checks = checksFor(value); return value;
}

test("图片先转写，观察器看不到用户预期，后续仅使用观察记录且不修改原上下文", async () => {
  const before = JSON.stringify(imageContext);
  const f = service(payload => payload.operation === "observe_image" ? { observations, legend: [] } :
    payload.operation === "solve" ? verificationOutput(payload) : payload.operation === "review" ? { findings: [], checks: checksFor(payload.candidate) } : imageDraft());
  const output = await f.api.run(imageContext);
  assert.equal(output.status, "ready");
  assert.deepEqual(f.requests[0].payload, { operation: "observe_image" });
  assert.equal(f.requests[0].request.messages.at(-1).content[1].type, "image_url");
  assert.ok(f.requests.slice(1).every(item => typeof item.request.messages.at(-1).content === "string"));
  assert.deepEqual(f.requests[1].payload.sources[0].observations, observations);
  assert.equal(JSON.stringify(imageContext), before);
});

test("颜色不能自证状态；明确图注可支持状态；表示无法判断的句子可以保留", () => {
  const ctx = { ...imageContext, evidence: [{ ...imageContext.evidence[0], observations, legend: [] }] };
  for (const claim of ["蓝色表示已修改。", "磁盘仍然保持原样。", "磁盘保留原数据。", "空框是保留区。"] ) {
    const value = imageDraft(); value.card.summary = claim;
    assert.ok(result(value, ctx).issues.some(issue => issue.code === "image_claim_unverified"), claim);
  }
  const value = imageDraft(); value.card.summary = "蓝色表示已修改。";
  const caption = { id: "caption", kind: "text", text: "图注：蓝色表示已修改。" };
  value.evidence.push({ claim: "summary", evidenceId: "caption", quote: caption.text });
  assert.equal(result(value, { ...ctx, evidence: [...ctx.evidence, caption] }).passed, true);
  value.card.summary = "仅凭颜色不能判断是否已修改。";
  assert.equal(result(value, { ...ctx, evidence: [...ctx.evidence, caption] }).passed, true);
  value.evidence = value.evidence.filter(item => item.evidenceId !== "caption");
  assert.equal(result(value, ctx).passed, true);
  value.evidence[0].observation = "虚构观察";
  assert.ok(result(value, ctx).issues.some(issue => issue.code === "evidence_location"));
});

test("没有可读图片证据时停止，不继续猜测或付费生成", async () => {
  const f = service(() => ({ observations: [], legend: [] }));
  const output = await f.api.run(imageContext);
  assert.equal(output.status, "insufficient_material");
  assert.equal(f.requests.length, 1);
});

test("目标要求不可见状态时请求补图注，不能偷换为位置识别", async () => {
  const f = service(() => ({ observations, legend: [] }));
  const output = await f.api.run({ ...imageContext, userGoal: "能识别哪一层已被修改" });
  assert.equal(output.status, "insufficient_material");
  assert.match(output.issues[0], /不能把目标改为位置识别/);
  assert.equal(f.requests.length, 1);
});

test("图片观察、生成和解题后的预算暂停均能续跑，已完成阶段不重复请求", async () => {
  for (const initialLimit of [1, 2, 3]) {
    let limit = initialLimit;
    const sent = [];
    const f = service(payload => {
      if (sent.length >= limit) throw Object.assign(new Error("budget"), { code: "EVAL_BUDGET_REACHED", sent: false });
      sent.push(payload.operation);
      return payload.operation === "observe_image" ? { observations, legend: [] } : payload.operation === "solve" ? verificationOutput(payload) :
        payload.operation === "review" ? { findings: [], checks: checksFor(payload.candidate) } : imageDraft();
    });
    const paused = await f.api.run(imageContext);
    assert.equal(paused.status, "needs_revision");
    assert.ok(paused.generation.resume);
    limit = 10;
    const finished = await f.api.run(imageContext, JSON.parse(JSON.stringify(paused)), "resume");
    assert.equal(finished.status, "ready");
    assert.deepEqual(sent, ["observe_image", "generate", "solve", "review"]);
  }
});

test("限定许可不能推导为禁止，原文明确规定的禁止仍可使用", () => {
  const value = draft();
  value.exercise.answerExplanation = "这时不能直接复用。";
  const ctx = { evidence: [{ id: "material", kind: "text", text: "新鲜响应通常可直接复用；陈旧响应可以向源站验证。" }] };
  assert.ok(result(value, ctx).issues.some(issue => issue.code === "conditions_strengthened"));
  ctx.evidence[0].text += "本情景明确禁止复用：这时不能直接复用。";
  assert.equal(result(value, ctx).issues.some(issue => issue.code === "conditions_strengthened"), false);
});

test("返回数值须与解析一致，独立解题的数值也不能被错误参考答案覆盖", async () => {
  const value = draft();
  value.exercise = { type: "recall", question: "连续调用counter()两次，第二次返回什么？", answer: "第二次返回 1。", answerExplanation: "第一次返回 1，第二次返回 2。", rubric: ["返回2"] };
  value.checks = checksFor(value);
  assert.ok(result(value).issues.some(i => i.code === "numeric_answer_mismatch"));
  value.exercise.answerExplanation = "闭包保留词法环境中的状态。";
  const f = service(payload => payload.operation === "generate" ? value : payload.operation === "solve" ? { ...verificationOutput(payload), answer: "第二次返回2。" } : {});
  assert.ok((await f.api.run(context)).quality.issues.some(i => i.code === "numeric_answer_mismatch"));
  value.exercise.answer = "第二次返回2。";
  value.exercise.answerExplanation = "第一次返回1，第二次返回2。";
  assert.equal(result(value).passed, true);
});

test("只解析纯数值四则运算，拒绝错误小数、保留正确百分比和舍入，不执行代码", () => {
  for (const [text, invalid] of [
    ["0.99×0.001+0.05×0.999≈0.0549", true], ["0.99×0.001+0.05×0.999=0.05094", false],
    ["600/1000=60%", false], ["600/1000=6%", true], ["1/3≈0.33", false],
    ["0.99×0.001/(0.99×0.001+0.05×0.999)≈0.0194", false],
    ["0.02×0.6+0.03×0.4=0.012+0.012=0.024", false],
    ["process.exit(1)+2=3", false], ["错误计算为1+2=4，实际1+2=3", false]
  ]) {
    const value = draft(); value.exercise.answerExplanation = text;
    assert.equal(result(value).issues.some(i => i.code === "numeric_calculation"), invalid, text);
  }
});

test("Python复合语句不能压在def同一行，合法单行简单函数与缩进代码仍可用", () => {
  for (const [text, invalid] of [["def g(x, lst=None): if lst is None: lst = []; return lst", true],
    ["def f(x): return x + 1", false], ["def g(x, lst=None):\n    if lst is None:\n        lst = []\n    return lst", false]]) {
    const value = draft(); value.card.example.text = text;
    assert.equal(result(value).issues.some(i => i.code === "code_format"), invalid, text);
  }
});

test("省略向字或改成进行源站验证仍属于条件加强", () => {
  const ctx = { evidence: [{ id: "material", kind: "text", text: "陈旧响应可以向源站验证。" }] };
  for (const text of ["陈旧响应应进行源站验证。", "应源站验证。", "应进行验证。"] ) {
    const value = draft(); value.exercise.answerExplanation = text;
    assert.ok(result(value, ctx).issues.some(i => i.code === "conditions_strengthened"), text);
  }
});

test("代码对照须说明共享变量的初始状态，材料未给出的日志先后顺序不得扩写", () => {
  const value = draft();
  value.card.example = { type: "contrast", origin: "authored", text: "nums=[3,1,2]；调用nums.sort()后nums变为[1,2,3]。若调用sorted(nums)，nums仍为[3,1,2]。" };
  assert.ok(result(value).issues.some(issue => issue.code === "example_context"));
  value.card.example.text = "两个情景独立运行，均从nums=[3,1,2]开始。" + value.card.example.text;
  assert.equal(result(value).passed, true);
  value.card.example = { type: "contrast", origin: "authored", text: "系统先写日志，再修改数据页，崩溃后恢复。" };
  assert.ok(result(value).issues.some(issue => issue.code === "example_context"));
  const ctx = { evidence: [{ id: "material", kind: "text", text: context.evidence[0].text + "系统先写日志，再修改数据页。" }] };
  assert.equal(result(value, ctx).passed, true);
});

test("应、应当、应该的条件加强会阻断；反馈逐字引用错误选项只豁免被引述部分", () => {
  const ctx = { evidence: [{ id: "material", kind: "text", text: "陈旧响应可以向源站验证。" }] };
  for (const word of ["应", "应当", "应该"]) {
    const value = draft(); value.card.summary = "陈旧响应" + word + "向源站验证。";
    assert.ok(result(value, ctx).issues.some(issue => issue.code === "conditions_strengthened"));
    value.card.summary = "对陈旧响应可以向源站验证。";
    value.exercise.options[0] = "应向源站验证";
    value.exercise.misconceptions[0] = "应向源站验证：原文只是可以，没有要求一定验证。";
    assert.equal(result(value, ctx).issues.some(issue => issue.code === "conditions_strengthened"), false);
    value.exercise.misconceptions[0] += "正确做法是应向源站验证。";
    assert.equal(result(value, ctx).issues.some(issue => issue.code === "conditions_strengthened"), true);
  }
});
