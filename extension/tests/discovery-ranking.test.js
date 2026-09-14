const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../src/backend/features/discovery/discovery-planner.js');
const ranking = require('../src/backend/features/discovery/discovery-ranking.js');
const discovery = require('../src/backend/features/discovery/discovery-service.js');

const seed = { id: 'interest:cache', baseScore: 120, baseTopicId: 'topic_cache', anchor: '缓存',
  mode: 'explicit_interest', reasonCode: 'explicit_interest', evidenceStatus: 'model_suggestion', baseSummary: '', sourceRefs: [] };
const context = preferences => ({ version: 1, interests: [], explicitPreferences: preferences, learnedUnits: [], excludedUnits: [], downrankedTopics: [] });
const outline = changes => ({ seedId: seed.id, conceptKey: 'expiry-invalidation', topic: '缓存过期和主动失效的区别',
  learningObjective: '能区分缓存过期和主动失效的触发方式', newKnowledge: '时间到期与主动删除分别如何触发失效。',
  knowledgeText: '缓存过期依赖时间条件，主动失效通常由数据变更触发。', difficulty: 'standard', ...changes });
function pool(outlines, { preferences = [], seeds = [seed], exclusions = {}, similarities, preferExploration = false } = {}) {
  return discovery.discoveryPool({ learningState: { cards: [] }, discoveryPools: [] }, 1,
    { learningContextForDb: () => context(preferences) }, { outlines, similarities,
      request: { seeds, preferExploration, exclusions: { existing: [], seenTargetKeys: [], seenTargets: [], ...exclusions } } });
}
function request(seeds = [seed], exclusions = {}) { return { seeds, exclusions: { existing: [], seenTargets: [], ...exclusions } }; }
function preference(value, scope = { type: 'global' }, id = 'difficulty') { return { id, category: 'difficulty_preference', value, scope }; }
function embedding(map) { return { dimensions: 2, embed: async texts => texts.map(text => map.get(text) || [0, 1]) }; }

test('重复填长新增说明不加分，有旧知识时只计算相对新增程度', () => {
  for (const baseSummary of ['', '缓存根据过期时间判断是否还能使用。']) for (const suffix of ['', '。']) {
    const original = outline({ newKnowledge: '新增比较主动删除与时间过期的触发条件' + suffix });
    const a = pool([original], { seeds: [{ ...seed, baseSummary }] }).candidates[0];
    const b = pool([{ ...original, newKnowledge: original.newKnowledge.repeat(5) }], { seeds: [{ ...seed, baseSummary }] }).candidates[0];
    assert.equal(a.score, b.score);
    assert.equal(a.scoreComponents.novelty, b.scoreComponents.novelty);
  }
  const similarities = ranking.lexicalComparison();
  const baseSummary = '缓存根据过期时间判断是否还能使用。';
  const copied = ranking.score(outline({ newKnowledge: baseSummary }), { ...seed, baseSummary }, {}, similarities);
  const novel = ranking.score(outline(), { ...seed, baseSummary }, {}, similarities);
  assert.equal(copied.components.novelty, 0);
  assert.ok(novel.components.novelty > copied.components.novelty);
});

test('入门偏好降低进阶候选优先级，保留实际难度、目标和知识内容', () => {
  const advanced = outline({ difficulty: 'challenge' });
  const easy = outline({ conceptKey: 'lru', topic: '最近最少使用淘汰的基本过程', learningObjective: '能演示缓存容量满时淘汰哪一项', difficulty: 'foundation' });
  const result = pool([advanced, easy], { preferences: [preference('foundational')] });
  assert.equal(result.candidates[0].conceptKey, easy.conceptKey);
  const actual = result.candidates.find(item => item.conceptKey === advanced.conceptKey);
  assert.equal(actual.difficulty, 'challenge');
  assert.equal(actual.knowledgeText, advanced.knowledgeText);
  assert.equal(actual.learningObjective, advanced.learningObjective);
  assert.ok(actual.scoreComponents.difficulty < 0);
  assert.match(actual.reasons.at(-1).summary, /降低推荐优先级/);
});

test('难度偏好按知识点、主题、全局顺序生效，其他主题不串用', () => {
  const preferences = [preference('foundational'), preference('balanced', { type: 'topic', topicId: 'topic_cache' }, 'topic'),
    preference('advanced', { type: 'unit', unitId: 'unit_cache' }, 'unit')];
  assert.equal(planner.difficultyPreference(preferences, { ...seed, baseLearningUnitId: 'unit_cache' }).id, 'unit');
  assert.equal(planner.difficultyPreference(preferences, seed).id, 'topic');
  assert.equal(planner.difficultyPreference(preferences, { baseTopicId: 'unrelated' }).id, 'difficulty');
  assert.equal(planner.difficultyPreference(preferences.slice(1), { baseTopicId: 'unrelated' }), null);
});

