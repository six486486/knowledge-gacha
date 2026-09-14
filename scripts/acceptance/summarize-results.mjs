import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Rebuild metrics from immutable run outputs and the separate AI review; no network.
const out = resolve(process.argv[2] || 'test-results/2026-09-06-product-acceptance');
const read = async file => JSON.parse(await readFile(join(out, file), 'utf8'));
const review = await read('ai-review.json');
const full = await read('real-current-24/outputs.json');
const capability = await read('real-capabilities/results.json');
const verified = await read('ocr-review-verified/results.json');
const numeric = await read('ocr-numeric-verified/results.json');
const repeatDirs = ['repeat-short-01-3', 'repeat-short-05-2', 'repeat-short-05-3', 'repeat-image-02-2', 'repeat-image-02-3'];
const capabilityDirs = ['real-capabilities', 'discovery-diagnostic', 'ocr-review-verified', 'ocr-numeric-verified'];
const runDirs = ['real-short-01', 'real-current-24', ...capabilityDirs, ...repeatDirs];
const runs = [];
for (const directory of runDirs) {
  const isCapabilities = capabilityDirs.includes(directory);
  const run = await read(`${directory}/${isCapabilities ? 'results.json' : 'outputs.json'}`);
  runs.push({ directory, requests: isCapabilities ? run.budget.requests : run.budget.requestsUsed,
    tokens: isCapabilities ? run.budget.tokens : run.budget.knownTokens, missingUsage: run.budget.missingUsage });
}
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
const byId = new Map(review.singleCards.map(item => [item.id, item]));
const countStatuses = rows => rows.reduce((acc, row) => ({ ...acc, [row.current.status]: (acc[row.current.status] || 0) + 1 }), {});
const single = full.cases.filter(item => item.expectedStatus === 'ready');
assert.equal(single.length, 15);
assert.equal(full.cases.length, 24);
const scored = single.map(item => ({ id: item.id, status: item.current.status,
  ...byId.get(item.id), deliveryAdjustedScores: item.current.status === 'ready' ? byId.get(item.id).scores : [1, 1, 1, 1, 1] }));
assert(scored.every(item => item.scores.length === 5));
const plans = capability.cases.filter(item => item.kind === 'multi_card');
const discovery = capability.cases.filter(item => item.kind === 'discovery');
const ocr = [...verified.cases, ...numeric.cases].filter(item => item.kind === 'ocr').map(item => {
  const page = item.data.recognized.job.pages.find(page => page.ocr);
  const normalized = page.ocr.text.replace(/\s/g, '');
  assert.equal(normalized, (item.data.reference || review.ocr.reference).replace(/\s/g, ''));
  return { id: item.id, status: item.execution, recognizedCharacters: normalized.length,
    exactMatchIgnoringWhitespace: true, textCalls: [...verified.requests, ...numeric.requests].filter(request => request.caseId === item.id).length,
    modelElapsedMs: page.ocr.elapsedMs };
});
const repetition = [];
for (const id of ['short-01', 'short-05', 'image-02']) {
  const dirs = id === 'short-01' ? ['real-short-01', 'real-current-24', 'repeat-short-01-3'] : ['real-current-24', `repeat-${id}-2`, `repeat-${id}-3`];
  const rows = [];
  for (const directory of dirs) {
    const item = (await read(`${directory}/outputs.json`)).cases.find(item => item.id === id);
    rows.push({ directory, status: item.current.status, elapsedMs: item.current.generation.elapsedMs });
  }
  repetition.push({ id, runs: rows, ready: rows.filter(row => row.status === 'ready').length });
}
const metrics = {
  model: full.model, promptVersion: full.promptVersion, thinkingPolicy: 'non-thinking-v1',
  engineering: { extensionTests: 219, releaseScriptTests: 7, e2eTests: 44, documentationFiles: 13, syntaxModules: 54,
    logs: ['check-final.txt', 'e2e-final-verified.txt', 'browsers.txt'], note: 'One Enter/keyup popup-close race in the test was corrected; the original 43/44 run is retained.' },
  realModel: { runs, totalRequests: runs.reduce((sum, run) => sum + run.requests, 0), totalKnownTokens: runs.reduce((sum, run) => sum + run.tokens, 0),
    missingUsage: runs.reduce((sum, run) => sum + run.missingUsage, 0), note: 'Includes preliminary attempts, invalid initial review fixture, diagnostics, and repeat runs; no duplicated resume usage.' },
  fullCorpus: { samples: 24, distribution: countStatuses(full.cases), expectedSingleCards: 15,
    singleReady: single.filter(item => item.current.status === 'ready').length,
    routingMatched: full.cases.filter(item => item.expectedStatus !== 'ready' && item.expectedStatus === item.current.status).length,
    expectedStatusMatched: full.cases.filter(item => item.expectedStatus === item.current.status).length,
    stringBooleanFinalChecks: single.filter(item => item.current.checks?.some(check => typeof check.passed === 'string')).map(item => item.id),
    criticalContentErrors: scored.filter(item => item.criticalError).length,
    averageScores: review.scoreOrder.map((_, i) => scored.reduce((sum, item) => sum + item.scores[i], 0) / scored.length),
    deliveryAdjustedAverageScores: review.scoreOrder.map((_, i) => scored.reduce((sum, item) => sum + item.deliveryAdjustedScores[i], 0) / scored.length),
    singleLatencyMs: { n: single.length, p50: quantile(single.map(item => item.current.generation.elapsedMs), .5), p95: quantile(single.map(item => item.current.generation.elapsedMs), .95), method: 'nearest rank; includes failed drafts and missing output' },
    perCase: full.cases.map(item => ({ id: item.id, expected: item.expectedStatus, status: item.current.status,
      elapsedMs: item.current.generation.elapsedMs, requests: item.current.generation.calls.length,
      tokens: item.current.generation.calls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0) })) },
  plans: plans.map(item => ({ id: item.id, status: item.data.analysis.plan.status,
    targets: item.data.analysis.plan.units.filter(unit => unit.disposition === 'active').map(unit => unit.title),
    selected: item.data.selectedUnitIds.length, generated: item.data.finalBatch.sessions.length, ready: item.data.readyCount,
    saved: item.data.savedCards?.length || 0 })),
  discovery: { attempts: discovery.length, completed: discovery.filter(item => item.execution === 'completed').length,
    failureCodes: [...new Set(discovery.map(item => item.error?.code).filter(Boolean))] },
  reviewVariant: verified.cases.find(item => item.kind === 'review_variant'),
  ocr: { distinctTextPages: 2, results: ocr }, repetition
};
await writeFile(join(out, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
const csv = ['id,expected,status,elapsed_ms,requests,tokens', ...metrics.fullCorpus.perCase.map(row => [row.id, row.expected, row.status, row.elapsedMs, row.requests, row.tokens].join(','))].join('\n') + '\n';
await writeFile(join(out, 'single-case-metrics.csv'), csv);
console.log(JSON.stringify({ model: metrics.model, usage: metrics.realModel, corpus: { ...metrics.fullCorpus, perCase: undefined },
  plans: metrics.plans, discovery: metrics.discovery, ocr: metrics.ocr, repetition: metrics.repetition }, null, 2));
