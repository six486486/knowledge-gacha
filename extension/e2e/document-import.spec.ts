import { test, expect, chromium, type Page } from '@playwright/test';
import path from 'node:path';
import { readTestDatabase } from './database';
import { artifactPath } from './artifacts';

const fixtures = path.resolve(__dirname, '../tests/fixtures/documents');
async function setup(page: Page, id: string) {
  await page.addInitScript(id => {
    if (sessionStorage.getItem('import_test_seed') === id) return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', id);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', reducedMotion: true }));
    sessionStorage.setItem('kg_web_api_key', 'fixture-only');
    sessionStorage.setItem('import_test_seed', id);
  }, id);
  const requests: any[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('8790/v1/chat/completions')) requests.push(request.postDataJSON());
  });
  await page.goto('/');
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  return requests;
}
async function openFile(page: Page, name: string) {
  await page.locator('#source-file-input').setInputFiles(path.join(fixtures, name));
  await expect(page.getByRole('heading', { name: '解析预览与范围选择' })).toBeVisible();
}
async function parse(page: Page, range: string) {
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill(range);
  await page.locator('#import-parse').click();
  await expect(page.locator('#import-use')).toBeEnabled();
}

test('第四步：中文 PDF 目录、选页、本地解析与未选范围隔离', async ({ page }) => {
  test.setTimeout(40000);
  const requests = await setup(page, 'profile_step04_pdf');
  await openFile(page, 'chinese.pdf');
  await expect(page.locator('.import-count')).toContainText('共 3 页');
  expect(requests).toHaveLength(0);
  await parse(page, '1-2');
  await expect(page.locator('.import-page')).toHaveCount(2);
  await expect(page.locator('.import-page').first()).toContainText('边际成本');
  await expect(page.locator('.import-page').first()).toContainText('已略去重复页眉');
  await page.locator('[data-import-page="2"]').uncheck();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: artifactPath('test-results/step04-pdf-320.png'), fullPage: true });
  await page.locator('#import-use').click();
  await expect(page.locator('#feed-text')).toHaveValue(/边际成本/);
  await expect(page.locator('#feed-text')).not.toHaveValue(/缓存|EXCLUDED_RANGE_TOKEN/);
  await page.locator('#import-retention').selectOption('original');
  await page.locator('#generate-card').click();
  await expect(page.getByRole('heading', { name: '知识扭蛋已出仓' })).toBeVisible();
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.locator('#draft-confirm')).toBeVisible({ timeout: 15000 });
  await page.locator('#draft-confirm').click();
  await page.locator('.card-sources > summary').click();
  await expect(page.getByRole('button', { name: '查看依据', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看依据', exact: true }).click();
  await expect(page.locator('.citation-locator')).toContainText('PDF 第 1 页');
  await page.locator('#citation-original').click();
  await expect(page.locator('.import-original-image')).toBeVisible();
  await expect(page.locator('.original-region')).toBeVisible();
  await page.screenshot({ path: artifactPath('test-results/step04-original-320.png'), fullPage: true });
  const db = await readTestDatabase(page, 'profile_step04_pdf');
  expect(db.documents).toHaveLength(1);
  expect(db.documents[0].originalAssetId).toBeTruthy();
  expect(db.documents[0].content).not.toMatch(/缓存|EXCLUDED_RANGE_TOKEN/);
  expect(db.learningState.cards[0].citations[0].position.locator.format).toBe('pdf');
  expect(JSON.stringify(requests)).not.toContain('EXCLUDED_RANGE_TOKEN');
  expect(JSON.stringify(requests)).not.toContain('缓存有效期');
  await page.locator('#original-reuse').click();
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await parse(page, '2');
  await expect(page.locator('.import-page')).toContainText('缓存策略');
  await page.locator('#import-discard').click();
  const retained = await readTestDatabase(page, 'profile_step04_pdf');
  expect(retained.documents[0].originalAssetId).toBe(db.documents[0].originalAssetId);
});

test('第四步：双栏 PDF 顺序、标题列表表格 DOCX 与纯文字预览', async ({ page }) => {
  test.setTimeout(40000);
  await setup(page, 'profile_step04_structure');
  await openFile(page, 'two-column.pdf');
  await parse(page, '1');
  await expect(page.locator('.import-page')).toContainText('按左右两栏读取');
  await page.locator('[data-preview-page="1"]').click();
  const text = await page.locator('#import-correction').inputValue();
  expect(text.indexOf('左栏结束')).toBeLessThan(text.indexOf('右栏开始'));
  await page.locator('#import-preview-close').click();
  await page.locator('#import-discard').click();
  await openFile(page, 'headings-lists-table.docx');
  await expect(page.locator('#import-use')).toBeEnabled();
  await expect(page.locator('.import-count')).toContainText('1 个表格');
  await expect(page.locator('.import-chapters')).toContainText('缓存策略');
  await page.locator('#import-chapter-preview').selectOption('2');
  await expect(page.locator('.import-blocks')).toContainText('<script>window.DOCX_INJECTION');
  expect(await page.evaluate(() => (window as any).DOCX_INJECTION)).toBeUndefined();
  await page.locator('#import-select-none').click();
  await page.locator('[data-import-chapter="1"]').check();
  await page.locator('#import-chapter-preview').selectOption('1');
  await expect(page.locator('.import-blocks')).toContainText('表 1 · 行 2 列 2');
  await page.setViewportSize({ width: 480, height: 900 });
  await page.screenshot({ path: artifactPath('test-results/step04-docx-480.png'), fullPage: true });
  await page.locator('#import-use').click();
  await expect(page.locator('#feed-text')).toHaveValue(/缓存有效期/);
  await expect(page.locator('#feed-text')).not.toHaveValue(/EXCLUDED_RANGE_TOKEN/);
  expect(await page.evaluate(() => (window as any).DOCX_INJECTION)).toBeUndefined();
});

test('第四步：混合 PDF 扫描页识别、确认校对与导入草稿恢复', async ({ page }) => {
  test.setTimeout(45000);
  const requests = await setup(page, 'profile_step04_scan');
  await openFile(page, 'mixed.pdf');
  await parse(page, '1-2');
  await expect(page.locator('.import-page').nth(1)).toContainText('待识别或补充文字');
  await page.locator('#import-use').click();
  await expect(page.locator('#toast')).toContainText('未解析、失败或无可用文字');
  expect(requests).toHaveLength(0);
  await page.locator('#import-ocr').click();
  await expect(page.locator('#modal-content')).toContainText('第 2 页');
  await page.locator('#ocr-confirm').click();
  await expect(page.locator('.import-page').nth(1)).toContainText('等待确认文字');
  await page.locator('[data-preview-page="2"]').click();
  await page.locator('#import-show-page').click();
  await expect(page.locator('.import-original-image')).toBeVisible();
  await page.locator('#import-correction').fill('每多生产一个单位额外增加的成本，称为边际成本。校对：新增收入 10 元，原料支出 6 元。');
  await page.locator('#import-correct').click();
  await expect(page.locator('.import-page').nth(1)).toContainText('识别文字已确认');
  await page.locator('#import-later').click();
  await expect(page.getByLabel('导入草稿')).toContainText('mixed.pdf');
  await page.reload();
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  await page.locator('[data-resume-import]').click();
  await expect(page.locator('.import-page').nth(1)).toContainText('校对：新增收入');
  await page.locator('[data-import-page="1"]').uncheck();
  await page.locator('#import-use').click();
  await expect(page.locator('#feed-text')).toHaveValue(/校对：新增收入/);
  const ocr = requests.filter(body => body.messages[0].content.includes('文档逐页识别器'));
  expect(ocr).toHaveLength(1);
  expect(JSON.parse(ocr[0].messages[1].content[0].text).pageNumber).toBe(2);
  expect(ocr[0].messages[1].content.filter((part: any) => part.type === 'image_url')).toHaveLength(1);
});

test('第四步：加密、损坏与 DOCX 解压预算提示明确，放弃清理临时文件', async ({ page }) => {
  test.setTimeout(40000);
  await setup(page, 'profile_step04_invalid');
  for (const [name, message] of [['encrypted.pdf', '已加密'], ['corrupt.pdf', '损坏'], ['corrupt.docx', '损坏'], ['oversized-entry.docx', '解压规模'], ['forged-entry.docx', '解压大小与目录不符']]) {
    await openFile(page, name);
    await expect(page.locator('.import-panel [role=alert]')).toContainText(message);
    await page.locator('#import-discard').click();
  }
  const counts = await page.evaluate(async () => {
    const repository = (window as any).KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: 'profile_step04_invalid' });
    const result = [(await repository.list('assets')).length, (await repository.list('imports')).length]; await repository.close(); return result;
  });
  expect(counts).toEqual([0, 0]);
});

