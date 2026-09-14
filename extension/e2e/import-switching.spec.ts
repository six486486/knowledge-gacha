import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PROFILE = 'profile_import_switching';
async function feed(page: Page) { await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click(); }
async function setup(page: Page) {
  await page.addInitScript(profile => {
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ reducedMotion: true }));
  }, PROFILE);
  await page.goto('/');
  await feed(page);
}
async function upload(page: Page, name: string) {
  await page.locator('#source-file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: readFileSync(path.resolve(__dirname, '../tests/fixtures/documents/mixed.pdf')) });
}
async function saved(page: Page, name: string) {
  await upload(page, name);
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill('1');
  await page.locator('#import-parse').click();
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('#import-later').click();
  const row = page.locator('.source-document').filter({ has: page.getByText(name, { exact: true }) });
  await expect(row.locator('[data-resume-import]')).toBeVisible();
  return (await row.locator('[data-resume-import]').getAttribute('data-resume-import'))!;
}

test('切换已保存导入后释放旧材料占用，另一窗口可接续且两份进度都保留', async ({ page, context }) => {
  await setup(page);
  const a = await saved(page, '材料甲.pdf');
  const b = await saved(page, '材料乙.pdf');
  await page.locator(`[data-resume-import="${a}"]`).click();
  await expect(page.locator('.import-panel h2')).toHaveText('材料甲.pdf');
  await feed(page);
  await page.locator(`[data-resume-import="${b}"]`).click();
  await expect(page.locator('.import-panel h2')).toHaveText('材料乙.pdf');
  const other = await context.newPage();
  await other.goto('/'); await feed(other);
  await other.locator(`[data-resume-import="${a}"]`).click();
  await expect(other.locator('.import-panel h2')).toHaveText('材料甲.pdf');
  await expect(other.locator('#import-use')).toBeEnabled();
  await other.locator('#import-later').click();
  await page.locator('#import-later').click();
  await expect(page.locator('[data-resume-import]')).toHaveCount(2);
  await other.close();
});

test('当前导入还在处理时不能切换到另一份，迟到结果不会替换新材料', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
      delete w.KnowledgeGachaExtensionService; w.KnowledgeGachaExtensionService = module;
      const create = module.createExtensionService;
      module.createExtensionService = (...args: any[]) => {
        const service = create(...args), original = service.importDocumentFile;
        service.importDocumentFile = async (file: File, ...options: any[]) => {
          const result = await original(file, ...options);
          if (file.name === '正在处理.pdf') {
            w.importResultWaiting = true;
            await new Promise<void>(resolve => { w.releaseImportResult = resolve; });
          }
          return result;
        };
        return service;
      };
    } });
  });
  await setup(page);
  const id = await saved(page, '已保存材料.pdf');
  await upload(page, '正在处理.pdf');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).importResultWaiting))).toBe(true);
  await feed(page);
  await page.locator(`[data-resume-import="${id}"]`).click();
  await expect(page.locator('#toast')).toContainText('请先暂停');
  await expect(page.locator('.import-panel')).toHaveCount(0);
  await page.evaluate(async () => { (window as any).releaseImportResult(); await new Promise(requestAnimationFrame); });
  await page.locator(`[data-resume-import="${id}"]`).click();
  await expect(page.locator('.import-panel h2')).toHaveText('已保存材料.pdf');
  await page.locator('#import-later').click();
  await expect(page.locator('[data-resume-import]')).toHaveCount(2);
});

