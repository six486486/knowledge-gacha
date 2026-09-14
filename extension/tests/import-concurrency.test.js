const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const utils = require('../src/shared/runtime-utils.js');
const domain = require('../src/frontend/domain/card-domain.js');
const { createMaterialRepository } = require('../src/backend/infrastructure/storage/material-repository.js');
const { createExtensionService } = require('../src/backend/application/extension-service.js');

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t) {
  const indexedDB = new IDBFactory(), storage = utils.memoryStorage(), profileId = utils.id('import_concurrency');
  function client() {
    const repository = createMaterialRepository({ indexedDB, profileId });
    const service = createExtensionService({ storage, repository, profileId, cardDomain: domain, providerModule: {},
      providerTransport: { complete: async () => { throw new Error('不应发送模型请求'); } },
      documentParser: { run: async (input, hooks) => {
        if (input.operation === 'inspect') return { pageCount: 1 };
        await hooks.onProgress({ type: 'page', page: { pageNumber: 1, status: 'ready', revision: 1, extractionMethod: 'text',
          blocks: [{ id: 'block_1', text: '原有正文', kind: 'paragraph', headingPath: [], locator: { format: 'pdf', pageNumber: 1, revision: 1 } }] } });
        return {};
      } } });
    t.after(async () => { service.dispose(); await repository.close(); });
    return { service, repository };
  }
  const first = client(), second = client();
  const bytes = new TextEncoder().encode('%PDF-1.7 test');
  const { job } = await first.service.importDocumentFile({ name: '材料.pdf', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
  await first.service.parseImportedPages(job.id, { pages: [1] });
  function pauseCorrection() {
    const entered = gate(), resume = gate(), put = first.repository.put;
    let paused = false;
    first.repository.put = async (name, id, value) => {
      if (!paused && name === 'imports' && id === job.id && value.pages[0]?.revision === 2) {
        paused = true; entered.release(); await resume.promise;
      }
      return put(name, id, value);
    };
    return { entered: entered.promise, release: resume.release };
  }
  const correct = (text = '已校对的正文') => first.service.correctImportedPage(job.id, { pageNumber: 1, expectedRevision: 1, text });
  return { first, second, job, correct, pauseCorrection };
}

test('同一页并发校对不能同时通过旧修订号，已保存文字不被覆盖', async t => {
  const f = await fixture(t), pause = f.pauseCorrection();
  const saving = f.correct();
  await pause.entered;
  let second;
  try { second = await f.correct('另一份旧修订覆盖'); }
  catch (error) { second = error; }
  finally { pause.release(); await saving; }
  assert.ok(second instanceof Error);
  const stored = await f.first.repository.get('imports', f.job.id);
  assert.equal(stored.pages[0].blocks[0].text, '已校对的正文');
  assert.equal(stored.pages[0].revision, 2);
  await assert.rejects(f.correct('旧版本'), /更新|处理|暂停/);
});

test('校对保存未结束时不能选择旧范围，完成后选择返回最新文字', async t => {
  const f = await fixture(t), pause = f.pauseCorrection();
  const saving = f.correct();
  await pause.entered;
  let result;
  try { result = await f.first.service.selectDocumentImport(f.job.id, { pages: [1] }); }
  catch (error) { result = error; }
  finally { pause.release(); await saving; }
  assert.ok(result instanceof Error);
  assert.equal((await f.first.service.selectDocumentImport(f.job.id, { pages: [1] })).material.text, '已校对的正文');
});

for (const method of ['retainDocumentImport', 'discardDocumentImport']) {
  test(`${method} 等待正在保存的校对，完成后不被迟到写入覆盖或复活`, async t => {
    const f = await fixture(t), pause = f.pauseCorrection();
    const saving = f.correct();
    await pause.entered;
    const finishing = f.first.service[method](f.job.id);
    finishing.then(pause.release, pause.release);
    // Correct implementations wait for the save; release the injected disk stall.
    const timer = setTimeout(pause.release, 50);
    try { await Promise.all([saving, finishing]); }
    finally { clearTimeout(timer); pause.release(); }
    const stored = await f.first.repository.get('imports', f.job.id);
    if (method === 'retainDocumentImport') {
      assert.equal(stored.keepDraft, true);
      assert.equal(stored.pages[0].blocks[0].text, '已校对的正文');
      assert.equal((await f.second.service.getDocumentImport(f.job.id)).job.keepDraft, true);
    } else {
      assert.equal(stored, undefined);
      assert.equal(await f.first.repository.get('assets', f.job.assetId), undefined);
    }
  });
}

test('同一窗口并发恢复同一草稿不会误报另一个窗口占用', async t => {
  const f = await fixture(t);
  await f.first.service.retainDocumentImport(f.job.id);
  const results = await Promise.all([f.first.service.getDocumentImport(f.job.id), f.first.service.getDocumentImport(f.job.id)]);
  assert.ok(results.every(result => result.job.id === f.job.id));
  await assert.rejects(f.second.service.getDocumentImport(f.job.id), /其他窗口/);
});

test('已有预览的临时读取失败不释放占用，其他窗口仍不能删除它', async t => {
  const f = await fixture(t), get = f.first.repository.get;
  let fail = true;
  f.first.repository.get = async (name, id) => {
    if (fail && name === 'imports' && id === f.job.id) { fail = false; throw new Error('读取暂时失败'); }
    return get(name, id);
  };
  await assert.rejects(f.first.service.getDocumentImport(f.job.id), /读取暂时失败/);
  await assert.rejects(f.second.service.discardDocumentImport(f.job.id), /其他窗口/);
  assert.equal((await f.first.service.getDocumentImport(f.job.id)).job.pages[0].blocks[0].text, '原有正文');
});

test('保留任务尚未写入完成时不接受新的范围操作', async t => {
  const f = await fixture(t), entered = gate(), resume = gate(), put = f.first.repository.put;
  f.first.repository.put = async (name, id, value) => {
    if (name === 'imports' && value.keepDraft) { entered.release(); await resume.promise; }
    return put(name, id, value);
  };
  const finishing = f.first.service.retainDocumentImport(f.job.id);
  await entered.promise;
  let outcome;
  try { outcome = await f.first.service.selectDocumentImport(f.job.id, { pages: [1] }); }
  catch (error) { outcome = error; }
  finally { resume.release(); await finishing; }
  assert.ok(outcome instanceof Error);
  assert.equal((await f.second.service.getDocumentImport(f.job.id)).job.keepDraft, true);
});

test('切换预览保留当前进度并释放本窗口占用，重复释放不干扰另一窗口', async t => {
  const f = await fixture(t);
  const released = await f.first.service.releaseDocumentImport(f.job.id);
  assert.equal(released.job.keepDraft, true);
  assert.equal(released.job.pages[0].blocks[0].text, '原有正文');
  await f.second.service.getDocumentImport(f.job.id);
  await f.second.service.correctImportedPage(f.job.id, { pageNumber: 1, expectedRevision: 1, text: '接续后的文字' });
  await f.first.service.releaseDocumentImport(f.job.id);
  assert.equal((await f.second.service.getDocumentImport(f.job.id)).job.pages[0].blocks[0].text, '接续后的文字');
  await assert.rejects(f.first.service.getDocumentImport(f.job.id), /其他窗口/);
  await f.first.service.releaseDocumentImport('missing');
  assert.equal((await f.first.repository.list('imports')).length, 1);
});

test('切换时保存失败保留原占用和进度，重试成功后才允许其他窗口接续', async t => {
  const f = await fixture(t), put = f.first.repository.put;
  let fail = true;
  f.first.repository.put = async (name, id, value) => {
    if (fail && name === 'imports' && value.keepDraft) { fail = false; throw new Error('QuotaExceededError'); }
    return put(name, id, value);
  };
  await assert.rejects(f.first.service.releaseDocumentImport(f.job.id), /QuotaExceededError/);
  await assert.rejects(f.second.service.getDocumentImport(f.job.id), /其他窗口/);
  assert.equal((await f.first.service.getDocumentImport(f.job.id)).job.pages.length, 1);
  await f.first.service.releaseDocumentImport(f.job.id);
  assert.equal((await f.second.service.getDocumentImport(f.job.id)).job.keepDraft, true);
});
