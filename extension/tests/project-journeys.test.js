const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { createExtensionService, DB_KEY } = require('../src/backend/application/extension-service.js');
const domain = require('../src/frontend/domain/card-domain.js');
const { memoryStorage } = require('../src/shared/runtime-utils.js');
const { fixtureData, DAY } = require('./fixtures/project-scenarios.js');

function fixture(kind, now, storage = memoryStorage(), indexedDB = new IDBFactory(), profileId = 'project-journey') {
  let clock = now;
  storage.setItem(DB_KEY + ':' + profileId, JSON.stringify(fixtureData(kind, now)));
  const create = () => createExtensionService({ storage, profileId, indexedDB, now: () => clock, cardDomain: domain, embedding: false,
    providerModule: {}, providerTransport: { complete: async () => { throw new Error('普通复习与数据操作不应请求模型'); } } });
  return { service: create(), reopen: create, setNow: value => { clock = value; }, storage, indexedDB };
}
const response = (question, chosenIndex, mutationId) => ({ attemptId: question.attemptId, exerciseId: question.exerciseId, exerciseVersion: question.exerciseVersion, chosenIndex, mutationId, durationMs: 1200 });

test('项目时钟场景：到期前、恰好到期、到期后一毫秒按真实服务筛选，重开保持一致', async () => {
  const now = new Date(2026, 8, 13, 12).getTime(), fx = fixture('due-boundaries', now);
  fx.setNow(now - 1);
  assert.equal((await fx.service.getGachaReview()).dueCount, 1);
  fx.setNow(now);
  assert.equal((await fx.service.getGachaReview()).dueCount, 2);
  fx.setNow(now + 1);
  assert.equal((await fx.service.getGachaReview()).dueCount, 3);
  const reopened = fx.reopen();
  assert.equal((await reopened.getGachaReview()).dueCount, 3);
  assert.deepEqual((await reopened.loadLearningState()).state.cards.map(c => c.dueAt), [now - 1, now, now + 1]);
  fx.service.dispose(); reopened.dispose();
});

test('项目跨月场景：作答、纠正、跨日重试、再次复习、近期过期与持久重开共用证据', async () => {
  const now = new Date(2026, 8, 13, 23, 59, 59, 500).getTime(), fx = fixture('single-due', now);
  await fx.service.createPreferenceMemory({ category: 'learning_format', value: '先举例再给定义', mutationId: 'format' });
  await fx.service.setCardFavorite('before', true);
  const question = (await fx.service.openGachaReview('before')).question;
  assert.equal(question.answer, undefined); assert.equal(question.correctIndex, undefined);
  await fx.service.getGachaReviewHint('before', { attemptId: question.attemptId });
  const input = response(question, 0, 'first-answer');
  const wrong = await fx.service.answerGachaReview('before', input);
  assert.equal(wrong.feedback.correct, false);
  await fx.service.correctGachaReviewEvent(wrong.feedback.reviewEventId, { errorType: 'concept_confusion', note: '混淆必要和充分条件', mutationId: 'correct-cause' });
  const first = (await fx.service.getGachaReviewEvidence('before')).events[0];
  fx.setNow(now + 1000);
  await fx.service.answerGachaReview('before', input);
  const nextDay = await fx.service.getGachaReview();
  assert.equal(nextDay.dailyAnswered, 0);
  assert.equal((await fx.service.getGachaReviewEvidence('before')).events.length, 1);
  fx.setNow(wrong.feedback.dueAt + 1);
  const retry = (await fx.service.openGachaReview('before')).question;
  assert.notEqual(retry.exerciseId, question.exerciseId);
  assert.equal(retry.type, 'recall');
  await fx.service.revealGachaReviewAnswer('before', { attemptId: retry.attemptId, responseText: '必要条件成立还不够' });
  await fx.service.answerGachaReview('before', { attemptId: retry.attemptId, exerciseId: retry.exerciseId, exerciseVersion: retry.exerciseVersion,
    selfAssessedCorrect: true, responseText: '必要条件成立还不够', mutationId: 'second-answer' });
  const recent = (await fx.service.getLearningContext({ mode: 'recommendation' })).context;
  assert.equal(recent.learnedUnits.find(u => u.learningUnitId === 'unit_before').reviewCount, 2);
  assert.ok(recent.recentFacts.length > 0);
  fx.setNow(wrong.feedback.dueAt + 32 * DAY);
  const reopened = fx.reopen();
  const month = (await reopened.getLearningContext({ mode: 'recommendation' })).context;
  assert.equal(month.recentFacts.length, 0);
  assert.equal(month.explicitPreferences.length, 1);
  const evidence = await reopened.getGachaReviewEvidence('before');
  assert.equal(evidence.events.length, 2); assert.equal(evidence.corrections.length, 1);
  assert.deepEqual(evidence.events.find(e => e.id === first.id), first);
  assert.equal((await reopened.loadLearningState()).state.cards.find(c => c.id === 'before').favorite, true);
  fx.service.dispose(); reopened.dispose();
});

test('项目规模与隔离场景：千卡库筛选、延期、删卡、清空不改变另一个档案', async () => {
  const now = new Date(2026, 8, 13, 12).getTime(), fx = fixture('large-library', now);
  const other = fixture('due-boundaries', now, fx.storage, fx.indexedDB, 'project-other');
  const original = (await other.service.loadLearningState()).state;
  const review = await fx.service.getGachaReview();
  assert.equal(review.dueCount, 600); assert.equal(review.capsule.cardId, 'scale_0000');
  const deferred = await fx.service.deferGachaReview('scale_0000', { action: 'later', mutationId: 'scale-defer' });
  assert.equal(deferred.review.dueCount, 599); assert.equal(deferred.review.deferredCount, 1);
  await fx.service.deleteCards(['scale_0001']);
  assert.equal((await fx.service.loadLearningState()).state.cards.length, 999);
  await fx.service.clearAllData();
  const fresh = fx.reopen();
  assert.equal((await fresh.loadLearningState()).state.cards.length, 0);
  assert.deepEqual((await other.service.loadLearningState()).state, original);
  fx.service.dispose(); fresh.dispose(); other.service.dispose();
});
