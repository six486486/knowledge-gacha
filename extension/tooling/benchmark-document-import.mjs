import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
const file = path.join(root, 'test-results/import-bench/limit-20mb-101pages.pdf');
const inputBytes = (await stat(file)).size;
assert.ok(inputBytes <= 20 * 1024 * 1024);
const server = spawn(process.execPath, [path.join(root, 'extension/tooling/dev-server.js')], { cwd: root, env: { ...process.env, PORT: '5175' }, windowsHide: true, stdio: 'ignore' });
let browser;
try {
  for (let n = 0; n < 100; n += 1) { try { if ((await fetch('http://127.0.0.1:5175')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('kg_web_profile_id', 'profile_import_benchmark');
    localStorage.setItem('kg_web_migration_v1', 'complete');
    const stats = window.importBenchmark = { gaps: [], longTasks: [], heapPeak: 0, started: performance.now() };
    let last = performance.now();
    setInterval(() => { const now = performance.now(); stats.gaps.push(now - last); last = now; stats.heapPeak = Math.max(stats.heapPeak, performance.memory?.usedJSHeapSize || 0); }, 50);
    new PerformanceObserver(list => { stats.longTasks.push(...list.getEntries().map(entry => entry.duration)); }).observe({ type: 'longtask' });
  });
  await page.goto('http://127.0.0.1:5175/');
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  const started = Date.now();
  await page.locator('#source-file-input').setInputFiles(file);
  await expect(page.locator('#import-page-range')).toBeEnabled({ timeout: 30000 });
  const inspectMs = Date.now() - started;
  await page.locator('#import-page-range').fill('1-101');
  await page.locator('#import-parse').click();
  await expect(page.locator('#toast')).toContainText('每批最多选择 100 页');
  await page.locator('#import-page-range').fill('1-100');
  const parsing = Date.now();
  await page.locator('#import-parse').click();
  await expect(page.locator('.import-page')).toHaveCount(100, { timeout: 90000 });
  await expect(page.locator('#import-use')).toBeEnabled({ timeout: 15000 });
  const parseMs = Date.now() - parsing;
  const result = await page.evaluate(async () => {
    const repo = window.KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: 'profile_import_benchmark' });
    const job = (await repo.list('imports'))[0].value;
    const assets = await repo.list('assets');
    const abort = new AbortController();
    const parser = window.KnowledgeGachaDocumentParser.createDocumentParser();
    const started = performance.now();
    const bytes = await assets[0].value.blob.arrayBuffer();
    const running = parser.run({ operation: 'parse', kind: 'pdf', bytes, pages: [101] }, { signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    let aborted = false;
    try { await running; } catch (error) { aborted = error.name === 'AbortError'; }
    await repo.close();
    return { pageCount: job.pageCount, parsedPages: job.pages.length, failedPages: job.pages.filter(page => page.status === 'failed').length,
      page101Processed: job.pages.some(page => page.pageNumber === 101), parserMetrics: job.parseMetrics,
      pageParseMaxMs: Math.max(...job.pages.map(page => page.metrics?.elapsedMs || 0)), workerCancelled: aborted, workerCancelMs: Math.round(performance.now() - started),
      heartbeatMaxGapMs: Math.round(Math.max(...window.importBenchmark.gaps)), mainHeapPeakBytes: window.importBenchmark.heapPeak,
      longTaskCount: window.importBenchmark.longTasks.length, longestMainTaskMs: Math.round(Math.max(0, ...window.importBenchmark.longTasks)),
      localIndexBytes: new Blob([localStorage.getItem('kg_extension_harness_v1:profile_import_benchmark')]).size };
  });
  let browserProcessPeakWorkingSetBytes = null;
  if (process.platform === 'win32') {
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map(process => Number(process.id)).filter(id => Number.isSafeInteger(id) && id > 0);
    if (ids.length) browserProcessPeakWorkingSetBytes = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process -Id ' + ids.join(',') + ' -ErrorAction SilentlyContinue | Measure-Object -Property PeakWorkingSet64 -Sum).Sum'], { encoding: 'utf8', windowsHide: true }).trim());
    await cdp.detach();
  }
  const report = { recordedAt: new Date().toISOString(), browser: browser.version(), platform: os.platform(), cpu: os.cpus()[0].model,
    totalMemoryBytes: os.totalmem(), inputBytes, inspectMs, parseMs, browserProcessPeakWorkingSetBytes,
    memoryNote: 'Sum of peak working sets for this disposable browser process tree; includes shared pages and is not a simultaneous private-memory measurement. Main heap does not include all worker allocations.', ...result };
  await writeFile(path.join(root, 'test-results/step04-import-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(result.pageCount, 101); assert.equal(result.parsedPages, 100); assert.equal(result.failedPages, 0); assert.equal(result.page101Processed, false); assert.equal(result.workerCancelled, true);
  assert.ok(result.localIndexBytes < 1000000, 'Original document must not be copied into the localStorage index');
  console.log(JSON.stringify(report, null, 2));
} finally { if (browser) await browser.close(); server.kill(); }
