import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readTestDatabase } from './database';
import { artifactPath } from './artifacts';

const report = artifactPath('test-results/2026-09-09-companion');
mkdirSync(report, { recursive: true });
async function open(page: Page, id: string, historyTurns = 0) {
  await page.addInitScript(({ id, historyTurns }) => {
    if (sessionStorage.getItem('companion-test-seeded') === id) return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', id);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini' }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-fixture');
    const companionSessions = historyTurns ? [{ id: 'long-discussion', title: 'Agent 面试讨论', mode: 'explain', useKnowledge: true, useMemory: true,
      createdAt: Date.now(), updatedAt: Date.now(), turn: null, context: null,
      messages: Array.from({ length: historyTurns }, (_, n) => [
        { id: 'u' + n, turnId: 't' + n, role: 'user', content: n === 0 ? '准备 Agent 面试，先举例再定义' : '继续讨论第' + n + '个问题' },
        { id: 'a' + n, turnId: 't' + n, role: 'assistant', status: 'completed', content: '这是第' + n + '条解释', citations: [], actions: [], followUps: [], steps: [] }
      ]).flat() }] : [];
    localStorage.setItem(`kg_extension_harness_v1:${id}`, JSON.stringify({ companionSessions, documents: [{ id: 'doc_cost', title: '边际成本笔记', type: 'text', content: '每多生产一个单位额外增加的成本，称为边际成本。新增一杯咖啡需要六元原料。', createdAt: Date.now() }] }));
    sessionStorage.setItem('companion-test-seeded', id);
  }, { id, historyTurns });
  await page.goto('/');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '伴学', exact: true }).click();
  await expect(page.locator('#companion-input')).toBeVisible();
}
async function ask(page: Page, content: string, count = 1) {
  await page.locator('#companion-input').fill(content);
  await page.locator('#companion-send').click();
  await expect(page.locator('.companion-message.is-assistant')).toHaveCount(count);
}

test('长对话自动整理摘要，原始历史和最新纠正保留，重开复用摘要', async ({ page }) => {
  const requests: any[] = [];
  await page.route('**/v1/chat/completions', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (!body.messages?.[1]?.content.includes('"operation":"compact_companion_context"')) return route.continue();
    const payload = JSON.parse(body.messages[1].content);
    expect(payload.turns).toHaveLength(9);
    expect(payload.turns[0].user.content).toContain('先举例再定义');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: JSON.stringify({
      goal: '准备 Agent 面试', constraints: ['先举例再定义'], corrections: [], conclusions: ['讨论了上下文管理'], openQuestions: [], referenceKeys: []
    }) } }] }) });
  });
  await open(page, 'profile_companion_e2e_compaction', 13);
  await ask(page, '现在纠正为先定义再举例', 14);
  await expect(page.getByText('较早讨论已整理为摘要，原文仍保留在历史中。')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1).content).toBe('现在纠正为先定义再举例');
  expect(requests[1].messages[1].content).toContain('先举例再定义');
  expect(requests[1].messages.filter((m: any) => m.role === 'assistant')).toHaveLength(4);
  await page.reload();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '伴学', exact: true }).click();
  await expect(page.locator('.companion-message')).toHaveCount(28);
  await ask(page, '继续按新的顺序解释', 15);
  expect(requests).toHaveLength(3);
  const db = await readTestDatabase(page, 'profile_companion_e2e_compaction');
  expect(db.companionSessions[0].contextSummary.coveredTurns).toBe(9);
  expect(db.companionSessions[0].messages).toHaveLength(30);
  expect(db.preferences).toHaveLength(0);
  const output = artifactPath('test-results/2026-09-13-companion-context');
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'companion-summary.png'), fullPage: true });
});

