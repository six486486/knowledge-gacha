const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const provider = require("../src/backend/provider/provider-transport.js");
const domain = require("../src/frontend/domain/card-domain.js");
const { createExtensionService, DB_KEY } = require("../src/backend/application/extension-service.js");
const { memoryStorage } = require("../src/shared/runtime-utils.js");
const { checks, checksFor, requestPayload, qualityOutput, verificationOutput } = require("./fixtures/quality-output.js");
const text = "边际成本是每多生产一个单位额外增加的成本。";
const context = { evidence: [{ id: "material", kind: "text", text }], materialLength: text.length };

test("结构化问题保留可读信息，不把对象显示为字符串占位", () => {
  const result = quality.parse(JSON.stringify({ status: "insufficient_material", issues: ["补充原文", { code: "missing", message: "缺少响应头" }, { reason: "缺少请求来源" }, null, {}, 42] }));
  assert.deepEqual(result.issues, ["补充原文", "缺少响应头", "缺少请求来源"]);
  assert.equal(quality.validate(result, context, task, true).issues[0].message, "补充原文；缺少响应头；缺少请求来源");
});

test("修复复制输入材料仍阻断，只有模型明确给出的引用和新检查能解除问题", async () => {
  for (const copiesSource of [true, false]) {
    const f = fixture((value, payload) => {
      assert.ok(payload.sources.length);
      assert.equal(payload.evidence, undefined);
      if (payload.operation === "generate") {
        value.card.boundaries = text;
        value.evidence = value.evidence.filter(ref => ref.claim === "summary");
      }
      if (payload.operation === "repair") return copiesSource
        ? { evidence: payload.sources, issues: payload.issues }
        : { evidence: [{ evidenceId: "material", claims: ["exercise", "boundaries"], quote: text }], checks };
      return value;
    });
    const draft = await f.draft();
    assert.equal(draft.status, copiesSource ? "needs_revision" : "ready");
    assert.deepEqual(f.requests.map(request => request.operation), copiesSource ? ["generate", "repair"] : ["generate", "repair", "solve", "review"]);
    if (copiesSource) {
      assert.ok(draft.quality.issues.some(issue => issue.code === "evidence_location"));
      assert.ok(draft.quality.issues.some(issue => issue.code === "evidence_exercise"));
      assert.ok(draft.quality.issues.every(issue => issue.message !== "[object Object]"));
      assert.throws(() => f.service.confirmGachaCardDraft(draft.id), /质量核验/);
    } else {
      assert.deepEqual(draft.evidence.map(ref => ref.claim), ["summary", "exercise", "boundaries"]);
      assert.equal(draft.quality.checks.length, 5);
    }
  }
});

test("同一引文只展开模型明确指定的字段，缺失边界或非法字段仍阻断", () => {
  const candidate = qualityOutput(context);
  candidate.card.boundaries = text;
  candidate.evidence = [{ evidenceId: "material", claims: ["summary", "exercise", "boundaries"], quote: text }];
  const parsed = quality.parse(JSON.stringify(candidate));
  assert.deepEqual(parsed.evidence.map(ref => ref.claim), ["summary", "exercise", "boundaries"]);
  assert.equal(quality.validate(parsed, context, task, true).passed, true);
  for (const claims of [["summary", "exercise"], ["summary", "exercise", "invented"], [], ["summary", "exercise", "boundaries", "example", "summary"]]) {
    candidate.evidence[0].claims = claims;
    assert.equal(quality.validate(quality.parse(JSON.stringify(candidate)), context, task, true).passed, false);
  }
});

