const test = require('node:test');
const assert = require('node:assert/strict');
const contexts = require('../src/harness/core/companion-context.js');
const { createExtensionService } = require('../src/backend/application/extension-service.js');
const { memoryStorage } = require('../src/shared/runtime-utils.js');
const domain = require('../src/frontend/domain/card-domain.js');
const providerModule = require('../src/backend/provider/provider-transport.js');

const answer = (text = '继续讲解', ids = []) => ({ content: JSON.stringify({ answer: text, citationIds: ids }), toolCalls: [], provider: { model: 'fixture' } });
const call = (name, args) => ({ content: '', toolCalls: [{ id: 'call_one', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const summary = (extra = {}) => ({ content: JSON.stringify({ goal: '准备 Agent 面试', constraints: ['先举例再解释'], corrections: [], conclusions: ['理解上下文预算'], openQuestions: ['如何处理压缩失败'], referenceKeys: [], ...extra }), toolCalls: [], provider: { usage: { inputTokens: 900, outputTokens: 90, totalTokens: 990, cachedInputTokens: 120 } } });
const isSummary = request => request.messages[1]?.content.includes('"operation":"compact_companion_context"');
const summaryData = request => JSON.parse(request.messages[1].content);
const projectedSummary = request => request.messages.find(m => m.content?.includes('"sessionSummary"'));
function oldMessages(count, length = 0) {
  return Array.from({ length: count }, (_, n) => [
    { id: 'u' + n, turnId: 't' + n, role: 'user', content: n === 0 ? '准备 Agent 面试，先举例再解释' : '问题' + n + 'x'.repeat(length) },
    { id: 'a' + n, turnId: 't' + n, role: 'assistant', status: 'completed', content: '讲解' + n + 'y'.repeat(length), citations: [], actions: [] }
  ]).flat();
}
function fixture(handler, extra = {}) {
  const requests = [], storage = extra.storage || memoryStorage(), profileId = extra.profileId || 'context-test';
  const service = createExtensionService({ storage, profileId, indexedDB: extra.indexedDB || false, embedding: false, cardDomain: domain, providerModule,
    companionContextOptions: extra.limits,
    modelConfig: { baseUrl: 'https://example.test/v1', apiKey: 'fixture-key', model: 'gpt-4o' },
    providerTransport: { complete: async (_config, request) => { requests.push(structuredClone(request)); return handler(request, requests.length); } } });
  const key = 'kg_extension_harness_v1:' + profileId;
  return { service, requests, storage, key, db: () => JSON.parse(storage.getItem(key)),
    mutate: fn => { const db = JSON.parse(storage.getItem(key)); fn(db); storage.setItem(key, JSON.stringify(db)); } };
}
async function seeded(fx, count = 13, input = {}) {
  const id = (await fx.service.createCompanionSession(input)).session.id;
  fx.mutate(db => { db.companionSessions.find(s => s.id === id).messages = oldMessages(count); });
  return id;
}
const send = (fx, id, content = '继续讲解', requestId = 'new_1') => fx.service.sendCompanionMessage(id, { content, requestId });

test('统一预算计入中文、工具 schema、输出及工具续跑预留，整对裁剪但不修改原协议', () => {
  assert.ok(contexts.estimateTokens('中文🙂') > contexts.estimateTokens('abcd'));
  assert.throws(() => contexts.budget({ windowTokens: 5000 }), /预留空间/);
  const base = [{ role: 'system', content: '规则' }, { role: 'user', content: '当前问题' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果'.repeat(300) }];
  const groups = contexts.pairs(oldMessages(5, 500));
  const tools = [{ type: 'function', function: { name: 'read', description: 'schema'.repeat(50) } }];
  const limits = contexts.budget({ windowTokens: 8000 });
  const result = contexts.fit(base, null, groups, tools, limits);
  assert.ok(result.groups.length < groups.length);
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 1);
  assert.deepEqual(result.messages.slice(-3), base.slice(1));
  assert.equal(base.length, 4); assert.equal(groups.length, 5);
  assert.ok(result.estimatedInputTokens + limits.outputTokens + limits.toolReserveTokens + limits.safetyTokens <= limits.windowTokens);
  const exact = { ...limits, inputTokens: contexts.inputSize(base, tools) };
  assert.equal(contexts.fit(base, null, [], tools, exact).estimatedInputTokens, exact.inputTokens);
  assert.throws(() => contexts.fit(base, null, [], tools, { ...exact, inputTokens: exact.inputTokens - 1 }), /上下文预算/);
});

test('未完成或 turnId 不匹配的消息不参与压缩，覆盖游标必须指向本会话完成回答', () => {
  const messages = oldMessages(2).concat([{ id: 'pending', role: 'user', turnId: 'pending', content: '待执行' },
    { id: 'bad', role: 'assistant', turnId: 'other', status: 'completed', content: '不匹配' }]);
  const groups = contexts.pairs(messages);
  assert.equal(groups.length, 2);
  assert.equal(contexts.validSummary({ version: 1, coveredTurns: 1, coveredThroughMessageId: 'a0', data: JSON.parse(summary().content), references: [] }, groups), true);
  assert.equal(contexts.validSummary({ version: 1, coveredTurns: 1, coveredThroughMessageId: 'a0', data: {}, references: [] }, groups), false);
  assert.equal(contexts.validSummary({ version: 1, coveredTurns: 1, coveredThroughMessageId: 'foreign', data: {}, references: [] }, groups), false);
});

test('短对话不发摘要请求；按预算而不是仅按条数触发，摘要请求本身也受预算约束', () => {
  const limits = contexts.budget({ windowTokens: 12000 });
  const base = [{ role: 'system', content: '规则' }, { role: 'user', content: '新的问题' }];
  assert.equal(contexts.plan(contexts.pairs(oldMessages(3)), null, base, null, [], limits), null);
  const groups = contexts.pairs(oldMessages(10, 3000));
  const plan = contexts.plan(groups, null, base, null, [], limits);
  assert.ok(plan.groups.length > 0 && plan.groups.length < 6);
  assert.ok(contexts.estimateTokens(plan.request) + limits.summaryOutputTokens + limits.safetyTokens <= limits.windowTokens);
  assert.deepEqual(plan.groups, groups.slice(0, plan.groups.length));
});

test('摘要 schema、长度和引用白名单严格校验；来源元数据由宿主复制', () => {
  const groups = contexts.pairs(oldMessages(13));
  groups[0].assistant.citations = [{ id: 'S1', kind: 'document', documentId: 'doc', quote: '原文', version: 1 }];
  const plan = contexts.plan(groups, null, [{ role: 'system', content: '' }, { role: 'user', content: '' }], null, [], contexts.budget());
  const result = contexts.parseSummary(summary({ referenceKeys: ['a0:S1'] }), plan, null, 1);
  assert.equal(result.references[0].documentId, 'doc'); assert.equal(result.coveredTurns, 9);
  assert.throws(() => contexts.parseSummary(summary({ referenceKeys: ['forged:S9'] }), plan, null, 1), /未知来源/);
  assert.throws(() => contexts.parseSummary(summary({ constraints: ['x'.repeat(321)] }), plan, null, 1), /条目/);
  assert.throws(() => contexts.parseSummary(summary({ tools: ['execute'] }), plan, null, 1), /字段/);
  assert.throws(() => contexts.parseSummary({ content: '{bad' }, plan, null, 1), /格式/);
});

test('首次长对话压缩保留早期要求、近期完整问答与最新纠正，不写长期记忆', async () => {
  const fx = fixture(request => {
    if (isSummary(request)) {
      const payload = summaryData(request);
      assert.ok(payload.turns[0].user.content.includes('先举例再解释'));
      assert.equal(payload.turns.length, 9);
      assert.equal(payload.turns.at(-1).assistant.id, 'a8');
      assert.ok(!JSON.stringify(payload.turns).includes('现在改成先定义'));
      return summary();
    }
    assert.ok(projectedSummary(request).content.includes('先举例再解释'));
    assert.equal(request.messages.at(-1).content, '现在改成先定义再举例');
    assert.equal(request.messages.filter(m => m.role === 'assistant').length, 4);
    assert.ok(request.messages[0].content.includes('较新的明确纠正优先'));
    return answer('按新的要求先给定义');
  });
  const id = await seeded(fx);
  const before = structuredClone(fx.db());
  const result = (await send(fx, id, '现在改成先定义再举例')).session;
  assert.equal(result.turn.status, 'completed'); assert.equal(result.turn.requestCount, 2);
  assert.equal(result.turn.contextStats.summaryTurns, 9); assert.equal(result.turn.contextStats.omittedTurns, 0);
  assert.equal(result.messages.length, 28);
  assert.deepEqual(result.messages.slice(0, 26), before.companionSessions[0].messages);
  assert.equal(result.contextSummary.coveredThroughMessageId, 'a8');
  assert.deepEqual(result.turn.compaction.usage, { inputTokens: 900, outputTokens: 90, totalTokens: 990, cachedInputTokens: 120 });
  assert.equal(fx.db().runs.at(-1).contextStats.summaryTurns, 9);
  for (const key of ['preferences', 'reviewEvents', 'memoryMutations']) assert.deepEqual(fx.db()[key], before[key]);
  const other = fixture(() => answer(), { storage: fx.storage, profileId: 'other' });
  assert.equal((await other.service.listCompanionSessions()).sessions.length, 0);
});

test('增量摘要跨重开合并旧摘要和新完成前缀，最新纠正覆盖旧要求，不重复覆盖', async () => {
  const fx = fixture(request => isSummary(request) ? summary() : answer());
  const id = await seeded(fx);
  await send(fx, id, '纠正：先定义再举例');
  const restarted = fixture(request => {
    if (!isSummary(request)) return answer();
    const payload = summaryData(request);
    assert.deepEqual(payload.previousSummary.constraints, ['先举例再解释']);
    assert.equal(payload.turns[0].user.id, 'u9');
    assert.ok(payload.turns.some(t => t.user.content === '纠正：先定义再举例'));
    assert.ok(!payload.turns.some(t => t.user.id === 'u0'));
    return summary({ constraints: ['先定义再举例'], corrections: ['讲解顺序已改为先定义'] });
  }, { storage: fx.storage });
  for (let i = 0; i < 9; i++) await send(restarted, id, '继续' + i, 'next' + i);
  const result = (await restarted.service.getCompanionSession(id)).session;
  assert.equal(restarted.requests.filter(isSummary).length, 1);
  assert.equal(result.contextSummary.coveredTurns, 18);
  assert.deepEqual(result.contextSummary.data.constraints, ['先定义再举例']);
  assert.ok(projectedSummary(restarted.requests.at(-1)).content.includes('先定义再举例'));
});

test('压缩失败保留上次摘要和完整历史；恢复主请求不再发摘要、不重复问题', async () => {
  const fx = fixture(request => isSummary(request) ? summary() : answer());
  const id = await seeded(fx);
  await send(fx, id);
  const old = structuredClone(fx.db().companionSessions[0].contextSummary);
  fx.mutate(db => { db.companionSessions[0].messages.push(...oldMessages(9).map(m => ({ ...m, id: 'extra' + m.id, turnId: 'extra' + m.turnId }))); });
  let main = 0;
  const reopened = fixture(request => {
    if (isSummary(request)) return { content: 'invalid summary' };
    if (++main === 1) throw new Error('temporary network failure');
    return answer();
  }, { storage: fx.storage });
  const failed = (await send(reopened, id, '网络恢复后继续', 'newfail')).session;
  assert.equal(failed.turn.status, 'failed'); assert.equal(failed.turn.compaction.status, 'failed');
  assert.deepEqual(failed.contextSummary, old);
  const result = (await reopened.service.resumeCompanionTurn(id)).session;
  assert.equal(result.turn.status, 'completed');
  assert.equal(reopened.requests.filter(isSummary).length, 1);
  assert.equal(result.messages.filter(m => m.requestId === 'newfail').length, 1);
  assert.ok(result.turn.omittedTurns > 0);
  assert.deepEqual(result.contextSummary, old);
});

test('摘要超时降级，迟到内容不覆盖摘要或追加回答', async () => {
  let release;
  const fx = fixture(request => isSummary(request) ? new Promise(resolve => { release = resolve; }) : answer(), { limits: { summaryTimeoutMs: 15 } });
  const id = await seeded(fx);
  const result = (await send(fx, id)).session;
  assert.equal(result.turn.status, 'completed'); assert.equal(result.turn.compaction.status, 'failed');
  assert.equal(result.contextSummary, undefined);
  release(summary());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fx.service.getCompanionSession(id)).session.contextSummary, undefined);
});

test('压缩中停止与重开恢复保留旧状态，已发摘要不重复，迟到结果不能提交', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const fx = fixture(request => isSummary(request) ? new Promise(resolve => { release = resolve; started(); }) : answer());
  const id = await seeded(fx);
  const running = send(fx, id);
  await ready;
  assert.equal((await fx.service.getCompanionSession(id)).session.turn.compaction.status, 'running');
  await fx.service.cancelCompanionTurn(id);
  const cancelled = (await running).session;
  assert.equal(cancelled.turn.status, 'cancelled'); assert.equal(cancelled.contextSummary, undefined);
  const reopened = fixture(() => answer(), { storage: fx.storage });
  const completed = (await reopened.service.resumeCompanionTurn(id)).session;
  assert.equal(completed.turn.status, 'completed'); assert.equal(completed.turn.compaction.status, 'interrupted');
  assert.equal(reopened.requests.length, 1); assert.equal(completed.messages.length, 28);
  release(summary()); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await reopened.service.getCompanionSession(id)).session.contextSummary, undefined);
});

