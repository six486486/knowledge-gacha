const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { setTimeout: delay } = require('node:timers/promises');
const utils = require('../src/shared/runtime-utils.js');
const domain = require('../src/frontend/domain/card-domain.js');
const { createExtensionService, DB_KEY } = require('../src/backend/application/extension-service.js');
const { createMaterialRepository } = require('../src/backend/infrastructure/storage/material-repository.js');
const { requestPayload, qualityOutput, verificationOutput } = require('./fixtures/quality-output.js');

const NOW = Date.UTC(2026, 8, 6, 8);
const TEXT = '边际成本是每多生产一个单位额外增加的成本。';
function fixture(t, respond) {
  const storage = utils.memoryStorage();
  const repository = createMaterialRepository({ indexedDB: new IDBFactory(), profileId: 'lifecycle' });
  const service = createExtensionService({ storage, repository, profileId: 'lifecycle', cardDomain: domain, providerModule: {}, now: () => NOW,
    modelConfig: { model: 'fixture', apiKey: 'fixture-only' }, providerTransport: { complete: async (_, request) => {
      const input = requestPayload(request);
      if (respond) await respond(input);
      return { content: JSON.stringify(verificationOutput(input) || qualityOutput(input)), provider: { model: 'fixture', latencyMs: 1 } };
    } } });
  t.after(() => repository.close());
  const db = async () => await repository.get('state', 'current') || {};
  return { service, storage, repository, db };
}
function card(id) { return domain.sanitizeCard({ id, title: id, summary: TEXT, question: '什么是新增成本？', options: ['新增部分', '全部成本'], correctIndex: 0, dueAt: NOW - 1 }); }
function state(cards = [], pending = []) { return { cards, pending, totalDraws: 0, reviewDay: { day: utils.localDay(NOW), answered: 0, completed: false } }; }

test('收藏只更新指定卡，保留最新复习、新卡和待打开卡；重复设置不重复记录', async t => {
  const f = fixture(t);
  await f.service.migrateLocalStorage(state([card('old')], [card('pending')]));
  const opened = await f.service.openGachaReview('old');
  await f.service.answerGachaReview('old', { attemptId: opened.question.attemptId, chosenIndex: 0, mutationId: 'review' });
  const draft = await f.service.createGachaCardDraft({ text: TEXT });
  await f.service.confirmGachaCardDraft(draft.session.id);
  const before = (await f.service.loadLearningState()).state;
  const events = structuredClone((await f.db()).reviewEvents);
  await f.service.setCardFavorite('old', true, 'favorite');
  const after = (await f.service.loadLearningState()).state;
  const expected = structuredClone(before);
  Object.assign(expected.cards.find(item => item.id === 'old'), { favorite: true, updatedAt: NOW });
  assert.deepEqual(after, expected);
  assert.deepEqual((await f.db()).reviewEvents, events);
  await f.service.setCardFavorite('old', true, 'favorite-retry');
  assert.equal((await f.db()).recentLearningEvents.filter(item => item.type === 'card_favorited').length, 1);
  await f.service.setCardFavorite('old', false, 'unfavorite');
  assert.equal((await f.db()).recentLearningEvents.filter(item => item.type === 'card_unfavorited').length, 1);
  await f.service.deleteCards(['old']);
  await assert.rejects(f.service.setCardFavorite('old', true), /不存在|删除/);
  assert.equal((await f.service.loadLearningState()).state.cards.some(item => item.id === 'old'), false);
});

test('旧待打开卡按 ID 入册且重复打开不重复计数，不覆盖同期复习', async t => {
  const f = fixture(t);
  await f.service.migrateLocalStorage(state([card('old')], [card('pending')]));
  const opened = await f.service.openGachaReview('old');
  await f.service.answerGachaReview('old', { attemptId: opened.question.attemptId, chosenIndex: 0 });
  const before = (await f.service.loadLearningState()).state;
  const first = await f.service.openPendingCard('pending');
  const again = await f.service.openPendingCard('pending');
  assert.equal(first.card.id, 'pending');
  assert.equal(again.card.id, first.card.id);
  assert.equal(again.state.totalDraws, before.totalDraws + 1);
  assert.equal(again.state.pending.length, 0);
  assert.deepEqual(again.state.cards.find(item => item.id === 'old'), before.cards[0]);
  assert.deepEqual(again.state.reviewDay, before.reviewDay);
  await f.service.deleteCards(['pending']);
  await assert.rejects(f.service.openPendingCard('pending'), /不存在|移除/);
});

test('草稿局部修改和重新核验保留学习单元与主题标识', async t => {
  const f = fixture(t);
  const { session } = await f.service.createGachaCardDraft({ text: TEXT, learningUnitId: 'unit_existing', topicId: 'topic_existing' });
  await f.service.updateGachaCardDraft(session.id, { title: '修改后的标题' });
  for (const action of ['review', 'example', 'exercise', 'retry']) {
    const revised = (await f.service.reviseGachaCardDraft(session.id, action)).session;
    assert.equal(revised.card.id, session.card.id);
    assert.equal(revised.card.learningUnitId, 'unit_existing', action);
    assert.equal(revised.card.topicId, 'topic_existing', action);
  }
});

test('应用资料搜索可读取实际资料与卡册，不修改数据库', async t => {
  const f = fixture(t);
  await f.service.migrateLocalStorage(state([card('saved')]));
  await f.service.ingestDocument({ title: '成本说明', text: TEXT, type: 'text' });
  const before = (await f.db());
  assert.equal((await f.service.getDocument(before.documents[0].id)).document.content, TEXT);
  const result = await f.service.searchKnowledge({ query: '边际成本' });
  assert.ok(result.results.some(item => item.type === 'document'));
  assert.ok(result.results.some(item => item.type === 'document' && item.text.includes('边际成本')));
  assert.ok(result.results.some(item => item.type === 'card' && item.id === 'saved'));
  assert.deepEqual((await f.db()), before);
});

test('派生向量清理失败不把已提交的删除误报成失败，也不能召回已删除卡', async t => {
  const f = fixture(t);
  await f.service.migrateLocalStorage(state([card('saved')]));
  const list = f.repository.list;
  f.repository.list = async name => { if (name === 'vectors') throw new Error('fixture index failure'); return list(name); };
  await f.service.deleteCards(['saved']);
  assert.equal((await f.service.loadLearningState()).state.cards.length, 0);
  assert.equal((await f.service.searchKnowledge({ query: '边际成本' })).results.length, 0);
});

test('清空等待已开始的生成完成，迟到结果不会重新留下草稿或材料', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture(t, async input => { if (input.operation === 'generate') { started(); await gate; } });
  const generated = f.service.createGachaCardDraft({ text: TEXT });
  await waiting;
  const cleared = f.service.clearAllData();
  await delay(40);
  release();
  await Promise.all([generated, cleared]);
  assert.equal((await f.service.listGachaCardDrafts()).sessions.length, 0);
  assert.equal((await f.service.loadLearningState()).state.cards.length, 0);
  for (const table of ['payloads', 'assets', 'imports']) assert.equal((await f.repository.list(table)).length, 0);
  await f.service.saveGachaMaterialDraft({ text: '清空后新建的材料' });
  assert.equal((await f.service.listGachaCardDrafts()).sessions.length, 1);
});