test("生产制卡各阶段通过统一出口关闭思考，仍保持分阶段输出预算", async () => {
  const requests = [];
  const transport = provider.createProviderTransport({ fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const payload = requestPayload(request);
    let output = qualityOutput(payload);
    if (payload.operation === "generate") output.card.boundaries = "需补充依据";
    if (payload.operation === "repair") output = { card: { boundaries: "" } };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  } });
  const service = quality.createQualityService({ task, transport, getModelConfig: () => ({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "deepseek-v4-flash-vision-exp" }) });
  const result = await service.run(context);
  assert.equal(result.status, "ready");
  assert.deepEqual(requests.map(request => requestPayload(request).operation), ["generate", "repair", "solve", "review"]);
  assert.deepEqual(requests.map(request => request.max_tokens), [3000, 1800, 1000, 1600]);
  assert.ok(requests.every(request => request.thinking.type === "disabled"));
  assert.ok(requests[1].messages[0].content.length < requests[0].messages[0].content.length);
  assert.ok(requests[2].messages[0].content.length < requests[0].messages[0].content.length);
  assert.deepEqual(result.generation.calls.map(call => call.requestOptions.max_tokens), [3000, 1800, 1000, 1600]);
  assert.ok(result.generation.calls.every(call => call.thinkingPolicy === provider.THINKING_POLICY));
  for (const model of ["mock", "deepseek-chat", "deepseek-v4-flash-custom"]) assert.deepEqual(task.requestOptions(model, "generate"), {});
});

test("输出截断保留真实用量和已有草稿，不触发另一轮付费修复", async () => {
  for (const phase of ["generate", "repair"]) {
    const requests = [];
    const transport = { complete: async (_config, request) => {
      const payload = requestPayload(request); requests.push(payload.operation);
      const output = qualityOutput(payload); output.card.boundaries = "缺少引用";
      return { content: payload.operation === phase ? '{"card":' : JSON.stringify(output), finishReason: payload.operation === phase ? "length" : "stop",
        provider: { model: "deepseek-v4-flash-vision-exp", latencyMs: 1, usage: { totalTokens: 99 } } };
    } };
    const service = quality.createQualityService({ task, transport, getModelConfig: () => ({ model: "deepseek-v4-flash-vision-exp" }) });
    const result = await service.run(context);
    assert.deepEqual(requests, phase === "generate" ? ["generate"] : ["generate", "repair"]);
    assert.equal(result.status, "needs_revision");
    assert.equal(result.generation.calls.at(-1).error, "MODEL_OUTPUT_LIMIT");
    assert.equal(result.generation.calls.at(-1).usage.totalTokens, 99);
    assert.deepEqual(result.generation.calls.at(-1).outputDiagnostics, { characters: 8, completeJson: false, head: '{"card":', tail: "", omittedCharacters: 0 });
    assert.ok(!result.quality.issues[0].message.includes("缩小材料"));
    if (phase === "repair") assert.equal(result.card.boundaries, "缺少引用");
  }
});

test("服务标记长度截断时，即使 JSON 可解析也不绕过质量核验", async () => {
  let requests = 0;
  const content = JSON.stringify(qualityOutput(context));
  const transport = { complete: async () => { requests++; return { content, finishReason: "length", provider: { model: "mock", latencyMs: 1, usage: { totalTokens: 99 } } }; } };
  const service = quality.createQualityService({ task, transport, getModelConfig: () => ({ model: "mock" }) });
  const result = await service.run(context);
  assert.equal(requests, 1);
  assert.equal(result.status, "needs_revision");
  assert.equal(result.quality.passed, false);
  const diagnostics = result.generation.calls[0].outputDiagnostics;
  assert.equal(diagnostics.characters, content.length);
  assert.equal(diagnostics.completeJson, true);
  assert.equal(diagnostics.head + diagnostics.tail, content);
  assert.equal(result.generation.calls[0].content, undefined);
});

test("超长回复只保留有界首尾诊断片段，不保存整段或请求配置", async () => {
  const content = '{"card":{"summary":"' + "x".repeat(6000);
  const transport = { complete: async () => ({ content, finishReason: "length", provider: { model: "mock", latencyMs: 1 } }) };
  const service = quality.createQualityService({ task, transport, getModelConfig: () => ({ model: "mock", apiKey: "secret-not-in-output" }) });
  const result = await service.run(context);
  const diagnostics = result.generation.calls[0].outputDiagnostics;
  assert.equal(diagnostics.head.length + diagnostics.tail.length, 2000);
  assert.equal(diagnostics.head, content.slice(0, 800));
  assert.equal(diagnostics.tail, content.slice(-1200));
  assert.equal(diagnostics.omittedCharacters, content.length - 2000);
  assert.ok(!JSON.stringify(result).includes("secret-not-in-output"));
  assert.equal(result.card, null);
});
function fixture(transform = value => value) {
  const storage = memoryStorage();
  const requests = [];
  const service = createExtensionService({ storage, cardDomain: domain, providerModule: {}, modelConfig: { model: "mock", temperature: 0 },
    providerTransport: { complete: async (_, request) => {
      assert.equal(request.tools, undefined);
      assert.equal(request.temperature, 0);
      const payload = requestPayload(request); requests.push(payload);
      const output = verificationOutput(payload) || await transform(qualityOutput(payload), payload, requests.length);
      return { content: typeof output === "string" ? output : JSON.stringify(output), provider: { model: "mock", latencyMs: 2, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } };
    } } });
  return { service, storage, requests, db: () => JSON.parse(storage.getItem(DB_KEY + ":default")), draft: async (extra = {}) => (await service.createGachaCardDraft({ text, ...extra })).session };
}