test('压缩中删除会话，迟到摘要不会重建会话', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const fx = fixture(() => new Promise(resolve => { release = resolve; started(); }));
  const id = await seeded(fx);
  const running = send(fx, id);
  const rejected = assert.rejects(running, /不存在/);
  await ready; await fx.service.deleteCompanionSession(id);
  release(summary()); await rejected;
  assert.equal((await fx.service.listCompanionSessions()).sessions.length, 0);
});

test('摘要引用沿用消息来源身份并重新登记本轮编号，来源变化后不再注入', async () => {
  let readReferences = [];
  const fx = fixture(request => {
    if (isSummary(request)) return summary({ referenceKeys: ['a0:S9'] });
    const message = projectedSummary(request);
    const payload = JSON.parse(message.content.slice(message.content.indexOf('{')));
    readReferences = payload.references;
    const ref = readReferences[0]?.reference;
    return ref ? answer('根据已核验原文 [' + ref.id + ']', [ref.id]) : answer('来源已经变化，请重新查找');
  });
  const id = await seeded(fx);
  fx.mutate(db => {
    db.documents.push({ id: 'doc1', title: '面试笔记', content: '原文可靠内容', type: 'text' });
    db.sources.push({ id: 'source1', documentId: 'doc1', version: 1 });
    db.companionSessions[0].messages[1].citations = [{ id: 'S9', kind: 'document', documentId: 'doc1', title: '面试笔记', quote: '原文可靠内容', version: 1, start: 0 }];
  });
  const result = (await send(fx, id)).session;
  assert.equal(result.turn.status, 'completed');
  assert.equal(readReferences[0].reference.id, 'S1');
  assert.equal(result.messages.at(-1).citations[0].documentId, 'doc1');
  fx.mutate(db => { db.documents[0].content = '已经更新内容'; db.sources.find(s => s.documentId === 'doc1').version = 2; });
  await send(fx, id, '继续', 'new_2');
  assert.equal(readReferences.length, 0);
  assert.ok(!fx.requests.at(-1).messages[0].content.includes('原文可靠内容'));
});

