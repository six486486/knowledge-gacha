const test = require("node:test");
const assert = require("node:assert/strict");
const domain = require("../src/frontend/domain/card-domain.js");
const index = require("../src/shared/material-index.js");
const { createExtensionService, DB_KEY } = require("../src/backend/application/extension-service.js");
const { memoryStorage } = require("../src/shared/runtime-utils.js");
const { requestPayload, verificationOutput } = require("./fixtures/quality-output.js");
const { planOutput, batchQualityOutput } = require("./fixtures/knowledge-plan-output.js");

const TEXT = "# 增量成本\n边际成本是每多生产一个单位额外增加的成本。\n\n只有增加产量时才比较该增量。\n\n# 固定支出\n月租在本次决策中保持不变，不应重复计入增量；但扩大场地时租金可能改变。\n";
const KEY = DB_KEY + ":default";
const NOW = 1788400000000;

test("模型学习目标格式错误只修复一次且受请求预算约束，失败不写入半份清单", async () => {
  for (const [limit, succeeds] of [[1, true], [2, true], [3, false]]) {
    let attempts = 0;
    const f = fixture(payload => {
      attempts += 1;
      const output = planOutput(payload);
      if (attempts === 1 || !succeeds) output.units[0].learningObjective = "理解增量成本";
      else {
        assert.match(payload.repairIssues[0], /学习目标/);
        assert.equal(payload.invalidResponse.units[0].learningObjective, "理解增量成本");
      }
      return output;
    });
    const created = await f.service.createKnowledgePlan({ text: TEXT });
    const output = await f.service.analyzeKnowledgePlan(created.plan.id, { maxRequests: limit });
    assert.equal(attempts, limit === 1 ? 1 : 2);
    assert.equal(output.plan.status, limit > 1 && succeeds ? "ready" : "needs_attention");
    if (output.plan.status !== "ready") assert.equal(output.plan.units.length, 0);
  }
});
function fixture(handler, storage = memoryStorage()) {
  const calls = [];
  const service = createExtensionService({ storage, cardDomain: domain, providerModule: {}, now: () => NOW,
    getModelConfig: () => ({ model: "fixture", apiKey: "not-a-real-key" }), providerTransport: { complete: async (_, request) => {
      const payload = requestPayload(request);
      calls.push({ payload, request });
      const result = verificationOutput(payload) || (handler ? await handler(payload, calls) : ["plan", "transcribe"].includes(payload.operation) ? planOutput(payload) : batchQualityOutput(payload));
      return { content: JSON.stringify(result), finishReason: "stop", provider: { model: "fixture", latencyMs: 1, usage: { totalTokens: 18 } } };
    } } });
  return { service, calls, storage, db: () => JSON.parse(storage.getItem(KEY) || "{}") };
}
async function prepare(f, overrides = {}) {
  const created = await f.service.createKnowledgePlan({ text: TEXT, source: { type: "file", title: "成本.md" }, ...overrides });
  return f.service.analyzeKnowledgePlan(created.plan.id);
}
async function generate(f, overrides = {}) {
  const ready = await prepare(f, overrides);
  assert.equal(ready.plan.status, "ready", ready.plan.error);
  return f.service.generateCardBatch(ready.plan.id);
}
async function save(f, view, unitIds = view.plan.units.filter(unit => unit.selected).map(unit => unit.id)) {
  const confirmation = await f.service.prepareCardBatchConfirmation(view.batch.id, unitIds);
  return f.service.confirmCardBatch(view.batch.id, confirmation.selection);
}

test("材料块保留段落、表格、代码、例外和精确位置；短目标仍可直达单卡", () => {
  const text = "# 比较\n前提是价格不变。\n\n| 品类 | 金额 |\n| --- | --- |\n| A | 10 |\n\n```js\nconst x = 2;\n```\n\n但涨价是例外。\n\n前提是价格不变。";
  const material = { id: "material_test", text, version: 2 };
  const chunks = index.splitMaterial(material);
  assert.deepEqual(new Set(chunks.map(chunk => chunk.kind)), new Set(["heading", "paragraph", "table", "code"]));
  for (const chunk of chunks) assert.equal(index.chunkView(material, chunk).text, text.slice(chunk.startCharacter, chunk.endCharacter));
  const repeats = chunks.filter(chunk => index.chunkView(material, chunk).text.includes("前提是价格不变"));
  assert.equal(repeats.length, 2);
  assert.notEqual(repeats[0].startCharacter, repeats[1].startCharacter);
  const last = chunks.find(chunk => index.chunkView(material, chunk).text.includes("const x"));
  assert.ok(index.contextFor(material, chunks, [last.id]).some(chunk => chunk.text.includes("但涨价是例外")));
  assert.equal(index.needsPlan({ text: "每多生产一个单位额外增加的成本，就是边际成本。" }), false);
  assert.equal(index.needsPlan({ text: TEXT }), true);
  assert.equal(index.needsPlan({ text: "字".repeat(12001) }), true);
});

