const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const domain = require('../src/frontend/domain/card-domain.js');
const utils = require('../src/shared/runtime-utils.js');
const { createExtensionService, DB_KEY } = require('../src/backend/application/extension-service.js');
const { createMaterialRepository } = require('../src/backend/infrastructure/storage/material-repository.js');
const { candidateOutlines, discoveryQualityOutput } = require('./fixtures/discovery-output.js');
const { requestPayload, verificationOutput, checksFor } = require('./fixtures/quality-output.js');

const NOW = Date.UTC(2026, 8, 6, 9);
function fixture(t, transform) {
  const storage = utils.memoryStorage();
  const repository = createMaterialRepository({ indexedDB: new IDBFactory(), profileId: 'discovery_lifecycle' });
  const calls = [];
  const service = createExtensionService({ storage, repository, profileId: 'discovery_lifecycle', cardDomain: domain, providerModule: {}, now: () => NOW,
    modelConfig: { apiKey: 'fixture-only', model: 'fixture' },
    discoveryPlanner: async request => ({ outlines: candidateOutlines(request).candidates, generation: { calls: 1, model: 'fixture' } }),
    providerTransport: { complete: async (_, request) => {
      const input = requestPayload(request); calls.push(input.operation);
      let output = verificationOutput(input) || (input.operation === 'review' ? { findings: [], checks: checksFor(input.candidate) } : discoveryQualityOutput(input));
      if (transform) output = await transform(output, input);
      return { content: JSON.stringify(output), finishReason: 'stop', provider: { model: 'fixture', latencyMs: 1 } };
    } } });
  t.after(() => repository.close());
  return { service, calls, storage, repository, db: async () => await repository.get('state', 'current') };
}

test('同一发现候选同时打开只生成一份草稿，后续打开复用同一结果', async t => {
  const f = fixture(t);
  const { pool } = await f.service.createGachaDiscoveryPool();
  const id = pool.candidates[0].id;
  const [first, second] = await Promise.all([f.service.openGachaDiscoveryCandidate(pool.id, id), f.service.openGachaDiscoveryCandidate(pool.id, id)]);
  assert.equal(first.session.id, second.session.id);
  assert.equal(f.calls.filter(item => item === 'generate').length, 1);
  assert.equal((await f.service.listGachaCardDrafts()).sessions.length, 1);
  assert.equal((await f.db()).discoveryPools[0].metrics.opened, 1);
  const again = await f.service.openGachaDiscoveryCandidate(pool.id, id);
  assert.equal(again.session.id, first.session.id);
  assert.equal(again.alreadyOpened, true);
});

test('纯模型发现卡保存来源身份，不创建空原文附件或把提纲保存为引用', async t => {
  const f = fixture(t);
  const { pool } = await f.service.createGachaDiscoveryPool();
  const candidate = pool.candidates[0];
  const { session } = await f.service.openGachaDiscoveryCandidate(pool.id, candidate.id);
  const { card } = await f.service.confirmGachaCardDraft(session.id);
  assert.equal(card.discoveryBasis.verification, 'model_suggestion');
  assert.equal(card.discoveryBasis.candidateId, candidate.id);
  assert.equal(card.sourceSnapshot, null);
  assert.deepEqual(card.citations, []);
  assert.deepEqual(card.sourceIds, []);
  assert.equal((await f.db()).sources.length, 0);
  assert.equal((await f.db()).documents.length, 0);
});

test('喜欢已打开或已收下的候选不会重置其进度和漏斗指标', async t => {
  const f = fixture(t);
  const { pool } = await f.service.createGachaDiscoveryPool();
  const id = pool.candidates[0].id;
  const opened = await f.service.openGachaDiscoveryCandidate(pool.id, id);
  let feedback = await f.service.sendGachaDiscoveryFeedback(pool.id, { candidateId: id, action: 'like_topic', mutationId: 'like-opened' });
  assert.equal(feedback.candidate.status, 'opened');
  const saved = await f.service.confirmGachaCardDraft(opened.session.id);
  feedback = await f.service.sendGachaDiscoveryFeedback(pool.id, { candidateId: id, action: 'like_topic', mutationId: 'like-saved' });
  assert.equal(feedback.candidate.status, 'saved');
  assert.equal(feedback.candidate.savedCardId, saved.card.id);
  assert.equal(feedback.pool.metrics.opened, 1);
  assert.equal(feedback.pool.metrics.saved, 1);
});

test('打开期间明确移除候选，迟到结果不能重新激活候选或留下孤立草稿', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture(t, async (output, input) => { if (input.operation === 'generate') { started(); await gate; } return output; });
  const { pool } = await f.service.createGachaDiscoveryPool();
  const id = pool.candidates[0].id;
  const opening = f.service.openGachaDiscoveryCandidate(pool.id, id);
  await waiting;
  await f.service.sendGachaDiscoveryFeedback(pool.id, { candidateId: id, action: 'dismiss_candidate' });
  const checked = assert.rejects(opening, /已变化|已移除|不再/);
  release();
  await checked;
  assert.equal((await f.db()).discoveryPools[0].candidates[0].status, 'dismissed');
  assert.equal((await f.service.listGachaCardDrafts()).sessions.length, 0);
});

