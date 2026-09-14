const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionService } = require('../src/backend/application/extension-service.js');
const domain = require('../src/frontend/domain/card-domain.js');
const providerModule = require('../src/backend/provider/provider-transport.js');
const { memoryStorage } = require('../src/shared/runtime-utils.js');
const { LIMITS, history } = require('../src/harness/core/companion-session.js');
const toolModule = require('../src/harness/tools/companion-tools.js');
const { qualityOutput, verificationOutput, requestPayload } = require('./fixtures/quality-output.js');

const answer = (text = '我们继续讨论。', citations = []) => ({ content: JSON.stringify({ answer: text, citationIds: citations, followUps: [] }), toolCalls: [], provider: { model: 'fixture', latencyMs: 1 } });
const tool = (name, args, id = 'call_1') => ({ content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }], provider: { model: 'fixture', latencyMs: 1 } });
function fixture(handler, extra = {}) {
  const requests = [], storage = extra.storage || memoryStorage();
  const service = createExtensionService({ storage, profileId: extra.profileId || 'test', indexedDB: extra.indexedDB || false,
    embedding: false, cardDomain: domain, providerModule, modelConfig: { baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret', model: 'gpt-4o' },
    providerTransport: { complete: async (_config, request) => { requests.push(structuredClone(request)); return handler(request, requests.length); } } });
  return { service, requests, storage };
}
async function send(service, id, content = '解释一下', requestId = 'request_1') { return service.sendCompanionMessage(id, { content, requestId }); }
async function seed(fx, cards = [], documents = []) {
  await fx.service.migrateLocalStorage({ cards, pending: [], totalDraws: 0, reviewDay: { day: '2026-09-08', answered: 0, completed: false } });
  const key = 'kg_extension_harness_v1:test';
  const db = JSON.parse(fx.storage.getItem(key)); db.documents = documents;
  fx.storage.setItem(key, JSON.stringify(db));
}

test('连续对话保留完整前轮；重开、改名和请求幂等', async () => {
  const fx = fixture(() => answer('第一条解释'));
  const id = (await fx.service.createCompanionSession({})).session.id;
  await send(fx.service, id, '什么是边际成本？');
  await send(fx.service, id, '换个例子', 'request_2');
  assert.ok(fx.requests[1].messages.some(m => m.role === 'assistant' && m.content === '第一条解释'));
  await send(fx.service, id, '不会重复插入', 'request_2');
  assert.equal(fx.requests.length, 2);
  await fx.service.updateCompanionSession(id, { title: '经济学讨论' });
  const restarted = fixture(() => answer(), { storage: fx.storage });
  const restored = (await restarted.service.getCompanionSession(id)).session;
  assert.equal(restored.title, '经济学讨论'); assert.equal(restored.messages.length, 4);
  assert.equal(restored.turn.skill.name, 'companion-explain');
  assert.equal(restored.turn.skill.version, '1.0.1');
  assert.equal(restored.turn.modelMessages, undefined);
});

test('RAG 可以先检索再读相邻来源，保存可定位引用', async () => {
  const fx = fixture((request, n) => n === 1 ? tool('search_knowledge', { query: '边际成本' }) : n === 2 ? tool('read_source', { referenceId: 'S1' }, 'call_2') : answer('材料讨论了边际成本。[S1]', ['S1']));
  await seed(fx, [], [{ id: 'doc_cost', title: '边际成本', type: 'text', content: '边际成本是多生产一个单位新增的成本。新增一杯咖啡原料需要六元。', createdAt: Date.now() }]);
  const id = (await fx.service.createCompanionSession({})).session.id;
  const final = (await send(fx.service, id, '找找我保存的边际成本资料')).session;
  assert.equal(final.turn.status, 'completed'); assert.equal(final.turn.toolCount, 2);
  assert.equal(fx.requests.length, 3);
  assert.equal(final.messages[1].citations[0].documentId, 'doc_cost');
  assert.ok(final.messages[1].citations[0].quote.includes('边际成本'));
  assert.equal(fx.requests[2].messages.filter(m => m.role === 'tool').length, 2);
});

test('关闭知识库和记忆会限制工具并移除新附加的学习上下文', async () => {
  const fx = fixture(() => answer());
  await fx.service.createPreferenceMemory({ category: 'learning_format', value: '喜欢生动的例子', mutationId: 'pref_1' });
  const id = (await fx.service.createCompanionSession({ useKnowledge: false, useMemory: false })).session.id;
  await send(fx.service, id);
  const request = fx.requests[0];
  assert.ok(!request.tools.some(t => ['search_knowledge', 'read_card', 'get_learning_context', 'propose_preference'].includes(t.function.name)));
  assert.ok(!JSON.stringify(request).includes('喜欢生动的例子'));
  assert.equal((await fx.service.getCompanionSession(id)).session.turn.memory, null);
});

test('学习记忆读取明确偏好，聊天不生成掌握或答题证据', async () => {
  const fx = fixture(() => answer('按你的偏好举例'));
  await fx.service.createPreferenceMemory({ category: 'learning_format', value: '先举生活例子', mutationId: 'pref_1' });
  const id = (await fx.service.createCompanionSession({})).session.id;
  await send(fx.service, id, '我懂了');
  assert.ok(JSON.stringify(fx.requests[0]).includes('先举生活例子'));
  const db = JSON.parse(fx.storage.getItem('kg_extension_harness_v1:test'));
  assert.equal(db.reviewEvents.length, 0); assert.equal(db.preferences.length, 1);
});

test('所有工具参数在执行前严格校验，包括数组和额外字段', () => {
  const session = { useKnowledge: true, useMemory: true };
  for (const [name, args] of [['search_knowledge', { query: 42 }], ['read_card', { cardId: 'card', profileId: 'other' }], ['propose_card', { goal: '目标', referenceIds: ['S1', 'S1'] }]]) {
    assert.throws(() => toolModule.parse(name, JSON.stringify(args), session));
  }
  assert.throws(() => toolModule.parse('delete_database', '{}', session));
  assert.throws(() => toolModule.parse('__proto__', '{}', session));
  assert.throws(() => toolModule.parse('read_card', '[]', session));
});

test('未知工具只产生失败观察，模型可据此正常结束', async () => {
  const fx = fixture((request, n) => n === 1 ? tool('execute_shell', { command: 'anything' }) : answer('只能讨论内部学习内容。'));
  const id = (await fx.service.createCompanionSession({})).session.id;
  const final = (await send(fx.service, id)).session;
  assert.equal(final.turn.status, 'completed'); assert.equal(final.turn.toolCount, 0);
  assert.equal(final.messages[1].steps[0].status, 'unavailable');
});

test('伪造引用经过一次格式修正仍不合法时保留失败，不冒充已核对', async () => {
  const fx = fixture(() => answer('不存在的资料。[S99]', ['S99']));
  const id = (await fx.service.createCompanionSession({})).session.id;
  const final = (await send(fx.service, id)).session;
  assert.equal(fx.requests.length, 2); assert.equal(final.turn.status, 'failed');
  assert.equal(final.messages.length, 1); assert.match(final.turn.error, /引用/);
});

test('无答案检索返回明确缺口，不制造来源', async () => {
  const fx = fixture((request, n) => n === 1 ? tool('search_knowledge', { query: '库里不存在的内容' }) : answer('没有找到对应资料，可以补充材料。'));
  const id = (await fx.service.createCompanionSession({})).session.id;
  const final = (await send(fx.service, id)).session;
  assert.equal(JSON.parse(fx.requests[1].messages.find(m => m.role === 'tool').content).found, false);
  assert.equal(final.messages[1].citations.length, 0);
});

test('停止后迟到回答不写入，随后可开始新的问题', async () => {
  let resolveSlow, started;
  const entered = new Promise(resolve => { started = resolve; });
  const fx = fixture((request, n) => n === 1 ? new Promise(resolve => { resolveSlow = resolve; started(); }) : answer('新的回答'));
  const id = (await fx.service.createCompanionSession({})).session.id;
  const ongoing = send(fx.service, id); await entered;
  await fx.service.cancelCompanionTurn(id); await ongoing;
  assert.equal((await fx.service.getCompanionSession(id)).session.turn.status, 'cancelled');
  await send(fx.service, id, '新问题', 'new_request');
  resolveSlow(answer('迟到的旧回答')); await new Promise(resolve => setTimeout(resolve, 0));
  const final = (await fx.service.getCompanionSession(id)).session;
  assert.equal(final.messages.length, 3); assert.equal(final.messages[2].content, '新的回答');
});

test('失败恢复复用工具观察，不重复检索或用户消息', async () => {
  const fx = fixture((request, n) => { if (n === 1) return tool('read_source', { referenceId: 'S1' }); if (n === 2) throw new Error('模拟断网'); return answer('恢复后回答。[S1]', ['S1']); });
  const id = (await fx.service.createCompanionSession({ context: { kind: 'text', text: '边际成本表示新增成本。' } })).session.id;
  assert.equal((await send(fx.service, id)).session.turn.status, 'failed');
  const restored = (await fx.service.resumeCompanionTurn(id)).session;
  assert.equal(restored.turn.status, 'completed'); assert.equal(restored.turn.toolCount, 1);
  assert.equal(restored.messages.length, 2); assert.equal(fx.requests[2].messages.filter(m => m.role === 'tool').length, 1);
});

test('执行中删除会话后迟到结果不恢复已删数据', async () => {
  let done, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const fx = fixture(() => new Promise(resolve => { done = resolve; entered(); }));
  const id = (await fx.service.createCompanionSession({})).session.id;
  const running = send(fx.service, id).catch(() => null); await started;
  await fx.service.deleteCompanionSession(id); done(answer()); await running;
  assert.equal((await fx.service.listCompanionSessions()).sessions.length, 0);
});

test('档案会话隔离，讨论材料有明确长度边界', async () => {
  const fx = fixture(() => answer());
  const id = (await fx.service.createCompanionSession({})).session.id;
  const other = fixture(() => answer(), { storage: fx.storage, profileId: 'other' });
  assert.equal((await other.service.listCompanionSessions()).sessions.length, 0);
  assert.throws(() => other.service.getCompanionSession(id), /不存在/);
  assert.throws(() => fx.service.createCompanionSession({ context: { kind: 'text', text: 'a'.repeat(LIMITS.context + 1) } }), /12000/);
  await assert.rejects(send(fx.service, id, 'a'.repeat(LIMITS.input + 1)), /4000/);
});

test('历史裁剪保留完整对话对，完整原历史不被修改', () => {
  const messages = [];
  for (let i = 0; i < 30; i++) messages.push({ role: 'user', content: '问题' }, { role: 'assistant', status: 'completed', content: '回答'.repeat(1000) });
  const scoped = history(messages);
  assert.ok(scoped.messages.length % 2 === 0); assert.equal(scoped.messages[0].role, 'user');
  assert.ok(scoped.messages.reduce((sum, m) => sum + m.content.length, 0) <= LIMITS.history);
  assert.equal(messages.length, 60); assert.ok(scoped.omittedTurns > 0);
});

test('工具请求循环预算会终止，不能无限调用', async () => {
  const fx = fixture((request, n) => tool('search_knowledge', { query: '查询' + n }, 'call_' + n));
  const id = (await fx.service.createCompanionSession({})).session.id;
  const final = (await send(fx.service, id)).session;
  assert.equal(final.turn.status, 'failed'); assert.equal(final.turn.toolCount, LIMITS.tools);
  assert.ok(fx.requests.length <= LIMITS.requests); assert.equal(fx.requests.at(-1).tool_choice, 'none');
});

test('偏好建议只在用户点击后写入，一次动作重试不重复', async () => {
  const fx = fixture((request, n) => n === 1 ? tool('propose_preference', { value: '先给生活例子' }) : answer('已准备偏好建议，请检查后保存。'));
  const id = (await fx.service.createCompanionSession({})).session.id;
  const final = (await send(fx.service, id, '请记住先给生活例子')).session;
  assert.equal((await fx.service.listPreferenceMemories()).memories.length, 0);
  const action = final.messages[1].actions.find(a => a.kind === 'preference');
  await fx.service.executeCompanionAction(id, action.id); await fx.service.executeCompanionAction(id, action.id);
  assert.equal((await fx.service.listPreferenceMemories()).memories.length, 1);
});

test('对话制卡复用真实质量工作流，收下之前不写卡册，重复动作复用草稿', async () => {
  const fx = fixture(request => {
    if (request.messages[0].content.includes('你的名字是伴学')) return answer('新增一单位产生的额外成本就是边际成本。[S1]', ['S1']);
    const payload = requestPayload(request);
    const output = verificationOutput(payload) || qualityOutput(payload);
    return { content: JSON.stringify(output), toolCalls: [], provider: { model: 'fixture', latencyMs: 1 } };
  });
  const id = (await fx.service.createCompanionSession({ context: { kind: 'text', text: '多生产一单位的新增成本称为边际成本。', title: '边际成本笔记' } })).session.id;
  const replied = (await send(fx.service, id)).session;
  const action = replied.messages[1].actions.find(a => a.kind === 'card');
  const created = await fx.service.executeCompanionAction(id, action.id);
  const again = await fx.service.executeCompanionAction(id, action.id);
  assert.equal(created.result.draftId, again.result.draftId);
  const draft = (await fx.service.getGachaCardDraft(created.result.draftId)).session;
  assert.equal(draft.companionActionId, action.id); assert.equal(draft.status, 'ready'); assert.equal(draft.quality.passed, true);
  assert.equal((await fx.service.loadLearningState()).state.cards.length, 0);
  await fx.service.confirmGachaCardDraft(draft.id);
  assert.equal((await fx.service.loadLearningState()).state.cards.length, 1);
});

test('会话及执行状态通过 IndexedDB payload 跨实例恢复', async () => {
  const { IDBFactory } = require('fake-indexeddb');
  const indexedDB = new IDBFactory(), storage = memoryStorage();
  const fx = fixture(() => answer('已经持久保存'), { indexedDB, storage });
  const id = (await fx.service.createCompanionSession({ context: { kind: 'text', text: '本地材料' } })).session.id;
  await send(fx.service, id);
  const reopened = fixture(() => answer(), { indexedDB, storage });
  const session = (await reopened.service.getCompanionSession(id)).session;
  assert.equal(session.messages[1].content, '已经持久保存'); assert.equal(session.context.text, '本地材料');
  await reopened.service.deleteCompanionSession(id);
  assert.equal((await reopened.service.listCompanionSessions()).sessions.length, 0);
});

test('从知识库讨论生成的卡片保留原文身份、位置与版本', async () => {
  let dialogueRequests = 0;
  const fx = fixture(request => {
    if (request.messages[0].content.includes('你的名字是伴学')) return ++dialogueRequests === 1
      ? tool('search_knowledge', { query: '边际成本' }) : answer('依据保存的原文解释边际成本。[S1]', ['S1']);
    const payload = requestPayload(request);
    return { content: JSON.stringify(verificationOutput(payload) || qualityOutput(payload)), toolCalls: [], provider: { model: 'fixture', latencyMs: 1 } };
  });
  await seed(fx, [], [{ id: 'doc_cost', title: '原始成本笔记', type: 'text', content: '边际成本是多生产一个单位新增的成本。', createdAt: Date.now() }]);
  const id = (await fx.service.createCompanionSession({})).session.id;
  const replied = (await send(fx.service, id)).session;
  const action = replied.messages[1].actions.find(a => a.kind === 'card');
  const created = await fx.service.executeCompanionAction(id, action.id);
  const draft = (await fx.service.getGachaCardDraft(created.result.draftId)).session;
  assert.equal(draft.status, 'ready');
  assert.equal(draft.context.evidence[0].documentId, 'doc_cost');
  await fx.service.confirmGachaCardDraft(draft.id);
  const card = (await fx.service.loadLearningState()).state.cards[0];
  assert.ok(card.citations.length > 0);
  assert.ok(card.citations.every(ref => ref.source.documentId === 'doc_cost' && ref.source.version === 1));
  assert.ok(card.citations.every(ref => '边际成本是多生产一个单位新增的成本。'.slice(ref.position.startCharacter, ref.position.endCharacter) === ref.quote));
});

test('失败记录隐藏配置密钥，运行记录保留真实状态与请求次数', async () => {
  const fx = fixture(() => { throw new Error('Provider returned fixture-secret'); });
  const id = (await fx.service.createCompanionSession({})).session.id;
  const failed = (await send(fx.service, id)).session;
  assert.equal(failed.turn.status, 'failed'); assert.ok(!failed.turn.error.includes('fixture-secret'));
  const db = JSON.parse(fx.storage.getItem('kg_extension_harness_v1:test'));
  const run = db.runs.find(item => item.id === failed.turn.id);
  assert.equal(run.status, 'failed'); assert.equal(run.requestCount, 1);
  assert.ok(!JSON.stringify(db).includes('fixture-secret'));
});

test('消息上限为一问一答预留空间，不截断或删除旧消息', async () => {
  const fx = fixture(() => answer());
  const id = (await fx.service.createCompanionSession({})).session.id;
  const db = JSON.parse(fx.storage.getItem('kg_extension_harness_v1:test'));
  db.companionSessions[0].messages = Array.from({ length: 119 }, (_, n) => ({ role: 'user', content: '问题' + n, requestId: 'old_' + n }));
  fx.storage.setItem('kg_extension_harness_v1:test', JSON.stringify(db));
  await assert.rejects(send(fx.service, id), /120 条消息/);
  assert.equal(fx.requests.length, 0);
  assert.equal((await fx.service.getCompanionSession(id)).session.messages.length, 119);
});
