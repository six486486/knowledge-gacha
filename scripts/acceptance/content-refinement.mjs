import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import quality from '../../extension/src/backend/features/generation/card-quality.js';
import skills from '../../extension/src/harness/skills/skill-registry.js';
import planner from '../../extension/src/backend/features/discovery/discovery-planner.js';
import provider from '../../extension/src/backend/provider/provider-transport.js';

const args = process.argv.slice(2);
const arg = key => { const i = args.indexOf(key); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('需要 ' + key); return args[i + 1]; };
const config = provider.normalizeModelConfig(JSON.parse(await readFile(resolve(arg('--config')), 'utf8')));
const out = resolve(arg('--out')); await mkdir(out, { recursive: false });
const only = args.includes('--only') ? new RegExp(arg('--only')) : null;
const fixtures = JSON.parse(await readFile('extension/tests/fixtures/content-refinement-regressions.json', 'utf8'));
const task = skills.loadTask('concept-card');
const report = { startedAt: new Date().toISOString(), taskVersion: task.version, discoveryVersion: planner.PROMPT_VERSION,
  model: config.model, limits: { requests: 40, tokens: 120000 }, requests: [], knownTokens: 0, missingUsage: 0, cases: [] };
const save = () => writeFile(join(out, 'results.json'), JSON.stringify(report, (_key, value) =>
  typeof value === 'string' ? value.replaceAll(config.apiKey, '[REDACTED]') : value, 2) + '\n');
const base = provider.createProviderTransport({ timeoutMs: 60000 });
let active;
const transport = { complete: async (settings, request) => {
  if (report.requests.length >= report.limits.requests || report.knownTokens >= report.limits.tokens) throw new Error('达到回归预算');
  const content = request.messages.at(-1).content;
  const payload = JSON.parse(typeof content === 'string' ? content : content.find(x => x.type === 'text').text);
  const call = { caseId: active, operation: payload.operation || 'outline' }; report.requests.push(call);
  try {
    const response = await base.complete(settings, request);
    call.response = response.content; call.usage = response.provider?.usage; call.latencyMs = response.provider?.latencyMs;
    if (Number.isFinite(call.usage?.totalTokens)) report.knownTokens += call.usage.totalTokens; else report.missingUsage++;
    return response;
  } catch (error) { call.error = { code: error.code, message: error.message }; report.missingUsage++; throw error; }
  finally { await save(); }
} };
const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
async function record(id, work, check) {
  if (only && !only.test(id)) return;
  active = id;
  const row = { id };
  try { row.output = await work(); check(row.output); row.passed = true; }
  catch (error) { row.passed = false; row.error = error.message; }
  report.cases.push(row); await save(); console.log(id + ': ' + (row.passed ? 'PASS' : 'FAIL'));
}
for (const row of fixtures) await record('frozen-' + row.id, async () => {
  const before = JSON.stringify(row);
  const output = await service.run(row.context, row.candidate, 'review');
  assert.equal(JSON.stringify(row), before); return output;
}, output => {
  assert.equal(output.status, 'needs_revision');
  assert.ok(output.quality.issues.some(i => ['term_conflation', 'transaction_context', 'image_answer_leak', 'approximation_derivation'].includes(i.code)));
});
for (const id of ['short-08', 'sensitivity', 'image-01']) {
  const row = fixtures.find(r => r.id === id);
  await record('new-' + id, () => service.run(row.context, id === 'image-01' ? row.candidate : undefined,
    id === 'image-01' ? 'exercise' : undefined), output => {
    assert.equal(output.status, 'ready', JSON.stringify(output.quality.issues));
    if (id === 'image-01') {
      assert.deepEqual(output.card, row.candidate.card, '只换图题不能改变卡片讲解');
      assert.notEqual(output.exercise.question, row.candidate.exercise.question);
    }
  });
}
for (const [id, anchor] of [['rule72', '72法则：解释其与精确复利翻倍公式的区别和近似条件'],
  ['iso', '数字摄影曝光三角：区分进光量与ISO影响的成像亮度']]) {
  await record('outline-card-' + id, async () => {
    const request = { planVersion: planner.PLAN_VERSION, refreshIndex: 1,
      seeds: [{ id, mode: 'explicit_interest', anchor, baseSummary: '', baseLearningObjective: '',
        relationship: '兴趣学习', evidenceStatus: 'explicit_interest', targetDifficulty: 'standard' }],
      exclusions: { existing: [], seenTargetKeys: [], seenTargets: [], excludedLearningUnitIds: [], downrankedTopicIds: [] } };
    const planned = await planner.requestOutlines(transport, () => config, request);
    const outline = planned.outlines.find(o => id === 'rule72' ? /72/.test(o.topic) : /ISO|曝光/.test(o.topic));
    assert.ok(outline, '不能替换成无关主题');
    const context = { userGoal: outline.learningObjective + '\n新增知识：' + outline.newKnowledge,
      evidence: [{ id: 'outline', kind: 'text', text: outline.knowledgeText, origin: 'discovery_outline' }] };
    return { planned, selected: outline, generated: await service.run(context) };
  }, result => assert.equal(result.generated.status, 'ready', JSON.stringify(result.generated.quality.issues)));
}
await record('bad-rule72-source', () => service.run({ userGoal: '能解释72法则如何由对数公式得出并估算翻倍期数',
  evidence: [{ id: 'outline', kind: 'text', origin: 'discovery_outline', text:
    '要估算本金翻倍所需期数,可令(1+r)^n=2,两边取对数得n=ln2/ln(1+r)。当每期利率r较小时,ln(1+r)≈r,且ln2≈0.693,换算成百分数即n≈72/(100r),这就是72法则。成立条件是r为每期利率且利息按期再投资。例如年利率8%时约需72/8=9年翻倍;利率很高时该近似会低估期数,应改用精确公式。' }] }),
  output => { assert.notEqual(output.status, 'ready'); assert.ok(['insufficient_material', 'needs_revision'].includes(output.status));
    assert.ok(output.quality.issues.some(i => /69|72|0.693|推导|换算|近似/.test(i.message))); });
report.finishedAt = new Date().toISOString(); report.passed = report.cases.every(c => c.passed); await save();
if (!report.passed) process.exitCode = 1;
