import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { artifactPath } from './artifacts';
import { readTestDatabase } from './database';

const screenshots = artifactPath('test-results/2026-09-14-ui-refinement');
mkdirSync(screenshots, { recursive: true });

async function open(page: Page, profile: string) {
  await page.addInitScript(profile => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini' }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-fixture');
  }, profile);
  await page.goto('/');
}

test('伴学在短窄屏保留阅读区和发送入口，设置浮层保留草稿并支持 Escape', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 520 });
  await open(page, 'profile_ui_refinement_chat');
  await page.getByRole('navigation').getByRole('button', { name: '伴学', exact: true }).click();
  await expect(page.getByText('从一个好奇开始。')).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, 'chat-empty-320x520.png') });
  await page.locator('#companion-input').fill('比较栈和队列');
  await page.locator('#companion-send').click();
  await expect(page.locator('.companion-markdown table')).toBeVisible();
  for (const size of [{ width: 320, height: 520 }, { width: 480, height: 900 }]) {
    await page.setViewportSize(size);
    const composer = await page.locator('.companion-composer').boundingBox();
    const messages = await page.locator('.companion-messages').boundingBox();
    const send = await page.locator('#companion-send').boundingBox();
    const nav = await page.locator('.nav-dock').boundingBox();
    expect(messages!.height).toBeGreaterThan(100);
    expect(messages!.y + messages!.height).toBeLessThanOrEqual(composer!.y);
    expect(send!.y + send!.height).toBeLessThan(nav!.y);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await page.screenshot({ path: resolve(screenshots, `chat-${size.width}x${size.height}.png`) });
  }
  await page.setViewportSize({ width: 320, height: 520 });
  await page.locator('.companion-settings > summary').click();
  await page.locator('#companion-discussion-preference').fill('这次多用类比');
  await page.getByLabel('参考学习记录', { exact: true }).uncheck();
  await expect(page.locator('#companion-discussion-preference')).toHaveValue('这次多用类比');
  await page.locator('#companion-discussion-preference').press('Escape');
  await expect(page.locator('.companion-settings')).not.toHaveAttribute('open');
  await expect(page.locator('.companion-settings > summary')).toBeFocused();
  await page.locator('#companion-input').fill('保留未发送内容\n'.repeat(14));
  expect((await page.locator('#companion-input').boundingBox())!.height).toBeLessThanOrEqual(132);
  await page.getByLabel('教学方式').selectOption('explain');
  await expect(page.locator('#companion-input')).toHaveValue('保留未发送内容\n'.repeat(14));
  expect(errors).toEqual([]);
});