test('伴学主入口、窄屏、来源、多步工具、追问与持久化', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  await page.setViewportSize({ width: 320, height: 900 });
  await open(page, 'profile_companion_e2e_sources');
  await page.screenshot({ path: resolve(report, 'companion-empty-320.png'), fullPage: true });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await ask(page, '查找我保存的边际成本资料');
  await expect(page.locator('.companion-reference').first()).toContainText('边际成本笔记');
  await page.locator('.companion-reference summary').first().click();
  await expect(page.locator('.companion-reference blockquote').first()).toContainText('边际成本');
  await page.locator('.companion-steps summary').click();
  await expect(page.locator('.companion-steps')).toContainText('查找相关知识');
  await expect(page.locator('.companion-steps')).toContainText('阅读来源片段');
  const messagesBox = await page.locator('.companion-messages').boundingBox();
  const composerBox = await page.locator('.companion-composer').boundingBox();
  expect(composerBox!.y).toBeGreaterThanOrEqual(messagesBox!.y + messagesBox!.height);
  const sendBox = await page.locator('#companion-send').boundingBox();
  const navBox = await page.locator('.nav-dock').boundingBox();
  expect(sendBox!.y + sendBox!.height).toBeLessThan(navBox!.y);
  await page.screenshot({ path: resolve(report, 'companion-sources-320.png'), fullPage: true });
  await ask(page, '再给一个例子', 2);
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: '伴学', exact: true }).click();
  await expect(page.locator('.companion-message')).toHaveCount(4);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.screenshot({ path: resolve(report, 'companion-conversation-480.png'), fullPage: true });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test('伴学材料确认、制卡质量流程与一次收下', async ({ page }) => {
  await open(page, 'profile_companion_e2e_card');
  await page.getByText('带入一段材料（可选）', { exact: true }).click();
  await page.locator('#companion-material-title').fill('边际成本学习材料');
  await page.locator('#companion-material').fill('多生产一单位的新增成本称为边际成本。');
  await page.locator('#companion-context-save').click();
  await expect(page.locator('.companion-context')).toContainText('边际成本学习材料');
  await ask(page, '讲清楚这段话');
  let db = await readTestDatabase(page, 'profile_companion_e2e_card');
  expect(db.learningState.cards).toHaveLength(0);
  await expect(page.getByRole('button', { name: '整理成卡片', exact: true })).not.toBeVisible();
  await page.locator('.companion-message-menu summary').click();
  await page.getByRole('button', { name: '整理成卡片', exact: true }).click();
  await expect(page.getByRole('heading', { name: '查看解释和自测' })).toBeVisible();
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  await page.locator('#draft-confirm').click();
  await expect(page.getByRole('button', { name: '收下返回', exact: true })).toBeVisible();
  db = await readTestDatabase(page, 'profile_companion_e2e_card');
  expect(db.learningState.cards).toHaveLength(1);
  await page.getByRole('navigation').getByRole('button', { name: '伴学', exact: true }).click();
  await page.locator('.companion-message-menu summary').click();
  await page.getByRole('button', { name: '查看卡片草稿', exact: true }).click();
  db = await readTestDatabase(page, 'profile_companion_e2e_card');
  expect(db.learningState.cards).toHaveLength(1);
});

test('伴学历史改名、新建切换、删除与偏好确认', async ({ page }) => {
  await open(page, 'profile_companion_e2e_history');
  await ask(page, '请记住先给生活例子');
  let db = await readTestDatabase(page, 'profile_companion_e2e_history');
  expect(db.preferences).toHaveLength(0);
  await page.getByRole('button', { name: '记住讲解偏好', exact: true }).click();
  await expect(page.getByRole('button', { name: '已记住', exact: true })).toBeDisabled();
  db = await readTestDatabase(page, 'profile_companion_e2e_history'); expect(db.preferences).toHaveLength(1);
  await page.locator('.companion-history summary').click();
  await page.locator('#companion-rename').click();
  await page.locator('#companion-title').fill('我的成本讨论');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.locator('.companion-toolbar')).toContainText('我的成本讨论');
  await page.locator('#companion-new').click();
  await expect(page.locator('.companion-message')).toHaveCount(0);
  await page.locator('.companion-history summary').click();
  await page.locator('#companion-history-select').selectOption({ label: '我的成本讨论' });
  await expect(page.locator('.companion-message')).toHaveCount(2);
  await page.locator('.companion-history summary').click();
  await page.locator('#companion-delete').click();
  await page.locator('#companion-delete-confirm').click();
  await expect(page.locator('.companion-message')).toHaveCount(0);
  db = await readTestDatabase(page, 'profile_companion_e2e_history'); expect(db.preferences).toHaveLength(1);
});

test('伴学停止后迟到请求不显示，切换会话保留各自输入', async ({ page }) => {
  await open(page, 'profile_companion_e2e_cancel');
  let requests = 0;
  await page.route('**/v1/chat/completions', async route => {
    if (!route.request().postData()?.includes('你的名字是伴学') || ++requests !== 1) return route.continue();
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: JSON.stringify({ answer: '迟到内容不应显示', citationIds: [] }) } }] }) });
  });
  await page.locator('#companion-input').fill('这是一条慢问题');
  await page.locator('#companion-send').click();
  await expect(page.locator('#companion-stop')).toBeVisible();
  await page.locator('#companion-stop').click();
  await expect(page.getByText('讨论已暂停', { exact: true })).toBeVisible();
  await ask(page, '现在回答新问题');
  await page.waitForTimeout(1400);
  await expect(page.locator('#page')).not.toContainText('迟到内容不应显示');
  await page.locator('#companion-input').fill('还没发出的草稿');
  await page.locator('#companion-new').click();
  await expect(page.locator('#companion-input')).toHaveValue('');
  await page.locator('.companion-history summary').click();
  await page.locator('#companion-history-select').selectOption({ label: '这是一条慢问题' });
  await expect(page.locator('#companion-input')).toHaveValue('还没发出的草稿');
});
