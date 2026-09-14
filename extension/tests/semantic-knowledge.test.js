const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const utils = require('../src/shared/runtime-utils.js');
const { createMaterialRepository } = require('../src/backend/infrastructure/storage/material-repository.js');
const { createHarnessStore } = require('../src/backend/infrastructure/storage/extension-store.js');
const { createSemanticKnowledgeService } = require('../src/harness/rag/semantic-knowledge-service.js');
const corpus = require('../src/shared/rag/knowledge-corpus.js');
const schema = require('../src/shared/knowledge-schema.js');
const { createLocalEmbeddingClient } = require('../src/backend/infrastructure/embedding/local-embedding-client.js');

// Controlled vectors test cache/lifecycle, not semantic accuracy. Real BGE evaluation is a separate browser run.
function fixture(t) {
  const indexedDB = new IDBFactory();
  const repository = createMaterialRepository({ indexedDB, profileId: 'semantic_test' });
  const db = schema.upgradeDb({ documents: [{ id: 'cache', title: '缓存', content: '# 缓存\n保存计算结果供下次使用。' }],
    learningState: { cards: [{ id: 'generated', title: '缓存卡片', summary: '复用先前保存的结果', sourceIds: [] }], pending: [] } });
  const calls = [];
  const embedding = { fingerprint: 'fixture-v1', dimensions: 3, embed: async (texts, options) => {
    calls.push({ texts, query: options?.query }); return texts.map(() => [1, 0, 0]);
  } };
  const service = createSemanticKnowledgeService({ readDb: () => db, repository, embedding });
  t.after(() => repository.close());
  return { db, repository, embedding, calls, service, indexedDB };
}

test('向量按内容与模型版本增量复用，重开仍命中；原文引用与模型卡身份分开', async t => {
  const f = fixture(t);
  const result = await f.service.search('换一种说法');
  assert.equal(result.trace.strategy, 'hybrid-rrf-v1');
  assert.equal(result.trace.indexed, 2);
  assert.equal(result.results.find(x => x.type === 'card').evidenceRole, 'learning_background');
  const source = result.results.find(x => x.type === 'document');
  assert.equal(f.db.documents[0].content.slice(source.startCharacter, source.endCharacter), source.text);
  const reopened = createSemanticKnowledgeService({ readDb: () => f.db, repository: f.repository, embedding: f.embedding });
  const warm = await reopened.search('不同表述');
  assert.equal(warm.trace.indexed, 0); assert.equal(warm.trace.cacheHits, 2);
  f.db.documents[0].content += '过期后重新计算。'; f.db.sources[0].version += 1;
  assert.equal((await reopened.search('不同表述')).trace.indexed, 1);
  f.embedding.fingerprint = 'fixture-v2';
  assert.equal((await reopened.search('不同表述')).trace.indexed, 2);
});

test('过滤发生在嵌入与召回之前，删除和检索期间更新不会返回旧引用', async t => {
  const f = fixture(t);
  const excluded = await f.service.search('缓存', { type: 'document', excludeDocumentId: 'cache' });
  assert.equal(excluded.results.length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.service.search('缓存', { onlyLinked: true })).results.length, 0);
  f.embedding.embed = async (texts, options) => {
    if (options?.query) { f.db.documents = []; f.db.learningState.cards = []; }
    return texts.map(() => [1, 0, 0]);
  };
  assert.equal((await f.service.search('缓存')).results.length, 0);
  await f.service.prune();
  assert.equal((await f.repository.list('vectors')).length, 0);
  const other = createMaterialRepository({ indexedDB: f.indexedDB, profileId: 'other' });
  await other.put('vectors', 'private', { vector: [1, 0, 0] });
  await f.repository.clear();
  assert.ok(await other.get('vectors', 'private')); await other.close();
});

