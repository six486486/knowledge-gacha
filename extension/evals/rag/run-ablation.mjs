import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync, cpSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadRealCorpus, scoreRanking, summarize, adoptionGate, digest } from './real-corpus.mjs';
import { validateExtensionPackage } from '../../../scripts/release/extension-browser-smoke.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const split = arg('--split', 'dev');
if (!['dev', 'test'].includes(split)) throw new Error('Use --split dev or --split test');
const output = resolve(arg('--out', `test-results/rag-ablation/${split}.json`));
const data = loadRealCorpus(), cases = data.cases.filter(item => item.split === split);
const extension = resolve('extension'), staging = resolve('.tmp-browser-qa/rag-ablation/extension');
const reranker = JSON.parse(readFileSync(new URL('./reranker-model.json', import.meta.url)));
const modelRoot = resolve('.tmp-browser-qa/rag-ablation/reranker');
let additionalBytes = 0;
for (const file of reranker.files) {
  const path = resolve(modelRoot, file.path);
  if (file.sha256 && digest(readFileSync(path)) !== file.sha256) throw new Error(`Reranker checksum mismatch: ${file.path}`);
  additionalBytes += statSync(path).size;
}
mkdirSync(staging, { recursive: true });
for (const path of ['manifest.json', 'index.html', 'src', 'assets', 'vendor']) cpSync(resolve(extension, path), resolve(staging, path), { recursive: true });
cpSync(modelRoot, resolve(staging, 'eval-models/reranker'), { recursive: true });
cpSync(resolve(import.meta.dirname, 'reranker-worker.mjs'), resolve(staging, 'reranker-worker.mjs'));
// The actual page and original content security policy stay in use. The BM25
// module is loaded only in this evaluation copy until an adoption gate passes.
const indexFile = resolve(staging, 'index.html');
writeFileSync(indexFile, readFileSync(indexFile, 'utf8').replace('<script src="./src/shared/rag/hybrid-retriever.js">', '<script src="./src/shared/rag/bm25-retriever.js"></script><script src="./src/shared/rag/hybrid-retriever.js">'));
const context = await chromium.launchPersistentContext(resolve('.tmp-browser-qa/rag-ablation/profiles', split + '-' + Date.now()), {
  channel: 'msedge', headless: true, args: [`--disable-extensions-except=${staging}`, `--load-extension=${staging}`]
});
const externalRequests = [], errors = [];
try {
  const page = await context.newPage();
  context.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('evalProgress', message => console.log(message));
  await page.goto(`chrome-extension://${validateExtensionPackage(staging).extensionId}/index.html`);
  const evaluated = await page.evaluate(async ({ db, cases }) => {
    const w = window, corpus = w.KnowledgeGachaKnowledgeCorpus, fusion = w.KnowledgeGachaHybridRetriever;
    const entries = corpus.buildCorpus(db), vectors = new Map();
    const embedding = w.KnowledgeGachaLocalEmbedding.createLocalEmbeddingClient();
    const worker = new Worker('./reranker-worker.mjs', { type: 'module' });
    const rerank = (query, texts) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reranker timeout')), 120000);
      worker.onerror = () => { clearTimeout(timer); reject(new Error('Reranker worker failed')); };
      worker.onmessage = ({ data }) => { clearTimeout(timer); data.error ? reject(new Error(data.error)) : resolve(data.scores); };
      worker.postMessage({ query, texts });
    });
    const unique = hits => {
      const counts = new Map();
      return hits.filter(hit => {
        const key = hit.entry.cardId || hit.entry.documentId, count = counts.get(key) || 0;
        if (count >= (hit.entry.type === 'card' ? 1 : 2)) return false;
        counts.set(key, count + 1); return true;
      });
    };
    const pick = hit => ({ id: hit.entry.id, documentId: hit.entry.documentId, text: hit.entry.text,
      startCharacter: hit.entry.startCharacter, endCharacter: hit.entry.endCharacter,
      score: hit.score, lexicalScore: hit.lexicalScore, denseScore: hit.denseScore, rerankScore: hit.rerankScore });
    try {
      const coldStart = performance.now();
      for (let i = 0; i < entries.length; i += 8) {
        const batch = entries.slice(i, i + 8), output = await embedding.embed(batch.map(entry => entry.embeddingText));
        batch.forEach((entry, j) => vectors.set(entry.id, output[j]));
      }
      const embeddingColdMs = performance.now() - coldStart;
      await embedding.embed(['初始化'], { query: true });
      const bmStart = performance.now(), bm25 = w.KnowledgeGachaBM25Retriever.createIndex(entries);
      const bm25IndexMs = performance.now() - bmStart;
      const rerankerStart = performance.now();
      await rerank('初始化', ['初始化模型，不属于评测问题。']);
      const rerankerColdMs = performance.now() - rerankerStart;
      await w.evalProgress(`Indexed ${entries.length} chunks; embedding cold ${Math.round(embeddingColdMs)} ms; reranker cold ${Math.round(rerankerColdMs)} ms`);
      const rows = [];
      for (const item of cases) {
        const started = performance.now();
        const vector = (await embedding.embed([item.query], { query: true }))[0];
        const embeddingMs = performance.now() - started, results = {};
        function measure(name, fn, baseMs) {
          const start = performance.now(), hits = fn();
          results[name] = { hits: unique(hits).slice(0, 3).map(pick), candidates: hits.slice(0, 10).map(pick), elapsedMs: performance.now() - start + (baseMs || 0) };
          return hits;
        }
        const overlapStart = performance.now();
        const scored = entries.map(entry => ({ entry, lexicalScore: w.KnowledgeGachaLexicalRetriever.score(item.query, entry.embeddingText), denseScore: fusion.cosine(vector, vectors.get(entry.id)) }));
        const scoreMs = performance.now() - overlapStart;
        const word = scored.filter(hit => hit.lexicalScore >= 0.18).sort((a, b) => b.lexicalScore - a.lexicalScore);
        const dense = scored.filter(hit => hit.denseScore >= fusion.DENSE_THRESHOLD).sort((a, b) => b.denseScore - a.denseScore);
        measure('overlap', () => word.map(hit => ({ ...hit, score: hit.lexicalScore })), scoreMs);
        measure('dense', () => dense.map(hit => ({ ...hit, score: hit.denseScore })), embeddingMs + scoreMs);
        const baseline = measure('overlap-rrf', () => fusion.rank(entries, item.query, vector, vectors), embeddingMs);
        const bmStart = performance.now(), bmHits = bm25.rank(item.query);
        const bmMs = performance.now() - bmStart;
        measure('bm25', () => bmHits.map(hit => ({ ...hit, lexicalScore: hit.score, denseScore: 0 })), bmMs);
        const byId = new Map(scored.map(hit => [hit.entry.id, hit]));
        const bmWord = bmHits.map(hit => ({ ...byId.get(hit.entry.id), lexicalScore: hit.score }));
        const bmHybrid = measure('bm25-rrf', () => fusion.fuse(bmWord, dense), embeddingMs + bmMs + scoreMs);
        const gated = bmWord.filter(hit => byId.get(hit.entry.id).lexicalScore >= 0.18);
        measure('bm25-gated-rrf', () => fusion.fuse(gated, dense), embeddingMs + bmMs + scoreMs);
        // Both first-stage baselines use the identical cross-encoder and top-10
        // budget. Scores are raw logits, not calibrated answerability confidence.
        for (const [name, hits] of [['overlap-rrf', baseline], ['bm25-rrf', bmHybrid]]) {
          const candidates = hits.slice(0, 10), rankStart = performance.now();
          const scores = candidates.length ? await rerank(item.query, candidates.map(hit => hit.entry.embeddingText)) : [];
          const ranked = candidates.map((hit, i) => ({ ...hit, rerankScore: scores[i] })).sort((a, b) => b.rerankScore - a.rerankScore || b.score - a.score);
          results[name + '-cross-encoder'] = { hits: unique(ranked).slice(0, 3).map(pick), candidates: candidates.map(pick),
            elapsedMs: results[name].elapsedMs + performance.now() - rankStart };
        }
        rows.push({ ...item, results });
        await w.evalProgress(`Finished ${item.id}`);
      }
      return { rows, chunks: entries.length, characters: db.documents.reduce((sum, doc) => sum + doc.content.length, 0), embeddingColdMs, bm25IndexMs, rerankerColdMs };
    } finally { embedding.dispose(); worker.terminate(); }
  }, { db: data.db, cases });
  const strategies = Object.keys(evaluated.rows[0].results), summaries = {};
  for (const strategy of strategies) {
    summaries[strategy] = summarize(evaluated.rows.map(row => {
      const result = row.results[strategy], scored = scoreRanking(row, result.hits);
      return { ...row, ...scored, elapsedMs: result.elapsedMs, candidateRecallAt10: scoreRanking(row, result.candidates, 10).recallAt3 };
    }));
  }
  const gates = Object.fromEntries(strategies.filter(name => name !== 'overlap-rrf').map(name => [name,
    adoptionGate(summaries['overlap-rrf'], summaries[name], name.endsWith('cross-encoder') ? additionalBytes : 0)]));
  const report = { generatedAt: new Date().toISOString(), split, fingerprints: data.fingerprints, browser: context.browser()?.version(),
    scope: data.manifest.sourceScope, corpusVersion: data.manifest.version, documentCount: data.db.documents.length,
    embedding: JSON.parse(readFileSync(resolve(extension, 'vendor/embedding/versions.json'))), reranker: { ...reranker, additionalBytes },
    parameters: { bm25: { k1: 1.2, b: 0.75 }, denseThreshold: 0.44, overlapThreshold: 0.18, rrf: { k: 60, lexicalWeight: 1.25, denseWeight: 1 }, candidateLimit: 10, topK: 3 },
    externalRequests, errors, ...evaluated, summaries, gates };
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ split, summaries, gates, externalRequests, errors }, null, 2));
  // Runtime/fixture failures always fail the process. Rejected candidates are
  // valid experiment outcomes, but --require-candidate makes adoption a CI gate.
  const required = arg('--require-candidate');
  if (errors.length || externalRequests.length || (required && !gates[required]?.passed)) process.exitCode = 1;
} finally { await context.close(); }
