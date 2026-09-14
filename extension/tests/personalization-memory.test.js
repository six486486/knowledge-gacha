const test = require("node:test");
const assert = require("node:assert/strict");
const domain = require("../src/frontend/domain/card-domain.js");
const { createExtensionService, DB_KEY } = require("../src/backend/application/extension-service.js");
const { memoryStorage } = require("../src/shared/runtime-utils.js");
const discoveryFixture = require("./fixtures/discovery-output.js");

const NOW = Date.UTC(2026, 8, 4, 8);

function fixture(options = {}) {
  const storage = options.storage || memoryStorage();
  let clock = options.now || NOW;
  const key = DB_KEY + ":" + String(options.profileId || "default");
  if (options.seed) storage.setItem(key, JSON.stringify(options.seed));
  const service = createExtensionService({
    storage,
    profileId: options.profileId,
    indexedDB: false,
    cardDomain: domain,
    providerModule: {},
    providerTransport: { complete: async function () { throw new Error("本测试不应调用模型"); } },
    discoveryPlanner: options.discoveryPlanner || async function (request) {
      return { outlines: discoveryFixture.candidateOutlines(request).candidates,
        generation: { planVersion: "discovery-plan-v2", promptVersion: "fixture", model: "fixture", elapsedMs: 1,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, calls: 1 } };
    },
    now: function () { return clock; }
  });
  return { service, storage, setNow: function (value) { clock = value; }, db: function () {
    return JSON.parse(storage.getItem(key) || "{}");
  } };
}

test("兴趣引导可跳过并按档案持久保存，不创建兴趣或修改学习记录", async () => {
  const storage = memoryStorage(), f = fixture({ storage, profileId: "interest-first" });
  assert.equal((await f.service.getDiscoveryInterests()).completed, false);
  const before = (await f.service.loadLearningState()).state;
  const result = await f.service.saveDiscoveryInterests({ skip: true, mutationId: "skip-setup" });
  assert.equal(result.completed, true);
  assert.equal(result.changed, false);
  assert.deepEqual(f.db().preferences, []);
  assert.deepEqual((await f.service.loadLearningState()).state, before);
  assert.equal((await fixture({ storage, profileId: "interest-first" }).service.getDiscoveryInterests()).completed, true);
  assert.equal((await fixture({ storage, profileId: "interest-other" }).service.getDiscoveryInterests()).completed, false);
});

test("兴趣一次保存、规范化去重并复用现有偏好，保留难度与排除", async () => {
  const f = fixture();
  const old = (await f.service.createPreferenceMemory({ category: "topic_interest", value: "摄影" })).memory;
  const difficulty = (await f.service.createPreferenceMemory({ category: "difficulty_preference", value: "advanced" })).memory;
  const exclusion = (await f.service.createPreferenceMemory({ category: "unit_exclusion", value: "排除目标", learningUnitId: "unit-blocked" })).memory;
  const current = await f.service.getDiscoveryInterests();
  assert.equal(current.completed, true);
  const input = { revision: current.revision, topics: ["摄影", " AI 应用 ", "AI 应用", "认知偏差"], mutationId: "select-interests" };
  const result = await f.service.saveDiscoveryInterests(input);
  assert.deepEqual(result.interests.map(item => item.value), ["摄影", "AI 应用", "认知偏差"]);
  assert.equal(result.interests[0].id, old.id);
  assert.equal(result.interests[0].version, old.version);
  assert.deepEqual(f.db().preferences.find(item => item.id === difficulty.id), difficulty);
  assert.deepEqual(f.db().preferences.find(item => item.id === exclusion.id), exclusion);
  assert.equal((await f.service.saveDiscoveryInterests(input)).alreadyApplied, true);
  assert.equal(f.db().preferences.length, 5);
});

