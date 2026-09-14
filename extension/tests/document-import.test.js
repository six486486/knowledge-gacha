const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const structure = require('../src/shared/document-structure.js');
const index = require('../src/shared/material-index.js');
const utils = require('../src/shared/runtime-utils.js');
const domain = require('../src/frontend/domain/card-domain.js');
const { createHarnessStore, DB_KEY, normalizeDb } = require('../src/backend/infrastructure/storage/extension-store.js');
const { createMaterialRepository } = require('../src/backend/infrastructure/storage/material-repository.js');
const { createExtensionService } = require('../src/backend/application/extension-service.js');
const { requestPayload, qualityOutput } = require('./fixtures/quality-output.js');
const { planOutput, batchQualityOutput } = require('./fixtures/knowledge-plan-output.js');

const NOW = 1788483600000;
const KEY = DB_KEY + ':profile_import_test';
const COST = '每多生产一个单位额外增加的成本，称为边际成本。新增收入 10 元，原料支出 6 元。';
const CACHE = '缓存有效期越短，回源请求越多，但数据更容易保持新鲜。';
const fullPage = { x: 0, y: 0, width: 1, height: 1 };
function block(pageNumber, text = COST, extra = {}) {
  return { id: 'pdf_p' + pageNumber + '_b0', text, kind: 'paragraph', headingPath: [], pageNumber,
    locator: { format: 'pdf', pageNumber, region: fullPage, extractionMethod: 'text', parserVersion: structure.PARSER_VERSION, revision: 1 }, ...extra };
}
function fakeFile(name = 'fixture.pdf') { const bytes = Buffer.from('%PDF-1.7 synthetic same-file fixture'); return { name, type: 'application/pdf', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }; }
function harness(options = {}) {
  const indexedDB = options.indexedDB || new IDBFactory();
  const storage = options.storage || utils.memoryStorage();
  const profileId = options.profileId || 'profile_import_test';
  const repository = createMaterialRepository({ indexedDB, profileId });
  const requests = [];
  const parsing = [];
  const documentParser = options.parser || { async run(input, hooks) {
    parsing.push({ ...input, bytes: undefined });
    if (input.operation === 'inspect') return { pageCount: 4, outline: [], parserVersion: structure.PARSER_VERSION };
    if (input.operation === 'render') return { dataUrl: 'data:image/jpeg;base64,AA==', width: 600, height: 800, region: fullPage, pageNumber: input.pageNumber };
    for (const number of input.pages) await hooks.onProgress({ type: 'page', page: { pageNumber: number, status: number === 3 ? 'needs_ocr' : 'ready',
      blocks: number === 3 ? [] : [options.makeBlock ? options.makeBlock(number) : block(number, number === 2 ? CACHE : COST)], extractionMethod: 'text', revision: 1 } });
    return { metrics: { elapsedMs: 10 } };
  } };
  const service = createExtensionService({ storage, indexedDB, repository, profileId, cardDomain: domain, providerModule: {}, now: () => NOW, documentParser,
    modelConfig: options.modelConfig || { baseUrl: 'http://localhost/v1', model: 'gpt-4o-mini', apiKey: 'fixture-only' },
    providerTransport: { complete: async (_, request) => {
      requests.push(request);
      if (options.respond) return options.respond(request);
      const payload = requestPayload(request);
      const output = payload.operation === 'document_ocr' ? { text: COST, unreadable: false, regions: [], uncertain: [] } :
        request.messages[0].content.includes('知识学习清单规划器') ? planOutput(payload) :
        payload.userGoal?.includes('仅生成此目标') ? batchQualityOutput(payload) : qualityOutput(payload);
      return { content: JSON.stringify(output), provider: { model: 'fixture', latencyMs: 1 } };
    } } });
  async function db() {
    const value = await repository.get('state', 'current') || {};
    for (const table of ['documents', 'materials', 'drafts']) for (const row of value[table] || []) if (row.payloadId) Object.assign(row, await repository.get('payloads', row.payloadId));
    return value;
  }
  return { service, repository, indexedDB, storage, requests, parsing, db };
}
async function select(f, pages = [1]) {
  const { job } = await f.service.importDocumentFile(fakeFile());
  await f.service.parseImportedPages(job.id, { pages });
  const result = await f.service.selectDocumentImport(job.id, { pages });
  return { id: job.id, ...result };
}
async function saveCard(f, selected, retention = 'excerpt') {
  const { session } = await f.service.createGachaCardDraft({ ...selected.material, sourcePlan: { duplicateAction: 'create_new', saveFullSource: retention !== 'excerpt', saveOriginal: retention === 'original' } });
  assert.equal(session.status, 'ready');
  return f.service.confirmGachaCardDraft(session.id);
}