test('添加学习偏好支持预设编辑和明确范围，取消不写入，保存失败可重试且不重复', async ({ page }) => {
  const profile = 'profile_ui_refinement_preferences';
  await page.setViewportSize({ width: 320, height: 900 });
  await open(page, profile);
  await page.getByRole('button', { name: '更多与设置' }).click();
  await page.getByRole('button', { name: /我的学习偏好/ }).click();
  await page.getByRole('button', { name: '添加学习偏好', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存偏好', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '先举例，再解释', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '你的偏好' })).toHaveValue('先给一个具体例子，再解释概念和原理。');
  await page.getByRole('textbox', { name: '你的偏好' }).fill('先举例，再解释；一次只讲一个重点。');
  await page.getByRole('radio', { name: '指定主题', exact: true }).check();
  await expect(page.getByRole('button', { name: '保存偏好', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '主题名称' }).fill('摄影');
  await expect(page.locator('#preference-preview')).toContainText('主题「摄影」');
  await page.screenshot({ path: resolve(screenshots, 'preference-create-320.png'), fullPage: true });
  await page.getByRole('radio', { name: '所有主题', exact: true }).check();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.locator('#modal')).not.toHaveClass(/is-open/);
  let db = await readTestDatabase(page, profile);
  expect(db.preferences).toHaveLength(1);
  expect(db.preferences[0].scope.type).toBe('global');
  expect(db.preferences[0].value).toBe('先举例，再解释；一次只讲一个重点。'.normalize('NFKC'));
  const originalPreferenceId = db.preferences[0].id;
  await page.getByRole('button', { name: '添加学习偏好', exact: true }).click();
  await page.getByRole('radio', { name: /内容难度/ }).check();
  await page.getByLabel('难度', { exact: true }).selectOption('advanced');
  await page.getByRole('radio', { name: '指定主题', exact: true }).check();
  await page.getByRole('textbox', { name: '主题名称' }).fill('摄影');
  await page.screenshot({ path: resolve(screenshots, 'preference-difficulty-320.png'), fullPage: true });
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.locator('#modal')).not.toHaveClass(/is-open/);
  db = await readTestDatabase(page, profile);
  expect(db.preferences).toHaveLength(2);
  expect(db.preferences.find((item: any) => item.category === 'difficulty_preference')).toMatchObject({ value: 'advanced', topicLabel: '摄影', scope: { type: 'topic' } });
  await page.getByRole('button', { name: '添加学习偏好', exact: true }).click();
  await page.getByRole('button', { name: '分步骤讲', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await readTestDatabase(page, profile)).preferences).toHaveLength(2);
  await page.getByRole('button', { name: '添加学习偏好', exact: true }).click();
  await page.getByRole('button', { name: '简短直接', exact: true }).click();
  await page.evaluate(profile => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'state' && key === profile + ':current' && value.preferences?.some((item: any) => item.category === 'learning_format' && item.value.startsWith('先说重点'))) {
        IDBObjectStore.prototype.put = put;
        throw new Error('偏好写入失败测试');
      }
      return put.call(this, value, key);
    };
  }, profile);
  await expect(page.locator('#preference-existing')).toContainText('这个范围已有设置');
  await page.getByRole('button', { name: '更新偏好', exact: true }).click();
  await expect(page.locator('#preference-create-error')).toContainText('偏好写入失败测试');
  await expect(page.getByRole('textbox', { name: '你的偏好' })).toHaveValue('先说重点，用简短清楚的语言讲解。');
  expect((await readTestDatabase(page, profile)).preferences).toHaveLength(2);
  await page.getByRole('button', { name: '更新偏好', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.locator('#modal')).not.toHaveClass(/is-open/);
  db = await readTestDatabase(page, profile);
  expect(db.preferences).toHaveLength(2);
  expect(db.preferences.find((item: any) => item.category === 'learning_format')).toMatchObject({ id: originalPreferenceId, value: '先说重点,用简短清楚的语言讲解。' });
});

test('更多取消高级功能中间页，诊断默认折叠且无记录时不展示历史连接', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await open(page, 'profile_ui_refinement_diagnostics');
  await page.getByRole('button', { name: '更多与设置' }).click();
  await expect(page.getByRole('button', { name: /高级功能/ })).toHaveCount(0);
  await expect(page.locator('#open-observability')).not.toBeVisible();
  await expect(page.getByText('更多功能', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: resolve(screenshots, 'more-320.png'), fullPage: true });
  await page.locator('.more-help > summary').click();
  await page.locator('#open-observability').click();
  await expect(page.getByRole('heading', { name: '运行记录', exact: true })).toBeVisible();
  await expect(page.getByText('当前范围暂无运行数据', { exact: true })).toBeVisible();
  await expect(page.locator('.legacy-connection-records')).toHaveCount(0);
  await page.getByRole('button', { name: '返回更多', exact: true }).click();
  await expect(page.getByRole('button', { name: /我的学习偏好/ })).toBeVisible();
});

test('运行记录显示伴学任务名称，并可按当前教学能力和来源筛选', async ({ page }) => {
  await open(page, 'profile_ui_refinement_run');
  await page.getByRole('navigation').getByRole('button', { name: '伴学', exact: true }).click();
  await page.locator('#companion-input').fill('比较栈和队列');
  await page.locator('#companion-send').click();
  await expect(page.locator('.companion-message.is-assistant')).toHaveCount(1);
  await page.getByRole('button', { name: '更多与设置' }).click();
  await page.locator('.more-help > summary').click();
  await page.locator('#open-observability').click();
  await page.getByRole('combobox', { name: '任务类型', exact: true }).selectOption('companion-compare');
  await page.getByRole('combobox', { name: '来源', exact: true }).selectOption('extension_harness');
  await expect(page.locator('.observability-run-card')).toHaveCount(1);
  await expect(page.locator('.observability-run-card')).toContainText('伴学比较');
  await page.getByRole('combobox', { name: '任务类型', exact: true }).selectOption('companion-practice');
  await expect(page.locator('.observability-run-card')).toHaveCount(0);
});
