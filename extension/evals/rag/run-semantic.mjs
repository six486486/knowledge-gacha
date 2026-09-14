import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { corpus, fixtureDb, evaluate } from './run.mjs';
import { validateExtensionPackage } from '../../../scripts/release/extension-browser-smoke.mjs';

const outIndex = process.argv.indexOf('--out');
const output = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : 'test-results/2026-09-08-semantic-knowledge/retrieval.json');
const cases = process.argv.includes('--holdout') ? JSON.parse(readFileSync(new URL('./semantic-cases.json', import.meta.url))).cases : corpus.cases;
const extension = resolve('extension');
const profile = resolve('.tmp-browser-qa/semantic-upgrade-20260908/eval-profile-' + Date.now());
const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  const page = await context.newPage();
  const requests = [], errors = [];
  context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') console.log(message.type(), message.text()); });
  await page.goto(`chrome-extension://${validateExtensionPackage(extension).extensionId}/index.html`);
  const result = await page.evaluate(async ({ db, cases, processThreshold }) => {
    const w = window;
    const repository = w.KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: 'semantic_eval' });
    const embedding = w.KnowledgeGachaLocalEmbedding.createLocalEmbeddingClient();
    const service = w.KnowledgeGachaSemanticKnowledge.createSemanticKnowledgeService({ readDb: () => db, repository, embedding });
    const results = [];
    try {
      for (const item of cases) {
        const baseline = w.KnowledgeGachaHarnessRag.createRagService({ readDb: () => db }).inspectRetrieval(item.query, { limit: 3, ...item.options });
        const result = await service.search(item.query, { type: 'document', limit: 3, ...item.options, ...(processThreshold ? { denseThreshold: 0 } : {}) });
        const relevant = span => item.expected.some(label => label.documentId === span.documentId && span.text.includes(label.contains));
        const first = result.results.findIndex(relevant);
        results.push({ id: item.id, query: item.query, positive: Boolean(item.expected.length), hitAt1: first === 0,
          recallAt3: item.expected.length ? item.expected.filter(label => result.results.some(span => label.documentId === span.documentId && span.text.includes(label.contains))).length / item.expected.length : null,
          reciprocalRankAt3: first < 0 ? 0 : 1 / (first + 1), noHitCorrect: !item.expected.length && !result.results.length,
          lexicalHitAt1: baseline.evidence.findIndex(relevant) === 0, lexicalRecallAt3: item.expected.length ? item.expected.filter(label => baseline.evidence.some(span => label.documentId === span.documentId && span.text.includes(label.contains))).length / item.expected.length : null,
          lexicalNoHitCorrect: !item.expected.length && !baseline.evidence.length, trace: result.trace });
      }
      return results;
    } finally { service.dispose(); await repository.close(); }
  }, { db: fixtureDb(), cases, processThreshold: process.argv.includes('--calibrate') });
  const mean = (items, field) => items.reduce((s, item) => s + Number(item[field]), 0) / items.length;
  const positive = result.filter(item => item.positive), negative = result.filter(item => !item.positive);
  const report = { generatedAt: new Date().toISOString(), browser: context.browser()?.version(), model: JSON.parse(readFileSync(resolve(extension, 'vendor/embedding/versions.json'))),
    corpus: process.argv.includes('--holdout') ? 'semantic-holdout-v1' : corpus.version, scope: 'Small authored regression corpus, not a production or public benchmark', externalRequests: requests, errors,
    metrics: { positive: positive.length, negative: negative.length, hitAt1: mean(positive, 'hitAt1'), recallAt3: mean(positive, 'recallAt3'), mrrAt3: mean(positive, 'reciprocalRankAt3'), noHitAccuracy: mean(negative, 'noHitCorrect'), lexicalHitAt1: mean(positive, 'lexicalHitAt1'), lexicalRecallAt3: mean(positive, 'lexicalRecallAt3'), lexicalNoHitAccuracy: mean(negative, 'lexicalNoHitCorrect') },
    lexical: evaluate(), cases: result };
  mkdirSync(resolve(output, '..'), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ metrics: report.metrics, externalRequests: requests, errors, cases: result.map(item => ({ id: item.id, hit: item.hitAt1, noHit: item.noHitCorrect, strategy: item.trace.strategy, top: item.trace.selected?.[0] })) }, null, 2));
  if (errors.length || requests.length || result.some(item => item.trace.degraded)) process.exitCode = 1;
} finally { await context.close(); }
