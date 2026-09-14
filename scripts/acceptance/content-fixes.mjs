import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import quality from '../../extension/src/backend/features/generation/card-quality.js';
import skills from '../../extension/src/harness/skills/skill-registry.js';
import provider from '../../extension/src/backend/provider/provider-transport.js';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--config') || !process.argv.includes('--out')) throw new Error('需要 --config 和新的 --out 目录');
const config = provider.normalizeModelConfig(JSON.parse(await readFile(resolve(arg('--config')), 'utf8')));
const out = resolve(arg('--out'));
await mkdir(out, { recursive: false });
const task = skills.loadTask('concept-card');
const records = JSON.parse(await readFile('extension/tests/fixtures/acceptance-september-regressions.json', 'utf8'));
const cases = records.map(row => ({ ...structuredClone(row), expected: 'rejected' }));
const sort = structuredClone(records.find(row => row.id === 'sorting-answer'));
sort.id = 'sorting-corrected'; sort.expected = 'ready';
sort.candidate.exercise.answer = '最终顺序为 ("x", 1)、("x", 3)、("y", 1)、("y", 3)。';
sort.candidate.exercise.rubric[0] = '最终顺序正确：(x, 1)、(x, 3)、(y, 1)、(y, 3)';
cases.push(sort);
const cache = structuredClone(records.find(row => row.id === 'cache-boundary'));
cache.id = 'cache-corrected'; cache.expected = 'ready';
cache.candidate.card.example.text = cache.candidate.card.example.text.replace('age 未超过其 max-age', 'age 小于其 max-age');
cases.push(cache);
const report = { startedAt: new Date().toISOString(), taskVersion: task.version, model: config.model,
  scope: 'Frozen failing outputs and authored positive controls; review operation cannot repair or replace the input',
  limits: { requests: 20, tokens: 60000 }, requests: [], knownTokens: 0, missingUsage: 0, cases: [] };
const checkpoint = () => writeFile(join(out, 'results.json'), JSON.stringify(report, (_key, value) =>
  typeof value === 'string' ? value.replaceAll(config.apiKey, '[REDACTED]') : value, 2) + '\n');
const base = provider.createProviderTransport({ timeoutMs: 60000 });
let caseId;
const transport = { complete: async (settings, request) => {
  if (report.requests.length >= report.limits.requests || report.knownTokens >= report.limits.tokens) throw new Error('达到本轮评测预算');
  const content = request.messages.at(-1).content;
  const payload = JSON.parse(typeof content === 'string' ? content : content.find(c => c.type === 'text').text);
  const call = { caseId, operation: payload.operation, startedAt: new Date().toISOString() };
  report.requests.push(call);
  try {
    const response = await base.complete(settings, request);
    call.usage = response.provider?.usage; call.response = response.content; call.latencyMs = response.provider?.latencyMs;
    if (Number.isFinite(call.usage?.totalTokens)) report.knownTokens += call.usage.totalTokens;
    else report.missingUsage++;
    return response;
  } catch (error) { call.error = { code: error.code, message: error.message }; report.missingUsage++; throw error; }
  finally { await checkpoint(); }
} };
const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
for (const row of cases) {
  caseId = row.id;
  const original = JSON.stringify(row);
  const output = await service.run(row.context, row.candidate, 'review');
  assert.equal(JSON.stringify(row), original, '复核不得修改输入或旧结果');
  const passed = row.expected === 'ready' ? output.status === 'ready' : output.status !== 'ready' &&
    output.quality.issues.some(i => ['sorting_trace_mismatch', 'boundary_unverified', 'question_condition_conflict', 'finite_sample_unverified', 'independent_answer_mismatch', 'semantic_fact', 'independent_answer_unavailable'].includes(i.code) || i.code.startsWith('semantic_'));
  report.cases.push({ id: row.id, expected: row.expected, passed, output });
  await checkpoint();
  console.log(row.id + ': ' + (passed ? 'PASS' : 'FAIL') + '; status=' + output.status);
}
report.finishedAt = new Date().toISOString();
report.passed = report.cases.every(c => c.passed);
await checkpoint();
if (!report.passed) process.exitCode = 1;
