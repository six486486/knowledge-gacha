import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import quality from '../../extension/src/backend/features/generation/card-quality.js';
import provider from '../../extension/src/backend/provider/provider-transport.js';
import task from '../../extension/src/harness/skills/definitions/concept-card/task.js';

// Additional authored cases, separate from the unchanged 24-case corpus.
// Credentials are read only from the explicitly authorized local JSON file.
const args = process.argv.slice(2);
const arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!arg('--config') || !arg('--out')) throw new Error('需要 --config 和新的 --out 目录');
const config = provider.normalizeModelConfig(JSON.parse(await readFile(resolve(arg('--config')), 'utf8')));
const out = resolve(arg('--out'));
await mkdir(out, { recursive: true });
try { await access(join(out, 'results.json')); throw new Error('输出已存在，请使用新目录'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const corpus = JSON.parse(await readFile('extension/evals/card-quality/cases.json', 'utf8'));
const cases = arg('--recorded') ? JSON.parse(await readFile(resolve(arg('--recorded')), 'utf8')) : [
  { id: 'choice-stable-method', text: corpus.find(c => c.id === 'short-03').text,
    userGoal: '能判断多级稳定排序的执行顺序。请明确使用一道三选一选择题，只考执行方法，不计算自拟列表的排序结果。' },
  { id: 'choice-exact-threshold', text: '本教学情境规定：借阅积分至少为10才可借书；恰好10分符合条件，少于10分不符合。',
    userGoal: '能判断借阅资格。请使用一道三选一选择题，比较9、10、11分三个数，要求选出完整的符合者名单。' },
  { id: 'nonmutating-default-list', text: 'Python默认参数值在函数定义时求值一次。lst.append(x)会修改原列表；lst + [x]返回一个新列表，不修改原列表。定义def f(x, lst=[]): return lst + [x]后，在不显式传入lst时，连续调用f(1)与f(2)分别返回[1]和[2]，默认列表没有被修改。',
    userGoal: '能区分修改默认列表与返回一个新列表。' },
  ...[1, 2].map(n => ({ id: 'cache-repeat-' + n, text: corpus.find(c => c.id === 'short-01').text, userGoal: '能区分缓存新鲜度和内容是否改变' })),
  { id: 'image-with-caption', imagePath: corpus.find(c => c.id === 'image-02').imagePath,
    text: '本教学示意图的补充图注：reserved表示预留锁。此时Disk列的蓝色页面仍保留原数据，没有被修改。仅按这段图注和可见标签识别状态，不从颜色推导其他机制。',
    userGoal: '能识别预留锁及仍保留原数据的磁盘区域。' },
  { id: 'image-without-caption', imagePath: corpus.find(c => c.id === 'image-02').imagePath, text: '',
    userGoal: '能识别预留锁及仍保留原数据的磁盘区域。' }
];
const report = { promptVersion: task.version, model: config.model, thinkingPolicy: 'non-thinking-v1',
  startedAt: new Date().toISOString(), budget: { maxRequests: 40, maxTokens: 100000, requests: 0, tokens: 0, missingUsage: 0 }, requests: [], cases: [] };
const checkpoint = () => writeFile(join(out, 'results.json'), JSON.stringify(report, (_key, value) => typeof value === 'string' ? value.replaceAll(config.apiKey, '[REDACTED]') : value, 2) + '\n');
const real = provider.createProviderTransport({ timeoutMs: 60000 });
let caseId;
const transport = { complete: async (settings, request) => {
  if (report.budget.requests >= report.budget.maxRequests || report.budget.tokens >= report.budget.maxTokens) throw Object.assign(new Error('验收预算已用尽'), { code: 'ACCEPTANCE_BUDGET_REACHED' });
  const body = request.messages.at(-1).content;
  const payload = JSON.parse(Array.isArray(body) ? body.find(part => part.type === 'text').text : body);
  const trace = { caseId, operation: payload.operation };
  report.requests.push(trace); report.budget.requests += 1;
  await checkpoint();
  try {
    const result = await real.complete(settings, request);
    trace.response = result.content; trace.usage = result.provider.usage || null; trace.finishReason = result.finishReason;
    if (Number.isFinite(trace.usage?.totalTokens)) report.budget.tokens += trace.usage.totalTokens;
    else report.budget.missingUsage += 1;
    return result;
  } catch (error) { trace.error = error.code || 'REQUEST_FAILED'; throw error; }
  finally { await checkpoint(); }
} };
const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
for (const sample of cases) {
  caseId = sample.id;
  if (sample.candidate && sample.context) {
    const reviewed = await service.run(sample.context, sample.candidate, 'review');
    const output = await service.run(sample.context);
    report.cases.push({ ...sample, reviewed, output });
    await checkpoint();
    process.stdout.write(`${caseId}: review=${reviewed.status}; regenerated=${output.status}; requests=${report.budget.requests}; tokens=${report.budget.tokens}\n`);
    continue;
  }
  const context = { userGoal: sample.userGoal, materialLength: sample.text.length, evidence: [] };
  if (sample.text) context.evidence.push({ id: 'material', kind: 'text', text: sample.text });
  if (sample.imagePath) {
    const data = await readFile(resolve('extension/evals/card-quality', sample.imagePath));
    context.image = { dataUrl: 'data:image/gif;base64,' + data.toString('base64') };
    context.evidence.push({ id: 'image', kind: 'image' });
  }
  const output = await service.run(context);
  report.cases.push({ ...sample, output });
  await checkpoint();
  process.stdout.write(`${caseId}: ${output.status}; requests=${report.budget.requests}; tokens=${report.budget.tokens}\n`);
}
report.finishedAt = new Date().toISOString();
await checkpoint();
