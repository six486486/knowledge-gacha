import { test, expect, type Page } from '@playwright/test';
import { readTestDatabase } from './database';

async function open(page: Page, profile: string) {
  await page.addInitScript(profile => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', reducedMotion: true }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-layout-fixture');
    const now = Date.now();
    const cards = Array.from({ length: 18 }, (_, i) => ({
      id: `layout-card-${i}`, title: `边际成本与决策 ${i + 1}`, source: '布局测试资料',
      summary: '只关注当前决策新增的变化。', analogy: '多做一杯咖啡时只看新增原料。',
      mantra: '只看新增', plainSummary: '先看新增部分。', question: '当前最应该关注什么？',
      options: ['总量', '新增变化', '无关历史'], correctIndex: 1, citations: [], color: '#ff6f61',
      favorite: false, mastery: 0, reviewCount: 0, lastCorrectReviewDay: '', createdAt: now,
      updatedAt: now, dueAt: 1
    }));
    localStorage.setItem(`kg_extension_harness_v1:${profile}`, JSON.stringify({
      schemaVersion: 1, version: 1, migrations: ['local_storage_v1'],
      learningState: { cards, pending: [], totalDraws: cards.length, reviewDay: { day: '', answered: 0, completed: false } },
      drafts: [], sourceChecks: [], documents: [], discoveryPools: [], reviewEvents: [], preferences: [],
      candidates: [], runs: [], traces: {}, pendingRuns: {}, audit: [],
      companionSessions: [{ id: 'layout-discussion', title: '长对话阅读测试', mode: 'explain', useKnowledge: true, useMemory: true,
        createdAt: now, updatedAt: now, turn: null, context: null,
        messages: Array.from({ length: 16 }, (_, i) => [
          { id: `u${i}`, turnId: `t${i}`, role: 'user', content: `第 ${i + 1} 个问题：如何理解边际成本？` },
          { id: `a${i}`, turnId: `t${i}`, role: 'assistant', status: 'completed',
            content: '边际成本指每增加一个单位产量所增加的成本。\n\n例如多做一杯咖啡，需要增加咖啡豆和牛奶。只考虑因当前决策而变化的部分。',
            citations: [], actions: [], followUps: [], steps: [] }
        ]).flat()
      }]
    }));
  }, profile);
  await page.goto('/');
}

async function selectNav(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}

async function expectPageAboveNavigation(page: Page) {
  const layout = await page.locator('#page').evaluate(element => {
    let visibleBottom = innerHeight;
    let visibleRight = innerWidth;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(ancestor).overflowY)) {
        visibleBottom = Math.min(visibleBottom, ancestor.getBoundingClientRect().bottom);
      }
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(ancestor).overflowX)) {
        visibleRight = Math.min(visibleRight, ancestor.getBoundingClientRect().right);
      }
    }
    const nav = document.querySelector('.nav-dock')!.getBoundingClientRect();
    return { visibleBottom, navTop: nav.top, navBottom: nav.bottom, height: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      contentOverflow: element.getBoundingClientRect().left + element.scrollWidth > visibleRight,
      overflowing: Array.from(element.querySelectorAll('*')).filter(child => child.getBoundingClientRect().right > visibleRight).slice(0, 8).map(child => ({ tag: child.tagName, class: child.className, width: child.getBoundingClientRect().width })) };
  });
  expect(layout.visibleBottom, '页面可见内容应在导航上方截止，不能从导航背后穿过').toBeLessThanOrEqual(layout.navTop - 1);
  expect(layout.navBottom).toBeLessThanOrEqual(layout.height);
  expect(layout.horizontalOverflow).toBe(false);
  expect(layout.contentOverflow, `侧栏内部也不能通过横向裁剪掩盖溢出：${JSON.stringify(layout.overflowing)}`).toBe(false);
}

for (const viewport of [{ width: 320, height: 480 }, { width: 480, height: 900 }, { width: 960, height: 640 }]) {
  test(`主要页面在 ${viewport.width}×${viewport.height} 窗口中与导航分区，长卡册可以滚动到底`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await open(page, `profile_layout_${viewport.width}`);
    for (const name of ['首页', '制卡', '卡册', '复习']) {
      await selectNav(page, name);
      await expectPageAboveNavigation(page);
      await expect(page.getByRole('navigation').getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    }
    await selectNav(page, '卡册');
    const lastCard = page.getByText('边际成本与决策 18', { exact: true });
    await lastCard.scrollIntoViewIfNeeded();
    await expect(lastCard).toBeInViewport();
    await lastCard.click();
    await expect(page.getByRole('dialog')).toContainText('边际成本与决策 18');
    await page.keyboard.press('Escape');
    await selectNav(page, '首页');
    await expect(page.getByRole('heading', { name: '知识扭蛋机', exact: true })).toBeInViewport();
  });
}