test('页码预算与解析范围严格校验，不能默默截到 100 页', () => {
  assert.deepEqual(structure.parsePageRange('1-3,2,9', 110), [1, 2, 3, 9]);
  assert.equal(structure.parsePageRange('2-101', 101).length, 100);
  for (const value of ['', '0', '2-1', '102', '1-101', '1-100,101', '1,x']) assert.throws(() => structure.parsePageRange(value, 101));
});
test('20 MiB 文件恰好可导入，超出一字节和空文件在读取前拒绝', async () => {
  const f = harness();
  const bytes = new Uint8Array(structure.LIMITS.fileBytes);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  const accepted = await f.service.importDocumentFile({ name: 'boundary.pdf', type: 'application/pdf', size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer });
  assert.equal(accepted.job.status, 'select_range');
  assert.equal(accepted.job.fileBytes, 20 * 1024 * 1024);
  const before = f.parsing.length;
  for (const size of [structure.LIMITS.fileBytes + 1, 0]) {
    await assert.rejects(f.service.importDocumentFile({ name: 'rejected.pdf', size,
      arrayBuffer: async () => { throw new Error('不应读取被拒绝的文件'); } }), size ? /20 MB/ : /文件为空/);
  }
  assert.equal(f.parsing.length, before);
  assert.equal((await f.repository.list('assets')).length, 1);
});
test('一百万字符选择完整保留，超限与跨段分隔符均计入容量', () => {
  const limit = structure.LIMITS.selectedCharacters;
  const exact = { id: 'exact', text: '甲'.repeat(limit - 1) + '终' };
  const selected = structure.selectionFromBlocks([exact], ['exact']);
  assert.equal(selected.text.length, limit);
  assert.equal(selected.text.at(-1), '终');
  assert.throws(() => structure.selectionFromBlocks([{ ...exact, text: exact.text + '超' }], ['exact']), /100 万字/);
  const paragraphs = [{ id: 'one', text: '甲'.repeat(limit - 3) }, { id: 'two', text: '终' }];
  assert.equal(structure.selectionFromBlocks(paragraphs, ['one', 'two']).text.length, limit);
  assert.throws(() => structure.selectionFromBlocks([{ ...paragraphs[0], text: paragraphs[0].text + '超' }, paragraphs[1]], ['one', 'two']), /100 万字/);
});
test('结构块保留段落、页码和文字偏移，不跨来源块合并', () => {
  const parsed = structure.assemble([block(1), block(2, CACHE)]);
  const material = { id: 'material_fixture', ...parsed };
  const chunks = index.splitMaterial(material);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].locator.pageNumber, 2);
  assert.equal(index.chunkView(material, chunks[1]).text, CACHE);
  assert.throws(() => index.splitMaterial({ ...material, blocks: [{ ...parsed.blocks[0], text: 'wrong' }] }), /位置不一致/);
  assert.equal(structure.selectionFromBlocks(parsed.blocks, [parsed.blocks[0].id]).text, COST);
  assert.throws(() => structure.selectionFromBlocks(parsed.blocks, ['missing']), /已变化/);
});
test('页眉清理需要跨页证据，识别或手动校对文字不会被后续解析覆盖', () => {
  const header = n => ({ ...block(n, '页眉 ' + n), margin: true });
  const pages = [1, 2].map(n => ({ pageNumber: n, rawBlocks: [header(n), block(n, COST)], extractionMethod: 'text' }));
  const cleaned = structure.cleanRepeatedMargins(pages);
  assert.deepEqual(cleaned.map(page => page.blocks.length), [1, 1]);
  assert.equal(structure.cleanRepeatedMargins([pages[0]])[0].blocks.length, 2);
  const manual = { ...pages[0], extractionMethod: 'manual', blocks: [block(1, '用户校对内容')] };
  assert.equal(structure.cleanRepeatedMargins([manual, pages[1]])[0].blocks[0].text, '用户校对内容');
});
test('DOCX 抽取标题、列表与单元格，忽略链接行为，不编造页码', () => {
  const p = (text, props = {}) => ({ type: 'paragraph', children: [{ type: 'text', value: text }], ...props });
  const document = { children: [p('标题', { styleId: 'Heading1' }), p('列表项', { numbering: { level: '1' } }),
    { type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [p('<script>literal</script>')], colSpan: 2 }] }] }] };
  const result = structure.docxBlocks(document);
  assert.equal(result.blocks[1].kind, 'list');
  assert.deepEqual(result.blocks[2].headingPath, ['标题']);
  assert.equal(result.blocks[2].locator.paragraphNumber, 3);
  assert.equal(result.blocks[2].locator.columnSpan, 2);
  assert.equal(result.blocks[2].locator.pageNumber, undefined);
  assert.ok(result.text.includes('<script>literal</script>'));
});

