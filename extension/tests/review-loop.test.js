const test = require("node:test");
const assert = require("node:assert/strict");

const domain = require("../src/frontend/domain/card-domain.js");
const { createExtensionService, DB_KEY } = require("../src/backend/application/extension-service.js");
const reviewService = require("../src/backend/features/review/review-service.js");
const reviewLearning = require("../src/shared/review-learning.js");
const utils = require("../src/shared/runtime-utils.js");

const NOW = Date.UTC(2026, 8, 4, 8);

function card(id, title, unitId, dueAt = NOW - 1, citations = []) {
  return domain.sanitizeCard({
    id: id, contentVersion: 2, version: 1, title: title, learningUnitId: unitId, learningObjective: "能判断" + title + "的适用条件",
    knowledgeType: "concept", summary: title + "只有在题干给定的条件成立时才能应用。",
    example: { type: "example", text: "在一个新的小场景中先核对条件，再使用这条规则。", origin: "authored" }, boundaries: "必须先核对题干条件。",
    citations: citations, favorite: false, mastery: 0, reviewCount: 0, createdAt: NOW - 1000, updatedAt: NOW - 1000, dueAt: dueAt
  });
}

function exercise(cardValue, id) {
  return {
    id: id || "exercise_" + cardValue.id, cardId: cardValue.id, learningUnitId: cardValue.learningUnitId, version: 1, type: "choice",
    question: "新场景中，使用“" + cardValue.title + "”前最先要做什么？", options: ["忽略题干条件直接套用", "先核对题干条件", "只记住术语"], correctIndex: 1,
    answer: "先核对题干条件", answerExplanation: "只有条件成立时才能应用这条规则。", rubric: ["识别必要条件", "再应用规则"],
    misconceptions: ["忽略题干中的必要条件", "", "混淆记住术语与应用规则"]
  };
}

function fixture(options = {}) {
  const storage = utils.memoryStorage();
  const profileId = options.profileId || "review-loop";
  const key = DB_KEY + ":" + profileId;
  let clock = options.now || NOW;
  const cards = options.cards || [];
  const exercises = options.exercises || cards.map(function (item) { return exercise(item); });
  cards.forEach(function (item) { item.exerciseIds = exercises.filter(function (question) { return question.cardId === item.id; }).map(function (question) { return question.id; }); });
  storage.setItem(key, JSON.stringify(Object.assign({
    schemaVersion: 7, version: 1,
    learningState: { cards: cards, pending: [], totalDraws: cards.length, reviewDay: { day: utils.localDay(clock), answered: 0, completed: false } },
    exercises: exercises, reviewEvents: [], reviewSettings: { dailyGoal: 3, scheduleVersion: reviewLearning.SCHEDULE_VERSION }
  }, options.seed || {})));
  const responses = (options.responses || []).slice();
  const service = createExtensionService({
    storage: storage, profileId: profileId, indexedDB: false, cardDomain: domain, providerModule: {},
    providerTransport: { complete: async function (_config, request) {
      if (options.complete) return options.complete(request);
      if (!responses.length) throw new Error("本测试不应调用模型");
      return responses.shift();
    } },
    modelConfig: options.modelConfig || null,
    now: function () { return clock; }
  });
  return {
    service: service,
    setNow: function (value) { clock = value; },
    db: function () { return JSON.parse(storage.getItem(key)); },
    write: function (db) { storage.setItem(key, JSON.stringify(db)); }
  };
}

async function answerChoice(f, opened, chosenIndex, mutationId) {
  return f.service.answerGachaReview(opened.question.cardId, {
    attemptId: opened.question.attemptId, exerciseId: opened.question.exerciseId, exerciseVersion: opened.question.exerciseVersion,
    chosenIndex: chosenIndex, mutationId: mutationId, durationMs: 1200
  });
}

