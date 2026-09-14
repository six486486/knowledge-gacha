const test = require("node:test");
const assert = require("node:assert/strict");

const domain = require("../src/frontend/domain/card-domain.js");
const planner = require("../src/backend/features/discovery/discovery-planner.js");
const schema = require("../src/shared/knowledge-schema.js");
const { createExtensionService, DB_KEY } = require("../src/backend/application/extension-service.js");
const { memoryStorage } = require("../src/shared/runtime-utils.js");
const discoveryFixture = require("./fixtures/discovery-output.js");
const qualityFixture = require("./fixtures/quality-output.js");

const NOW = Date.UTC(2026, 8, 4, 9);

function card(id, title, summary) {
  return domain.sanitizeCard({
    id: id,
    title: title,
    contentVersion: 2,
    learningUnitId: "unit_" + id,
    learningObjective: "能解释" + title + "的基本机制",
    summary: summary,
    example: { type: "example", text: "这是已有卡片中的例子。", origin: "authored" },
    boundaries: "",
    citations: [],
    exerciseIds: [],
    sourceSnapshot: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    dueAt: NOW + 86_400_000
  }, { now: NOW });
}

function fixture(options = {}) {
  const storage = options.storage || memoryStorage();
  const profileId = options.profileId || "default";
  const key = DB_KEY + ":" + profileId;
  if (options.seed) storage.setItem(key, JSON.stringify(options.seed));
  const providerCalls = [];
  const providerTransport = options.providerTransport || {
    complete: async function (_, request) {
      providerCalls.push(request);
      const payload = qualityFixture.requestPayload(request);
      let output;
      if (payload.operation === "review") output = { findings: [], checks: qualityFixture.checksFor(payload.candidate) };
      else output = discoveryFixture.discoveryQualityOutput(payload);
      return { content: JSON.stringify(output), finishReason: "stop", provider: { model: "fixture-model", latencyMs: 2,
        usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 } } };
    }
  };
  const settings = {
    storage: storage,
    profileId: profileId,
    indexedDB: false,
    cardDomain: domain,
    providerModule: {},
    providerTransport: providerTransport,
    modelConfig: options.modelConfig === undefined ? { baseUrl: "https://model.invalid/v1", apiKey: "test-key", model: "fixture-model" } : options.modelConfig,
    now: function () { return options.now || NOW; }
  };
  if (options.injectPlanner !== false) settings.discoveryPlanner = options.discoveryPlanner || async function (request) {
    return { outlines: discoveryFixture.candidateOutlines(request).candidates,
      generation: { planVersion: planner.PLAN_VERSION, promptVersion: "fixture", model: "fixture-model", elapsedMs: 3,
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, calls: 1 } };
  };
  const service = createExtensionService(settings);
  return { service: service, storage: storage, providerCalls: providerCalls, db: function () { return JSON.parse(storage.getItem(key)); } };
}

function learningState(cards) {
  return { cards: cards || [], pending: [], totalDraws: (cards || []).length,
    reviewDay: { day: "", answered: 0, completed: false } };
}

test("多个兴趣在不同推荐批次轮换，前四个之外的兴趣也能得到候选", async () => {
  const f = fixture();
  const interests = ["摄影", "数学", "历史", "写作", "天文", "语言学习", "经济学"];
  const setup = await f.service.getDiscoveryInterests();
  const saved = await f.service.saveDiscoveryInterests({ revision: setup.revision, topics: interests, mutationId: "many-interests" });
  const seen = new Set();
  let poolId;
  for (let i = 0; i < 3; i++) {
    const { pool } = await f.service.createGachaDiscoveryPool(poolId);
    poolId = pool.id;
    for (const candidate of pool.candidates) if (candidate.mode === "explicit_interest") seen.add(candidate.reasons[0].sourceId);
  }
  assert.deepEqual([...seen].sort(), saved.interests.map(item => item.id).sort());
});

test("已有连续兴趣推荐时，新批次保留一个合格探索机会", async () => {
  const f = fixture({ seed: { discoveryPools: [1, 2, 3].map(index => ({
    id: "prior-interest-pool-" + index, poolVersion: "discovery-pool-v2.1", status: "refreshed", createdAt: NOW - index,
    candidates: [{ id: "prior-interest-" + index, mode: "explicit_interest", status: "available" }]
  })) } });
  const setup = await f.service.getDiscoveryInterests();
  await f.service.saveDiscoveryInterests({ revision: setup.revision, topics: ["摄影", "数学", "历史", "天文"], mutationId: "explore-interests" });
  const { pool } = await f.service.createGachaDiscoveryPool();
  assert.equal(pool.candidates.filter(item => item.mode === "explicit_interest").length, 2);
  assert.equal(pool.candidates.filter(item => item.mode === "controlled_exploration").length, 1);
  assert.equal(pool.candidates[0].mode, "explicit_interest");
});

