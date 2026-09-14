const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const utils = require('../src/shared/runtime-utils.js');
const structure = require('../src/shared/document-structure.js');
const domain = require('../src/frontend/domain/card-domain.js');
const { createMaterialRepository } = require('../src/backend/infrastructure/storage/material-repository.js');
const { createExtensionService } = require('../src/backend/application/extension-service.js');

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(t, migrated = true) {
  const indexedDB = new IDBFactory();
  const storage = utils.memoryStorage();
  const profileId = utils.id('import_lifecycle');
  storage.setItem('kg_extension_harness_v1:' + profileId, JSON.stringify(migrated ? { materialStorage: 'indexeddb-v1' } : {
    learningState: { cards: [domain.sanitizeCard({ id: 'prior_card', title: '原有卡片', summary: '原有知识' })], pending: [], totalDraws: 1 },
    documents: [{ id: 'prior_doc', title: '原有材料', content: '原有材料正文' }]
  }));
  function client() {
    const repository = createMaterialRepository({ indexedDB, profileId });
    const service = createExtensionService({ storage, repository, profileId, cardDomain: domain, providerModule: {},
      providerTransport: { complete: async () => { throw new Error('本测试不应调用模型'); } },
      documentParser: { run: async (input, hooks) => {
        if (input.operation === 'inspect') return { pageCount: 2, parserVersion: structure.PARSER_VERSION };
        for (const pageNumber of input.pages) await hooks.onProgress({ type: 'page', page: { pageNumber, status: 'ready', revision: 1,
          extractionMethod: 'text', blocks: [{ id: 'p' + pageNumber, text: '第 ' + pageNumber + ' 页原文', kind: 'paragraph', headingPath: [],
            locator: { format: 'pdf', pageNumber, revision: 1, extractionMethod: 'text' } }] } });
        return {};
      } } });
    t.after(async () => { service.dispose(); await repository.close(); });
    return { service, repository };
  }
  const first = client();
  const second = client();
  const bytes = new TextEncoder().encode('%PDF-1.7 isolated import fixture');
  const file = { name: '材料.pdf', type: 'application/pdf', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
  return { first, second, file, profileId };
}

test('另一个窗口不能放弃正在预览的导入，原文与解析进度保留', async t => {
  const f = fixture(t);
  const { job } = await f.first.service.importDocumentFile(f.file);
  await f.first.service.parseImportedPages(job.id, { pages: [1] });
  await assert.rejects(f.second.service.discardDocumentImport(job.id), /其他窗口|另一个窗口/);
  assert.equal((await f.first.service.getDocumentImport(job.id)).job.pages.length, 1);
  assert.ok(await f.first.repository.get('assets', job.assetId));
  await f.first.service.retainDocumentImport(job.id);
  await f.second.service.discardDocumentImport(job.id);
  assert.equal(await f.first.repository.get('imports', job.id), undefined);
  assert.equal(await f.first.repository.get('assets', job.assetId), undefined);
  await f.second.service.discardDocumentImport(job.id);
});

for (const [method, input] of [
  ['correctImportedPage', { pageNumber: 1, expectedRevision: 1, text: '另一个窗口的修改' }],
  ['selectDocumentImport', { pages: [1] }],
  ['retainDocumentImport', undefined]
]) {
  test(`另一窗口的 ${method} 不能覆盖占用中的导入，释放后可接续`, async t => {
    const f = fixture(t);
    const { job } = await f.first.service.importDocumentFile(f.file);
    await f.first.service.parseImportedPages(job.id, { pages: [1] });
    const before = await f.first.repository.get('imports', job.id);
    await assert.rejects(f.second.service[method](job.id, input), /其他窗口|另一个窗口/);
    assert.deepEqual(await f.first.repository.get('imports', job.id), before);
    await f.first.service.retainDocumentImport(job.id);
    const resumed = await f.second.service.getDocumentImport(job.id);
    assert.equal(resumed.job.pages.length, 1);
    await f.second.service[method](job.id, input);
  });
}

test('后台清理读到旧列表时，不能删除刚保存为稍后继续的导入', async t => {
  const f = fixture(t);
  const { job } = await f.first.service.importDocumentFile(f.file);
  const captured = gate(), resume = gate();
  const list = f.second.repository.list;
  let paused = false;
  f.second.repository.list = async name => {
    const rows = await list(name);
    if (name === 'imports' && !paused) { paused = true; captured.release(); await resume.promise; }
    return rows;
  };
  const loading = f.second.service.listDocumentImports();
  await captured.promise;
  await f.first.service.retainDocumentImport(job.id);
  resume.release();
  const result = await loading;
  assert.ok(result.imports.some(item => item.id === job.id));
  assert.ok(await f.first.repository.get('assets', job.assetId));
  assert.equal((await f.second.service.getDocumentImport(job.id)).job.keepDraft, true);
});

test('首次保存导入失败会释放占用，可重试且不留下幽灵任务', async t => {
  const f = fixture(t);
  const put = f.first.repository.put;
  let failedId;
  f.first.repository.put = async (name, id, value) => {
    if (name === 'imports' && !failedId) { failedId = id; throw new Error('QuotaExceededError'); }
    return put(name, id, value);
  };
  await assert.rejects(f.first.service.importDocumentFile(f.file), /QuotaExceededError/);
  const locks = await navigator.locks.query();
  assert.equal(locks.held.some(lock => lock.name.endsWith(':import:' + failedId)), false);
  assert.equal((await f.first.repository.list('imports')).length, 0);
  assert.equal((await f.first.repository.list('assets')).length, 0);
  const retried = await f.first.service.importDocumentFile(f.file);
  assert.equal(retried.job.status, 'select_range');
});

test('被删除或不存在的导入不能留下占用，后续页面可正常继续其他材料', async t => {
  const f = fixture(t);
  await assert.rejects(f.first.service.getDocumentImport('missing'), /已移除/);
  const locks = await navigator.locks.query();
  assert.equal(locks.held.some(lock => lock.name.endsWith(':import:missing')), false);
  const { job } = await f.first.service.importDocumentFile(f.file);
  await f.first.service.retainDocumentImport(job.id);
  assert.equal((await f.second.service.getDocumentImport(job.id)).job.id, job.id);
});

test('两个页面同时迁移旧资料都能启动，原有卡片与正文保持完整', async t => {
  const f = fixture(t, false);
  const results = await Promise.all([f.first.service.loadLearningState(), f.second.service.loadLearningState()]);
  assert.ok(results.every(result => result.state.cards[0].id === 'prior_card'));
  assert.equal((await f.first.repository.list('payloads')).length, 1);
  assert.equal((await f.first.repository.list('payloads'))[0].value.content, '原有材料正文');
  assert.equal((await f.second.service.loadLearningState()).state.cards.length, 1);
});
