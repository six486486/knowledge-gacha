import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const PROFILE = 'profile_import_lifecycle_browser';
const fixture = path.resolve(__dirname, '../tests/fixtures/documents/mixed.pdf');

async function feed(page: Page) {
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
}

test('一页正在预览的导入不能被另一页放弃，保存释放后可以正常删除', async ({ page, context }) => {
  await page.addInitScript(profile => {
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ reducedMotion: true }));
  }, PROFILE);
  await page.goto('/');
  await feed(page);
  await page.locator('#source-file-input').setInputFiles(fixture);
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill('1');
  await page.locator('#import-parse').click();
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('#import-later').click();
  const resume = page.locator('[data-resume-import]');
  await expect(resume).toHaveCount(1);
  const id = await resume.getAttribute('data-resume-import');
  const other = await context.newPage();
  await other.goto('/');
  await feed(other);
  const discard = other.locator(`[data-discard-import="${id}"]`);
  await expect(discard).toBeVisible();
  await resume.click();
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await discard.click();
  await expect(other.locator('#toast')).toContainText('其他窗口');
  await expect(discard).toBeVisible();
  await page.locator('#import-page-range').fill('1-2');
  await page.locator('#import-parse').click();
  await expect(page.locator('.import-page')).toHaveCount(2);
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('#import-later').click();
  await expect(page.locator('[data-resume-import]')).toHaveCount(1);
  await discard.click();
  await expect(other.locator('[data-discard-import]')).toHaveCount(0);
  const remaining = await other.evaluate(async profile => {
    const repository = (window as any).KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: profile });
    try { return { imports: (await repository.list('imports')).length, assets: (await repository.list('assets')).length }; }
    finally { await repository.close(); }
  }, PROFILE);
  expect(remaining).toEqual({ imports: 0, assets: 0 });
  await other.close();
});