test('放弃后旧导入迟到返回，不覆盖随后打开的新文件或解除其忙碌状态', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.releaseImportResults = {};
    Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
      delete w.KnowledgeGachaExtensionService; w.KnowledgeGachaExtensionService = module;
      const create = module.createExtensionService;
      module.createExtensionService = (...args: any[]) => {
        const service = create(...args), original = service.importDocumentFile;
        service.importDocumentFile = async (file: File, ...options: any[]) => {
          const result = await original(file, ...options);
          await new Promise<void>(resolve => { w.releaseImportResults[file.name] = resolve; });
          return result;
        };
        return service;
      };
    } });
  });
  await setup(page);
  await upload(page, '延迟甲.pdf');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).releaseImportResults['延迟甲.pdf']))).toBe(true);
  await page.locator('#import-discard').click();
  await expect(page.locator('#source-file-input')).toBeAttached();
  await upload(page, '延迟乙.pdf');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).releaseImportResults['延迟乙.pdf']))).toBe(true);
  await page.evaluate(async () => { (window as any).releaseImportResults['延迟甲.pdf'](); await new Promise(requestAnimationFrame); });
  await expect(page.locator('.import-panel h2')).toHaveText('延迟乙.pdf');
  await expect(page.locator('#import-use')).toBeDisabled();
  await expect(page.locator('#import-pause')).toBeVisible();
  await page.evaluate(async () => { (window as any).releaseImportResults['延迟乙.pdf'](); await new Promise(requestAnimationFrame); });
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill('1');
  await page.locator('#import-parse').click();
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('#import-later').click();
  await expect(page.locator('[data-resume-import]')).toHaveCount(1);
  await expect(page.locator('.source-document strong')).toHaveText('延迟乙.pdf');
});

test('暂停的迟到响应不能把已切换的材料改回旧文件', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
      delete w.KnowledgeGachaExtensionService; w.KnowledgeGachaExtensionService = module;
      const create = module.createExtensionService;
      module.createExtensionService = (...args: any[]) => {
        const service = create(...args), parse = service.parseImportedPages, pause = service.cancelDocumentImport;
        service.parseImportedPages = async (...input: any[]) => {
          const result = await parse(...input);
          await new Promise<void>(resolve => { w.releaseParseResult = resolve; });
          return result;
        };
        service.cancelDocumentImport = async (...input: any[]) => {
          const result = await pause(...input);
          await new Promise<void>(resolve => { w.releasePauseResult = resolve; });
          return result;
        };
        return service;
      };
    } });
  });
  await setup(page);
  await upload(page, '暂停前的材料.pdf');
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill('1');
  await page.locator('#import-parse').click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).releaseParseResult))).toBe(true);
  await page.locator('#import-pause').click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).releasePauseResult))).toBe(true);
  await page.evaluate(async () => { (window as any).releaseParseResult(); await new Promise(requestAnimationFrame); });
  await expect(page.locator('#import-later')).toBeVisible();
  await page.locator('#import-later').click();
  await expect(page.locator('#source-file-input')).toBeAttached();
  await upload(page, '随后打开的材料.pdf');
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.evaluate(async () => { (window as any).releasePauseResult(); await new Promise(requestAnimationFrame); });
  await expect(page.locator('.import-panel h2')).toHaveText('随后打开的材料.pdf');
  await page.locator('#import-discard').click();
  await expect(page.locator('.source-document strong')).toHaveText('暂停前的材料.pdf');
});

test('放弃后迟到的范围选择不能把已删除原文填入制卡页，重新导入仍可正常使用', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
      delete w.KnowledgeGachaExtensionService; w.KnowledgeGachaExtensionService = module;
      const create = module.createExtensionService;
      module.createExtensionService = (...args: any[]) => {
        const service = create(...args), select = service.selectDocumentImport;
        let first = true;
        service.selectDocumentImport = async (...input: any[]) => {
          const result = await select(...input);
          if (first) { first = false; await new Promise<void>(resolve => { w.releaseSelectionResult = resolve; }); }
          return result;
        };
        return service;
      };
    } });
  });
  await setup(page);
  await upload(page, '即将放弃.pdf');
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill('1');
  await page.locator('#import-parse').click();
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('#import-use').click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).releaseSelectionResult))).toBe(true);
  await page.locator('#import-discard').click();
  await expect(page.locator('#source-file-input')).toBeAttached();
  await page.evaluate(async () => { (window as any).releaseSelectionResult(); await new Promise(requestAnimationFrame); });
  await expect.poll(async () => await page.locator('#feed-text').count() ? page.locator('#feed-text').inputValue() : '').toBe('');
  await expect(page.locator('#back-to-import')).toHaveCount(0);
  await upload(page, '重新导入.pdf');
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill('1');
  await page.locator('#import-parse').click();
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('#import-use').click();
  await expect(page.locator('#feed-text')).toHaveValue(/边际成本/);
});