test('候选模型请求接收每个种子的难度要求，修复请求仍保留要求', async () => {
  const db = { discoveryPools: [], learningState: { cards: [] } };
  const req = planner.buildSeedRequest(db, context([preference('foundational')]), 1, {});
  let calls = 0;
  await planner.requestOutlines({ complete: async (_, input) => {
    const payload = JSON.parse(input.messages.at(-1).content);
    assert.ok(payload.seeds.every(item => item.targetDifficulty === 'foundation'));
    assert.match(input.messages[0].content, /不能只改标签/);
    calls++;
    return { content: JSON.stringify(calls === 1 ? {} : { candidates: [outline({ seedId: req.seeds[0].id, difficulty: 'foundation', knowledgeText: '具体知识说明，包含入门所需的成立条件与例子。'.repeat(4) })] }),
      finishReason: 'stop', provider: { model: 'fixture' } };
  } }, () => ({}), req);
  assert.equal(calls, 2);
});

test('本地语义相同的不同措辞及不同目标键只展示一条', async () => {
  const a = outline(), b = outline({ conceptKey: 'natural-expiration', topic: '主动删除缓存与自然到期有什么不同', learningObjective: '能比较自然到期与显式删除两种失效方式' });
  const similarities = await ranking.prepare(request(), [a, b], embedding(new Map([
    [ranking.targetText(a), [1, 0]], [ranking.targetText(b), [0.98, 0.02]]
  ])));
  assert.equal(similarities.strategy, 'local-semantic');
  assert.equal(pool([a, b], { similarities }).candidates.length, 1);
  assert.equal(pool([b], { similarities, exclusions: { seenTargets: [a] } }).candidates.length, 0);
  assert.equal(pool([b], { similarities, exclusions: { existing: [{ ...a, title: a.topic }] } }).candidates.length, 0);
});

test('相同话题中的不同目标和不同领域的相同句式不误删', async () => {
  const a = outline(), b = outline({ conceptKey: 'lru', topic: '缓存容量已满时如何选择淘汰项', learningObjective: '能演示最近最少使用淘汰算法' });
  const similarities = await ranking.prepare(request(), [a, b], embedding(new Map([
    [ranking.targetText(a), [1, 0]], [ranking.targetText(b), [0.7, Math.sqrt(0.51)]]
  ])));
  assert.equal(pool([a, b], { similarities }).candidates.length, 2);
  assert.equal(ranking.lexicalComparison().sameTarget(
    { topic: '摄影中的条件与反例', learningObjective: '能解释摄影中结论成立的条件与一个反例' },
    { topic: '数学中的条件与反例', learningObjective: '能解释数学中结论成立的条件与一个反例' }), false);
});

test('同分同目标仅保留一条，已排除的高分项不会压掉可用项', () => {
  const first = outline();
  assert.equal(pool([first, { ...first, topic: '改写后的缓存失效主题' }]).candidates.length, 1);
  const excludedSeed = { ...seed, id: 'excluded', baseScore: 200, baseLearningUnitId: 'excluded_unit' };
  const preferences = [{ id: 'exclude', category: 'unit_exclusion', scope: { type: 'unit', unitId: 'excluded_unit' } }];
  const result = pool([first, { ...first, seedId: 'excluded' }], { seeds: [seed, excludedSeed], preferences });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].seedId, seed.id);
});

test('不同种子属于同一主题时让其他主题提前，同时保留可学习的相关目标', () => {
  const seeds = [seed, { ...seed, id: 'other-cache', baseScore: 118 }, { ...seed, id: 'photo', baseTopicId: 'topic_photo', baseScore: 110 }];
  const result = pool([outline(), outline({ seedId: 'other-cache', conceptKey: 'lru', topic: '缓存容量不足时的淘汰机制', learningObjective: '能判断最近最少使用的缓存项' }),
    outline({ seedId: 'photo', conceptKey: 'aperture', topic: '光圈如何控制景深', learningObjective: '能比较不同光圈下的清晰范围' })], { seeds });
  assert.deepEqual(result.candidates.map(item => item.seedId), [seed.id, 'photo', 'other-cache']);
  assert.ok(result.candidates[2].diversityPenalty > 0);
});