test("中文换措辞召回可用；无关长文和零命中不被强行附为依据", () => {
  const material = { id: "cache", text: "# 系统缓存\n缓存的过期时间需要兼顾新鲜度。\n\n# 无关\n" + "古诗的平仄与押韵。".repeat(700) };
  const chunks = index.splitMaterial(material);
  const hits = index.retrieve(material, chunks, "快取有效期");
  assert.ok(hits.length && hits[0].text.includes("缓存"));
  assert.ok(hits.every(hit => !hit.text.includes("古诗")));
  assert.deepEqual(index.retrieve(material, chunks, "quantum entanglement"), []);
});

test("长材料按预算分批、覆盖到最后；重新打开只分析未完成批次并合并跨块同目标", async () => {
  const f = fixture();
  const text = "# 增量成本\n" + ("每多生产一个单位额外增加的成本。\n\n").repeat(850) + "最后一句需要覆盖。";
  const created = await f.service.createKnowledgePlan({ text, requestId: "one-click", source: { type: "file", title: "long.md" } });
  assert.equal((await f.service.createKnowledgePlan({ text, requestId: "one-click" })).plan.id, created.plan.id);
  const first = await f.service.analyzeKnowledgePlan(created.plan.id, { maxRequests: 1 });
  assert.equal(first.plan.status, "paused");
  assert.equal(first.plan.analyses.filter(batch => batch.status === "completed").length, 1);
  const reopened = fixture(null, f.storage);
  const completed = await reopened.service.analyzeKnowledgePlan(created.plan.id, { maxRequests: 6 });
  assert.equal(completed.plan.status, "ready", completed.plan.error);
  assert.equal(completed.plan.units.length, 1);
  assert.equal(completed.plan.coverage.length, completed.chunks.length);
  assert.ok(completed.chunks.at(-1).endCharacter > 12000);
  assert.equal(f.calls.length + reopened.calls.length, completed.plan.analyses.length);
  assert.ok(reopened.calls[0].payload.existingUnits.length);
});

test("覆盖缺项与伪造依据被拒绝，失败分析不污染已有完成范围", async () => {
  for (const corrupt of [payload => { payload.coverage.pop(); }, payload => { payload.units[0].evidenceIds.push("invented_chunk"); }]) {
    const f = fixture(payload => { const result = planOutput(payload); corrupt(result); return result; });
    const result = await prepare(f);
    assert.equal(result.plan.status, "needs_attention");
    assert.equal(result.plan.units.length, 0);
    assert.equal(result.plan.coverage.length, 0);
    assert.ok(result.material.text.includes("固定支出"));
  }
});

test("勾选、排序、合并与继续拆分持久化，跳过目标不会进入后续推荐接口", async () => {
  const f = fixture();
  let view = await prepare(f);
  const ids = view.plan.units.map(unit => unit.id);
  view = await f.service.reshapeKnowledgeUnits(view.plan.id, { action: "merge", unitIds: ids, targets: [{ title: "成本比较", learningObjective: "能区分固定支出和增量成本" }] });
  const merged = view.plan.units.find(unit => unit.disposition === "active");
  view = await f.service.reshapeKnowledgeUnits(view.plan.id, { action: "split", unitIds: [merged.id], targets: [
    { title: "增量", learningObjective: "能判断新增成本" }, { title: "边界", learningObjective: "能识别固定成本的适用边界" }
  ] });
  const active = view.plan.units.filter(unit => unit.disposition === "active");
  await f.service.retainKnowledgePlan(view.plan.id);
  await f.service.updateKnowledgePlan(view.plan.id, { units: [{ id: active[1].id, selected: false, skipReason: "本周先不学边界" }] });
  const reopened = fixture(null, f.storage);
  const targets = (await reopened.service.listRetainedLearningTargets()).targets;
  assert.deepEqual(targets.map(target => target.unitId), [active[0].id]);
  view = await reopened.service.getKnowledgePlan(view.plan.id);
  assert.ok(view.coverage.some(row => row.status === "skipped" && row.reason === "本周先不学边界"));
  assert.ok(view.plan.coverage.every(row => row.unitIds.every(id => active.some(unit => unit.id === id))));
});

