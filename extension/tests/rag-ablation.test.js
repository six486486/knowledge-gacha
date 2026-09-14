const test = require('node:test');
const assert = require('node:assert/strict');
const bm25 = require('../src/shared/rag/bm25-retriever.js');
const analyzer = require('../src/shared/rag/query-analyzer.js');
const hybrid = require('../src/shared/rag/hybrid-retriever.js');

const entry = (id, embeddingText) => ({ id, embeddingText });
test('BM25 matches the formula, saturates repeated terms and normalizes length', () => {
  const entries = [entry('a', 'cache cache transaction'), entry('b', 'cache'), entry('c', 'transaction transaction')];
  const index = bm25.createIndex(entries);
  const hit = index.rank('cache').find(hit => hit.entry.id === 'a');
  const expected = Math.log(1 + 1.5 / 2.5) * 2 * 2.2 / (2 + 1.2 * (0.25 + 0.75 * 3 / 2));
  assert.ok(Math.abs(hit.score - expected) < 1e-12);
  const noLength = bm25.createIndex(entries, { b: 0 });
  const two = noLength.rank('cache').find(hit => hit.entry.id === 'a').score;
  const one = noLength.rank('cache').find(hit => hit.entry.id === 'b').score;
  assert.ok(two > one && two < one * 2);
  assert.equal(index.rank('cache')[0].entry.id, 'b');
  assert.ok(bm25.createIndex([entry('a', 'common rare'), entry('b', 'common'), entry('c', 'common')]).rank('rare')[0].score >
    bm25.createIndex([entry('a', 'common rare'), entry('b', 'common'), entry('c', 'common')]).rank('common')[0].score);
});
test('BM25 preserves term frequencies, normalizes width, isolates corpus statistics and handles empty text', () => {
  assert.equal(analyzer.tokens('ＣＡＣＨＥ cache 缓存缓存').filter(token => token === 'cache').length, 2);
  assert.equal(analyzer.tokens('缓存缓存').filter(token => token === '缓存').length, 2);
  assert.equal(bm25.createIndex([entry('x', 'ＡＢＣ１２３')]).rank('abc123')[0].entry.id, 'x');
  assert.deepEqual(bm25.createIndex([]).rank('anything'), []);
  assert.deepEqual(bm25.createIndex([entry('empty', '')]).rank('anything'), []);
  assert.deepEqual(bm25.createIndex([entry('scope-a', 'cache')]).rank('transaction'), []);
  assert.equal(bm25.createIndex([entry('scope-b', 'transaction')]).rank('transaction').length, 1);
  assert.deepEqual(bm25.createIndex([entry('a', 'cache')]).rank('the and'), []);
  assert.throws(() => bm25.createIndex([], { k1: NaN }), /parameters/);
  assert.throws(() => bm25.createIndex([], { b: 2 }), /parameters/);
});
test('RRF keeps weights and contributes a result from either branch without averaging incomparable scores', () => {
  const a = { entry: entry('a', ''), lexicalScore: 100, denseScore: 0.1 };
  const b = { entry: entry('b', ''), lexicalScore: 0, denseScore: 0.9 };
  const scores = hybrid.fuse([a], [b, a]);
  assert.equal(scores[0].entry.id, 'a');
  assert.ok(Math.abs(scores[0].score - (1.25 / 2.25 + 61 / 62 / 2.25)) < 1e-12);
  assert.deepEqual(hybrid.fuse([], []), []);
});
test('pinned real-source corpus has answer spans and document-disjoint evaluation labels', async () => {
  const { loadRealCorpus } = await import('../evals/rag/real-corpus.mjs');
  const corpus = loadRealCorpus();
  assert.equal(corpus.db.documents.length, 20);
  assert.equal(corpus.cases.length, 48);
  const answerDocs = split => new Set(corpus.cases.filter(item => item.split === split).flatMap(item => item.expected.map(label => label.documentId)));
  assert.equal([...answerDocs('dev')].filter(id => answerDocs('test').has(id)).length, 0);
});
test('evaluation rejects duplicate credit, calculates nearest-rank p95, and fails adoption on a recall or negative regression', async () => {
  const { scoreRanking, percentile, adoptionGate } = await import('../evals/rag/real-corpus.mjs');
  const item = { expected: [{ documentId: 'a', contains: 'answer' }] };
  const hits = [{ documentId: 'a', text: 'answer' }, { documentId: 'a', text: 'answer' }];
  assert.equal(scoreRanking(item, hits).ndcgAt3, 1);
  assert.equal(scoreRanking(item, [{ documentId: 'a', text: 'heading only' }]).recallAt3, 0);
  assert.equal(scoreRanking({ expected: [] }, hits).noHitCorrect, false);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19);
  const baseline = { hitAt1: 0.5, recallAt3: 0.8, mrrAt3: 0.6, noHitAccuracy: 0.9, warmP95Ms: 100 };
  assert.equal(adoptionGate(baseline, { ...baseline, hitAt1: 0.7, mrrAt3: 0.8 }).passed, true);
  for (const changed of [{ recallAt3: 0.7 }, { noHitAccuracy: 0.8 }, { warmP95Ms: 201 }]) {
    assert.equal(adoptionGate(baseline, { ...baseline, hitAt1: 0.7, mrrAt3: 0.8, ...changed }).passed, false);
  }
  assert.equal(adoptionGate(baseline, { ...baseline, hitAt1: 0.7 }, 60_000_000).passed, false);
  assert.equal(adoptionGate(baseline, { ...baseline, hitAt1: NaN, mrrAt3: 0.9 }).passed, false);
});
