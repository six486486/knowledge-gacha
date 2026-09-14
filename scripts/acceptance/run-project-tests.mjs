import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
export function buildStages(output, unitFiles) {
  return [
    { id: 'docs', args: ['scripts/validate-docs.mjs'] },
    { id: 'skills', args: ['extension/tooling/build-skills.mjs', '--check'] },
    { id: 'syntax', args: ['extension/tooling/check-source.mjs'] },
    { id: 'unit-integration', args: ['--test', ...unitFiles] },
    { id: 'release-contracts', args: ['--test', 'scripts/release/tests/provider-compatibility.test.mjs', 'scripts/release/tests/extension-browser-smoke.test.mjs', 'scripts/release/tests/public-package.test.mjs'] },
    { id: 'browser-journeys', args: ['extension/e2e/run-e2e.mjs'] },
    { id: 'edge-extension', args: ['scripts/release/extension-browser-smoke.mjs', '--json'] },
    { id: 'lexical-retrieval', args: ['extension/evals/rag/run.mjs', '--out', join(output, 'rag.json')] },
    { id: 'semantic-retrieval', args: ['extension/evals/rag/run-semantic.mjs', '--holdout', '--out', join(output, 'semantic.json')] },
    { id: 'discovery-ranking', args: ['extension/evals/discovery/run.mjs', '--out', join(output, 'discovery.json')] }
  ];
}
async function runStage(stage, output) {
  const started = Date.now(), log = await open(join(output, stage.id + '.log'), 'wx');
  console.log('开始：' + stage.id);
  try {
    const exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, stage.args, { cwd: root, env: { ...process.env, KG_TEST_REPORT_DIR: join(output, 'e2e') }, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
      child.on('error', reject);
      child.on('exit', code => done(code ?? 1));
    });
    const text = await readFile(join(output, stage.id + '.log'), 'utf8');
    const counts = {};
    for (const key of ['tests', 'pass', 'fail', 'skipped']) { const match = text.match(new RegExp('(?:ℹ|#) ' + key + ' (\\d+)')); if (match) counts[key] = Number(match[1]); }
    console.log(stage.id + '：' + (exitCode === 0 ? '通过' : '失败') + '，' + Math.round((Date.now() - started) / 1000) + ' 秒');
    return { id: stage.id, status: exitCode === 0 ? 'passed' : 'failed', exitCode, durationMs: Date.now() - started, counts, log: stage.id + '.log' };
  } catch (error) { return { id: stage.id, status: 'failed', durationMs: Date.now() - started, error: error.message, log: stage.id + '.log' }; }
  finally { await log.close(); }
}
async function main() {
  const index = process.argv.indexOf('--out');
  if (index >= 0 && !process.argv[index + 1]) throw new Error('--out 需要新目录');
  const output = resolve(index >= 0 ? process.argv[index + 1] : join(root, 'test-results', 'project-' + new Date().toISOString().replace(/[:.]/g, '-')));
  // Never overwrite a previous run or use an existing user-data directory.
  await mkdir(output, { recursive: false });
  const unitFiles = (await readdir(join(root, 'extension/tests'))).filter(name => name.endsWith('.test.js')).sort().map(name => 'extension/tests/' + name);
  const report = { version: 1, startedAt: new Date().toISOString(), scope: 'Engineering and bundled local-model evaluation; no remote provider calls or human learning study', stages: [] };
  for (const stage of buildStages(output, unitFiles)) {
    report.stages.push(await runStage(stage, output));
    await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  }
  try { const e2e = JSON.parse(await readFile(join(output, 'e2e/e2e-results.json'), 'utf8')); report.browserTests = e2e.stats; } catch { /* The failed stage and its log remain visible. */ }
  report.finishedAt = new Date().toISOString();
  report.passed = report.stages.every(stage => stage.status === 'passed');
  report.contentQuality = 'not-certified-by-engineering-tests';
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['# 项目工程验收', '', `执行时间：${report.startedAt}`, '', `工程门禁：${report.passed ? '通过' : '未通过'}`, '',
    '| 阶段 | 结果 | 耗时 | 日志 |', '| --- | --- | --- | --- |',
    ...report.stages.map(stage => `| ${stage.id} | ${stage.status} | ${(stage.durationMs / 1000).toFixed(1)} s | [日志](${stage.log}) |`), '',
    '语义检索和推荐结果见 semantic.json、discovery.json；命令成功不等于内容准确率满分。真实生成、摘要质量和真人学习效果需要单独验收。', ''];
  await writeFile(join(output, 'REPORT.md'), lines.join('\n'));
  console.log('结果：' + join(output, 'REPORT.md'));
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