test("必需项、占位选项、答案索引和逐字引用分别阻止成品卡", () => {
  const base = qualityOutput(context);
  assert.equal(quality.validate(base, context, task, true).passed, true);
  for (const mutate of [
    c => { delete c.card.learningObjective; }, c => { c.card.summary = ""; }, c => { c.exercise.answer = "不存在"; },
    c => { c.exercise.correctIndex = 7; }, c => { c.exercise.options[0] = "先收藏以后再说"; }, c => { c.exercise.rubric = []; },
    c => { c.exercise.misconceptions = []; }, c => { c.evidence[0].quote = "编造的来源"; }, c => { c.evidence[0].occurrence = 9; },
    c => { c.checks[0] = { rule: "grounding", passed: false, reason: "结论没有依据" }; }
  ]) { const candidate = structuredClone(base); mutate(candidate); assert.equal(quality.validate(candidate, context, task, true).passed, false); }
});

test("一次定向修复后仍错误，保留问题草稿且不可确认", async () => {
  const f = fixture(value => { if (value.exercise) value.exercise.answer = "错"; return value; });
  const draft = await f.draft();
  assert.equal(draft.status, "needs_revision");
  assert.deepEqual(f.requests.map(r => r.operation), ["generate", "repair"]);
  assert.ok(f.requests[1].issues.some(i => i.code === "answer_consistency"));
  assert.throws(() => f.service.confirmGachaCardDraft(draft.id), /质量核验/);
  assert.equal(f.db().learningState.cards.length, 0);
  assert.equal((await f.service.listGachaCardDrafts()).sessions.length, 1);
});

test("省略正确选项空位的误区数组按选项顺序对齐，真正缺少误区仍阻断", () => {
  for (let count = 2; count <= 5; count++) for (let index = 0; index < count; index++) {
    const candidate = qualityOutput(context);
    const options = Array.from({ length: count }, (_, i) => "具体选项" + i);
    const reasons = options.filter((_, i) => i !== index).map(option => option + "忽略了新增单位的成本");
    candidate.exercise = { ...candidate.exercise, options, correctIndex: index, answer: options[index], misconceptions: reasons };
    candidate.checks = checksFor(candidate);
    const parsed = quality.parse(JSON.stringify(candidate));
    assert.equal(quality.validate(parsed, context, task, true).passed, true);
    assert.deepEqual(parsed.exercise.misconceptions, options.map((option, i) => i === index ? "" : option + "忽略了新增单位的成本"));
    assert.equal(reasons.length, count - 1);
  }
  for (const reasons of [[], ["只解释了一个误区"], ["解释了第一个误区", ""]]) {
    const candidate = qualityOutput(context);
    candidate.exercise.misconceptions = reasons;
    assert.ok(quality.validate(quality.parse(JSON.stringify(candidate)), context, task, true).issues.some(i => i.code === "misconceptions"));
  }
});

test("仅修复边界时保留整卡、练习及其他引用，缺少新检查则独立复核", async () => {
  for (const repairChecks of [undefined, { grounding: true }, [null]]) {
    let original;
    const f = fixture((value, payload) => {
      if (payload.operation === "generate") {
        value.card.boundaries = "待补充边界依据";
        original = structuredClone(value);
      }
      if (payload.operation === "repair") return { card: { boundaries: text }, evidence: [{ evidenceId: "material", claim: "boundaries", quote: text }], checks: repairChecks };
      return value;
    });
    const draft = await f.draft();
    assert.equal(draft.status, "ready");
    assert.equal(draft.card.title, original.card.title);
    assert.equal(draft.card.summary, original.card.summary);
    assert.deepEqual(quality.pick(draft.exercise, quality.EXERCISE_FIELDS), original.exercise);
    assert.equal(draft.card.boundaries, text);
    assert.deepEqual(draft.evidence.map(ref => ref.claim), ["summary", "exercise", "boundaries"]);
    assert.deepEqual(f.requests.map(r => r.operation), ["generate", "repair", "solve", "review"]);
    assert.equal(f.requests[3].candidate.checks, undefined);
    assert.equal(draft.generation.reviewMode, "separate");
  }
});

