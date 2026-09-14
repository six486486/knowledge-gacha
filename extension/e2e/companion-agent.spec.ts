import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readTestDatabase } from './database';
import { artifactPath } from './artifacts';

const screenshots = artifactPath('test-results/2026-09-14-companion-agent');
mkdirSync(screenshots, { recursive: true });

test('自动教学、题目和提示跨重开延续，Markdown 表格和手动指定可用', async ({ page }) => {
  const profile = 'profile_companion_agent_e2e';
  await page.addInitScript(profile => {
    if (sessionStorage.getItem('agent-seeded')) return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', profile); localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini' }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-fixture'); sessionStorage.setItem('agent-seeded', 'true');
  }, profile);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '伴学', exact: true }).click();
  await expect(page.getByLabel('教学方式')).toHaveValue('auto');
  async function ask(text: string, count: number) {
    await page.locator('#companion-input').fill(text); await page.locator('#companion-send').click();
    await expect(page.locator('.companion-message.is-assistant')).toHaveCount(count);
  }
  await ask('比较栈和队列', 1);
  await expect(page.locator('.companion-markdown table')).toBeVisible();
  await expect(page.locator('.companion-markdown strong')).toHaveText('关键区别');
  await expect(page.getByRole('button', { name: '整理成卡片', exact: true })).not.toBeVisible();
  await ask('考考我', 2);
  await expect(page.locator('.companion-task-status')).toContainText('等待你回答');
  let db = await readTestDatabase(page, profile); const questionId = db.companionSessions[0].learningTask.questionId;
  await page.reload();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '伴学', exact: true }).click();
  await ask('给一个提示', 3);
  db = await readTestDatabase(page, profile);
  expect(db.companionSessions[0].learningTask.questionId).toBe(questionId);
  expect(db.companionSessions[0].learningTask.hintLevel).toBe(1);
  expect(db.reviewEvents).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(screenshots, 'practice-320.png'), fullPage: true });
  await ask('答案是2', 4);
  await expect(page.locator('.companion-task-status')).toContainText('本题反馈已完成');
  await page.getByLabel('教学方式').selectOption('compare');
  await ask('比较栈和队列', 5);
  db = await readTestDatabase(page, profile);
  expect(db.companionSessions[0].turn.skillActivations).toBe(0);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.screenshot({ path: resolve(screenshots, 'comparison-480.png'), fullPage: true });
});

test('讨论设置拆分权限，本次偏好不写全局，偏好页按目的分组', async ({ page }) => {
  const profile = 'profile_companion_preferences_e2e';
  await page.addInitScript(profile => {
    if (sessionStorage.getItem('preferences-seeded')) return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', profile); localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini' }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-fixture'); sessionStorage.setItem('preferences-seeded', 'true');
    localStorage.setItem('kg_extension_harness_v1:' + profile, JSON.stringify({ preferences: [
      { id: 'interest', category: 'topic_interest', value: '摄影', topicLabel: '摄影', scope: { type: 'topic', topicId: 'photography' }, enabled: true },
      { id: 'style', category: 'learning_format', value: '优先使用生活例子', scope: { type: 'global' }, enabled: true },
      { id: 'difficulty', category: 'difficulty_preference', value: 'advanced', topicLabel: '摄影', scope: { type: 'topic', topicId: 'photography' }, enabled: true }
    ] }));
  }, profile);
  await page.setViewportSize({ width: 320, height: 900 }); await page.goto('/');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '伴学', exact: true }).click();
  await page.locator('.companion-settings summary').click();
  await page.getByLabel('参考学习记录', { exact: true }).uncheck();
  await expect(page.getByLabel('使用我的偏好', { exact: true })).toBeChecked();
  await page.locator('#companion-discussion-preference').fill('这次用简短的例子');
  await page.getByRole('button', { name: '保存本次偏好', exact: true }).click();
  await expect(page.getByRole('button', { name: '清除', exact: true })).toBeVisible();
  let db = await readTestDatabase(page, profile);
  expect(db.companionSessions[0].discussionPreference).toBe('这次用简短的例子'); expect(db.preferences).toHaveLength(3);
  expect(db.companionSessions[0].usePreferences).toBe(true); expect(db.companionSessions[0].useLearningRecords).toBe(false);
  await page.screenshot({ path: resolve(screenshots, 'discussion-settings-320.png'), fullPage: true });
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await expect(page.locator('#companion-discussion-preference')).toHaveValue('');
  await page.getByRole('button', { name: '更多与设置' }).click();
  await page.getByRole('button', { name: /我的学习偏好/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: '摄影', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '优先使用生活例子' })).toHaveCount(0);
  await page.getByRole('tab', { name: '难度与表达' }).click();
  await expect(page.getByRole('heading', { name: '优先使用生活例子' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '进阶一些' })).toBeVisible();
  await expect(page.locator('.preference-scope').filter({ hasText: '主题「摄影」' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(screenshots, 'preferences-320.png'), fullPage: true });
  await page.getByRole('tab', { name: '学习记录' }).click();
  await expect(page.getByRole('button', { name: '复习结果', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '待确认建议' }).click();
  await expect(page.getByText('现在没有待确认候选。系统推断不会在你不知情时变成长期记忆。')).toBeVisible();
});