test('发现草稿的重新核验仍检查新增内容，不能绕过重复卡检查', async t => {
  const existing = domain.sanitizeCard({ id: 'existing', title: '缓存基础', summary: '缓存复用旧结果，减少重复计算。', learningObjective: '能解释缓存基础', contentVersion: 2 });
  const f = fixture(t, (output, input) => {
    if (input.operation === 'generate') output.card.summary = existing.summary;
    return output;
  });
  await f.service.migrateLocalStorage({ cards: [existing], pending: [], totalDraws: 1, reviewDay: {} });
  const { pool } = await f.service.createGachaDiscoveryPool();
  const candidate = pool.candidates.find(item => item.relatedCardIds.includes(existing.id));
  const opened = await f.service.openGachaDiscoveryCandidate(pool.id, candidate.id);
  assert.ok(opened.session.quality.issues.some(issue => issue.code === 'discovery_duplicate'));
  const reviewed = await f.service.reviseGachaCardDraft(opened.session.id, 'review');
  assert.equal(reviewed.session.status, 'needs_revision');
  assert.ok(reviewed.session.quality.issues.some(issue => issue.code === 'discovery_duplicate'));
  await assert.rejects(f.service.confirmGachaCardDraft(opened.session.id), /核验/);
  assert.equal((await f.service.loadLearningState()).state.cards.length, 1);
  const stored = (await f.db());
  const historical = stored.drafts.find(item => item.id === opened.session.id);
  historical.status = 'ready'; historical.quality.passed = true; historical.validatedRevision = historical.revision;
  await f.repository.put('state', 'current', stored);
  await assert.rejects(f.service.confirmGachaCardDraft(opened.session.id), /重复/);
  await f.service.updateGachaCardDraft(opened.session.id, { summary: candidate.learningObjective + '。' + candidate.newKnowledge });
  const repaired = await f.service.reviseGachaCardDraft(opened.session.id, 'review');
  assert.equal(repaired.session.status, 'ready');
  await f.service.confirmGachaCardDraft(opened.session.id);
  assert.equal((await f.service.loadLearningState()).state.cards.length, 2);
});

test('重试短暂返回无卡片后再成功，仍保留草稿原有的学习关联与卡片 ID', async t => {
  let insufficient = false;
  const f = fixture(t, (output, input) => input.operation === 'generate' && insufficient ? { status: 'insufficient_material', issues: ['需要更多材料'], card: null } : output);
  const { pool } = await f.service.createGachaDiscoveryPool();
  const opened = await f.service.openGachaDiscoveryCandidate(pool.id, pool.candidates[0].id);
  insufficient = true;
  const failed = await f.service.reviseGachaCardDraft(opened.session.id, 'retry');
  assert.equal(failed.session.card, null);
  insufficient = false;
  const recovered = await f.service.reviseGachaCardDraft(opened.session.id, 'retry');
  assert.equal(recovered.session.card.id, opened.session.card.id);
  assert.equal(recovered.session.card.learningUnitId, opened.session.card.learningUnitId);
  assert.equal(recovered.session.card.topicId, opened.session.card.topicId);
});

test('复习拒绝明确失效的尝试 ID 和空值答案，合法重试仍只记录一次', async t => {
  const f = fixture(t);
  const card = domain.sanitizeCard({ id: 'review', title: '回忆', summary: '测试', question: '选出正确项', options: ['甲', '乙'], correctIndex: 0, dueAt: NOW - 1 });
  await f.service.migrateLocalStorage({ cards: [card], pending: [], totalDraws: 1, reviewDay: {} });
  const opened = await f.service.openGachaReview(card.id);
  const before = (await f.service.loadLearningState()).state;
  await assert.rejects(f.service.answerGachaReview(card.id, { attemptId: 'no-longer-exists', chosenIndex: 0 }), /重新打开|不存在|失效/);
  for (const chosenIndex of [null, '', false, [], '0', -1, 2]) {
    await assert.rejects(f.service.answerGachaReview(card.id, { attemptId: opened.question.attemptId, chosenIndex }), /作答|答案/);
  }
  assert.deepEqual((await f.service.loadLearningState()).state, before);
  assert.equal((await f.db()).reviewEvents.length, 0);
  const input = { attemptId: opened.question.attemptId, chosenIndex: 0, mutationId: 'answer-once' };
  await f.service.answerGachaReview(card.id, input);
  assert.equal((await f.service.answerGachaReview(card.id, input)).alreadyApplied, true);
  await assert.rejects(f.service.answerGachaReview(card.id, { ...input, chosenIndex: null }), /作答|答案/);
  assert.equal((await f.db()).reviewEvents.length, 1);
});

test('复习恢复只返回已主动查看的提示和答案，未查看时保持隐藏', async t => {
  const f = fixture(t);
  const card = domain.sanitizeCard({ id: 'recall', title: '核心要点', learningObjective: '能解释核心要点', summary: '核心含义', contentVersion: 2, dueAt: NOW - 1 });
  await f.service.migrateLocalStorage({ cards: [card], pending: [], totalDraws: 1, reviewDay: {} });
  const first = await f.service.openGachaReview(card.id);
  assert.equal(first.question.type, 'recall');
  assert.equal(first.question.savedHint, '');
  assert.equal(first.question.revealedAnswer, null);
  const hint = await f.service.getGachaReviewHint(card.id, { attemptId: first.question.attemptId });
  const answer = await f.service.revealGachaReviewAnswer(card.id, { attemptId: first.question.attemptId, responseText: '自己的答案' });
  const resumed = await f.service.openGachaReview(card.id);
  assert.equal(resumed.question.attemptId, first.question.attemptId);
  assert.equal(resumed.question.savedHint, hint.hint);
  assert.equal(resumed.question.revealedAnswer.answer, answer.answer);
  assert.equal(resumed.question.savedResponse, '自己的答案');
  assert.equal((await f.db()).reviewEvents.length, 0);
});
