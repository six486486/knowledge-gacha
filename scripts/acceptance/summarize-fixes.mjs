import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Offline summary of immutable model runs. Does not load model credentials.
const root = resolve(process.argv[2] || 'test-results/2026-09-06-product-fixes');
const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const runs = [];
for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  let record, file;
  for (const name of ['results.json', 'outputs.json']) {
    try { record = await read(file = join(root, entry.name, name)); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!record?.budget) continue;
  const b = record.budget;
  runs.push({ directory: entry.name, promptVersion: record.promptVersion,
    requests: b.requests ?? b.requestsUsed, tokens: b.tokens ?? b.knownTokens, missingUsage: b.missingUsage,
    cases: record.cases.length, source: file.slice(root.length + 1).replaceAll('\\', '/') });
}
const probes = await read(join(root, 'probe-independent.json'));
runs.push({ directory: 'probe-independent.json', promptVersion: 'independent-answer-probe/non-thinking-v1',
  requests: probes.length, tokens: probes.reduce((sum, p) => sum + (p.usage?.totalTokens || 0), 0),
  missingUsage: probes.filter(p => !Number.isFinite(p.usage?.totalTokens)).length, cases: probes.length, source: 'probe-independent.json' });
const full = await read(join(root, 'v2.3.4-full', 'outputs.json'));
const capabilities = await read(join(root, 'v2.3.4-capabilities', 'results.json'));
const holdouts = await read(join(root, 'v2.3.5-holdouts', 'results.json'));
const regressions = await read(join(root, 'v2.3.6-recorded', 'results.json'));
// Use IDs because historical harness kind names may differ across runs.
const multi = capabilities.cases.filter(c => c.id.startsWith('plan-'));
const discovery = capabilities.cases.filter(c => c.id.startsWith('discovery-'));
const total = runs.reduce((sum, r) => ({ requests: sum.requests + r.requests, tokens: sum.tokens + r.tokens,
  missingUsage: sum.missingUsage + r.missingUsage }), { requests: 0, tokens: 0, missingUsage: 0 });
const result = { scope: 'This repair turn only; excludes the earlier 192-request acceptance baseline.',
  warning: 'ready is a program status, not a factual-quality pass. See REPORT.md for content failures.',
  runs, total, fullCorpus: { promptVersion: full.promptVersion, cases: full.cases.map(c => ({ id: c.id,
    expectedStatus: c.expectedStatus, actualStatus: c.current.status, issueCodes: c.current.quality?.issues?.map(i => i.code) || [] })),
    expectedSingle: full.cases.filter(c => c.expectedStatus === 'ready').length,
    readySingle: full.cases.filter(c => c.expectedStatus === 'ready' && c.current.status === 'ready').length },
  capabilities: { promptVersion: capabilities.promptVersion,
    plans: multi.map(c => ({ id: c.id, status: c.data.analysis.plan.status, units: c.data.analysis.plan.units.length,
      readyCards: c.data.readyCount, savedCards: c.data.savedCards.length,
      confirmationIdempotent: JSON.stringify(c.data.confirmation.results) === JSON.stringify(c.data.repeatedConfirmation.results) })),
    discovery: discovery.map(c => ({ id: c.id, poolStatus: c.data.pool.status, draftStatus: c.data.opened.session.status,
      savedStatus: c.data.saved?.session.status || null })),
    other: capabilities.cases.filter(c => !multi.includes(c) && !discovery.includes(c)).map(c => ({ id: c.id, execution: c.execution })) },
  holdouts: { promptVersion: holdouts.promptVersion, cases: holdouts.cases.map(c => ({ id: c.id, status: c.output.status })) },
  recorded: { promptVersion: regressions.promptVersion, cases: regressions.cases.map(c => ({ id: c.id,
    historicalRecheck: c.reviewed.status, regenerated: c.output.status })) } };
await writeFile(join(root, 'metrics.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ total, runs: runs.length, single: `${result.fullCorpus.readySingle}/${result.fullCorpus.expectedSingle}`,
  plans: result.capabilities.plans, discovery: result.capabilities.discovery, recorded: result.recorded }) + '\n');