test("取消选中的兴趣仅停用对应项，空选择持久保留引导完成状态", async () => {
  const f = fixture();
  const old = (await f.service.createPreferenceMemory({ category: "topic_interest", value: "摄影" })).memory;
  const current = await f.service.getDiscoveryInterests();
  const cleared = await f.service.saveDiscoveryInterests({ revision: current.revision, topics: [], mutationId: "clear-interests" });
  assert.equal(cleared.completed, true);
  assert.deepEqual(cleared.interests, []);
  assert.equal(f.db().preferences[0].enabled, false);
  assert.equal((await f.service.getLearningContext({ mode: "recommendation" })).context.interests.length, 0);
  const restored = await f.service.saveDiscoveryInterests({ revision: cleared.revision, topics: ["摄影"], mutationId: "restore-interest" });
  assert.equal(restored.interests[0].id, old.id);
  assert.equal(f.db().preferences.length, 1);
});

test("未修改兴趣不作废候选；批量改变兴趣只推进一次推荐版本", async () => {
  const f = fixture();
  await f.service.createPreferenceMemory({ category: "topic_interest", value: "摄影" });
  const pool = (await f.service.createGachaDiscoveryPool()).pool;
  const current = await f.service.getDiscoveryInterests(), version = f.db().memoryVersion;
  const same = await f.service.saveDiscoveryInterests({ revision: current.revision, topics: ["摄影"], mutationId: "same-interests" });
  assert.equal(same.changed, false);
  assert.equal(f.db().memoryVersion, version);
  assert.equal(f.db().discoveryPools[0].status, "active");
  await f.service.saveDiscoveryInterests({ revision: same.revision, topics: ["摄影", "物理", "心理学"], mutationId: "new-interests" });
  assert.equal(f.db().memoryVersion, version + 1);
  assert.equal(f.db().discoveryPools.find(item => item.id === pool.id).status, "stale");
});

test("旧兴趣编辑快照不能覆盖后来的兴趣，其他种类的偏好不会阻止保存", async () => {
  const f = fixture();
  await f.service.createPreferenceMemory({ category: "topic_interest", value: "摄影" });
  const current = await f.service.getDiscoveryInterests();
  await f.service.createPreferenceMemory({ category: "learning_format", value: "先给例子" });
  await f.service.saveDiscoveryInterests({ revision: current.revision, topics: ["摄影"], mutationId: "different-category" });
  await f.service.createPreferenceMemory({ category: "topic_interest", value: "写作" });
  await assert.rejects(f.service.saveDiscoveryInterests({ revision: current.revision, topics: ["数学"], mutationId: "stale-editor" }), /其他窗口更新/);
  assert.deepEqual((await f.service.getDiscoveryInterests()).interests.map(item => item.value), ["摄影", "写作"]);
});

test("兴趣输入无效或存储失败时，整批偏好保持原值且可重试", async () => {
  const f = fixture();
  await f.service.createPreferenceMemory({ category: "topic_interest", value: "摄影" });
  const current = await f.service.getDiscoveryInterests(), before = f.db();
  for (const topics of [["物理", ""], ["物理", "长".repeat(121)], ["物理", null]]) {
    await assert.rejects(f.service.saveDiscoveryInterests({ revision: current.revision, topics, mutationId: "invalid-topics" }));
    assert.deepEqual(f.db(), before);
  }
  const setItem = f.storage.setItem;
  f.storage.setItem = function () { throw new Error("空间不足"); };
  const input = { revision: current.revision, topics: ["物理", "数学"], mutationId: "quota-topics" };
  await assert.rejects(f.service.saveDiscoveryInterests(input), /空间不足/);
  assert.deepEqual(f.db(), before);
  f.storage.setItem = setItem;
  assert.equal((await f.service.saveDiscoveryInterests(input)).interests.length, 2);
});

test("明确喜欢立即改变下一批排序，撤销后恢复原排序", async function () {
  const f = fixture();
  const baseline = (await f.service.createGachaDiscoveryPool()).pool;
  const target = baseline.candidates.at(-1);
  const feedback = await f.service.sendGachaDiscoveryFeedback(baseline.id, {
    action: "like_topic", candidateId: target.id, mutationId: "like-once"
  });
  assert.equal(feedback.preference.category, "topic_interest");
  assert.equal(f.db().discoveryPools.find(function (pool) { return pool.id === baseline.id; }).status, "stale");
  const personalized = (await f.service.createGachaDiscoveryPool()).pool;
  assert.ok(personalized.candidates[0].topic.startsWith(target.topic));
  assert.ok(personalized.usedPreferenceIds.includes(feedback.preference.id));
  await f.service.deletePreferenceMemory(feedback.preference.id, "undo-like");
  const restored = (await f.service.createGachaDiscoveryPool()).pool;
  assert.equal(restored.candidates[0].topic.startsWith(target.topic), false);
});