test("同一目标换措辞通过候选语义匹配复用旧卡，默认不自动再生成", async () => {
  const f = fixture(payload => {
    if (payload.operation === "plan") {
      const result = planOutput(payload);
      if (payload.relatedCards.length) Object.assign(result.units[0], { relatedCardId: payload.relatedCards[0].id, relationToCard: "same_goal" });
      return result;
    }
    return batchQualityOutput(payload);
  });
  const first = await generate(f);
  await save(f, first);
  const second = await prepare(f, { text: "# 增量支出\n多生产一件产品造成的额外成本就是边际成本。" });
  assert.equal(second.plan.units[0].selected, false);
  assert.match(second.plan.units[0].skipReason, /已有相同学习目标/);
  await assert.rejects(f.service.generateCardBatch(second.plan.id), /至少选择/);
});

test("逐卡返回结果、重复点击不重复请求；单次上限后可恢复剩余目标", async () => {
  const f = fixture();
  const planned = await prepare(f);
  const preference = await f.service.createPreferenceMemory({ category: "learning_format", value: "先给实例", mutationId: "batch-format-example" });
  const updates = [];
  const a = f.service.generateCardBatch(planned.plan.id, { maxUnits: 1, onProgress: view => updates.push(view.sessions.map(draft => draft.status)) });
  const b = f.service.generateCardBatch(planned.plan.id, { maxUnits: 1 });
  const [first, same] = await Promise.all([a, b]);
  assert.equal(first.batch.id, same.batch.id);
  assert.equal(first.sessions.length, 1);
  assert.ok(updates.some(statuses => statuses.includes("generating")));
  assert.equal(first.sessions[0].status, "ready");
  const reopened = fixture(null, f.storage);
  const complete = await reopened.service.generateCardBatch(planned.plan.id);
  assert.equal(complete.sessions.length, 2);
  assert.equal(reopened.calls.filter(call => call.payload.operation === "generate").length, 1);
  assert.equal(f.db().materials.length, 1);
  assert.ok(f.db().drafts.every(draft => !draft.material && draft.materialId === f.db().materials[0].id));
  assert.ok(f.calls.every(call => !call.request.tools));
  const generation = f.calls.find(call => call.payload.operation === "generate");
  const review = f.calls.find(call => call.payload.operation === "review");
  assert.ok(generation.payload.learningContext.appliedPreferenceIds.includes(preference.memory.id));
  assert.equal(review.payload.learningContext, undefined);
});

test("部分失败后只重试指定卡，保留已完成卡片和手动编辑字段", async () => {
  let fail = true;
  const f = fixture(payload => {
    if (payload.operation === "plan") return planOutput(payload);
    if (fail && payload.operation === "generate" && payload.userGoal.split("\n")[0].includes("固定支出")) throw new Error("模拟网络中断");
    return batchQualityOutput(payload);
  });
  let view = await generate(f);
  const complete = view.sessions.find(draft => draft.status === "ready");
  const failed = view.sessions.find(draft => draft.status !== "ready");
  assert.ok(complete && failed);
  const before = JSON.stringify(complete);
  fail = false;
  view = await f.service.generateCardBatch(view.plan.id, { unitIds: [failed.unitId], retry: true });
  assert.equal(view.sessions.find(draft => draft.id === failed.id).status, "ready");
  assert.equal(JSON.stringify(view.sessions.find(draft => draft.id === complete.id)), before);
  await f.service.updateGachaCardDraft(complete.id, { title: "用户自己写的标题" });
  view = await f.service.generateCardBatch(view.plan.id, { unitIds: [complete.unitId], retry: true });
  assert.equal(view.sessions.find(draft => draft.id === complete.id).card.title, "用户自己写的标题");
  assert.equal(f.calls.at(-1).payload.operation, "review");
});

test("浏览器关闭留下 generating 时，重新打开可恢复该项且不重做其他卡", async () => {
  const f = fixture();
  let view = await generate(f);
  const db = f.db();
  db.drafts[1].status = "generating";
  f.storage.setItem(KEY, JSON.stringify(db));
  const reopened = fixture(null, f.storage);
  view = await reopened.service.generateCardBatch(view.plan.id);
  assert.equal(reopened.calls.filter(call => call.payload.operation === "generate").length, 1);
  assert.ok(view.sessions.every(draft => draft.status === "ready"));
});