test("答案不会随题目提前返回，提示和具体错因进入同一幂等事件", async function () {
  const item = card("card_hint", "缓存边界", "unit_hint");
  const f = fixture({ cards: [item] });
  const opened = await f.service.openGachaReview(item.id);
  assert.equal(Object.hasOwn(opened.question, "answer"), false);
  assert.equal(Object.hasOwn(opened.question, "correctIndex"), false);
  await f.service.getGachaReviewHint(item.id, { attemptId: opened.question.attemptId });
  const first = await answerChoice(f, opened, 0, "answer-once");
  const duplicate = await answerChoice(f, opened, 0, "answer-once");
  assert.equal(first.feedback.correct, false);
  assert.equal(first.feedback.hintUsed, true);
  assert.equal(first.feedback.errorCause.code, "missing_prerequisite");
  assert.equal(duplicate.alreadyApplied, true);
  assert.equal(f.db().reviewEvents.length, 1);
  await assert.rejects(answerChoice(f, opened, 1, "answer-once"), /同一操作标识/);
});

test("作答按打开时的题目快照判分，后来改题不覆盖历史版本", async function () {
  const item = card("card_version", "适用范围", "unit_version");
  const f = fixture({ cards: [item] });
  const opened = await f.service.openGachaReview(item.id);
  const changed = f.db();
  const stored = changed.exercises.find(function (question) { return question.id === opened.question.exerciseId; });
  stored.version = 2;
  stored.question = "已经修改的新问题";
  stored.correctIndex = 0;
  stored.answer = stored.options[0];
  f.write(changed);
  const answered = await answerChoice(f, opened, 1, "answer-old-version");
  assert.equal(answered.feedback.correct, true);
  assert.equal(f.db().reviewEvents[0].exerciseVersion, 1);
  assert.match(f.db().reviewEvents[0].exerciseSnapshot.question, /使用“适用范围”前/);
});

test("同一学习目标轮换到不同回忆题，回忆答案只在主动对照后返回", async function () {
  const item = card("card_variant", "条件判断", "unit_variant");
  const f = fixture({ cards: [item] });
  const first = await f.service.openGachaReview(item.id);
  const answered = await answerChoice(f, first, 1, "variant-first");
  f.setNow(answered.feedback.dueAt + 1);
  const second = await f.service.openGachaReview(item.id);
  assert.notEqual(second.question.exerciseId, first.question.exerciseId);
  assert.equal(second.question.type, "recall");
  assert.equal(Object.hasOwn(second.question, "answer"), false);
  const revealed = await f.service.revealGachaReviewAnswer(item.id, { attemptId: second.question.attemptId, responseText: "先核对条件" });
  assert.match(revealed.answer, /条件/);
  const completed = await f.service.answerGachaReview(item.id, { attemptId: second.question.attemptId, exerciseId: second.question.exerciseId,
    exerciseVersion: second.question.exerciseVersion, selfAssessedCorrect: true, responseText: "先核对条件", mutationId: "variant-second" });
  assert.equal(completed.feedback.scoringMethod, "self_assessment");
});

test("每日目标不是硬上限，达标后继续可完成更多到期题", async function () {
  const firstCard = card("card_goal_a", "目标甲", "unit_goal_a");
  const secondCard = card("card_goal_b", "目标乙", "unit_goal_b");
  const f = fixture({ cards: [firstCard, secondCard], seed: { reviewSettings: { dailyGoal: 1 } } });
  const overview = await f.service.getGachaReview();
  const first = await f.service.openGachaReview(overview.capsule.cardId);
  const firstResult = await answerChoice(f, first, 1, "goal-first");
  assert.equal(firstResult.next.status, "goal_reached");
  assert.equal(firstResult.next.dueCount, 1);
  const continued = await f.service.continueGachaReview({ mutationId: "goal-continue" });
  assert.equal(continued.review.status, "ready");
  const second = await f.service.openGachaReview(continued.review.capsule.cardId);
  const secondResult = await answerChoice(f, second, 1, "goal-second");
  assert.equal(secondResult.feedback.dailyAnswered, 2);
  assert.equal(f.db().learningState.reviewDay.answered, 2);
});
test("跨午夜提交计入实际作答日，重复提交不重新计数且保留前日事件", async function () {
  const beforeMidnight = new Date(2026, 8, 6, 23, 59, 59, 500).getTime();
  const a = card("card_midnight_a", "跨日甲", "unit_midnight_a");
  const b = card("card_midnight_b", "跨日乙", "unit_midnight_b");
  const f = fixture({ now: beforeMidnight, cards: [a, b], seed: { reviewSettings: { dailyGoal: 1 } } });
  const first = await f.service.openGachaReview(a.id);
  await answerChoice(f, first, 1, "midnight-first");
  await f.service.continueGachaReview({ mutationId: "midnight-continue" });
  const second = await f.service.openGachaReview(b.id);
  f.setNow(beforeMidnight + 1000);
  const result = await answerChoice(f, second, 1, "midnight-second");
  assert.equal(result.feedback.dailyAnswered, 1);
  assert.equal(f.db().learningState.reviewDay.day, "2026-09-07");
  assert.equal(f.db().reviewEvents.length, 2);
  await answerChoice(f, second, 1, "midnight-second");
  assert.equal(f.db().learningState.reviewDay.answered, 1);
  assert.equal(f.db().reviewEvents.length, 2);
});

