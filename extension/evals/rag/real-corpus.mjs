import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import corpusModule from '../../src/shared/rag/knowledge-corpus.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function loadRealCorpus() {
  const root = resolve(import.meta.dirname, 'real-sources');
  const manifestBytes = readFileSync(resolve(root, 'manifest.json'));
  const queryBytes = readFileSync(resolve(root, 'queries.json'));
  const manifest = JSON.parse(manifestBytes), questions = JSON.parse(queryBytes);
  const documents = manifest.documents.map(item => {
    const bytes = readFileSync(resolve(root, item.path));
    if (digest(bytes) !== item.sha256) throw new Error(`Source checksum mismatch: ${item.id}`);
    const content = bytes.toString('utf8');
    return { id: item.id, title: content.split('\n')[0].replace(/^#\s*/, ''), type: 'markdown', content, sourceUrl: item.sourceUrl };
  });
  const db = { documents, sources: documents.map(doc => ({ id: 'source-' + doc.id, documentId: doc.id, version: 1 })), learningState: { cards: [] } };
  const entries = corpusModule.buildCorpus(db), ids = new Set();
  for (const item of questions.cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate query: ${item.id}`);
    ids.add(item.id);
    for (const label of item.expected) {
      const source = manifest.documents.find(doc => doc.id === label.documentId);
      if (!label.contains || source?.split !== item.split || !entries.some(entry => entry.documentId === label.documentId && entry.text.includes(label.contains))) {
        throw new Error(`Missing answer chunk or cross-split label: ${item.id}`);
      }
    }
  }
  return { db, entries, cases: questions.cases, manifest,
    fingerprints: { manifest: digest(manifestBytes), queries: digest(queryBytes) } };
}

// Multiple overlapping chunks with the same answer count once in recall/DCG.
export function scoreRanking(item, hits, k = 3) {
  const found = new Set(); let first = -1, dcg = 0;
  hits.slice(0, k).forEach((hit, rank) => {
    const entry = hit.entry || hit;
    const matches = item.expected.map((label, i) => label.documentId === entry.documentId && entry.text.includes(label.contains) ? i : -1).filter(i => i >= 0);
    if (matches.length && first < 0) first = rank;
    if (matches.some(i => !found.has(i))) dcg += 1 / Math.log2(rank + 2);
    matches.forEach(i => found.add(i));
  });
  const ideal = Array.from({ length: Math.min(k, item.expected.length) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return { hitAt1: first === 0, recallAt3: item.expected.length ? found.size / item.expected.length : null,
    mrrAt3: first < 0 ? 0 : 1 / (first + 1), ndcgAt3: ideal ? dcg / ideal : null,
    noHitCorrect: !item.expected.length && !hits.length };
}
export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}
export function summarize(cases) {
  const positive = cases.filter(item => item.expected.length), negative = cases.filter(item => !item.expected.length);
  const mean = (items, name) => items.length ? items.reduce((sum, item) => sum + Number(item[name]), 0) / items.length : null;
  return { queries: cases.length, positive: positive.length, negative: negative.length,
    hitAt1: mean(positive, 'hitAt1'), recallAt3: mean(positive, 'recallAt3'), mrrAt3: mean(positive, 'mrrAt3'), ndcgAt3: mean(positive, 'ndcgAt3'),
    candidateRecallAt10: mean(positive, 'candidateRecallAt10'), noHitAccuracy: mean(negative, 'noHitCorrect'),
    outOfDomainNoHitAccuracy: mean(negative.filter(item => item.category === 'out-of-domain'), 'noHitCorrect'),
    nearDomainNoHitAccuracy: mean(negative.filter(item => item.category === 'near-domain-unanswerable'), 'noHitCorrect'),
    warmP50Ms: percentile(cases.map(item => item.elapsedMs), 0.5), warmP95Ms: percentile(cases.map(item => item.elapsedMs), 0.95) };
}
export function adoptionGate(baseline, candidate, additionalBytes = 0) {
  const failures = [];
  for (const metric of ['hitAt1', 'recallAt3', 'mrrAt3', 'noHitAccuracy']) {
    if (!Number.isFinite(candidate[metric]) || !Number.isFinite(baseline[metric])) failures.push(`${metric} missing or non-finite`);
  }
  for (const metric of ['hitAt1', 'recallAt3', 'mrrAt3', 'noHitAccuracy']) if (candidate[metric] < baseline[metric]) failures.push(`${metric} regressed`);
  if (candidate.hitAt1 <= baseline.hitAt1 && candidate.mrrAt3 <= baseline.mrrAt3) failures.push('no top-rank improvement');
  if (!Number.isFinite(candidate.warmP95Ms) || candidate.warmP95Ms > 200) failures.push('warm p95 exceeds 200 ms');
  if (additionalBytes > 50_000_000) failures.push('additional runtime exceeds 50 MB');
  return { passed: !failures.length, failures };
}