test("批量确认逐卡可恢复且幂等，确认后共享全文只保留一份", async () => {
  const f = fixture();
  const view = await generate(f, { sourcePlan: { saveFullSource: true } });
  assert.equal(f.db().documents.length, 0);
  const prepared = await f.service.prepareCardBatchConfirmation(view.batch.id, view.plan.units.map(unit => unit.id));
  const write = f.storage.setItem;
  let failOnce = true;
  f.storage.setItem = (key, value) => {
    if (failOnce && JSON.parse(value).learningState.cards.length === 2) { failOnce = false; throw new Error("模拟保存失败"); }
    write(key, value);
  };
  const partial = await f.service.confirmCardBatch(view.batch.id, prepared.selection);
  assert.deepEqual(partial.results.map(result => result.status), ["confirmed", "failed"]);
  assert.equal(f.db().learningState.cards.length, 1);
  assert.ok(f.db().drafts.some(draft => draft.status === "ready"));
  assert.ok((await f.service.confirmCardBatch(view.batch.id, prepared.selection)).results.every(result => result.status === "confirmed"));
  await f.service.confirmCardBatch(view.batch.id, prepared.selection);
  const db = f.db();
  assert.equal(db.learningState.cards.length, 2);
  assert.equal(db.documents.length, 1);
  assert.equal(db.documents[0].content, TEXT);
  assert.equal(db.materials[0].text, undefined);
  assert.equal(new Set(db.learningState.cards.map(card => card.sourceIds[0])).size, 1);
  assert.ok(db.drafts.every(draft => !draft.context && !draft.material));
  for (const card of db.learningState.cards) for (const citation of card.citations) assert.equal((await f.service.resolveCitation(citation)).status, "available");
});

test("不保留原文时完成卡组只留下最小依据，后续目标查询排除已完成项", async () => {
  const f = fixture();
  const view = await generate(f);
  await f.service.retainKnowledgePlan(view.plan.id);
  assert.equal((await f.service.listRetainedLearningTargets()).targets.length, 2);
  await save(f, view);
  const db = f.db();
  assert.equal(db.documents.length, 0);
  assert.equal(db.materials[0].text, undefined);
  assert.equal((await f.service.listRetainedLearningTargets()).targets.length, 0);
  assert.equal((await f.service.resolveCitation(db.learningState.cards[0].citations[0])).status, "excerpt_only");
});

test("合并前返回差异，过期确认被拒绝；合并保留收藏、复习事件与排期", async () => {
  const f = fixture();
  const first = await generate(f, { sourcePlan: { saveFullSource: true } });
  await save(f, first);
  const state = (await f.service.loadLearningState()).state;
  const old = state.cards.find(card => card.title === "增量成本");
  Object.assign(old, { favorite: true, reviewCount: 7, mastery: 3, dueAt: NOW + 30000 });
  await f.service.replaceLearningState(state);
  let next = await prepare(f, { text: "# 增量成本\n每多生产一个单位额外增加的成本，需考虑扩大规模时新增的固定投入。" });
  const unit = next.plan.units[0];
  await f.service.updateKnowledgePlan(next.plan.id, { units: [{ id: unit.id, selected: true, duplicateAction: "merge" }] });
  next = await f.service.generateCardBatch(next.plan.id);
  let prepared = await f.service.prepareCardBatchConfirmation(next.batch.id, [unit.id]);
  assert.equal(prepared.selection[0].before.title, "增量成本");
  assert.ok(prepared.selection[0].after.summary);
  await f.service.updateGachaCardDraft(next.sessions[0].id, { title: "补充后的成本" });
  assert.equal((await f.service.confirmCardBatch(next.batch.id, prepared.selection)).results[0].status, "failed");
  await f.service.reviseGachaCardDraft(next.sessions[0].id, "review");
  prepared = await f.service.prepareCardBatchConfirmation(next.batch.id, [unit.id]);
  const merged = await f.service.confirmCardBatch(next.batch.id, prepared.selection);
  assert.equal(merged.results[0].status, "confirmed", merged.results[0].message);
  const saved = f.db().learningState.cards.find(card => card.id === old.id);
  assert.equal(saved.favorite, true);
  assert.equal(saved.reviewCount, 7);
  assert.equal(saved.dueAt, old.dueAt);
  assert.equal(saved.learningUnitId, old.learningUnitId);
});

test("来源更新后即使相同句子仍在原位置，也不冒充旧版本依据", async () => {
  const f = fixture();
  const view = await generate(f, { sourcePlan: { saveFullSource: true } });
  await save(f, view, [view.plan.units[0].id]);
  const doc = f.db().documents[0];
  const citation = f.db().learningState.cards[0].citations[0];
  await f.service.updateDocument(doc.id, { content: doc.content + "\n本版本修改了适用范围。" });
  await assert.rejects(f.service.resolveCitation(citation), /版本.*变化|已经变化/);
  const result = await save(f, view, [view.plan.units[1].id]);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].message, /原文或版本已变化/);
});