test('压缩后失败恢复保留工具配对结果和动作回执且不重复执行', async () => {
  let main = 0;
  const fx = fixture(request => {
    if (isSummary(request)) return summary();
    if (++main === 1) return call('propose_preference', { value: '先举例' });
    if (main === 2) throw new Error('网络断开');
    const observation = request.messages.find(m => m.role === 'tool');
    assert.equal(observation.tool_call_id, 'call_one');
    assert.equal(JSON.parse(observation.content).action.value, '先举例');
    assert.equal(request.messages.filter(m => m.tool_calls?.length).length, 1);
    return answer();
  });
  const id = await seeded(fx);
  const failed = (await send(fx, id)).session;
  assert.equal(failed.turn.status, 'failed');
  assert.equal(fx.db().companionSessions[0].turn.modelMessages.filter(message => message.role !== 'system').length, 3);
  assert.equal(fx.db().companionSessions[0].turn.modelMessages.filter(message => message.role === 'tool').length, 1);
  const completed = (await fx.service.resumeCompanionTurn(id)).session;
  assert.equal(completed.turn.status, 'completed', completed.turn.error); assert.equal(completed.turn.toolCount, 1);
  assert.equal(fx.requests.filter(isSummary).length, 1);
  const action = completed.messages.at(-1).actions.find(a => a.kind === 'preference');
  assert.equal(fx.db().preferences.length, 0);
  await fx.service.executeCompanionAction(id, action.id);
  await fx.service.executeCompanionAction(id, action.id);
  assert.equal(fx.db().preferences.length, 1);
  for (const request of fx.requests.filter(r => !isSummary(r))) {
    assert.ok(contexts.inputSize(request.messages, request.tools, request.tool_choice) <= contexts.budget().inputTokens);
  }
});

