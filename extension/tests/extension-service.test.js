const test = require("node:test");
const assert = require("node:assert/strict");

const { qualityOutput, checks, verificationOutput, requestPayload } = require("./fixtures/quality-output.js");

const domain = require("../src/frontend/domain/card-domain.js");
const providerModule = require("../src/backend/provider/provider-transport.js");
const extensionServiceModule = require("../src/backend/application/extension-service.js");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function learningState(card) {
  return { cards: card ? [card] : [], pending: [], totalDraws: 0, reviewDay: { day: "2026-08-28", answered: 0, completed: false } };
}

function createService(responses, nowValue) {
  const queue = responses.slice();
  const storage = new MemoryStorage();
  const service = extensionServiceModule.createExtensionService({
    storage,
    cardDomain: domain,
    providerModule,
    providerTransport: { complete: async function (_config, request) {
      let payload; try { payload = requestPayload(request); } catch {}
      const verification = payload && verificationOutput(payload);
      return verification ? { content: JSON.stringify(verification), provider: { model: "demo", latencyMs: 1 } } : queue.shift();
    } },
    modelConfig: { baseUrl: "https://model.example/v1", apiKey: "secret", model: "demo" },
    now: function () { return nowValue || Date.UTC(2026, 7, 28, 8); }
  });
  return { service, storage };
}

test("连接测试由扩展内 Provider 传输完成", async function () {
  const fixture = createService([{ content: "OK", toolCalls: [], provider: { model: "demo", latencyMs: 3 } }]);
  const response = await fixture.service.testModelConnection();
  assert.equal(response.provider.model, "demo");
  assert.equal(response.provider.latencyMs, 3);
});

test("学习状态保存在扩展后端存储中并可恢复", async function () {
  const fixture = createService([]);
  const state = learningState();
  const first = await fixture.service.migrateLocalStorage(state);
  const second = await fixture.service.migrateLocalStorage(state);
  assert.equal(first.alreadyApplied, false);
  assert.equal(second.alreadyApplied, true);
  assert.deepEqual((await fixture.service.loadLearningState()).state, { ...state,
    reviewDay: { ...state.reviewDay, continueAfterGoal: false, lastLearningUnitId: null }, exercises: [] });
});

test("制卡核对、模型生成、草稿编辑和确认均在扩展内闭环", async function () {
  const modelJson = JSON.stringify(qualityOutput({ evidence: [{ id: "material", kind: "text", text: "多生产一单位的新增成本" }] }));
  const reviewed = { content: JSON.stringify({ findings: [], checks }), provider: { model: "demo", latencyMs: 3 } };
  const fixture = createService([{ content: modelJson, toolCalls: [], provider: { model: "demo", latencyMs: 8 } }, reviewed, reviewed]);
  await fixture.service.migrateLocalStorage(learningState());
  const material = { text: "多生产一单位的新增成本", source: { type: "manual", title: "手动输入", url: null, capturedAt: 1 } };
  const checked = await fixture.service.checkGachaCardSources(material);
  const draft = await fixture.service.createGachaCardDraft(Object.assign({}, material, { sourcePlan: { checkId: checked.check.id, duplicateAction: "create_new", targetCardId: null, saveFullSource: false } }));
  assert.equal(draft.session.status, "ready");
  const dashboard = await fixture.service.getObservabilityDashboard({ window: "all" });
  const run = dashboard.recentRuns.find(run => run.id === draft.session.runId);
  assert.equal(run.source, "extension_workflow");
  assert.equal(run.promptVersion, draft.session.generation.promptVersion);
  assert.equal(run.harnessVersion, null);
  await fixture.service.updateGachaCardDraft(draft.session.id, Object.assign({}, draft.session.card, { title: "边际成本（改）" }));
  await fixture.service.reviseGachaCardDraft(draft.session.id, "review");
  const confirmed = await fixture.service.confirmGachaCardDraft(draft.session.id);
  assert.equal(confirmed.card.title, "边际成本（改）");
  assert.equal((await fixture.service.loadLearningState()).state.cards.length, 1);
});

test("事实审校失败不能确认保存，原卡册与复习状态保持不变", async function () {
  const text = "多生产一单位的新增成本";
  const candidate = qualityOutput({ evidence: [{ id: "material", kind: "text", text }] });
  candidate.card.summary = "主动删除缓存即可保证强一致。";
  const verdict = { findings: [{ field: "card.summary", quote: candidate.card.summary, reason: "并发旧读取仍可能在失效后回填旧值" }], checks };
  const response = value => ({ content: JSON.stringify(value), provider: { model: "demo", latencyMs: 1 } });
  const fixture = createService([response(candidate), response(verdict), response({}), response(verdict)]);
  await fixture.service.migrateLocalStorage(learningState({ id: "existing-card", title: "已有卡片", summary: "保留已有内容", question: "已有题目", options: ["甲", "乙"], correctIndex: 1, favorite: true }));
  const before = await fixture.service.loadLearningState();
  const draft = await fixture.service.createGachaCardDraft({ text, source: { type: "manual", title: "测试材料" } });
  assert.equal(draft.session.status, "needs_revision");
  assert.ok(draft.session.quality.issues.some(issue => issue.code === "semantic_fact"));
  await assert.rejects(async () => fixture.service.confirmGachaCardDraft(draft.session.id), /质量核验/);
  assert.deepEqual((await fixture.service.loadLearningState()).state, before.state);
});

test("Agent Harness 固化 Skill 白名单并在写工具前等待确认", async function () {
  const toolCall = { id: "call_1", type: "function", function: { name: "create_card", arguments: JSON.stringify({ title: "RAG", summary: "先检索再生成", analogy: "开卷答题" }) } };
  const fixture = createService([
    { content: "", toolCalls: [toolCall], provider: { model: "demo", latencyMs: 4 } },
    { content: "已按你的确认保存卡片。", toolCalls: [], provider: { model: "demo", latencyMs: 5 } }
  ]);
  await fixture.service.migrateLocalStorage(learningState());
  const waiting = await fixture.service.runAgent({ userInput: "帮我保存一张 RAG 卡片" });
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.approval.toolName, "create_card");
  assert.equal((await fixture.service.loadLearningState()).state.cards.length, 0);
  const completed = await fixture.service.continueAgent(waiting.run.id, { approvalId: waiting.approval.id, decision: "approve" });
  assert.equal(completed.status, "completed");
  assert.equal((await fixture.service.loadLearningState()).state.cards.length, 1);
});

test("复习判分和排期由后端业务服务更新，不依赖页面或 Harness 比较答案", async function () {
  const timestamp = Date.UTC(2026, 7, 28, 8);
  const card = domain.generateLocalCard("间隔复习通过拉开时间巩固记忆", null, { now: timestamp - 1000, random: function () { return 0.5; } });
  card.dueAt = timestamp - 1;
  const fixture = createService([], timestamp);
  await fixture.service.migrateLocalStorage(learningState(card));
  const opened = await fixture.service.openGachaReview(card.id);
  assert.equal(opened.question.cardId, card.id);
  const answered = await fixture.service.answerGachaReview(card.id, { chosenIndex: card.correctIndex });
  assert.equal(answered.feedback.correct, true);
  assert.ok(answered.feedback.dueAt > timestamp);
});