test("主题降权和学习单元排除真实生效，同一单元换措辞也不会绕过", async function () {
  const f = fixture();
  const card = domain.generateLocalCard("缓存过期时间需要兼顾新鲜度", null, { now: NOW - 1000, random: function () { return 0.5; } });
  card.learningUnitId = "unit_cache_ttl";
  await f.service.replaceLearningState({ cards: [card], pending: [], totalDraws: 1, reviewDay: { day: "", answered: 0, completed: false } });
  const first = (await f.service.createGachaDiscoveryPool()).pool;
  const downrankTarget = first.candidates[0];
  const lowered = await f.service.sendGachaDiscoveryFeedback(first.id, { action: "less_topic", candidateId: downrankTarget.id, mutationId: "less-1" });
  const downranked = (await f.service.createGachaDiscoveryPool()).pool;
  assert.notEqual(downranked.candidates[0].topicId, downrankTarget.topicId);
  await f.service.deletePreferenceMemory(lowered.preference.id, "undo-less");

  const restoredBeforeExclusion = (await f.service.createGachaDiscoveryPool()).pool;
  const excludeTarget = restoredBeforeExclusion.candidates.find(function (candidate) { return candidate.relatedLearningUnitIds.includes(card.learningUnitId); });
  assert.ok(excludeTarget);
  const excluded = await f.service.sendGachaDiscoveryFeedback(restoredBeforeExclusion.id, { action: "exclude_unit", candidateId: excludeTarget.id, mutationId: "exclude-1" });
  const learning = (await f.service.loadLearningState()).state;
  learning.cards[0].title = "Cache TTL 的同义标题";
  await f.service.replaceLearningState(learning, "rename-same-unit");
  const next = (await f.service.createGachaDiscoveryPool()).pool;
  assert.ok(next.candidates.every(function (candidate) { return candidate.learningUnitId !== excludeTarget.learningUnitId && candidate.conceptKey !== excludeTarget.conceptKey; }));
  await f.service.deletePreferenceMemory(excluded.preference.id, "undo-exclusion");
  const restored = (await f.service.createGachaDiscoveryPool()).pool;
  assert.ok(restored.candidates.some(function (candidate) { return candidate.conceptKey === excludeTarget.conceptKey; }));
});

test("重复反馈只写一次，暂时不看和换一批不生成长期偏好", async function () {
  const f = fixture();
  const pool = (await f.service.createGachaDiscoveryPool()).pool;
  const input = { action: "too_hard", candidateId: pool.candidates[0].id, mutationId: "difficulty-once" };
  const first = await f.service.sendGachaDiscoveryFeedback(pool.id, input);
  const duplicate = await f.service.sendGachaDiscoveryFeedback(pool.id, input);
  assert.equal(duplicate.alreadyApplied, true);
  assert.equal(first.preference.id, duplicate.preference.id);
  assert.equal((await f.service.listPreferenceMemories()).memories.length, 1);
  const dismissed = (await f.service.createGachaDiscoveryPool()).pool;
  await f.service.sendGachaDiscoveryFeedback(dismissed.id, { action: "end_session", mutationId: "dismiss-only" });
  const refreshed = (await f.service.createGachaDiscoveryPool(dismissed.id)).pool;
  assert.equal(refreshed.candidates.some(function (candidate) { return dismissed.candidates.some(function (old) { return old.conceptKey === candidate.conceptKey || old.semanticSignature === candidate.semanticSignature; }); }), false);
  assert.equal((await f.service.listPreferenceMemories()).memories.length, 1);
});