test('第四步：DOCX 单元格引用保留位置，多章节直接进入第三步清单', async ({ page }) => {
  test.setTimeout(40000);
  await setup(page, 'profile_step04_docx_citation');
  await openFile(page, 'headings-lists-table.docx');
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('#import-select-none').click();
  await page.locator('#import-chapter-preview').selectOption('1');
  await page.locator('[data-import-block="docx_p10"]').check();
  await page.locator('[data-import-block="docx_p12"]').check();
  await page.locator('#import-use').click();
  await page.locator('#import-retention').selectOption('text');
  await page.locator('#generate-card').click();
  await expect(page.getByRole('heading', { name: '知识扭蛋已出仓' })).toBeVisible();
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('#draft-confirm').click();
  await page.locator('.card-sources > summary').click();
  await page.getByRole('button', { name: '查看依据', exact: true }).click();
  await expect(page.locator('.citation-locator')).toContainText('表 1 · 行 2 列 2 · 段 10');
  await expect(page.locator('#citation-original')).toHaveCount(0);
  const db = await readTestDatabase(page, 'profile_step04_docx_citation');
  expect(db.learningState.cards[0].citations[0].source.type).toBe('docx');
  expect(db.learningState.cards[0].citations[0].position.pageNumber).toBeNull();
  await page.locator('#citation-close').click();
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  await openFile(page, 'headings-lists-table.docx');
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('[data-import-chapter="2"]').uncheck();
  await page.locator('#import-use').click();
  await expect(page.locator('#generate-card')).toHaveText('整理学习清单');
  await page.locator('#generate-card').click();
  await expect(page.locator('.knowledge-unit')).toHaveCount(2);
  await expect(page.locator('#generate-plan')).toBeEnabled();
  const plans = (await readTestDatabase(page, 'profile_step04_docx_citation')).knowledgePlans;
  expect(plans[0].analyses.every((analysis: any) => analysis.status === 'completed')).toBe(true);
  await page.locator('#discard-plan').click();
  await expect(page.getByRole('heading', { name: '捕获值得记住的内容' })).toBeVisible();
  const after = await readTestDatabase(page, 'profile_step04_docx_citation');
  expect(after.knowledgePlans).toHaveLength(0);
  expect(after.materials).toHaveLength(0);
  expect(after.learningState.cards).toHaveLength(1);
  expect(after.documents).toHaveLength(1);
});