test("局部修复后的核验失败仍阻断，且不重复修复", async () => {
  const f = fixture((value, payload) => {
    if (payload.operation === "generate") value.card.boundaries = "待补充边界依据";
    if (payload.operation === "repair") return { card: { boundaries: "" } };
    if (payload.operation === "review") return { findings: [], checks: checks.map(check => check.rule === "conditions" ? { ...check, passed: false, reason: "原文条件仍被遗漏" } : check) };
    return value;
  });
  const draft = await f.draft();
  assert.equal(draft.status, "needs_revision");
  assert.ok(draft.card.title);
  assert.ok(draft.exercise.question);
  assert.ok(draft.quality.issues.some(i => i.code === "semantic_conditions"));
  assert.deepEqual(f.requests.map(r => r.operation), ["generate", "repair", "solve", "review"]);
  assert.throws(() => f.service.confirmGachaCardDraft(draft.id), /质量核验/);
});

test("局部修复的非法引用继续阻断，材料不足状态不与旧卡合并", async () => {
  for (const patch of [{ card: { boundaries: "" }, evidence: [null] }, { status: "insufficient_material", issues: ["补充原文条件"], card: null }]) {
    const f = fixture((value, payload) => {
      if (payload.operation === "generate") value.card.boundaries = "待补充边界依据";
      return payload.operation === "repair" ? patch : value;
    });
    const draft = await f.draft();
    assert.equal(draft.status, patch.status || "needs_revision");
    assert.ok(draft.quality.issues.some(i => i.code === (patch.status || "evidence_location")));
    if (patch.status) assert.equal(draft.card, null);
    assert.deepEqual(f.requests.map(r => r.operation), ["generate", "repair"]);
  }
});

test("局部重做练习后再修复答案，不回退到旧题或覆盖用户其他编辑", async () => {
  const f = fixture((value, payload) => {
    if (payload.operation === "revise") {
      value.exercise.question = "新增两杯时，如何识别新增成本？";
      value.exercise.answer = "需要修复的答案";
    }
    if (payload.operation === "repair") return { exercise: { answer: payload.candidate.exercise.options[payload.candidate.exercise.correctIndex] } };
    return value;
  });
  const first = await f.draft();
  await f.service.updateGachaCardDraft(first.id, { title: "保留用户标题", summary: "保留用户解释" });
  const revised = (await f.service.reviseGachaCardDraft(first.id, "exercise")).session;
  assert.equal(revised.status, "ready");
  assert.equal(revised.card.title, "保留用户标题");
  assert.equal(revised.card.summary, "保留用户解释");
  assert.equal(revised.exercise.question, "新增两杯时，如何识别新增成本？");
  assert.equal(revised.exercise.answer, revised.exercise.options[revised.exercise.correctIndex]);
  assert.deepEqual(f.requests.map(r => r.operation), ["generate", "solve", "review", "revise", "repair", "solve", "review"]);
});

test("语义失败可以修复一次；解析失败不补通用内容", async () => {
  const repaired = fixture((value, payload, count) => payload.operation === "review" && count === 3 ? { ...value, checks: [{ rule: "answerCorrectness", passed: false, reason: "答案不符" }] } : value);
  assert.equal((await repaired.draft()).status, "ready");
  assert.deepEqual(repaired.requests.map(r => r.operation), ["generate", "solve", "review", "repair", "review"]);
  const malformed = fixture(() => "这不是JSON");
  const draft = await malformed.draft();
  assert.equal(draft.status, "needs_revision");
  assert.equal(draft.card, null);
  assert.equal(malformed.requests.length, 2);
});