test("停用偏好后上下文与候选缓存都不再使用，档案之间互不串用", async function () {
  const storage = memoryStorage();
  const a = fixture({ storage: storage, profileId: "a" });
  const b = fixture({ storage: storage, profileId: "b" });
  const sharedCard = domain.generateLocalCard("同一套卡册里的共同知识", null, { now: NOW - 1000, random: function () { return 0.5; } });
  const sharedState = { cards: [sharedCard], pending: [], totalDraws: 1, reviewDay: { day: "", answered: 0, completed: false } };
  await a.service.replaceLearningState(sharedState);
  await b.service.replaceLearningState(sharedState);
  const created = await a.service.createPreferenceMemory({ category: "topic_interest", value: "摄影", mutationId: "interest-photo" });
  await b.service.createPreferenceMemory({ category: "topic_interest", value: "数学", mutationId: "interest-math" });
  assert.deepEqual((await a.service.getLearningContext({ mode: "recommendation" })).context.interests.map(function (item) { return item.value; }), ["摄影"]);
  assert.deepEqual((await b.service.getLearningContext({ mode: "recommendation" })).context.interests.map(function (item) { return item.value; }), ["数学"]);
  const activePool = (await a.service.createGachaDiscoveryPool()).pool;
  await a.service.updatePreferenceMemory(created.memory.id, { enabled: false, mutationId: "disable-photo" });
  assert.equal(a.db().discoveryPools.find(function (pool) { return pool.id === activePool.id; }).status, "stale");
  const context = (await a.service.getLearningContext({ mode: "recommendation" })).context;
  assert.equal(context.explicitPreferences.length, 0);
  assert.equal((await a.service.createGachaDiscoveryPool()).pool.usedPreferenceIds.length, 0);
});

test("近期事实只保留三十天，可清除且不会自动变成长期兴趣", async function () {
  const f = fixture();
  await f.service.recordLearningEvent({ eventId: "recent-open", type: "card_opened", cardId: "card-new", topic: "缓存", occurredAt: NOW - 2 * 86_400_000 });
  await f.service.recordLearningEvent({ eventId: "expired-open", type: "card_opened", cardId: "card-old", topic: "网络", occurredAt: NOW - 31 * 86_400_000 });
  const context = (await f.service.getLearningContext({ mode: "recommendation" })).context;
  assert.deepEqual(context.recentFacts.map(function (event) { return event.cardId; }), ["card-new"]);
  assert.equal(context.interests.length, 0);
  assert.equal((await f.service.listPreferenceMemories()).memories.length, 0);
  const cleared = await f.service.clearRecentLearningContext({ mutationId: "clear-recent" });
  assert.equal(cleared.clearedCount, 1);
  assert.equal((await f.service.getLearningContext({ mode: "recommendation" })).context.recentFacts.length, 0);
});
test("近期事实三十天临界值精确到毫秒，窗口滑动不删除长期偏好", async function () {
  const f = fixture();
  const cutoff = NOW - 30 * 86400000;
  await f.service.createPreferenceMemory({ category: "topic_interest", value: "摄影", mutationId: "boundary-interest" });
  for (const offset of [-1, 0, 1]) await f.service.recordLearningEvent({ eventId: "boundary-" + offset, type: "card_opened",
    cardId: "card-boundary-" + offset, topic: "摄影", occurredAt: cutoff + offset });
  let context = (await f.service.getLearningContext({ mode: "recommendation" })).context;
  assert.deepEqual(context.recentFacts.map(item => item.cardId).sort(), ["card-boundary-0", "card-boundary-1"]);
  f.setNow(NOW + 1);
  context = (await f.service.getLearningContext({ mode: "recommendation" })).context;
  assert.deepEqual(context.recentFacts.map(item => item.cardId), ["card-boundary-1"]);
  assert.deepEqual(context.interests.map(item => item.value), ["摄影"]);
});

test("答错只形成可追溯练习证据，不会被写成不喜欢", async function () {
  const f = fixture();
  const card = domain.generateLocalCard("间隔复习通过拉开时间巩固记忆", null, { now: NOW - 1000, random: function () { return 0.5; } });
  card.dueAt = NOW - 1;
  card.mastery = 4;
  await f.service.replaceLearningState({ cards: [card], pending: [], totalDraws: 0, reviewDay: { day: "", answered: 0, completed: false } });
  const wrongIndex = card.correctIndex === 0 ? 1 : 0;
  const opened = await f.service.openGachaReview(card.id);
  await f.service.getGachaReviewHint(card.id, { attemptId: opened.question.attemptId });
  await f.service.answerGachaReview(card.id, { attemptId: opened.question.attemptId, exerciseId: opened.question.exerciseId,
    exerciseVersion: opened.question.exerciseVersion, chosenIndex: wrongIndex, mutationId: "review-wrong-once", durationMs: 2400 });
  const context = (await f.service.getLearningContext({ mode: "recommendation" })).context;
  assert.equal(context.explicitPreferences.length, 0);
  assert.equal(context.learnedUnits[0].evidenceKind, "observed_review");
  assert.equal(context.learnedUnits[0].incorrectCount, 1);
  assert.equal(context.learnedUnits[0].hintUsedCount, 1);
  assert.equal(context.learnedUnits[0].masteryScore, null);
  assert.equal(context.learnedUnits[0].masteryLevel, "learning");
  assert.equal(context.learnedUnits[0].errorCause, "unknown");
});