test('IndexedDB 迁移保留旧材料和卡片关系，切换前逐条验证，重开可恢复', async () => {
  const storage = utils.memoryStorage();
  const indexedDB = new IDBFactory();
  const repository = createMaterialRepository({ indexedDB, profileId: 'profile_import_test' });
  const original = normalizeDb({ documents: [{ id: 'doc_legacy', title: '历史资料', content: COST.repeat(3000), createdAt: NOW }],
    drafts: [{ id: 'draft_legacy', status: 'material', source: { title: '草稿' }, material: { text: CACHE, source: { title: '草稿' } } }],
    preferences: [{ id: 'pref_legacy', value: '保留' }] }, utils.localDay, NOW);
  storage.setItem(KEY, JSON.stringify(original));
  const store = createHarnessStore({ storage, repository, utils, profileId: 'profile_import_test', now: () => NOW });
  await store.ready;
  const metadata = await repository.get("state", "current");
  assert.equal(metadata.documents[0].content, undefined);
  assert.ok(metadata.documents[0].payloadId);
  assert.equal(store.readDb().documents[0].content, original.documents[0].content);
  assert.deepEqual(store.readDb().preferences, original.preferences);
  const reopened = createHarnessStore({ storage, repository, utils, profileId: 'profile_import_test', now: () => NOW });
  await reopened.ready;
  assert.equal(reopened.readDb().drafts[0].material.text, CACHE);
  assert.equal(reopened.readDb().documents[0].content, original.documents[0].content);
  await repository.close();
});
test('迁移的事务写入失败时保留旧 JSON，不清掉尚未切换的资料', async () => {
  const storage = utils.memoryStorage();
  const original = JSON.stringify({ documents: [{ id: 'doc_old', title: '旧文', content: COST }] });
  storage.setItem(KEY, original);
  const repository = createMaterialRepository({ indexedDB: new IDBFactory(), profileId: 'profile_import_test' });
  repository.commitState = async () => { throw new Error('QuotaExceededError'); };
  const store = createHarnessStore({ storage, repository, utils, profileId: 'profile_import_test', now: () => NOW });
  await assert.rejects(store.ready, /QuotaExceededError/);
  assert.equal(storage.getItem(KEY), original);
  assert.equal((await repository.list('payloads')).length, 0);
  await repository.close();
});
test('新材料缺失的索引不会被静默当作空数据库；其他档案独立保存', async () => {
  const indexedDB = new IDBFactory();
  const storage = utils.memoryStorage();
  storage.setItem(KEY, JSON.stringify({ materialStorage: 'indexeddb-v1', documents: [{ id: 'doc_lost', payloadId: 'payload_missing' }] }));
  const repository = createMaterialRepository({ indexedDB, profileId: 'profile_import_test' });
  const original = storage.getItem(KEY);
  const store = createHarnessStore({ storage, repository, utils, profileId: 'profile_import_test', now: () => NOW });
  await assert.rejects(store.ready, /材料记录缺失/);
  assert.equal(storage.getItem(KEY), original);
  const another = createMaterialRepository({ indexedDB, profileId: 'profile_other' });
  await another.put('assets', 'asset_shared', { text: 'other profile' });
  await repository.clear();
  assert.equal((await another.get('assets', 'asset_shared')).text, 'other profile');
  await repository.close(); await another.close();
});