test('第四步：真实 MV3 扩展从包内加载 PDF 和 DOCX 解析器', async () => {
  test.setTimeout(45000);
  const extensionPath = path.resolve(__dirname, '..');
  const context = await chromium.launchPersistentContext('', { channel: 'msedge', headless: true, viewport: { width: 480, height: 900 },
    args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const panel = await context.newPage();
    const errors: string[] = [];
    panel.on('pageerror', error => errors.push(error.message));
    const external: string[] = [];
    context.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    await panel.goto('chrome-extension://' + new URL(worker.url()).host + '/index.html');
    await panel.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
    await openFile(panel, 'chinese.pdf');
    await parse(panel, '1');
    await panel.locator('[data-preview-page="1"]').click();
    await panel.locator('#import-show-page').click();
    await expect(panel.locator('.import-original-image')).toBeVisible();
    await panel.locator('#import-preview-close').click();
    await panel.locator('#import-discard').click();
    await openFile(panel, 'headings-lists-table.docx');
    await expect(panel.locator('.import-count')).toContainText('1 个表格');
    await panel.locator('#import-discard').click();
    await openFile(panel, 'scanned.pdf');
    await parse(panel, '1');
    await expect(panel.locator('.import-page')).toContainText('待识别或补充文字');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally { await context.close(); }
});