test("只有旧卡分数时明确标为历史状态，不包装成精确能力", async function () {
  const f = fixture();
  const card = domain.generateLocalCard("缓存通过复用结果减少重复工作", null, { now: NOW - 1000, random: function () { return 0.5; } });
  card.mastery = 5;
  await f.service.replaceLearningState({ cards: [card], pending: [], totalDraws: 0, reviewDay: { day: "", answered: 0, completed: false } });
  const concepts = (await f.service.listConceptMasteries()).concepts;
  assert.equal(concepts[0].evidenceKind, "legacy_card_state");
  assert.equal(concepts[0].evidenceState, "unknown");
  assert.equal(concepts[0].masteryScore, null);
  assert.equal(concepts[0].legacyScore, 5);
});

test("打开、收藏和收下只记近期事实，不会被解释为兴趣或答题掌握", async function () {
  const f = fixture();
  const card = domain.generateLocalCard("收藏不等于学会", null, { now: NOW - 1000, random: function () { return 0.5; } });
  await f.service.replaceLearningState({ cards: [card], pending: [], totalDraws: 1, reviewDay: { day: "", answered: 0, completed: false } });
  const next = (await f.service.loadLearningState()).state;
  next.cards[0].favorite = true;
  await f.service.replaceLearningState(next, "favorite-card-once");
  await f.service.recordLearningEvent({ eventId: "opened-card-once", type: "card_opened", cardId: card.id, learningUnitId: card.learningUnitId, topic: card.title });
  await f.service.recordLearningEvent({ eventId: "saved-card-once", type: "card_saved", cardId: card.id, learningUnitId: card.learningUnitId, topic: card.title });
  const context = (await f.service.getLearningContext({ mode: "recommendation" })).context;
  assert.deepEqual(new Set(context.recentFacts.map(function (event) { return event.type; })), new Set(["card_favorited", "card_opened", "card_saved"]));
  assert.equal(context.interests.length, 0);
  assert.equal(context.reviewSummary.observedUnitCount, 0);
  assert.equal(context.learnedUnits[0].evidenceKind, "legacy_card_state");
  assert.equal(context.learnedUnits[0].masteryLevel, "unknown");
});

test("旧的不感兴趣候选保留为待确认建议，迁移不会静默升级", async function () {
  const f = fixture({ seed: {
    schemaVersion: 5, version: 1,
    learningState: { cards: [], pending: [], totalDraws: 0, reviewDay: { day: "", answered: 0, completed: false } },
    migrations: [], drafts: [], sourceChecks: [], documents: [], discoveryPools: [], reviewEvents: [], preferences: [],
    candidates: [{ id: "candidate_legacy_negative", category: "topic_interest", value: "减少推荐旧主题", confidence: 0.5,
      evidence: [{ sourceType: "agent_run", sourceId: "legacy", summary: "旧版反馈", observedAt: NOW }], eligibleForConfirmation: false, status: "pending", createdAt: NOW, updatedAt: NOW }],
    runs: [], traces: {}, pendingRuns: {}, audit: []
  } });
  assert.equal((await f.service.listPreferenceMemories()).memories.length, 0);
  assert.equal((await f.service.listMemoryCandidates()).candidates[0].status, "pending");
  assert.throws(function () { f.service.confirmMemoryCandidate("candidate_legacy_negative", "do-not-promote"); }, /确认门槛/);
  assert.equal((await f.service.getLearningContext({ mode: "recommendation" })).context.explicitPreferences.length, 0);
});