test('语义推断中途失败或向量无效时整批回退，排序仍可用', async () => {
  let calls = 0;
  const outlines = Array.from({ length: 6 }, (_, index) => outline({ topic: '主题' + index, learningObjective: '目标' + index, newKnowledge: '新增内容' + index }));
  const failed = await ranking.prepare(request(), outlines, { dimensions: 2, embed: async texts => {
    if (++calls === 2) throw new Error('unavailable');
    return texts.map(() => [1, 0]);
  } });
  assert.equal(failed.strategy, 'lexical-fallback');
  assert.equal(failed.similarity('主题0。目标0', '主题5。目标5'), ranking.lexicalComparison().similarity('主题0。目标0', '主题5。目标5'));
  for (const vector of [[NaN, 0], [0, 0], [1]]) {
    const invalid = await ranking.prepare(request(), [outline()], { dimensions: 2, embed: async texts => texts.map(() => vector) });
    assert.equal(invalid.strategy, 'lexical-fallback');
    assert.equal(pool([outline()], { similarities: invalid }).candidates.length, 1);
  }
});

test('相似模板属于不同明确兴趣时不能因向量相近而合并', async () => {
  const a = outline({ seedAnchor: '摄影', baseTopicId: 'photo', topic: '摄影中的条件与反例' });
  const b = outline({ conceptKey: 'math-conditions', seedAnchor: '数学', baseTopicId: 'math', topic: '数学中的条件与反例' });
  const similarities = await ranking.prepare(request(), [a, b], embedding(new Map([
    [ranking.targetText(a), [1, 0]], [ranking.targetText(b), [0.98, 0.02]], ['摄影', [1, 0]], ['数学', [0, 1]]
  ])));
  assert.equal(similarities.sameTarget(a, b), false);
});

test('完整制卡接收目标难度，候选不会被预先改成入门标签', async () => {
  const candidate = pool([outline({ difficulty: 'challenge' })], { preferences: [preference('foundational')] }).candidates[0];
  const current = { id: 'pool', candidates: [candidate], metrics: {}, openedDraftIds: [] };
  const db = { discoveryPools: [current], drafts: [] };
  let input;
  const service = discovery.createDiscoveryService({ readDb: () => db, mutate: fn => fn(db), now: () => 1, requestId: () => 'request',
    recordLearningEventInDb: () => {}, checkGachaCardSources: async () => ({ check: { id: 'check' } }),
    createGachaCardDraft: async value => { input = value; return { session: { id: 'draft' } }; } });
  await service.openGachaDiscoveryCandidate('pool', candidate.id);
  assert.equal(candidate.difficulty, 'challenge');
  assert.match(input.userGoal, /目标难度：入门/);
  assert.match(input.userGoal, /前置知识、解释步骤和例子/);
});

test('本地语义计算期间偏好改变时丢弃过时批次，不保存曝光', async () => {
  const db = { memoryVersion: 1, learningState: { cards: [] }, discoveryPools: [] };
  let exposed = 0;
  const service = discovery.createDiscoveryService({ readDb: () => db, mutate: fn => fn(db), now: () => 1, requestId: () => 'request',
    learningContextForDb: () => context([]), recordLearningEventInDb: () => { exposed++; },
    embedding: { dimensions: 2, embed: async texts => { db.memoryVersion = 2; return texts.map(() => [1, 0]); } },
    planDiscoveryCandidates: async req => ({ outlines: [outline({ seedId: req.seeds[0].id })] }) });
  await assert.rejects(service.createGachaDiscoveryPool(), /学习偏好已变化/);
  assert.equal(db.discoveryPools.length, 0);
  assert.equal(exposed, 0);
});

test('换批保留目标文本，新排序版本不复用旧缓存', async () => {
  let calls = 0;
  const db = { memoryVersion: 1, learningState: { cards: [] }, discoveryPools: [] };
  const service = discovery.createDiscoveryService({ readDb: () => db, mutate: fn => fn(db), now: () => 100, requestId: () => 'request',
    learningContextForDb: () => context([]), recordLearningEventInDb: () => {},
    planDiscoveryCandidates: async req => {
      calls++;
      if (calls === 3) assert.equal(req.exclusions.seenTargets.length, 1);
      return { outlines: [outline({ seedId: req.seeds[0].id })], generation: {} };
    } });
  const first = (await service.createGachaDiscoveryPool()).pool;
  assert.equal(first.rankingVersion, discovery.RANKING_VERSION);
  assert.equal((await service.createGachaDiscoveryPool()).reused, true);
  first.rankingVersion = 'old';
  const current = (await service.createGachaDiscoveryPool()).pool;
  const next = (await service.createGachaDiscoveryPool(current.id)).pool;
  assert.equal(calls, 3);
  assert.equal(next.candidates.length, 0);
});
