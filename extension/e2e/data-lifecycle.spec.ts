import { expect, test, type Page } from '@playwright/test';
import { readTestDatabase } from './database';

const PROFILE = 'profile_lifecycle_browser';
const KEY = 'kg_extension_harness_v1:' + PROFILE;
const oldCard = { id: 'old_card', title: '已有卡片', summary: '已有知识解释', question: '选择正确答案', options: ['正确', '错误'], correctIndex: 0,
  favorite: false, dueAt: 1, createdAt: 1, updatedAt: 1, mastery: 0, reviewCount: 0 };

async function open(page: Page, pending = false) {
  await page.addInitScript(({ profile, key, card, withPending }) => {
    if (sessionStorage.getItem('lifecycle_seed')) return;
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini' }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-secret');
    localStorage.setItem(key, JSON.stringify({ version: 1, migrations: ['local_storage_v1'], learningState: { cards: [card],
      pending: withPending ? [{ ...card, id: 'pending_card', title: '待打开卡片' }] : [], totalDraws: 1, reviewDay: {} },
      drafts: [{ id: 'material_draft', status: 'material', material: { text: '尚未完成的材料' } }] }));
    sessionStorage.setItem('lifecycle_seed', 'true');
  }, { profile: PROFILE, key: KEY, card: oldCard, withPending: pending });
  await page.goto('/');
  await expect.poll(async () => (await readTestDatabase(page, PROFILE)).materialStorage).toBe('indexeddb-v1');
  await page.getByLabel('主导航').getByRole('button', { name: '卡册', exact: true }).click();
  await expect(page.getByText('已有卡片', { exact: true })).toBeVisible();
}

async function newerChanges(page: Page) {
  await page.evaluate(async ({ profile, card }) => {
    const w = window as any;
    const service = w.KnowledgeGachaExtensionService.createExtensionService({ profileId: profile, storage: localStorage,
      cardDomain: w.KnowledgeGachaCardDomain, providerModule: w.KnowledgeGachaProviderTransport });
    const opened = await service.openGachaReview(card.id);
    await service.answerGachaReview(card.id, { attemptId: opened.question.attemptId, chosenIndex: 0 });
    const snapshot = (await service.loadLearningState()).state;
    snapshot.cards.push({ ...card, id: 'new_card', title: '另一窗口保存的卡片' });
    await service.replaceLearningState(snapshot);
    service.dispose();
  }, { profile: PROFILE, card: oldCard });
  return readTestDatabase(page, PROFILE);
}

async function more(page: Page) {
  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('button', { name: '更多与设置' }).click();
}

test('旧侧栏收藏和打开待保存卡均保留另一页面的新卡与复习进度', async ({ page, context }) => {
  await open(page, true);
  await page.getByText('已有卡片', { exact: true }).click();
  const other = await context.newPage();
  await other.goto('/');
  const before = await newerChanges(other);
  await page.locator('#favorite-card').click();
  await expect(page.locator('#favorite-card')).toHaveText('取消收藏');
  let db = await readTestDatabase(page, PROFILE);
  expect(db.learningState.cards.map((card: any) => card.id).sort()).toEqual(['new_card', 'old_card']);
  expect(db.learningState.cards.find((card: any) => card.id === 'old_card').reviewCount).toBe(1);
  expect(db.reviewEvents).toEqual(before.reviewEvents);
  expect(db.learningState.reviewDay).toEqual(before.learningState.reviewDay);
  await page.locator('#modal-close').click();
  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await page.locator('#home-draw').click();
  await page.locator('#open-capsule-action').click();
  await expect(page.getByRole('heading', { name: '待打开卡片', exact: true })).toBeVisible();
  await page.locator('#draw-favorite').click();
  await expect(page.locator('#draw-favorite')).toContainText('已收藏');
  db = await readTestDatabase(page, PROFILE);
  expect(db.learningState.cards).toHaveLength(3);
  expect(db.learningState.totalDraws).toBe(before.learningState.totalDraws + 1);
  expect(db.reviewEvents).toEqual(before.reviewEvents);
  await other.close();
});

test('提交复习期间离开再返回，迟到反馈不污染当前页面或报错', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
      delete w.KnowledgeGachaExtensionService;
      w.KnowledgeGachaExtensionService = module;
      const create = module.createExtensionService;
      module.createExtensionService = (...options: any[]) => {
        const service = create(...options);
        const answer = service.answerGachaReview;
        service.answerGachaReview = async (...args: any[]) => {
          const result = await answer(...args);
          w.lifecycleAnswerWaiting = true;
          await new Promise<void>(resolve => { w.lifecycleReleaseAnswer = resolve; });
          return result;
        };
        return service;
      };
    } });
  });
  await open(page);
  await page.getByLabel('主导航').getByRole('button', { name: '复习', exact: true }).click();
  await page.getByRole('button', { name: /打开这颗复习扭蛋/ }).click();
  await page.locator('[data-answer="0"]').click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).lifecycleAnswerWaiting))).toBe(true);
  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await page.getByLabel('主导航').getByRole('button', { name: '复习', exact: true }).click();
  const before = await readTestDatabase(page, PROFILE);
  await page.evaluate(() => (window as any).lifecycleReleaseAnswer());
  await expect(page.locator('#toast')).not.toContainText('Cannot read');
  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await expect(page.locator('#home-review')).toContainText('查看复习');
  const after = await readTestDatabase(page, PROFILE);
  expect(after.reviewEvents).toEqual(before.reviewEvents);
  expect(after.reviewEvents).toHaveLength(1);
});

