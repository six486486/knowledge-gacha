import { readTestDatabase } from "./database";
import { artifactPath } from './artifacts';
import { expect, test, type Page } from '@playwright/test';

const TEXT = '# 增量成本\n边际成本是每多生产一个单位额外增加的成本。\n\n只有增加产量时才比较该增量。\n\n# 固定支出\n月租在本次决策中保持不变，但扩大场地时租金可能改变。\n\n# 决策边界\n实际决策应同时考虑产能和需求，不单看单位成本。';

async function setup(page: Page, id: string) {
  const requests: any[] = [];
  await page.addInitScript(({ id }) => {
    if (sessionStorage.getItem('step03-profile') === id) return;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', id);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', reducedMotion: true }));
    sessionStorage.setItem('kg_web_api_key', 'step03-local-fixture');
    sessionStorage.setItem('step03-profile', id);
  }, { id });
  page.on('request', request => {
    if (request.url() === 'http://127.0.0.1:8790/v1/chat/completions' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const content = body.messages.at(-1).content;
      requests.push({ body, payload: JSON.parse(Array.isArray(content) ? content.find((item: any) => item.type === 'text').text : content) });
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '制卡', exact: true }).click();
  return requests;
}

async function plan(page: Page, text = TEXT, retain = false) {
  await page.locator('#source-file-input').setInputFiles({ name: '成本学习.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
  if (retain) await page.getByRole('switch', { name: '随卡片保留原文' }).click();
  await page.locator('#generate-card').click();
  await expect(page.getByRole('heading', { name: '学习清单与卡组', exact: true })).toBeVisible();
  await expect(page.locator('#generate-plan')).toBeEnabled();
}

test('第三步：选择目标、逐卡编辑、确认卡组、卡册分组与共享原文回查', async ({ page }) => {
  const requests = await setup(page, 'profile_step03_complete');
  await plan(page, TEXT, true);
  await expect(page.locator('.knowledge-unit')).toHaveCount(3);
  await page.locator('[data-unit-select]').nth(2).uncheck();
  await expect(page.locator('#generate-plan')).toHaveText('生成所选 2 个目标');
  await expect(page.locator('#generate-plan')).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('.plan-unit-detail summary').first().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.locator('#toast')).not.toHaveClass(/is-open/);
  await page.screenshot({ path: artifactPath('test-results/step03-plan-320.png'), fullPage: true });
  await page.locator('#generate-plan').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(2);
  await expect(page.locator('[data-open-batch-draft]').first()).toBeEnabled();
  await page.locator('[data-open-batch-draft]').first().click();
  await page.getByText('手动修改内容', { exact: true }).click();
  await page.locator('#draft-title').fill('我理解的增量成本');
  await page.getByRole('button', { name: '核验修改', exact: true }).click();
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  await page.getByRole('button', { name: '返回卡组', exact: true }).click();
  await expect(page.locator('.batch-card').first()).toContainText('我理解的增量成本');
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(page.locator('#toast')).not.toHaveClass(/is-open/);
  await page.screenshot({ path: artifactPath('test-results/step03-batch-480.png'), fullPage: true });
  await page.locator('#save-selected-batch').click();
  await expect(page.getByRole('heading', { name: '确认收下 2 张卡片', exact: true })).toBeVisible();
  await page.locator('#apply-batch-confirm').click();
  await expect(page.locator('.batch-card .state-confirmed')).toHaveCount(2);
  await expect(page.locator('#save-selected-batch')).toBeDisabled();
  await page.reload();
  await page.getByLabel('主导航').getByRole('button', { name: '卡册', exact: true }).click();
  const filter = page.locator('#album-batch-filter');
  await expect(filter).toBeVisible();
  await filter.selectOption({ label: '成本学习.md · 2 张' });
  await expect(page.locator('.card-tile')).toHaveCount(2);
  const db = await readTestDatabase(page, 'profile_step03_complete');
  expect(db.documents).toHaveLength(1);
  expect(db.materials[0].text).toBeUndefined();
  expect(db.learningState.cards).toHaveLength(2);
  expect(db.knowledgePlans[0].units.filter((unit: any) => unit.selected)).toHaveLength(2);
  for (const card of db.learningState.cards) for (const citation of card.citations) {
    expect(db.documents[0].content.slice(citation.position.startCharacter, citation.position.endCharacter)).toBe(citation.quote);
  }
  expect(requests.every(({ body }) => !body.tools)).toBe(true);
  expect(JSON.stringify(db)).not.toContain('step03-local-fixture');
});

test('第三步：每次最多三张，稍后恢复仅生成剩余项', async ({ page }) => {
  const requests = await setup(page, 'profile_step03_resume');
  await plan(page, TEXT + '\n\n# 沉没成本\n已经发生且无法收回的支出不随当前决定改变。');
  await expect(page.locator('.knowledge-unit')).toHaveCount(4);
  await page.locator('#generate-plan').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(3);
  await expect(page.locator('#continue-batch')).toBeEnabled();
  await expect(page.locator('#continue-batch')).toContainText('剩余 1 张');
  await page.locator('#plan-later').click();
  await page.reload();
  await page.getByRole('button', { name: '制卡', exact: true }).click();
  await page.locator('[data-open-knowledge-plan]').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(3);
  const before = requests.filter(({ payload }) => payload.operation === 'generate').length;
  await page.locator('#continue-batch').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(4);
  expect(requests.filter(({ payload }) => payload.operation === 'generate').length - before).toBe(1);
  const db = await readTestDatabase(page, 'profile_step03_resume');
  expect(db.materials).toHaveLength(1);
  expect(db.drafts).toHaveLength(4);
  expect(db.knowledgePlans[0].retainedUnitIds).toHaveLength(4);
});

test('第三步：界面合并、继续拆分和明确跳过均可恢复', async ({ page }) => {
  await setup(page, 'profile_step03_reshape');
  await plan(page);
  await page.locator('[data-unit-select]').nth(2).uncheck();
  await expect(page.locator('#merge-plan-units')).toBeEnabled();
  await page.locator('#merge-plan-units').click();
  await page.locator('#plan-reshape-targets').fill('成本比较 | 能区分固定支出和增量成本');
  await page.locator('#apply-reshape').click();
  await expect(page.locator('.knowledge-unit')).toHaveCount(2);
  await page.locator('.plan-unit-detail summary').first().click();
  await page.locator('[data-unit-split]').first().click();
  await page.locator('#plan-reshape-targets').fill('新增支出 | 能判断增加产量的新增支出\n固定边界 | 能识别固定支出何时改变');
  await page.locator('#apply-reshape').click();
  await expect(page.locator('.knowledge-unit')).toHaveCount(3);
  await expect(page.locator('.knowledge-unit.is-skipped')).toHaveCount(1);
  await page.locator('#plan-later').click();
  await page.reload();
  await page.getByRole('button', { name: '制卡', exact: true }).click();
  await page.locator('[data-open-knowledge-plan]').click();
  await expect(page.locator('.knowledge-unit')).toHaveCount(3);
  await expect(page.locator('.knowledge-unit-list')).toContainText('新增支出');
  await expect(page.locator('.knowledge-unit-list')).toContainText('固定边界');
  await expect(page.locator('.knowledge-unit.is-skipped')).toContainText('用户本次跳过');
});

test('第三步：一个请求失败后保留已完成卡，只重做该卡', async ({ page }) => {
  const requests = await setup(page, 'profile_step03_failure');
  let fail = true;
  await page.route('http://127.0.0.1:8790/v1/chat/completions', async route => {
    const body = route.request().postDataJSON();
    const content = body.messages.at(-1).content;
    const payload = JSON.parse(Array.isArray(content) ? content[0].text : content);
    if (fail && payload.operation === 'generate' && payload.userGoal.split('\n')[0].includes('固定支出')) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '本地测试故障' } }) });
    } else await route.continue();
  });
  await plan(page);
  await page.locator('#generate-plan').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(2);
  await expect(page.locator('.batch-card .state-failed')).toHaveCount(1);
  const before = requests.filter(({ payload }) => payload.operation === 'generate').length;
  await page.locator('.batch-card').filter({ has: page.locator('.state-failed') }).locator('[data-retry-unit]').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(3);
  expect(requests.filter(({ payload }) => payload.operation === 'generate').length - before).toBe(1);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('产品验收：材料卡组恢复后接通复习、偏好和发现，历史记录保持关联', async ({ page }, testInfo) => {
  test.setTimeout(45000);
  const profile = 'profile_acceptance_complete_journey';
  await setup(page, profile);
  await plan(page, TEXT, true);
  await page.locator('[data-unit-select]').nth(2).uncheck();
  await page.locator('#generate-plan').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(2);
  await page.locator('#plan-later').click();
  await page.reload();
  await page.getByRole('button', { name: '制卡', exact: true }).click();
  await page.locator('[data-open-knowledge-plan]').click();
  await expect(page.locator('.batch-card .state-ready')).toHaveCount(2);
  await page.locator('#save-selected-batch').click();
  await page.locator('#apply-batch-confirm').click();
  await expect(page.locator('.batch-card .state-confirmed')).toHaveCount(2);
  const saved = await readTestDatabase(page, profile);
  expect(saved.documents).toHaveLength(1);
  expect(saved.learningState.cards).toHaveLength(2);

  await page.reload();
  await page.getByLabel('主导航').getByRole('button', { name: '复习', exact: true }).click();
  await page.getByRole('button', { name: '提前学下一张新卡' }).click();
  await page.getByRole('button', { name: /打开这颗复习扭蛋/ }).click();
  await page.locator('[data-answer]').first().click();
  await expect.poll(async () => (await readTestDatabase(page, profile)).reviewEvents.length).toBe(1);
  const event = (await readTestDatabase(page, profile)).reviewEvents[0];
  expect(saved.learningState.cards.some((card: any) => card.id === event.cardId)).toBe(true);

  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('button', { name: '更多与设置' }).click();
  await page.getByRole('button', { name: /我的学习偏好/ }).click();
  await page.getByRole('button', { name: '调整兴趣', exact: true }).click();
  await page.getByRole('button', { name: /设计与表达/ }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: /^摄影/ }).click();
  await page.getByRole('button', { name: '保存兴趣', exact: true }).click();
  await expect(page.getByRole('heading', { name: '摄影', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /发现新知识/ }).click();
  const interestCandidate = page.locator('.discovery-candidate').filter({ hasText: '摄影' }).first();
  await expect(interestCandidate).toBeVisible();
  const discovery = await readTestDatabase(page, profile);
  const pool = discovery.discoveryPools[0];
  const preference = discovery.preferences.find((item: any) => item.enabled && item.category === 'topic_interest' && item.value === '摄影');
  expect(pool.usedPreferenceIds).toContain(preference.id);
  expect(pool.candidates.some((item: any) => item.mode === 'explicit_interest' && item.topic.includes('摄影'))).toBe(true);
  await interestCandidate.locator('[data-discovery-open]').click();
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  await page.locator('#draft-confirm').click();
  await page.getByRole('button', { name: '返回候选列表', exact: true }).click();
  await expect(page.locator('.discovery-candidate.status-saved')).toHaveCount(1);
  const final = await readTestDatabase(page, profile);
  expect(final.learningState.cards).toHaveLength(3);
  expect(final.reviewEvents[0]).toEqual(event);
  expect(final.documents).toHaveLength(1);
  expect(final.preferences.some((preference: any) => preference.category === 'topic_interest' && preference.value === '摄影')).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('complete-journey-discovery-320.png'), fullPage: true });
});
