const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const index = require('../src/shared/material-index.js');
const lexical = require('../src/shared/rag/lexical-retriever.js');
const rag = require('../src/harness/rag/rag-service.js');
const memory = require('../src/harness/memory/learning-context.js');
const tools = require('../src/harness/tools/tool-calling.js');
const skills = require('../src/harness/skills/skill-registry.js');
const catalog = require('../src/harness/skills/skill-catalog.generated.js');
const { createExtensionService } = require('../src/backend/application/extension-service.js');
const { memoryStorage } = require('../src/shared/runtime-utils.js');
const domain = require('../src/frontend/domain/card-domain.js');
const { requestPayload, qualityOutput, verificationOutput } = require('./fixtures/quality-output.js');
const { planOutput } = require('./fixtures/knowledge-plan-output.js');
const { candidateOutlines } = require('./fixtures/discovery-output.js');
const NOW = Date.UTC(2026, 8, 8);
const DAY = 86400000;

function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('正文检索排除纯标题，兼容全半角，同时保持原文位置可回查', () => {
  const material = { id: 'sample', version: 4, text: '# ABC123\n原文令牌是 ＡＢＣ１２３，必须原样保存。' };
  const hits = index.retrieve(material, index.splitMaterial(material), 'abc123', { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'paragraph');
  assert.match(hits[0].text, /ＡＢＣ１２３/);
  assert.equal(material.text.slice(hits[0].startCharacter, hits[0].endCharacter), hits[0].text);
  assert.equal(hits[0].version, 4);
  assert.deepEqual(index.retrieve({ id: 'empty', text: '# ABC123' }, index.splitMaterial({ id: 'empty', text: '# ABC123' }), 'abc123'), []);
  const explanation = lexical.explainScore('快取有效期', '缓存的过期时间');
  assert.ok(explanation.score > 0.18);
  assert.ok(explanation.matchedTerms.some(term => term.startsWith('synonym_')));
});

test('带答案位置的检索集与标题消融展示真实差异，未收录改写不伪装为成功', async () => {
  const { evaluate } = await import('../evals/rag/run.mjs');
  const current = evaluate(), ablation = evaluate({ headings: true });
  assert.equal(current.metrics.passed, current.metrics.scoredCases);
  assert.ok(current.metrics.hitRateAt1 > ablation.metrics.hitRateAt1);
  assert.ok(current.cases.find(item => item.probe && !item.passed));
});

test('检索策略可替换，文档范围筛选在策略之前，追踪只含来源与分数', async () => {
  const { fixtureDb } = await import('../evals/rag/run.mjs');
  const db = freeze(fixtureDb()), searched = [];
  const service = rag.createRagService({ readDb: () => db, retrievalStrategy: 'test-adapter', retrieve: (material, chunks, query, options) => {
    searched.push(material.id); return index.retrieve(material, chunks, query, options);
  } });
  const result = service.inspectRetrieval('幂等', { onlyLinked: true });
  assert.deepEqual(searched, ['retry']);
  assert.equal(result.trace.strategy, 'test-adapter');
  assert.equal(result.trace.searchedDocumentCount, 1);
  assert.ok(result.evidence[0].text.includes('不增加额外副作用'));
  assert.equal(Object.hasOwn(result.trace, 'query'), false);
  assert.equal(Object.hasOwn(result.trace.selected[0], 'text'), false);
});

test('记忆投影是纯读取，默认推荐与显式主题范围不同，过期事实不进入提示', () => {
  const db = freeze({ memoryVersion: 8, preferences: [
    { id: 'global', category: 'learning_format', value: '先举例', scope: { type: 'global' } },
    { id: 'topic-a', category: 'topic_interest', value: '摄影', scope: { type: 'topic', topicId: 'a' } },
    { id: 'topic-b', category: 'topic_interest', value: '数据库', scope: { type: 'topic', topicId: 'b' } },
    { id: 'disabled', category: 'topic_interest', value: '数学', enabled: false, scope: { type: 'global' } }
  ], recentLearningEvents: [
    { id: 'old', topicId: 'a', occurredAt: NOW - 30 * DAY - 1 },
    { id: 'edge', topicId: 'a', occurredAt: NOW - 30 * DAY },
    { id: 'other', topicId: 'b', occurredAt: NOW }
  ], learningUnits: [], reviewEvents: [], learningState: { cards: [], pending: [] } });
  const original = JSON.stringify(db);
  const all = memory.learningContextForDb(db, NOW);
  assert.deepEqual(all.appliedPreferenceIds, ['global', 'topic-a', 'topic-b']);
  assert.equal(all.taskScope.mode, 'recommendation');
  const scoped = memory.learningContextForDb(db, NOW, { topicId: 'a' });
  assert.deepEqual(scoped.appliedPreferenceIds, ['global', 'topic-a']);
  assert.deepEqual(scoped.recentFacts.map(event => event.eventId), ['edge']);
  scoped.explicitPreferences[1].scope.topicId = 'changed';
  assert.equal(JSON.stringify(db), original);
});

test('助手读工具与制卡复用同一检索和记忆，零命中不返回任意资料', async () => {
  const { fixtureDb } = await import('../evals/rag/run.mjs');
  const db = fixtureDb();
  db.preferences = [{ id: 'p', enabled: true, category: 'topic_interest', value: '缓存', scope: { type: 'global' } }];
  db.recentLearningEvents = [];
  const original = JSON.stringify(db);
  const hits = tools.executeReadTool(db, 'search_knowledge', { query: '快取有效期' }, NOW);
  assert.equal(hits[0].id, 'cache');
  assert.ok(hits[0].text.includes('过期时间'));
  assert.equal(hits[0].source.version, 1);
  assert.deepEqual(tools.executeReadTool(db, 'search_knowledge', { query: 'quantum entanglement' }, NOW), []);
  assert.deepEqual(tools.executeReadTool(db, 'get_learning_context', {}, NOW).context.appliedPreferenceIds, ['p']);
  assert.equal(JSON.stringify(db), original);
});

test('Skill 入口可校验且浏览器包与源文件一致，目录不注入未激活正文', async () => {
  const { buildCatalog, renderCatalog, parseSkill } = await import('../tooling/build-skills.mjs');
  assert.deepEqual(buildCatalog(), catalog);
  assert.equal(renderCatalog(catalog), fs.readFileSync(path.resolve(__dirname, '../src/harness/skills/skill-catalog.generated.js'), 'utf8'));
  assert.equal(skills.listSkills().length, 10);
  assert.ok(skills.listSkills().some(entry => entry.name === 'learning-dialogue' && entry.mode === 'workflow'));
  assert.ok(skills.listSkills().every(entry => !Object.hasOwn(entry, 'instructions')));
  assert.throws(() => parseSkill('# Missing frontmatter', 'bad'), /frontmatter/);
  assert.throws(() => parseSkill('---\nname: wrong\ndescription: sample\nmetadata: {}\n---\ntext', 'different'), /name/);
  assert.throws(() => skills.activate('../secret'), /不可用/);
  assert.throws(() => skills.loadTask('citation-check'), /不可用/);
  for (const entry of catalog.filter(entry => Object.hasOwn(entry.metadata, 'harness-tools'))) {
    assert.deepEqual((entry.metadata['harness-tools'] || '').split(' ').filter(Boolean), skills.SKILLS[entry.name]);
  }
  const messages = skills.harnessMessages('用大白话解释', 'plain-explanation');
  assert.ok(messages[0].content.includes(skills.activate('plain-explanation').instructions));
  assert.ok(!messages[0].content.includes(skills.activate('knowledge-plan').instructions));
});

test('主制卡、长材料规划和发现真实组装请求时均激活对应 Skill，核验仍隔离记忆', async () => {
  const requests = [];
  const service = createExtensionService({ storage: memoryStorage(), indexedDB: false, cardDomain: domain, providerModule: {}, now: () => NOW,
    getModelConfig: () => ({ apiKey: 'fixture-only', model: 'fixture' }), providerTransport: { complete: async (_, request) => {
      const payload = requestPayload(request); requests.push({ request, payload });
      const output = payload.seeds ? candidateOutlines(payload) : verificationOutput(payload) || (payload.operation === 'plan' ? planOutput(payload) : qualityOutput(payload));
      return { content: JSON.stringify(output), toolCalls: [], provider: { model: 'fixture', latencyMs: 1, usage: { totalTokens: 1 } } };
    } } });
  await service.createPreferenceMemory({ category: 'learning_format', value: '先举例' });
  const text = '边际成本是每多生产一个单位额外增加的成本。';
  const generated = await service.createGachaCardDraft({ text });
  assert.equal(generated.session.status, 'ready');
  assert.equal(generated.session.generation.promptVersion, 'concept-card-v2.6.5+skill.1.0.0');
  const cardRequests = requests.splice(0);
  assert.ok(cardRequests.every(item => item.request.messages[0].content.includes(skills.activate('concept-card').instructions)));
  assert.ok(cardRequests.some(item => item.payload.learningContext?.appliedPreferenceIds.length));
  assert.ok(cardRequests.filter(item => ['review', 'solve'].includes(item.payload.operation)).every(item => !item.payload.learningContext));
  const plan = await service.createKnowledgePlan({ text: '# 成本\n' + text });
  await service.analyzeKnowledgePlan(plan.plan.id);
  assert.ok(requests.some(item => item.request.messages[0].content.includes(skills.activate('knowledge-plan').instructions)));
  requests.length = 0;
  await service.createGachaDiscoveryPool();
  assert.ok(requests.length > 0);
  assert.ok(requests.every(item => item.request.messages[0].content.includes(skills.activate('gacha-discovery').instructions)));
  assert.ok(requests.every(item => item.request.tools === undefined));
});

test('浏览器使用相同模块装配顺序，无 Node 全局也能读取 Skills 和检索', () => {
  const context = vm.createContext({ Intl, TextEncoder, TextDecoder, URL, Blob, console });
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="\.\/(src\/[^\"]+)"/g)].map(match => match[1]);
  const end = scripts.indexOf('src/backend/application/extension-service.js');
  for (const script of scripts.slice(0, end + 1)) vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', script), 'utf8'), context, { filename: script });
  assert.equal(context.KnowledgeGachaHarnessSkills.loadTask('knowledge-plan').version, 'knowledge-plan-v1.0.1+skill.1.0.0');
  assert.ok(context.KnowledgeGachaMaterialIndex.score('快取', '缓存') > 0);
});