test("相同卡册的不同明确兴趣会改变首个主题，理由定位到实际偏好", async function () {
  const storage = memoryStorage();
  const shared = learningState([card("shared", "缓存基础", "缓存复用旧结果，减少重复计算。")]);
  const photography = fixture({ storage: storage, profileId: "photo" });
  const mathematics = fixture({ storage: storage, profileId: "math" });
  await photography.service.replaceLearningState(shared);
  await mathematics.service.replaceLearningState(shared);
  const photoPreference = (await photography.service.createPreferenceMemory({ category: "topic_interest", value: "摄影", mutationId: "photo-interest" })).memory;
  const mathPreference = (await mathematics.service.createPreferenceMemory({ category: "topic_interest", value: "概率数学", mutationId: "math-interest" })).memory;
  const photoPool = (await photography.service.createGachaDiscoveryPool()).pool;
  const mathPool = (await mathematics.service.createGachaDiscoveryPool()).pool;
  assert.match(photoPool.candidates[0].topic, /^摄影/);
  assert.match(mathPool.candidates[0].topic, /^概率数学/);
  assert.notEqual(photoPool.candidates[0].topic, mathPool.candidates[0].topic);
  assert.deepEqual(photoPool.candidates[0].reasons[0], {
    code: "explicit_interest", sourceType: "preference", sourceId: photoPreference.id,
    summary: "因为你明确选择了“摄影”这个学习方向"
  });
  assert.ok(mathPool.usedPreferenceIds.includes(mathPreference.id));
});

test("换一批排除本次会话已曝光目标，同义改名不能补足数量", async function () {
  let call = 0;
  const f = fixture({ discoveryPlanner: async function (request) {
    call += 1;
    const seed = request.seeds.find(function (item) { return item.mode === "controlled_exploration"; });
    const candidate = call === 1
      ? { seedId: seed.id, conceptKey: "same-target", topic: "缓存过期和主动失效的区别", learningObjective: "能区分缓存过期与主动失效", newKnowledge: "新增两种失效机制的触发条件与并发边界", difficulty: "standard" }
      : { seedId: seed.id, conceptKey: "same-target", topic: "主动删除缓存与自然到期有什么不同", learningObjective: "能判断自然到期和主动删除的不同", newKnowledge: "新增失效触发条件以及并发情况下的处理边界", difficulty: "standard" };
    return { outlines: [candidate], generation: { planVersion: planner.PLAN_VERSION, promptVersion: "fixture", calls: 1 } };
  } });
  const first = (await f.service.createGachaDiscoveryPool()).pool;
  assert.equal(first.candidates.length, 1);
  const refreshed = (await f.service.createGachaDiscoveryPool(first.id)).pool;
  assert.equal(refreshed.candidates.length, 0);
  assert.equal(refreshed.status, "empty");
  assert.ok(refreshed.sessionSeenTargetKeys.includes("same-target"));
});

