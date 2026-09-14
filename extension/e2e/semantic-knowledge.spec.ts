import { expect, test } from '@playwright/test';
import { readTestDatabase } from './database';

test('卡册可用不同措辞找到卡片；重开复用持久向量，更新删除和档案隔离生效', async ({ page }) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('semantic_seed')) return;
    localStorage.setItem('kg_web_profile_id', 'profile_semantic_ui');
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_extension_harness_v1:profile_semantic_ui', JSON.stringify({ migrations: ['local_storage_v1'], learningState: { cards: [
      { id: 'cost', title: '边际成本', summary: '边际成本是每多生产一个单位额外增加的成本。这里月租不随本次产量改变，不计入这次增量。', dueAt: 1 },
      { id: 'verse', title: '古诗', summary: '古诗常使用押韵和平仄，表达季节变化与个人感受。', dueAt: 1 }
    ], pending: [] } }));
    sessionStorage.setItem('semantic_seed', 'yes');
  });
  await page.goto('/');
  await expect.poll(async () => (await readTestDatabase(page, 'profile_semantic_ui')).stateStorage).toBe('indexeddb-v2');
  await page.getByLabel('主导航').getByRole('button', { name: '卡册', exact: true }).click();
  await page.locator('#album-search').fill('再做一件产品会额外花多少钱？');
  await expect(page.locator('#album-search-status')).toHaveText('已按关键词和语义查找', { timeout: 20000 });
  await expect(page.locator('#album-results').getByText('边际成本', { exact: true })).toBeVisible();
  await expect(page.locator('#album-results').getByText('古诗', { exact: true })).toHaveCount(0);
  await page.reload();
  const warm = await page.evaluate(async () => {
    const w = window as any;
    const service = w.KnowledgeGachaExtensionService.createExtensionService({ profileId: 'profile_semantic_ui', storage: localStorage,
      cardDomain: w.KnowledgeGachaCardDomain, providerModule: w.KnowledgeGachaProviderTransport });
    try {
      const result = await service.searchCards({ query: '再做一件产品会额外花多少钱？' });
      await service.deleteCards(['cost']);
      const deleted = await service.searchCards({ query: '再做一件产品会额外花多少钱？' });
      return { trace: result.trace, ids: result.results.map((x: any) => x.cardId), deleted: deleted.results.map((x: any) => x.cardId) };
    } finally { service.dispose(); }
  });
  expect(warm.trace.indexed).toBe(0); expect(warm.trace.cacheHits).toBe(2);
  expect(warm.ids).toContain('cost'); expect(warm.deleted).not.toContain('cost');
});

test('语义模型不可用时卡册仍可搜索，连续输入只显示最新查询', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const RealWorker = w.Worker;
    w.Worker = function (url: URL, options: any) {
      if (String(url).includes('local-embedding-worker')) throw new Error('fixture unavailable');
      return new RealWorker(url, options);
    };
    localStorage.setItem('kg_web_profile_id', 'profile_semantic_failure');
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_extension_harness_v1:profile_semantic_failure', JSON.stringify({ migrations: ['local_storage_v1'], learningState: {
      cards: [{ id: 'cache', title: '缓存', summary: '缓存保存计算结果，过期后重新计算。', dueAt: 1 }], pending: [] } }));
  });
  await page.goto('/');
  await page.getByLabel('主导航').getByRole('button', { name: '卡册', exact: true }).click();
  await page.locator('#album-search').fill('不存在的知识');
  await page.locator('#album-search').fill('缓存');
  await expect(page.locator('#album-search-status')).toContainText('语义检索暂不可用');
  await expect(page.locator('#album-results').getByText('缓存', { exact: true })).toBeVisible();
});