test('清空保存失败保持卡册、模型设置和草稿，重试成功后页面与重开均为空', async ({ page }) => {
  await open(page);
  await more(page);
  await page.evaluate(key => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, name) {
      if (this.name === 'state' && name === 'profile_lifecycle_browser:current' && value.learningState.cards.length === 0) {
        IDBObjectStore.prototype.put = original;
        throw new Error('清空写入失败测试');
      }
      return original.call(this, value, name);
    };
  }, KEY);
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#wipe-all').click();
  await expect(page.locator('#toast')).toContainText('清空写入失败测试');
  expect((await readTestDatabase(page, PROFILE)).learningState.cards).toHaveLength(1);
  expect(await page.evaluate(() => Boolean(sessionStorage.getItem('kg_web_api_key')))).toBe(true);
  await page.getByLabel('主导航').getByRole('button', { name: '卡册', exact: true }).click();
  await expect(page.getByText('已有卡片', { exact: true })).toBeVisible();
  await more(page);
  await Promise.all([page.waitForEvent('load'), page.locator('#wipe-all').click()]);
  await expect.poll(async () => (await readTestDatabase(page, PROFILE)).drafts.length).toBe(0);
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  await expect(page.getByRole('region', { name: '材料草稿' })).toHaveCount(0);
  await page.reload();
  await page.getByLabel('主导航').getByRole('button', { name: '卡册', exact: true }).click();
  await expect(page.getByText('已有卡片', { exact: true })).toHaveCount(0);
});

test('收藏写入失败可重试；另一页已删除的卡片不会被旧详情恢复', async ({ page, context }) => {
  await open(page);
  await page.getByText('已有卡片', { exact: true }).click();
  await page.evaluate(key => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, name) {
      if (this.name === 'state' && name === 'profile_lifecycle_browser:current' && value.learningState.cards.some((card: any) => card.favorite)) {
        IDBObjectStore.prototype.put = original;
        throw new Error('收藏写入失败测试');
      }
      return original.call(this, value, name);
    };
  }, KEY);
  await page.locator('#favorite-card').click();
  await expect(page.locator('#toast')).toContainText('收藏写入失败测试');
  await expect(page.locator('#favorite-card')).toHaveText('收藏');
  expect((await readTestDatabase(page, PROFILE)).learningState.cards[0].favorite).toBe(false);
  await page.locator('#favorite-card').click();
  await expect(page.locator('#favorite-card')).toHaveText('取消收藏');
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate(async profile => {
    const w = window as any;
    const service = w.KnowledgeGachaExtensionService.createExtensionService({ profileId: profile, storage: localStorage,
      cardDomain: w.KnowledgeGachaCardDomain, providerModule: w.KnowledgeGachaProviderTransport });
    await service.deleteCards(['old_card']);
    service.dispose();
  }, PROFILE);
  await page.locator('#favorite-card').click();
  await expect(page.locator('#toast')).toContainText('已删除');
  expect((await readTestDatabase(page, PROFILE)).learningState.cards).toHaveLength(0);
  await other.close();
});

test('清空与另一页正在生成的任务互斥，生成返回后没有残留材料', async ({ page, context }) => {
  await open(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate(profile => {
    const w = window as any;
    let release: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    w.lifecycleRelease = () => release();
    const transport = w.KnowledgeGachaProviderTransport.createProviderTransport({ chromeApi: window.chrome });
    const service = w.KnowledgeGachaExtensionService.createExtensionService({ profileId: profile, storage: localStorage,
      cardDomain: w.KnowledgeGachaCardDomain, providerModule: w.KnowledgeGachaProviderTransport,
      modelConfig: { baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', apiKey: 'e2e-secret' },
      providerTransport: { complete: async (config: any, request: any) => { w.lifecycleStarted = true; await gate; return transport.complete(config, request); } } });
    w.lifecycleWork = service.createGachaCardDraft({ text: '每多生产一个单位额外增加的成本，称为边际成本。' })
      .then(() => { w.lifecycleDone = true; service.dispose(); });
  }, PROFILE);
  await expect.poll(() => other.evaluate(() => Boolean((window as any).lifecycleStarted))).toBe(true);
  await more(page);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#wipe-all').click();
  await expect(page.locator('#loader')).toBeVisible();
  expect((await readTestDatabase(page, PROFILE)).learningState.cards).toHaveLength(1);
  await Promise.all([page.waitForEvent('load'), other.evaluate(() => (window as any).lifecycleRelease())]);
  expect(await other.evaluate(() => (window as any).lifecycleDone)).toBe(true);
  const db = await readTestDatabase(page, PROFILE);
  expect(db.learningState.cards).toHaveLength(0);
  expect(db.drafts).toHaveLength(0);
  const lengths = await page.evaluate(async profile => {
    const repo = (window as any).KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: profile });
    const result = await Promise.all(['payloads', 'assets', 'imports'].map(async table => (await repo.list(table)).length));
    await repo.close();
    return result;
  }, PROFILE);
  expect(lengths).toEqual([0, 0, 0]);
  await other.close();
});