test("候选规划只批量直连模型，结构错误最多修复一次且只认版本核对资料", async function () {
  const request = {
    planVersion: planner.PLAN_VERSION,
    contextMemoryVersion: 1,
    refreshIndex: 1,
    seeds: [{ id: "explore:1", mode: "controlled_exploration", anchor: "通用知识探索", baseSummary: "", baseLearningObjective: "",
      relationship: "提供通用方向", evidenceStatus: "model_suggestion" }],
    exclusions: { seenTargetKeys: [], excludedLearningUnitIds: [], downrankedTopicIds: [], existing: [] }
  };
  const calls = [];
  const result = await planner.requestOutlines({ complete: async function (_, input) {
    calls.push(input);
    assert.equal(input.tools, undefined);
    const payload = JSON.parse(input.messages.at(-1).content);
    const content = calls.length === 1
      ? { candidates: [{ seedId: "unknown", topic: "空", learningObjective: "理解", newKnowledge: "重复", difficulty: "standard" }] }
      : discoveryFixture.candidateOutlines(payload);
    return { content: JSON.stringify(content), finishReason: "stop", provider: { model: "fixture-model", latencyMs: 1,
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } } };
  } }, function () { return { apiKey: "test", model: "fixture-model" }; }, request);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].messages.at(-1).content).operation, "repair");
  assert.ok(result.outlines.length > 0);
  assert.equal(result.generation.calls, 2);
  assert.equal(result.generation.usage.totalTokens, 8);

  const sourceText = "缓存过期后需要回源更新。";
  const cited = card("cited", "缓存过期", "缓存过期后旧值不再满足新鲜度要求。");
  cited.citations = [{ id: "citation_saved", claim: "summary", quote: sourceText, headingPath: [],
    source: { documentId: "doc_saved", sourceId: "source_doc_saved", version: 1, title: "缓存资料", type: "text" },
    position: { startCharacter: 0, endCharacter: sourceText.length, pageNumber: null } }];
  const db = { learningState: learningState([cited]), documents: [{ id: "doc_saved", title: "缓存资料", type: "text", content: sourceText, createdAt: NOW }],
    sources: [{ id: "source_doc_saved", documentId: "doc_saved", version: 1, status: "available" }], discoveryPools: [] };
  const context = { version: 1, interests: [], learnedUnits: [], excludedUnits: [], downrankedTopics: [], explicitPreferences: [] };
  const withSource = planner.buildSeedRequest(db, context, NOW, {});
  const cardSeed = withSource.seeds.find(function (seed) { return seed.relatedCardId === cited.id; });
  assert.equal(cardSeed.evidenceStatus, "saved_source");
  assert.equal(cardSeed.sourceRefs.length, 1);
  db.documents = [];
  const withoutSource = planner.buildSeedRequest(db, context, NOW, {});
  const staleSeed = withoutSource.seeds.find(function (seed) { return seed.relatedCardId === cited.id; });
  assert.equal(staleSeed.evidenceStatus, "card_extension");
  assert.equal(staleSeed.sourceRefs.length, 0);
});

for (const onlyRealSources of [false, true]) test("发现卡保留真实材料引用与发现身份：" + (onlyRealSources ? "仅引用原文" : "原文与提纲混合"), async function () {
  const text = "缓存过期后需要回源更新。";
  const existing = card("cited", "缓存过期", "缓存过期后旧值不再满足新鲜度要求。");
  existing.citations = [{ id: "citation_saved", claim: "summary", quote: text, headingPath: [],
    source: { documentId: "doc_saved", sourceId: "source_doc_saved", version: 1, title: "缓存资料", type: "text" },
    position: { startCharacter: 0, endCharacter: text.length, pageNumber: null } }];
  const f = fixture({ seed: { learningState: learningState([existing]),
    documents: [{ id: "doc_saved", title: "缓存资料", type: "text", content: text, createdAt: NOW }],
    sources: [{ id: "source_doc_saved", documentId: "doc_saved", title: "缓存资料", type: "text", version: 1, status: "available" }] },
    providerTransport: { complete: async (_, request) => {
      const payload = qualityFixture.requestPayload(request);
      const output = payload.operation === "review" ? { findings: [], checks: qualityFixture.checksFor(payload.candidate) } : discoveryFixture.discoveryQualityOutput(payload);
      if (payload.operation === "generate") {
        const source = payload.sources.find(item => item.origin === "saved_source");
        assert.ok(source);
        if (onlyRealSources) output.evidence = output.evidence.map(ref => Object.assign({}, ref, { evidenceId: source.id, quote: source.text }));
        else output.evidence.push({ claim: "summary", evidenceId: source.id, quote: source.text });
      }
      return { content: JSON.stringify(output), finishReason: "stop", provider: { model: "fixture", latencyMs: 1 } };
    } } });
  const { pool } = await f.service.createGachaDiscoveryPool();
  const candidate = pool.candidates.find(item => item.relatedCardIds.includes(existing.id));
  const { session } = await f.service.openGachaDiscoveryCandidate(pool.id, candidate.id);
  assert.equal(session.status, "ready");
  const { card: saved } = await f.service.confirmGachaCardDraft(session.id);
  assert.equal(saved.discoveryBasis.verification, "model_suggestion");
  assert.equal(saved.sourceSnapshot, null);
  assert.equal(saved.citations.length, onlyRealSources ? 2 : 1);
  assert.ok(saved.citations.every(citation => citation.source.documentId === "doc_saved" && citation.quote === text));
  assert.equal(f.db().sources.length, 1);
});