test('发现和制卡结果保留所属导航，长草稿底部操作可见且可点击', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 520 });
  await open(page, 'profile_layout_subpages');
  await page.getByRole('button', { name: /发现新知识/ }).click();
  await page.getByRole('button', { name: '先随便看看', exact: true }).click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  await expectPageAboveNavigation(page);
  await expect(page.getByRole('navigation').getByRole('button', { name: '首页', exact: true })).toHaveAttribute('aria-current', 'page');
  await selectNav(page, '制卡');
  await page.getByRole('button', { name: /手动输入/ }).click();
  await page.getByRole('textbox', { name: '制卡素材', exact: true }).fill('边际成本是每多生产一个单位额外增加的成本。');
  await page.getByRole('button', { name: '凝练成卡', exact: true }).click();
  await expect(page.getByRole('heading', { name: '知识扭蛋已出仓' })).toBeVisible();
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expectPageAboveNavigation(page);
  await expect(page.getByRole('navigation').getByRole('button', { name: '制卡', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.locator('#draft-confirm').scrollIntoViewIfNeeded();
  const button = await page.locator('#draft-confirm').boundingBox();
  const nav = await page.locator('.nav-dock').boundingBox();
  expect(button!.y + button!.height).toBeLessThan(nav!.y);
  await page.locator('#draft-confirm').click();
  await expect(page.getByRole('button', { name: '收下返回', exact: true })).toBeVisible();
  expect((await readTestDatabase(page, 'profile_layout_subpages')).learningState.cards).toHaveLength(19);
});

test('鼠标拖动长对话只滚动消息，输入框和导航保持可用', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 520 });
  await open(page, 'profile_layout_chat_drag');
  await selectNav(page, '伴学');
  await expect(page.locator('.companion-message.is-assistant')).toHaveCount(16);
  const messages = page.locator('.companion-messages');
  const before = await messages.evaluate(element => element.scrollTop);
  expect(before).toBeGreaterThan(200);
  const box = (await messages.boundingBox())!;
  await page.mouse.move(box.x + 65, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 150, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeLessThan(before - 80);
  await expect(page.locator('#companion-send')).toBeInViewport();
  await expectPageAboveNavigation(page);
});

test('短窗口里的长输入和设置浮层保留阅读空间，学习偏好弹窗可完整操作', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await open(page, 'profile_layout_short');
  await selectNav(page, '伴学');
  await page.locator('#companion-input').fill('保留未发送的长草稿\n'.repeat(20));
  expect((await page.locator('.companion-messages').boundingBox())!.height).toBeGreaterThanOrEqual(80);
  await page.locator('.companion-settings > summary').click();
  const settings = (await page.locator('.companion-settings-panel').boundingBox())!;
  expect(settings.y).toBeGreaterThanOrEqual(0);
  await page.locator('#companion-discussion-preference').fill('多用例子');
  await page.keyboard.press('Escape');
  await expect(page.locator('#companion-input')).toHaveValue('保留未发送的长草稿\n'.repeat(20));
  await page.getByRole('button', { name: '更多与设置', exact: true }).click();
  await page.getByRole('button', { name: /我的学习偏好/ }).click();
  await page.getByRole('button', { name: '添加学习偏好', exact: true }).click();
  await page.getByRole('button', { name: '先举例，再解释', exact: true }).click();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expectPageAboveNavigation(page);
});

test('短窗口展开陪练题目并编辑长回答时，仍能阅读历史和操作会话', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await open(page, 'profile_layout_practice');
  await selectNav(page, '伴学');
  await page.getByLabel('教学方式').selectOption('auto');
  await page.locator('#companion-input').fill('考考我');
  await page.locator('#companion-send').click();
  await expect(page.locator('.companion-task-status')).toContainText('等待你回答');
  await page.locator('.companion-task-status summary').click();
  await page.locator('#companion-input').fill('分析过程与回答\n'.repeat(20));
  expect((await page.locator('.companion-messages').boundingBox())!.height).toBeGreaterThanOrEqual(80);
  await page.locator('.companion-history > summary').click();
  await page.locator('#companion-rename').click();
  await page.locator('#companion-title').fill('短窗口中的陪练');
  await expect(page.getByRole('button', { name: '保存名称' })).toBeInViewport();
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.locator('.companion-toolbar h2')).toHaveText('短窗口中的陪练');
  await expect(page.locator('#companion-send')).toBeInViewport();
  const layout = await page.locator('.companion-shell').evaluate(shell => ({
    bottom: shell.getBoundingClientRect().bottom,
    composerBottom: shell.querySelector('.companion-composer')!.getBoundingClientRect().bottom,
    children: Array.from(shell.children).map(child => ({ class: child.className, top: child.getBoundingClientRect().top, height: child.getBoundingClientRect().height }))
  }));
  expect(layout.composerBottom, JSON.stringify(layout)).toBeLessThanOrEqual(layout.bottom);
  await page.screenshot({ path: testInfo.outputPath('practice-short.png') });
});

test('更多、模型、偏好和运行记录在窄屏中可完整滚动且不横向裁切', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await open(page, 'profile_layout_utilities');
  await page.getByRole('button', { name: '更多与设置', exact: true }).click();
  await expectPageAboveNavigation(page);
  await page.screenshot({ path: testInfo.outputPath('more.png') });
  for (const label of ['我的模型', '我的学习偏好']) {
    await page.getByRole('button', { name: new RegExp(label) }).click();
    await expectPageAboveNavigation(page);
    await page.screenshot({ path: testInfo.outputPath(`${label}.png`) });
    await page.getByRole('button', { name: '返回更多', exact: true }).click();
  }
  await page.locator('.more-help > summary').click();
  await page.locator('#open-observability').click();
  await expect(page.getByRole('heading', { name: '运行记录', exact: true })).toBeVisible();
  await expectPageAboveNavigation(page);
  await page.screenshot({ path: testInfo.outputPath('diagnostics.png') });
});