test('当前材料超过可用预算时在调用前失败，保留用户问题和全部材料', async () => {
  const fx = fixture(() => { throw new Error('不应请求模型'); }, { limits: { windowTokens: 8000 } });
  const id = (await fx.service.createCompanionSession({ context: { kind: 'text', text: '学习材料'.repeat(1000) } })).session.id;
  const result = (await send(fx, id)).session;
  assert.equal(result.turn.status, 'failed'); assert.match(result.turn.error, /上下文预算/);
  assert.equal(fx.requests.length, 0); assert.equal(result.messages.length, 1);
  assert.equal(result.context.text.length, 4000);
});

test('连续多个工具结果增长时重算预算，保留原调用列表并按整轮移除较早问答', async () => {
  const fx = fixture((request, n) => n === 1 ? {
    content: '', toolCalls: [
      { id: 'source_search', type: 'function', function: { name: 'search_knowledge', arguments: JSON.stringify({ query: '上下文预算' }) } },
      { id: 'preference', type: 'function', function: { name: 'propose_preference', arguments: JSON.stringify({ value: '先举例' }) } }
    ]
  // Allow the expanded skill catalog plus all mandatory tool results, while
  // still forcing removal of older conversational pairs after tool execution.
  } : answer(), { limits: { windowTokens: 18000, recentTurns: 12 } });
  const id = await seeded(fx, 8);
  fx.mutate(db => {
    db.companionSessions[0].messages = oldMessages(8, 850);
    db.documents = Array.from({ length: 3 }, (_, n) => ({ id: 'context-doc' + n, title: '上下文预算' + n, type: 'text', content: '上下文预算：工具返回的原文必须保留引用和定位信息。'.repeat(150) }));
  });
  const result = (await send(fx, id)).session;
  assert.equal(result.turn.status, 'completed', result.turn.error);
  assert.equal(fx.requests.length, 2);
  const first = fx.requests[0], last = fx.requests[1];
  assert.ok(last.messages.filter(m => m.role === 'assistant' && !m.tool_calls).length < first.messages.filter(m => m.role === 'assistant').length);
  assert.deepEqual(last.messages.find(m => m.tool_calls)?.tool_calls.map(c => c.id), ['source_search', 'preference']);
  assert.deepEqual(last.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['source_search', 'preference']);
  assert.ok(result.turn.contextStats.estimatedInputTokens <= result.turn.contextStats.inputBudgetTokens);
  assert.equal(result.messages.length, 18);
});

test('摘要与原始对话在同一 IndexedDB payload 保存，跨实例重开可继续使用', async () => {
  const { IDBFactory } = require('fake-indexeddb');
  const indexedDB = new IDBFactory(), storage = memoryStorage();
  // Migrate a realistic long legacy conversation through the production storage path.
  const seed = fixture(() => answer(), { storage });
  const id = await seeded(seed);
  const fx = fixture(request => isSummary(request) ? summary() : answer(), { storage, indexedDB });
  await send(fx, id);
  const reopened = fixture(request => { assert.ok(projectedSummary(request)); return answer(); }, { storage, indexedDB });
  const loaded = (await reopened.service.getCompanionSession(id)).session;
  assert.equal(loaded.contextSummary.coveredTurns, 9); assert.equal(loaded.messages.length, 28);
  const completed = (await send(reopened, id, '再次继续', 'persisted-next')).session;
  assert.equal(completed.turn.status, 'completed'); assert.equal(reopened.requests.length, 1);
});