test("图文识别接入相同接口，标出不可读位置，图片只在共享材料中保存", async () => {
  const f = fixture();
  let view = await prepare(f, { image: { dataUrl: "data:image/png;base64,fixture", name: "表格.png" } });
  assert.equal(view.plan.status, "ready");
  assert.match(view.material.text, /图片识别文字/);
  assert.deepEqual(view.material.transcription.unreadable, ["右下角模糊数字"]);
  assert.equal(f.calls[0].request.messages.at(-1).content[1].type, "image_url");
  view = await f.service.generateCardBatch(view.plan.id);
  assert.ok(view.sessions.every(draft => !draft.context.image));
  assert.ok(f.db().materials[0].image);
  assert.ok(f.calls.filter(call => call.payload.operation === "observe_image").every(call => call.request.messages.at(-1).content.some(part => part.type === "image_url")));
  assert.ok(f.calls.filter(call => call.payload.operation === "generate").every(call => typeof call.request.messages.at(-1).content === "string"));
});

test("模型意外返回多张卡时全部候选保留，不将第一张冒充单卡成果", async () => {
  const quality = require("../src/backend/features/generation/card-quality.js");
  const parsed = quality.parse(JSON.stringify({ cards: [{ title: "一" }, { title: "二" }] }));
  assert.equal(parsed.status, "needs_split");
  assert.equal(parsed.card, null);
  assert.equal(parsed.candidates.length, 2);
});

test("补充检索须明确允许且经清单选取，冲突来源保留各自位置和版本", async () => {
  for (const allowed of [false, true]) {
    const f = fixture(payload => {
      if (payload.operation === "plan") {
        const result = planOutput(payload);
        result.units[0].supplementalEvidenceIds = payload.supplementalCandidates.map(span => span.id);
        return result;
      }
      return batchQualityOutput(payload);
    });
    const documents = [60, 10].map(seconds => ({ id: "doc_policy_" + seconds, title: "策略 " + seconds, type: "text", createdAt: NOW,
      content: "缓存策略配置需考虑更新频率，缓存有效期始终为 " + seconds + " 秒。" }));
    const cards = documents.map(doc => domain.sanitizeCard({ id: "card_" + doc.id, title: doc.title, summary: "旧的策略说明", sourceIds: ["source_" + doc.id] }));
    f.storage.setItem(KEY, JSON.stringify({ documents, learningState: { cards, pending: [], totalDraws: 0, reviewDay: {} } }));
    const view = await generate(f, { text: "# 缓存策略\n缓存策略配置需考虑更新频率，缓存用于复用结果。", allowSupplemental: allowed });
    const supplemental = view.sessions[0].context.evidence.filter(span => span.origin === "supplemental");
    assert.equal(supplemental.length, allowed ? 2 : 0);
    if (allowed) {
      assert.equal(new Set(supplemental.map(span => span.documentId)).size, 2);
      for (const span of supplemental) {
        const doc = f.db().documents.find(doc => doc.id === span.documentId);
        assert.equal(doc.content.slice(span.startCharacter, span.startCharacter + span.text.length), span.text);
        assert.equal(span.version, 1);
      }
      assert.match(view.sessions[0].context.userGoal, /区分并说明.*差异/);
    }
  }
});

test("未获允许的补充来源不能靠模型输出自动加入清单", async () => {
  const f = fixture(payload => {
    const result = planOutput(payload);
    result.units[0].supplementalEvidenceIds = ["retained_invented"];
    return result;
  });
  const result = await prepare(f);
  assert.equal(result.plan.status, "needs_attention");
  assert.match(result.plan.error, /补充来源未获选择/);
  assert.equal(result.plan.units.length, 0);
});

test("用户暂停后只完成当前卡，再次继续保留先前结果和用量", async () => {
  const f = fixture();
  let view = await prepare(f);
  const id = view.plan.id;
  view = await f.service.generateCardBatch(id, { onProgress: progress => {
    if (progress.sessions.some(draft => draft.status === "generating")) void f.service.pauseKnowledgeWork(id);
  } });
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0].status, "ready");
  const first = JSON.stringify(view.sessions[0]);
  assert.equal(f.calls.filter(call => call.payload.operation === "generate").length, 1);
  view = await f.service.generateCardBatch(id);
  assert.equal(view.sessions.length, 2);
  assert.equal(JSON.stringify(view.sessions[0]), first);
  assert.equal(f.calls.filter(call => call.payload.operation === "generate").length, 2);
});