test("队列避免同单元紧邻，并允许稍后处理当前卡", async function () {
  const a1 = card("card_adj_a1", "同单元甲一", "unit_adj_a");
  const a2 = card("card_adj_a2", "同单元甲二", "unit_adj_a");
  const b = card("card_adj_b", "不同单元乙", "unit_adj_b");
  const f = fixture({ cards: [a1, a2, b], seed: { learningState: { cards: [a1, a2, b], pending: [], totalDraws: 3,
    reviewDay: { day: utils.localDay(NOW), answered: 1, completed: false, lastLearningUnitId: "unit_adj_a" } } } });
  const overview = await f.service.getGachaReview();
  assert.equal(overview.capsule.cardId, b.id);
  const deferred = await f.service.deferGachaReview(b.id, { action: "later", mutationId: "defer-b" });
  assert.equal(deferred.review.deferredCount, 1);
  assert.ok([a1.id, a2.id].includes(deferred.review.capsule.cardId));
});

test("批量新卡按每日目标分批到期", function () {
  const cards = [];
  const group = "batch_release";
  const first = reviewService.nextNewCardDueAt(cards, NOW, 2, group);
  cards.push({ releaseGroupId: group, learningStage: "new", initialLearningCompletedAt: null });
  const second = reviewService.nextNewCardDueAt(cards, NOW, 2, group);
  cards.push({ releaseGroupId: group, learningStage: "new", initialLearningCompletedAt: null });
  const third = reviewService.nextNewCardDueAt(cards, NOW, 2, group);
  assert.equal(first, NOW + reviewLearning.DAY);
  assert.equal(second, NOW + reviewLearning.DAY);
  assert.equal(third, NOW + 2 * reviewLearning.DAY);
});

test("错因纠正追加独立记录，并由证据接口和记忆读取同一结果", async function () {
  const item = card("card_correction", "必要条件", "unit_correction");
  const f = fixture({ cards: [item] });
  const opened = await f.service.openGachaReview(item.id);
  const answered = await answerChoice(f, opened, 0, "correction-answer");
  await f.service.correctGachaReviewEvent(answered.feedback.reviewEventId, { errorType: "concept_confusion", note: "我把两个条件混在一起", mutationId: "correction-once" });
  const evidence = await f.service.getGachaReviewEvidence(item.id);
  const concepts = await f.service.listConceptMasteries();
  assert.equal(evidence.events.length, 1);
  assert.equal(evidence.corrections.length, 1);
  assert.equal(evidence.mastery.errorCause.code, "concept_confusion");
  assert.equal(concepts.concepts[0].errorCause, "concept_confusion");
  assert.equal(f.db().reviewEvents[0].errorType, "missing_prerequisite");
});

test("没有到期题时可主动释放一张已分批排期的新卡", async function () {
  const item = card("card_release", "分批学习", "unit_release", NOW + reviewLearning.DAY);
  item.learningStage = "new";
  item.initialLearningCompletedAt = null;
  const f = fixture({ cards: [item] });
  const overview = await f.service.getGachaReview();
  assert.equal(overview.status, "no_due_reviews");
  assert.equal(overview.newCardCount, 1);
  const continued = await f.service.continueGachaReview({ mutationId: "release-next" });
  assert.equal(continued.releasedCardId, item.id);
  assert.equal(continued.review.status, "ready");
});