test("多知识点不静默取第一张；材料不足也保留可恢复状态", async () => {
  for (const output of [{ cards: [{ title: "甲" }, { title: "乙" }] }, { status: "insufficient_material", issues: ["缺少具体条件"], card: null }]) {
    const f = fixture(() => output);
    const draft = await f.draft();
    assert.equal(draft.status, output.cards ? "needs_split" : "insufficient_material");
    assert.equal(f.requests.length, 1);
    assert.throws(() => f.service.confirmGachaCardDraft(draft.id));
  }
});

test("相关资料、旧卡摘要与明确偏好经不同字段进入制卡上下文", async () => {
  const f = fixture();
  await f.service.ingestDocument({ source: { title: "边际成本", content: text + " 多一份咖啡的原料费是新增成本。" } });
  await f.service.replaceLearningState({ cards: [domain.sanitizeCard({ id: "old", title: "边际成本", summary: text })], pending: [] });
  const preference = await f.service.createPreferenceMemory({ category: "learning_format", value: "先给实例", mutationId: "format-example" });
  const draft = await f.draft({ userGoal: "能判断新增一杯的成本" });
  assert.equal(f.requests[0].userGoal, "能判断新增一杯的成本");
  assert.ok(f.requests[0].sources.some(item => item.id.startsWith("related_") && item.text.includes("边际成本")));
  assert.equal(f.requests[0].evidence, undefined);
  assert.equal(f.requests[0].relatedCards[0].title, "边际成本");
  assert.equal(f.requests[0].preferences, undefined);
  assert.deepEqual(f.requests[0].learningContext.appliedPreferenceIds, [preference.memory.id]);
  assert.equal(f.requests[0].learningContext.explicitPreferences[0].value, "先给实例");
  assert.equal(f.requests[1].learningContext, undefined);
  assert.equal(draft.generation.calls[0].usage.totalTokens, 30);
  assert.equal(draft.generation.promptVersion, task.version);
});

test("局部重做保留其他用户修改，解释更改会使旧答案待核验", async () => {
  const f = fixture((value, payload) => payload.operation === "review" && payload.candidate.card.summary === "错误解释" ? { findings: [], checks: checks.map(check => check.rule === "answerCorrectness" ? { ...check, passed: false, reason: "解释与答案冲突" } : check) } : value);
  const draft = await f.draft();
  await f.service.updateGachaCardDraft(draft.id, { title: "用户保留的完整长标题：增加产量时如何计算边际成本", summary: "用户手写解释" });
  const changed = (await f.service.reviseGachaCardDraft(draft.id, "example")).session;
  assert.equal(changed.card.summary, "用户手写解释");
  assert.ok(changed.card.title.startsWith("用户保留"));
  assert.deepEqual(changed.exercise, draft.exercise);
  assert.notEqual(changed.card.example.text, draft.card.example.text);
  await f.service.updateGachaCardDraft(draft.id, { summary: "错误解释" });
  assert.throws(() => f.service.confirmGachaCardDraft(draft.id), /质量核验/);
  const reviewed = (await f.service.reviseGachaCardDraft(draft.id, "review")).session;
  assert.equal(reviewed.status, "needs_revision");
  assert.throws(() => f.service.confirmGachaCardDraft(draft.id), /质量核验/);
});

test("长材料与图片独立核验，视觉依据不冒充文字引文", async () => {
  const long = fixture();
  const draft = await long.draft({ text: text.repeat(100) });
  assert.equal(draft.status, "ready");
  assert.deepEqual(long.requests.map(r => r.operation), ["generate", "solve", "review"]);
  const f = fixture();
  const imageDraft = await f.draft({ text: "", image: { dataUrl: "data:image/png;base64,abc" }, source: { type: "image", title: "图" } });
  const saved = await f.service.confirmGachaCardDraft(imageDraft.id);
  assert.equal(saved.card.citations.length, 0);
  assert.equal(saved.card.visualEvidence.length, 2);
  assert.equal(f.db().drafts[0].context, undefined);
  assert.equal(f.db().drafts[0].material, undefined);
});