test('PDF 单页选择只发送所选文字，保存仅有片段时释放原文件与解析草稿', async () => {
  const f = harness();
  const selected = await select(f, [1]);
  assert.equal(f.requests.length, 0);
  const result = await saveCard(f, selected);
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes(CACHE)));
  assert.equal(result.card.citations[0].position.pageNumber, 1);
  assert.equal(result.card.citations[0].position.locator.format, 'pdf');
  assert.equal((await f.db()).documents.length, 0);
  assert.equal((await f.repository.list('assets')).length, 0);
  assert.equal((await f.repository.list('imports')).length, 0);
  const resolved = await f.service.resolveCitation(result.card.citations[0]);
  assert.equal(resolved.excerpt.highlight, result.card.citations[0].quote);
  assert.equal(resolved.originalAvailable, false);
  await f.repository.close();
});
test('保留解析文字可重开与回查，但不提供原页或原始文件下载', async () => {
  const f = harness();
  const selected = await select(f);
  const saved = await saveCard(f, selected, 'text');
  const documentId = saved.card.sourceSnapshot.fullSourceDocumentId;
  const document = (await f.service.getDocument(documentId)).document;
  assert.equal(document.content, COST);
  assert.equal(document.originalAssetId, undefined);
  await assert.rejects(f.service.getDocumentOriginal(documentId), /未保留原始文件/);
  assert.equal((await f.repository.list('assets')).length, 0);
  const reopened = harness({ indexedDB: f.indexedDB, storage: f.storage });
  assert.equal((await reopened.service.getDocument(documentId)).document.content, COST);
  assert.equal((await reopened.service.resolveCitation(saved.card.citations[0])).status, 'available');
  await f.repository.close(); await reopened.repository.close();
});
test('同一原始文件多次选页共享二进制、追加文字不移动旧引用、删除不损伤最小依据', async () => {
  const f = harness();
  const first = await saveCard(f, await select(f, [1]), 'original');
  const firstQuote = first.card.citations[0];
  const second = await saveCard(f, await select(f, [2]), 'original');
  const db = await f.db();
  assert.equal(db.documents.length, 1);
  assert.equal(db.documents[0].selections.length, 2);
  assert.equal((await f.repository.list('assets')).length, 1);
  assert.equal((await f.service.resolveCitation(firstQuote)).excerpt.highlight, firstQuote.quote);
  assert.equal(second.card.citations[0].position.pageNumber, 2);
  assert.ok(second.card.citations[0].position.startCharacter > COST.length);
  const again = await select(f, [1]);
  await f.service.discardDocumentImport(again.id);
  assert.equal((await f.repository.list('assets')).length, 1);
  const download = await f.service.getDocumentOriginal(db.documents[0].id);
  assert.ok(download.blob.size > 0);
  await f.service.deleteDocument(db.documents[0].id);
  assert.equal((await f.repository.list('assets')).length, 0);
  assert.equal((await f.service.loadLearningState()).state.cards.length, 2);
  assert.equal((await f.service.resolveCitation(firstQuote)).status, 'removed');
  await f.repository.close();
});
test('旧片段未保留的范围不会误定位到同文件后来保存的另一选区', async () => {
  const f = harness();
  const first = await saveCard(f, await select(f, [1]));
  await saveCard(f, await select(f, [2]), 'text');
  const result = await f.service.resolveCitation(first.card.citations[0]);
  assert.equal(result.status, 'excerpt_only');
  assert.equal(result.documentId, null);
  await f.repository.close();
});
test('扫描页先确认发送、再确认文字；修订版本和页面区域随依据保存', async () => {
  const f = harness();
  const { job } = await f.service.importDocumentFile(fakeFile());
  await f.service.parseImportedPages(job.id, { pages: [1, 3] });
  await assert.rejects(f.service.selectDocumentImport(job.id, { pages: [3] }), /无可用文字/);
  await assert.rejects(f.service.recognizeImportedPages(job.id, { pages: [3] }), /确认/);
  assert.equal(f.requests.length, 0);
  const recognized = await f.service.recognizeImportedPages(job.id, { pages: [3], confirmTransmission: true });
  const page = recognized.job.pages.find(page => page.pageNumber === 3);
  assert.equal(page.ocr.reviewed, false);
  assert.equal(requestPayload(f.requests[0]).pageNumber, 3);
  await assert.rejects(f.service.selectDocumentImport(job.id, { pages: [3] }));
  const corrected = COST + ' 用户已校对。';
  await f.service.correctImportedPage(job.id, { pageNumber: 3, text: corrected, expectedRevision: page.ocr.revision });
  const selected = await f.service.selectDocumentImport(job.id, { pages: [3] });
  assert.equal(selected.material.text, corrected);
  const saved = await saveCard(f, selected, 'original');
  assert.equal(saved.card.citations[0].position.locator.extractionMethod, 'ocr_corrected');
  assert.equal(saved.card.citations[0].position.locator.revision, 2);
  assert.deepEqual(saved.card.citations[0].position.locator.region, fullPage);
  assert.equal(saved.card.citations[0].position.pageNumber, 3);
  await f.repository.close();
});
test('无视觉能力和失败识别保留源页，重试不会重复请求成功页', async () => {
  let fail = true;
  const f = harness({ respond: async request => {
    if (requestPayload(request).pageNumber === 3 && fail) { fail = false; throw new Error('vision unavailable'); }
    return { content: JSON.stringify({ text: COST, unreadable: false, regions: [], uncertain: [] }), provider: { model: 'fixture' } };
  } });
  const { job } = await f.service.importDocumentFile(fakeFile());
  await f.service.parseImportedPages(job.id, { pages: [1, 3] });
  await f.service.recognizeImportedPages(job.id, { pages: [1, 3], confirmTransmission: true });
  const second = await f.service.recognizeImportedPages(job.id, { pages: [1, 3], confirmTransmission: true });
  assert.deepEqual(f.requests.map(request => requestPayload(request).pageNumber), [1, 3, 3]);
  assert.ok(second.job.pages.find(page => page.pageNumber === 3).ocr.text);
  const blocked = harness({ modelConfig: { model: 'gpt-3.5-turbo', apiKey: 'fixture-only' } });
  const imported = await blocked.service.importDocumentFile(fakeFile());
  await blocked.service.parseImportedPages(imported.job.id, { pages: [3] });
  await assert.rejects(blocked.service.recognizeImportedPages(imported.job.id, { pages: [3], confirmTransmission: true }), /不能识别图片/);
  assert.equal(blocked.requests.length, 0);
  await f.repository.close(); await blocked.repository.close();
});
test('暂停只保留已解析页，恢复仅解析剩余范围，选定草稿可接第三步', async () => {
  let first = true;
  let pageDone;
  const checkpoint = new Promise(resolve => { pageDone = resolve; });
  const parsed = [];
  const f = harness({ parser: { async run(input, hooks) {
    if (input.operation === 'inspect') return { pageCount: 2, outline: [] };
    parsed.push(input.pages);
    for (const number of input.pages) {
      await hooks.onProgress({ type: 'page', page: { pageNumber: number, blocks: [block(number)], status: 'ready', extractionMethod: 'text', revision: 1 } });
      if (first) { first = false; pageDone(); await new Promise((resolve, reject) => { hooks.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); }
    }
    return {};
  } } });
  const { job } = await f.service.importDocumentFile(fakeFile());
  const work = f.service.parseImportedPages(job.id, { pages: [1, 2] });
  await checkpoint;
  const paused = await f.service.cancelDocumentImport(job.id);
  await work;
  assert.equal(paused.job.status, 'paused');
  assert.equal(paused.job.pages.length, 1);
  await f.service.retainDocumentImport(job.id);
  await f.service.parseImportedPages(job.id, { pages: [1, 2] });
  assert.deepEqual(parsed, [[1, 2], [2]]);
  const selected = await f.service.selectDocumentImport(job.id, { pages: [1, 2] });
  const draft = await f.service.saveGachaMaterialDraft(selected.material);
  assert.equal((await f.repository.list('imports')).length, 0);
  const plan = await f.service.createKnowledgePlan({ ...draft.session.material, sourcePlan: { saveFullSource: true }, materialDraftId: draft.session.id });
  const analyzed = await f.service.analyzeKnowledgePlan(plan.plan.id);
  assert.equal(analyzed.plan.status, 'ready');
  assert.equal(analyzed.chunks.length, 2);
  assert.equal(analyzed.chunks[1].locator.pageNumber, 2);
  assert.equal((await f.repository.list('assets')).length, 1);
  await f.repository.close();
});
test('确认写索引失败可重试，不丢草稿、不产生幽灵原文或重复卡', async () => {
  const f = harness();
  const selected = await select(f);
  const { session } = await f.service.createGachaCardDraft({ ...selected.material, sourcePlan: { saveOriginal: true } });
  const commit = f.repository.commitState;
  let reject = true;
  f.repository.commitState = async (expected, value, rows) => { if (reject && value.drafts?.some(draft => draft.status === 'confirmed')) { reject = false; throw new Error('QuotaExceededError'); } return commit(expected, value, rows); };
  await assert.rejects(f.service.confirmGachaCardDraft(session.id), /QuotaExceededError/);
  let db = await f.db();
  assert.equal(db.learningState.cards.length, 0);
  assert.equal(db.documents.length, 0);
  assert.equal(db.drafts[0].status, 'ready');
  await f.service.confirmGachaCardDraft(session.id);
  await f.service.confirmGachaCardDraft(session.id);
  db = await f.db();
  assert.equal(db.learningState.cards.length, 1);
  assert.equal(db.documents.length, 1);
  assert.equal((await f.repository.list('assets')).length, 1);
  await f.repository.close();
});

test('同一文件的未选历史范围不会经相关来源进入单卡或多卡请求', async () => {
  const marker = 'SAME_FILE_UNSELECTED_RANGE';
  const f = harness({ makeBlock: number => block(number, COST + (number === 2 ? ' ' + marker : '')) });
  await saveCard(f, await select(f, [2]), 'text');
  await f.service.ingestDocument({ source: { title: '另一份相关原文', content: COST + ' OTHER_SOURCE_ALLOWED' } });
  f.requests.length = 0;
  const selected = await select(f, [1]);
  await f.service.createGachaCardDraft({ ...selected.material, sourcePlan: { duplicateAction: 'create_new' } });
  assert.ok(!JSON.stringify(f.requests).includes(marker));
  assert.ok(!JSON.stringify(f.requests).includes('OTHER_SOURCE_ALLOWED'));
  f.requests.length = 0;
  await f.service.createGachaCardDraft({ ...selected.material, allowSupplemental: true, sourcePlan: { duplicateAction: 'create_new' } });
  assert.ok(!JSON.stringify(f.requests).includes(marker));
  assert.ok(JSON.stringify(f.requests).includes('OTHER_SOURCE_ALLOWED'));
  f.requests.length = 0;
  const again = await select(f, [1]);
  const created = await f.service.createKnowledgePlan({ ...again.material, allowSupplemental: true });
  const plan = await f.service.analyzeKnowledgePlan(created.plan.id);
  assert.equal(plan.plan.status, 'ready');
  assert.ok(!JSON.stringify(f.requests).includes(marker));
  await f.repository.close();
});

test('放弃导入清单删除未收下草稿与临时文件，保留已收下卡片和共享原件', async () => {
  for (const saveOriginal of [false, true]) {
    const f = harness({ makeBlock: number => block(number, number === 1 ? COST : CACHE, { headingPath: [number === 1 ? '成本' : '缓存'] }) });
    const selected = await select(f, [1, 2]);
    const created = await f.service.createKnowledgePlan({ ...selected.material, sourcePlan: { saveOriginal } });
    const analyzed = await f.service.analyzeKnowledgePlan(created.plan.id);
    assert.equal(analyzed.plan.units.length, 2);
    const generated = await f.service.generateCardBatch(created.plan.id, { maxUnits: 2 });
    assert.equal(generated.sessions.filter(draft => draft.status === 'ready').length, 2);
    const choice = await f.service.prepareCardBatchConfirmation(generated.batch.id, [analyzed.plan.units[0].id]);
    const saved = await f.service.confirmCardBatch(generated.batch.id, choice.selection);
    assert.equal(saved.results[0].status, 'confirmed');
    const before = await f.db();
    await f.service.discardKnowledgePlan(created.plan.id);
    const after = await f.db();
    assert.equal(after.learningState.cards.length, 1);
    assert.deepEqual(after.learningState.cards[0].citations, before.learningState.cards[0].citations);
    assert.equal(after.drafts.length, 1);
    assert.equal(after.drafts[0].status, 'confirmed');
    assert.equal(after.materials[0].text, undefined);
    assert.equal(after.materials[0].blocks, undefined);
    assert.equal(after.knowledgePlans[0].units.length, 1);
    assert.equal((await f.repository.list('assets')).length, saveOriginal ? 1 : 0);
    assert.equal((await f.service.listRetainedLearningTargets()).targets.length, 0);
    await assert.rejects(f.service.analyzeKnowledgePlan(created.plan.id), /已放弃/);
    assert.equal((await f.service.resolveCitation(after.learningState.cards[0].citations[0])).status, saveOriginal ? 'available' : 'excerpt_only');
    await f.repository.close();
  }
});