test("一次答对仍是正在学习，跨两种练习多次无提示答对才进入多次验证", function () {
  const one = reviewLearning.masterySnapshot([{ id: "e1", exerciseId: "a", exerciseVersion: 1, correct: true, hintUsed: false, answeredAt: NOW }], NOW);
  assert.equal(one.masteryLevel, "learning");
  const verified = reviewLearning.masterySnapshot([
    { id: "e1", exerciseId: "a", exerciseVersion: 1, correct: true, hintUsed: false, answeredAt: NOW },
    { id: "e2", exerciseId: "b", exerciseVersion: 1, correct: true, hintUsed: false, answeredAt: NOW + reviewLearning.DAY },
    { id: "e3", exerciseId: "a", exerciseVersion: 1, correct: true, hintUsed: false, answeredAt: NOW + 2 * reviewLearning.DAY }
  ], NOW + 2 * reviewLearning.DAY);
  assert.equal(verified.masteryLevel, "multiple_verified");
});

test("按需生成的新情景题经过独立核验后保存为新练习版本", async function () {
  const quote = "缓存规则只有在题干给定的条件成立时才能应用。";
  const citation = { id: "citation_variant", claim: "summary", chunkId: "chunk_variant", source: { documentId: "doc_variant", title: "缓存资料", type: "text", version: 1 },
    headingPath: [], quote: quote, position: { startCharacter: 0, endCharacter: quote.length, pageNumber: null } };
  const boundaryCitation = { ...citation, id: "citation_variant_boundary", claim: "boundaries" };
  const item = card("card_model_variant", "缓存规则", "unit_model_variant", NOW - 1, [citation, boundaryCitation]);
  const generatedExercise = { type: "choice", question: "新系统要求先确认缓存条件，哪一步正确？", options: ["直接套用", "先核对条件", "应用后再补条件"], correctIndex: 1,
    answer: "先核对条件", answerExplanation: "资料明确要求条件成立后再应用。", rubric: ["先识别条件", "再应用规则"],
    misconceptions: ["忽略必要条件", "", "步骤顺序错误，把条件检查放到了应用之后"] };
  const checks = ["grounding", "coherence", "objectiveAlignment", "answerCorrectness", "conditions"].map(function (rule) {
    const check = { rule: rule, passed: true, reason: "该项与保存依据一致" };
    if (rule === "answerCorrectness") check.optionChecks = generatedExercise.options.map(function (_option, index) {
      return { index: index, validAnswer: index === generatedExercise.correctIndex, misconceptionCorrect: true, reason: "逐项核对通过" };
    });
    return check;
  });
  const f = fixture({ cards: [item], modelConfig: { baseUrl: "https://model.example/v1", apiKey: "secret", model: "demo" }, complete: async function (request) {
    const raw = request.messages.at(-1).content;
    const payload = JSON.parse(Array.isArray(raw) ? raw.find(function (part) { return part.type === "text"; }).text : raw);
    if (payload.operation === "solve") return { content: JSON.stringify(require("./fixtures/quality-output.js").verificationOutput(payload, generatedExercise.correctIndex)), provider: { model: "demo", latencyMs: 1 } };
    if (payload.operation === "review") return { content: JSON.stringify({ findings: [], checks: checks }), provider: { model: "demo", latencyMs: 2 } };
    return { content: JSON.stringify({ exercise: generatedExercise, evidence: [{ id: "e1", evidenceId: "review_source_0", quote: quote, occurrence: 0 }], supports: { exercise: ["e1"] } }),
      provider: { model: "demo", latencyMs: 3 } };
  } });
  const created = await f.service.createGachaReviewVariant(item.id, { mutationId: "model-variant-once" });
  const duplicate = await f.service.createGachaReviewVariant(item.id, { mutationId: "model-variant-once" });
  assert.equal(created.exercise.origin, "generated_review_variant");
  assert.equal(duplicate.alreadyApplied, true);
  assert.equal(f.db().exercises.filter(function (question) { return question.origin === "generated_review_variant"; }).length, 1);
});