test("多字段共用三段依据时生成不误修复，收下与重新读取保留全部九条引用", async () => {
  const parts = ["边际成本是新增单位的额外成本。", "增量收入减去增量成本得到增量收益。", "没有改变的月租不计入增量成本。"];
  const f = fixture((value, payload) => {
    if (payload.operation !== "review") value.evidence = ["summary", "exercise", "example"].flatMap(claim => parts.map(quote => ({ claim, evidenceId: "material", quote })));
    return value;
  });
  const draft = await f.draft({ text: parts.join("") });
  assert.equal(draft.status, "ready");
  assert.deepEqual(f.requests.map(request => request.operation), ["generate", "solve", "review"]);
  assert.equal(draft.quality.evidence.length, 9);
  const saved = await f.service.confirmGachaCardDraft(draft.id);
  assert.equal(saved.card.citations.length, 9);
  const stored = f.db().learningState.cards[0];
  assert.equal(stored.citations.length, 9);
  const restored = domain.sanitizeCard(stored);
  assert.equal(restored.citations.length, 9);
  assert.deepEqual(restored.citations.slice(6).map(ref => ref.claim), ["example", "example", "example"]);
  assert.equal(restored.citations[8].quote, parts[2]);
  assert.equal(domain.normalizeCitations(stored.citations).length, 8); // Legacy limit remains unchanged.
});

test("独立练习原子保存，重复确认不重复；回忆题自评分与题目版本入事件", async () => {
  const f = fixture(value => { if (value.exercise) value.exercise = { type: "recall", question: "增量决策为什么不计入固定的历史支出？", answer: "因为决策不会改变该支出", answerExplanation: "比较的是新增部分", rubric: ["识别不变成本"] }; return value; });
  const draft = await f.draft();
  const { card } = await f.service.confirmGachaCardDraft(draft.id);
  await f.service.confirmGachaCardDraft(draft.id);
  assert.equal(f.db().exercises.length, 1);
  assert.equal(f.db().exercises[0].cardId, card.id);
  assert.equal(f.db().learningUnits[0].learningObjective, card.learningObjective);
  await f.service.continueGachaReview({ mutationId: "release-recall-card" });
  const opened = await f.service.openGachaReview(card.id);
  assert.equal(opened.question.type, "recall");
  assert.equal(Object.hasOwn(opened.question, "answer"), false);
  assert.throws(() => f.service.answerGachaReview(card.id, { attemptId: opened.question.attemptId, selfAssessedCorrect: true }), /对照要点/);
  await f.service.revealGachaReviewAnswer(card.id, { attemptId: opened.question.attemptId, responseText: "固定支出不会被当前决策改变" });
  await f.service.answerGachaReview(card.id, { attemptId: opened.question.attemptId, selfAssessedCorrect: true, responseText: "固定支出不会被当前决策改变",
    exerciseId: opened.question.exerciseId, exerciseVersion: 1, mutationId: "recall-self-assessment" });
  assert.equal(f.db().reviewEvents[0].assessment, "self");
  assert.equal(f.db().reviewEvents[0].exerciseId, opened.question.exerciseId);
});

test("异步局部结果不能覆盖期间发生的用户修改", async () => {
  let release;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async (value, payload) => { if (payload.operation === "revise") { began(); await blocked; } return value; });
  const draft = await f.draft();
  const revision = f.service.reviseGachaCardDraft(draft.id, "example");
  await started;
  await f.service.updateGachaCardDraft(draft.id, { title: "期间的新修改" });
  release();
  await assert.rejects(revision, /草稿已变化/);
  assert.equal((await f.service.getGachaCardDraft(draft.id)).session.card.title, "期间的新修改");
});

test("相关来源在确认前改变会阻止保存；引用相同文字也要核对版本", async () => {
  const f = fixture((value, payload) => {
    if (value.evidence) value.evidence.forEach(ref => { const source = payload.sources.find(item => item.id.startsWith("related_")); ref.evidenceId = source.id; ref.quote = source.text; });
    return value;
  });
  const { document } = await f.service.ingestDocument({ source: { title: "边际成本", content: text } });
  const draft = await f.draft();
  const db = f.db();
  db.sources.find(source => source.documentId === document.id).version += 1;
  f.storage.setItem(DB_KEY + ":default", JSON.stringify(db));
  assert.throws(() => f.service.confirmGachaCardDraft(draft.id), /相关来源已变化/);
  assert.equal(f.db().learningState.cards.length, 0);
  assert.equal(f.db().exercises.length, 0);
});