test('模型和索引写入失败明确降级，仍能返回关键词原文', async t => {
  const f = fixture(t);
  f.embedding.embed = async () => { throw new Error('fixture failure'); };
  const result = await f.service.search('缓存', { type: 'document' });
  assert.equal(result.trace.degraded, 'local_embedding_unavailable');
  assert.equal(result.trace.strategy, 'lexical');
  assert.equal(result.results[0].documentId, 'cache');
});

test('长材料末尾被独立索引，窗口不切断代理对且保留原文偏移', () => {
  const text = '# 资料\n' + '前段🙂。'.repeat(300) + '最终结论：这段必须能够被检索。';
  const entries = corpus.buildCorpus({ documents: [{ id: 'long', content: text }], sources: [], learningState: { cards: [] } });
  assert.ok(entries.some(x => x.embeddingText.includes('最终结论')));
  entries.forEach(entry => { assert.equal(entry.text, text.slice(entry.startCharacter, entry.endCharacter)); assert.ok(entry.embeddingText.length <= 441); assert.doesNotMatch(entry.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/); });
});

test('模型超时会释放 Worker；下一次调用可重建，错误向量不能进入索引', async () => {
  let workers = 0, terminated = 0;
  const client = createLocalEmbeddingClient({ timeoutMs: 10, workerFactory: () => {
    workers += 1;
    const worker = { terminate() { terminated += 1; }, postMessage(data) {
      if (workers > 1) queueMicrotask(() => worker.onmessage({ data: { id: data.id, vectors: [Array(512).fill(NaN)] } }));
    } }; return worker;
  } });
  await assert.rejects(client.embed(['a']), /停止/);
  await assert.rejects(client.embed(['a']), /格式无效/);
  assert.equal(workers, 2); assert.equal(terminated, 1); client.dispose();
});

test('IndexedDB 原子事务同时提交状态与原文，冲突与中途异常不改变旧状态', async t => {
  const repository = createMaterialRepository({ indexedDB: new IDBFactory(), profileId: 'atomic' });
  t.after(() => repository.close());
  const old = { preferences: [{ id: 'p', value: '喜欢实例' }], version: 1 };
  await repository.commitState('{}', old, [{ id: 'old', value: { text: '旧资料' } }]);
  await assert.rejects(repository.commitState('{}', { version: 2 }, [{ id: 'bad', value: 'x' }]), /其他窗口/);
  const rows = [{ id: 'queued', value: '已排入事务但尚未提交' }, { id: 'invalid', value: { uncloneable: () => {} } }];
  await assert.rejects(repository.commitState(JSON.stringify(old), { version: 2 }, rows));
  assert.deepEqual(await repository.get('state', 'current'), old);
  assert.equal(await repository.get('payloads', 'queued'), undefined);
  assert.equal(await repository.get('payloads', 'bad'), undefined);
});

test('迁移后学习和记忆更新不再写 localStorage，旧备份保留且清空不会复活', async t => {
  const repository = createMaterialRepository({ indexedDB: new IDBFactory(), profileId: 'migration' });
  t.after(() => repository.close());
  const storage = utils.memoryStorage(), key = 'kg_extension_harness_v1:migration';
  const legacy = JSON.stringify({ preferences: [{ id: 'p', value: '喜欢实例' }], documents: [{ id: 'd', title: '旧文', content: '不能丢失的原文' }] });
  storage.setItem(key, legacy);
  const options = { storage, repository, profileId: 'migration', utils };
  const store = createHarnessStore(options); await store.ready;
  assert.equal(storage.getItem(key), legacy);
  storage.setItem = () => { throw new Error('localStorage quota'); };
  await store.run(() => store.mutate(db => { db.preferences[0].value = '新偏好'; }));
  const reopened = createHarnessStore(options); await reopened.ready;
  assert.equal(reopened.readDb().preferences[0].value, '新偏好');
  assert.equal(reopened.readDb().documents[0].content, '不能丢失的原文');
  await reopened.run(() => reopened.clear()); await repository.clear();
  const cleared = createHarnessStore(options); await cleared.ready;
  assert.equal(cleared.readDb().preferences.length, 0);
  assert.equal(cleared.readDb().documents.length, 0);
});
