import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateExtensionPackage } from '../../../scripts/release/extension-browser-smoke.mjs';

const corpus = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url)));
const outputIndex = process.argv.indexOf('--out');
const output = resolve(outputIndex < 0 ? 'test-results/discovery-ranking/semantic.json' : process.argv[outputIndex + 1]);
const extension = resolve('extension');
const context = await chromium.launchPersistentContext(resolve('.tmp-browser-qa/discovery-ranking/eval-' + Date.now()), {
  channel: 'msedge', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  const page = await context.newPage(), externalRequests = [], errors = [];
  context.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${validateExtensionPackage(extension).extensionId}/index.html`);
  console.log('Evaluating discovery duplicates with the bundled local embedding model...');
  const result = await page.evaluate(async cases => {
    const ranking = window.KnowledgeGachaDiscoveryRanking;
    const embedding = window.KnowledgeGachaLocalEmbedding.createLocalEmbeddingClient();
    const outlines = cases.flatMap(item => [item.left, item.right].map(([topic, learningObjective], index) => ({ topic, learningObjective,
      seedAnchor: item.anchors?.[index], baseTopicId: item.anchors?.[index] })));
    const started = performance.now();
    try {
      const semantic = await ranking.prepare({ seeds: [], exclusions: {} }, outlines, embedding);
      const lexical = ranking.lexicalComparison();
      return { rankingVersion: ranking.VERSION, threshold: ranking.DUPLICATE_THRESHOLD, strategy: semantic.strategy,
        elapsedMs: performance.now() - started, cases: cases.map((item, index) => {
          const left = outlines[index * 2], right = outlines[index * 2 + 1];
          return { id: item.id, expectedDuplicate: item.duplicate, duplicate: semantic.sameTarget(left, right),
            lexicalDuplicate: lexical.sameTarget(left, right), similarity: semantic.similarity(ranking.targetText(left), ranking.targetText(right)),
            objectiveSimilarity: semantic.similarity(left.learningObjective, right.learningObjective) };
        }) };
    } finally { embedding.dispose(); }
  }, corpus.cases);
  const positives = result.cases.filter(item => item.expectedDuplicate), negatives = result.cases.filter(item => !item.expectedDuplicate);
  const report = { corpus: corpus.version, scope: 'Small authored regression set; not a production relevance benchmark', ...result,
    metrics: { duplicatesDetected: positives.filter(item => item.duplicate).length, duplicates: positives.length,
      falsePositives: negatives.filter(item => item.duplicate).length, distinctPairs: negatives.length }, externalRequests, errors };
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  // Preserve uncertain paraphrases; the regression gate prioritizes precision over recall.
  if (externalRequests.length || errors.length || result.strategy !== 'local-semantic' || report.metrics.falsePositives
    || !result.cases.find(item => item.id === 'cache-expiry-paraphrase')?.duplicate
    || report.metrics.duplicatesDetected < 2) process.exitCode = 1;
} finally { await context.close(); }