test("打开候选传递完整承诺，收下后保存发现依据、事件与漏斗指标", async function () {
  const existing = card("cache", "缓存基础", "缓存复用旧结果，减少重复计算。")
  const f = fixture();
  await f.service.replaceLearningState(learningState([existing]));
  const pool = (await f.service.createGachaDiscoveryPool()).pool;
  const candidate = pool.candidates.find(function (item) { return item.relatedCardIds.includes(existing.id); });
  assert.ok(candidate);
  const opened = await f.service.openGachaDiscoveryCandidate(pool.id, candidate.id);
  assert.equal(opened.session.status, "ready");
  assert.equal(opened.session.discoveryContext.learningObjective, candidate.learningObjective);
  assert.equal(opened.session.discoveryContext.newKnowledge, candidate.newKnowledge);
  assert.match(opened.session.card.summary, new RegExp(candidate.newKnowledge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const confirmed = await f.service.confirmGachaCardDraft(opened.session.id);
  assert.equal(confirmed.card.discoveryBasis.verification, "model_suggestion");
  assert.equal(confirmed.card.discoveryBasis.candidateId, candidate.id);
  assert.equal(confirmed.card.citations.length, 0);
  const db = f.db();
  const storedPool = db.discoveryPools.find(function (item) { return item.id === pool.id; });
  const storedCandidate = storedPool.candidates.find(function (item) { return item.id === candidate.id; });
  assert.equal(storedCandidate.status, "saved");
  assert.equal(storedCandidate.savedCardId, confirmed.card.id);
  assert.equal(storedPool.status, "active");
  assert.equal(storedPool.metrics.opened, 1);
  assert.equal(storedPool.metrics.saved, 1);
  assert.ok(db.recentLearningEvents.some(function (item) { return item.type === "recommendation_exposure"; }));
  assert.ok(db.recentLearningEvents.some(function (item) { return item.type === "discovery_opened"; }));
  assert.ok(db.recentLearningEvents.some(function (item) { return item.type === "discovery_saved"; }));
  const run = db.runs.find(function (item) { return item.id === pool.runId; });
  assert.equal(run.skill.name, "gacha-discovery");
  assert.equal(run.candidateCount, pool.candidates.length);
  assert.equal(run.usage.totalTokens, 12);
});

test("关联卡摘要被换标题复述时，发现草稿不能进入可收下状态", async function () {
  const existing = card("repeat", "缓存基础", "缓存复用旧结果，减少重复计算。");
  const normal = discoveryFixture.discoveryQualityOutput;
  const f = fixture({ providerTransport: { complete: async function (_, request) {
    const payload = qualityFixture.requestPayload(request);
    if (payload.operation === "solve") return { content: JSON.stringify(qualityFixture.verificationOutput(payload)), provider: { model: "fixture", latencyMs: 1 } };
    if (payload.operation === "review") return { content: JSON.stringify({ findings: [], checks: qualityFixture.checksFor(payload.candidate) }), finishReason: "stop", provider: { model: "fixture", latencyMs: 1 } };
    const output = normal(payload);
    output.card.summary = existing.summary;
    output.card.example.text = lineFromGoal(payload.userGoal, "必须新增：");
    return { content: JSON.stringify(output), finishReason: "stop", provider: { model: "fixture", latencyMs: 1 } };
  } } });
  await f.service.replaceLearningState(learningState([existing]));
  const pool = (await f.service.createGachaDiscoveryPool()).pool;
  const candidate = pool.candidates.find(function (item) { return item.relatedCardIds.includes(existing.id); });
  const opened = await f.service.openGachaDiscoveryCandidate(pool.id, candidate.id);
  assert.equal(opened.session.status, "needs_revision");
  assert.ok(opened.session.quality.issues.some(function (issue) { return issue.code === "discovery_duplicate"; }));
  assert.throws(function () { f.service.confirmGachaCardDraft(opened.session.id); }, /核验|草稿/);
});

test("空档案只显示通用模型建议，不伪造兴趣、资料或薄弱点", async function () {
  const f = fixture();
  const pool = (await f.service.createGachaDiscoveryPool()).pool;
  assert.ok(pool.candidates.length >= 1 && pool.candidates.length <= 3);
  assert.ok(pool.candidates.every(function (candidate) {
    return candidate.mode === "controlled_exploration" && candidate.evidenceStatus === "model_suggestion"
      && candidate.reasons.every(function (reason) { return reason.sourceType === "exploration_rule"; });
  }));
  assert.equal(pool.contextSummary.enabledPreferenceCount, 0);
  assert.equal(pool.contextSummary.observedReviewUnitCount, 0);
});

test("没有模型配置时不生成固定模板；已有批次在刷新失败后仍保留", async function () {
  const noModel = fixture({ injectPlanner: false, modelConfig: null, providerTransport: { complete: async function () { throw new Error("不应请求模型"); } } });
  await assert.rejects(noModel.service.createGachaDiscoveryPool(), function (error) { return error.code === "MODEL_CONFIG_REQUIRED"; });
  assert.ok(!noModel.db() || noModel.db().discoveryPools.length === 0);

  let fail = false;
  const preserved = fixture({ discoveryPlanner: async function (request) {
    if (fail) throw Object.assign(new Error("模型暂不可用"), { code: "MODEL_DOWN" });
    return { outlines: discoveryFixture.candidateOutlines(request).candidates, generation: { calls: 1 } };
  } });
  const pool = (await preserved.service.createGachaDiscoveryPool()).pool;
  fail = true;
  await assert.rejects(preserved.service.createGachaDiscoveryPool(pool.id), /模型暂不可用/);
  const stored = preserved.db().discoveryPools.find(function (item) { return item.id === pool.id; });
  assert.equal(stored.status, "active");
  assert.equal(stored.metrics.generationFailures, 1);
});

test("schemaVersion 8 将旧发现池失效并补齐新版候选指标", function () {
  const db = {
    schemaVersion: 7,
    version: 1,
    learningState: learningState([]),
    documents: [],
    discoveryPools: [
      { id: "old", status: "active", poolVersion: "discovery-pool-v1", candidates: [] },
      { id: "new", status: "active", poolVersion: "discovery-pool-v2.1", candidates: [{ id: "candidate" }] }
    ],
    runs: [], traces: {}, pendingRuns: {}, audit: []
  };
  schema.upgradeDb(db);
  assert.equal(db.schemaVersion, 8);
  assert.equal(db.discoveryPools[0].status, "stale");
  assert.deepEqual(db.discoveryPools[1].metrics, { exposed: 0, opened: 0, saved: 0, feedback: 0, generationFailures: 0 });
  assert.deepEqual(db.discoveryPools[1].candidates[0].sourceRefs, []);
});

function lineFromGoal(value, label) {
  const line = String(value || "").split(/\r?\n/).find(function (item) { return item.startsWith(label); });
  return line ? line.slice(label.length).trim() : "";
}

test("模型回传output包装时定向修复根结构，知识说明不可省略，来源保持模型建议", async () => {
  const f = fixture();
  await f.service.replaceLearningState(learningState([]));
  const request = planner.buildSeedRequest(f.db(), { version: 1, interests: [], learnedUnits: [], excludedUnits: [], downrankedTopics: [], explicitPreferences: [] }, NOW, {});
  const calls = [];
  const planned = await planner.requestOutlines({ complete: async (_, request) => {
    const payload = qualityFixture.requestPayload(request); calls.push(payload);
    assert.equal(payload.output, undefined);
    assert.equal(payload.request, undefined);
    const content = discoveryFixture.candidateOutlines(payload);
    return { content: JSON.stringify(calls.length === 1 ? { ...payload, output: content } : content), provider: { model: "fixture", latencyMs: 1 } };
  } }, () => ({ model: "fixture" }), request);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].operation, "repair");
  assert.ok(calls[1].invalidResponse.includes('"output"'));
  assert.ok(planned.outlines.every(outline => outline.knowledgeText.length >= 60));
  const incomplete = discoveryFixture.candidateOutlines(request);
  incomplete.candidates.forEach(item => { delete item.knowledgeText; });
  assert.throws(() => planner.validateOutlines(incomplete, request), /缺少知识说明/);
  const pool = (await f.service.createGachaDiscoveryPool()).pool;
  const opened = await f.service.openGachaDiscoveryCandidate(pool.id, pool.candidates[0].id);
  assert.ok(opened.session.context.evidence[0].text.includes(pool.candidates[0].knowledgeText));
  const saved = await f.service.confirmGachaCardDraft(opened.session.id);
  assert.equal(saved.card.discoveryBasis.verification, "model_suggestion");
  assert.equal(saved.card.citations.length, 0);
});
