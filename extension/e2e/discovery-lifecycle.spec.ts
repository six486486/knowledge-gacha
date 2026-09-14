import { expect, test, type Page } from '@playwright/test';
import { readTestDatabase } from './database';

const PROFILE = 'profile_discovery_lifecycle';

async function open(page: Page, recall = false) {
  await page.addInitScript(({ profile, recall }) => {
    if (sessionStorage.getItem('discovery_lifecycle_seed')) return;
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', reducedMotion: true }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-secret');
    const card = { id: 'review_card', title: '复习卡', summary: '回答核心要点', contentVersion: recall ? 2 : 1,
      learningObjective: '能解释核心要点', question: '选择核心要点', options: ['核心要点', '无关信息'], correctIndex: 0,
      exerciseIds: recall ? ['exercise_recall'] : [], dueAt: 1, createdAt: 1, updatedAt: 1 };
    localStorage.setItem('kg_extension_harness_v1:' + profile, JSON.stringify({ version: 1, migrations: ['local_storage_v1'],
      discoveryInterestSetup: { completedAt: 1 }, learningState: { cards: [card], pending: [], totalDraws: 1, reviewDay: {} }, exercises: recall ? [{ id: 'exercise_recall',
        cardId: card.id, type: 'recall', question: '请写出核心要点', options: [], answer: '核心要点', answerExplanation: '说明核心要点的含义', rubric: ['核心要点'], version: 1 }] : [] }));
    sessionStorage.setItem('discovery_lifecycle_seed', 'true');
  }, { profile: PROFILE, recall });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '知识扭蛋机', exact: true })).toBeVisible();
  await expect.poll(async () => (await readTestDatabase(page, PROFILE)).materialStorage).toBe('indexeddb-v1');
}

test('当前版本发现候选重开后可直接查看，没有会话密钥也不丢失已有方向', async ({ page }) => {
  await open(page);
  await page.locator('#home-discovery').click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  const title = await page.locator('.discovery-candidate h3').first().innerText();
  const before = await readTestDatabase(page, PROFILE);
  await page.evaluate(() => sessionStorage.removeItem('kg_web_api_key'));
  await page.reload();
  await page.locator('#home-discovery').click();
  await expect(page.locator('.discovery-candidate h3').first()).toHaveText(title);
  expect((await readTestDatabase(page, PROFILE)).discoveryPools.length).toBe(before.discoveryPools.length);
});

test('发现自动修正示例格式，草稿和收下后的卡片只显示 AI 来源', async ({ page }, testInfo) => {
  const operations: string[] = [];
  await page.route('http://127.0.0.1:8790/v1/chat/completions', async route => {
    const content = route.request().postDataJSON().messages.at(-1).content;
    const payload = JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === 'text').text : content);
    if (payload.operation) operations.push(payload.operation);
    if (payload.operation !== 'generate') { await route.fallback(); return; }
    const response = await route.fetch();
    const body = await response.json();
    const output = JSON.parse(body.choices[0].message.content);
    output.card.example.type = 'scenario';
    body.choices[0].message.content = JSON.stringify(output);
    await route.fulfill({ response, json: body });
  });
  await open(page);
  await page.locator('#home-discovery').click();
  await page.locator('[data-discovery-open]').first().click();
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  await expect(page.locator('.quality-issues')).toHaveCount(0);
  await expect(page.locator('.card-provenance')).toContainText('AI 生成');
  await expect(page.locator('.draft-evidence, #draft-material, .generation-metrics')).toHaveCount(0);
  await expect(page.locator('.gacha-draft-card')).not.toContainText('发现候选：');
  expect(operations.filter(value => value === 'repair')).toHaveLength(1);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('#toast')).not.toHaveClass(/is-open/);
  await page.screenshot({ path: testInfo.outputPath('discovery-draft-320.png'), fullPage: true });
  await page.locator('#draft-confirm').click();
  await expect(page.locator('.discovery-after-save')).toBeVisible();
  await expect(page.locator('.card-provenance')).toContainText('AI 生成');
  await expect(page.locator('.card-sources, .source-snapshot, .evidence-section')).toHaveCount(0);
  const db = await readTestDatabase(page, PROFILE);
  const saved = db.learningState.cards.find((card: any) => card.discoveryBasis);
  expect(saved.citations).toHaveLength(0);
  expect(saved.sourceSnapshot).toBeNull();
  await page.evaluate(async profile => {
    const repository = (window as any).KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: profile });
    const db = await repository.get('state', 'current');
    db.learningState.cards.find((card: any) => card.discoveryBasis).sourceSnapshot = {
      sourceType: 'discovery', title: '发现候选：旧版卡片', status: 'unavailable', excerpt: ''
    };
    await repository.put('state', 'current', db); await repository.close();
  }, PROFILE);
  await page.reload();
  await page.getByLabel('主导航').getByRole('button', { name: '卡册', exact: true }).click();
  await page.getByText(saved.title, { exact: true }).click();
  await expect(page.locator('.card-provenance')).toContainText('AI 生成');
  await expect(page.locator('.card-sources, .source-snapshot, .evidence-section')).toHaveCount(0);
});

test('示例修复失败和旧失败草稿只提示重试，可返回发现并恢复生成', async ({ page }, testInfo) => {
  let fail = true;
  let generations = 0;
  await page.route('http://127.0.0.1:8790/v1/chat/completions', async route => {
    const content = route.request().postDataJSON().messages.at(-1).content;
    const payload = JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === 'text').text : content);
    if (payload.operation === 'generate') generations++;
    if (!fail || !['generate', 'repair'].includes(payload.operation)) { await route.fallback(); return; }
    const response = await route.fetch();
    const body = await response.json();
    const output = JSON.parse(body.choices[0].message.content);
    delete output.card.example.origin;
    body.choices[0].message.content = JSON.stringify(output);
    await route.fulfill({ response, json: body });
  });
  await open(page);
  await page.locator('#home-discovery').click();
  const title = await page.locator('.discovery-candidate h3').first().innerText();
  await page.locator('[data-discovery-open]').first().click();
  await expect(page.locator('.quality-issues')).toContainText('示例暂未整理完成，可以重试生成。');
  await expect(page.locator('.quality-issues')).not.toContainText(/草稿待修复|请区分|origin|type/);
  await expect(page.locator('#draft-confirm')).toBeDisabled();
  await expect(page.locator('#draft-material, .draft-evidence')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.locator('#toast')).not.toHaveClass(/is-open/);
  await page.screenshot({ path: testInfo.outputPath('discovery-retry-320.png'), fullPage: true });
  await page.locator('#draft-later').click();
  await expect(page.locator('.discovery-candidate h3').first()).toHaveText(title);
  await page.locator('[data-discovery-open]').first().click();
  await expect(page.locator('.quality-issues')).toContainText('示例暂未整理完成');
  expect(generations).toBe(1);
  // Restore the exact persisted legacy issue to exercise the existing-draft UI.
  await page.evaluate(async profile => {
    const repository = (window as any).KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: profile });
    const db = await repository.get('state', 'current');
    const record = db.drafts.find((draft: any) => draft.status === 'needs_revision');
    record.quality.issues = [{ code: 'example_origin', message: '请区分教学自拟示例与原文示例' }];
    await repository.put('state', 'current', db); await repository.close();
  }, PROFILE);
  await page.reload();
  await page.locator('#home-discovery').click();
  await page.locator('[data-discovery-open]').first().click();
  await expect(page.locator('.quality-issues')).toContainText('示例暂未整理完成');
  await expect(page.locator('.quality-issues')).not.toContainText('请区分');
  fail = false;
  await page.getByRole('button', { name: '重试生成', exact: true }).click();
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  expect(generations).toBe(2);
});

test('发现依据不足时保留原因和草稿，可返回原候选；手动材料保留补充提示', async ({ page }, testInfo) => {
  let generated = 0;
  await page.route('http://127.0.0.1:8790/v1/chat/completions', async route => {
    const content = route.request().postDataJSON().messages.at(-1).content;
    const payload = JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === 'text').text : content);
    if (payload.operation !== 'generate') { await route.fallback(); return; }
    generated++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant',
      content: JSON.stringify({ status: 'insufficient_material', issues: ['缺少目标必需的适用条件'], card: null }) } }] }) });
  });
  await open(page);
  await page.locator('#home-discovery').click();
  const candidate = page.locator('.discovery-candidate').first();
  const title = await candidate.locator('h3').innerText();
  await candidate.locator('[data-discovery-open]').click();
  await expect(page.locator('.quality-issues')).toContainText('这个方向暂时未能成卡');
  await expect(page.locator('.quality-issues')).toContainText('缺少目标必需的适用条件');
  await expect(page.locator('#draft-confirm')).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('discovery-unavailable-320.png'), fullPage: true });
  const before = await readTestDatabase(page, PROFILE);
  await expect(page.locator('#draft-later')).toHaveText('返回发现');
  await page.locator('#draft-later').click();
  await expect(page.locator('.discovery-candidate h3').first()).toHaveText(title);
  await page.locator('[data-discovery-open]').first().click();
  await expect(page.locator('.quality-issues')).toContainText('这个方向暂时未能成卡');
  expect(generated).toBe(1);
  const after = await readTestDatabase(page, PROFILE);
  expect(after.drafts).toEqual(before.drafts);
  expect(after.learningState).toEqual(before.learningState);

  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  await page.getByRole('button', { name: /^手动输入/ }).click();
  await page.getByRole('textbox', { name: '制卡素材' }).fill('这是一段缺少必要说明的手动输入测试材料。');
  await page.getByRole('button', { name: '凝练成卡', exact: true }).click();
  await expect(page.locator('.quality-issues')).toContainText('需要更多材料');
  await expect(page.locator('#draft-later')).toHaveText('稍后打开');
  await expect(page.locator('#draft-confirm')).toBeDisabled();
});

for (const [method, selector, recall] of [
  ['getGachaReviewHint', '#review-hint', false],
  ['revealGachaReviewAnswer', '#review-reveal', true]
] as const) {
  test(`复习 ${method} 返回前离开再进入，迟到内容不报错且再次打开能恢复`, async ({ page }) => {
    await page.addInitScript(method => {
      const w = window as any;
      Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
        delete w.KnowledgeGachaExtensionService;
        w.KnowledgeGachaExtensionService = module;
        const create = module.createExtensionService;
        module.createExtensionService = (...options: any[]) => {
          const service = create(...options);
          const original = service[method];
          service[method] = async (...args: any[]) => {
            const result = await original(...args);
            w.reviewResponseWaiting = true;
            await new Promise<void>(resolve => { w.releaseReviewResponse = resolve; });
            return result;
          };
          return service;
        };
      } });
    }, method);
    await open(page, recall);
    await page.getByLabel('主导航').getByRole('button', { name: '复习', exact: true }).click();
    await page.getByRole('button', { name: /打开这颗复习扭蛋/ }).click();
    if (recall) await page.locator('#review-recall-response').fill('我写出的核心要点');
    await page.locator(selector).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).reviewResponseWaiting))).toBe(true);
    await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
    await page.getByLabel('主导航').getByRole('button', { name: '复习', exact: true }).click();
    await page.evaluate(async () => { (window as any).releaseReviewResponse(); await new Promise(requestAnimationFrame); });
    await expect(page.locator('#toast')).not.toContainText('Cannot');
    await expect(page.locator('.review-answer-panel, .review-hint')).toHaveCount(0);
    await page.getByRole('button', { name: /打开这颗复习扭蛋/ }).click();
    if (recall) {
      await expect(page.locator('#review-recall-response')).toHaveValue('我写出的核心要点');
      await expect(page.locator('.review-answer-panel')).toContainText('核心要点');
    } else await expect(page.locator('.review-hint')).toBeVisible();
    expect((await readTestDatabase(page, PROFILE)).reviewEvents).toHaveLength(0);
  });
}

test('发现生成锁保留到材料写入完成，其他页面不会重复消耗请求', async ({ page, context }) => {
  await open(page);
  await page.locator('#home-discovery').click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  const db = await readTestDatabase(page, PROFILE);
  const poolId = db.discoveryPools[0].id, candidateId = db.discoveryPools[0].candidates[0].id;
  const other = await context.newPage();
  await other.goto('/');
  await page.evaluate(({ profile, poolId, candidateId }) => {
    const w = window as any;
    const repository = w.KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: profile });
    const commitState = repository.commitState;
    let paused = false;
    repository.commitState = async (expected: string, value: any, rows: any[]) => {
      if (!paused && rows.some(row => row.value.material?.source?.type === 'discovery')) {
        paused = true; w.discoveryCommitWaiting = true;
        await new Promise<void>(resolve => { w.releaseDiscoveryCommit = resolve; });
      }
      return commitState(expected, value, rows);
    };
    const service = w.KnowledgeGachaExtensionService.createExtensionService({ profileId: profile, storage: localStorage, repository,
      cardDomain: w.KnowledgeGachaCardDomain, providerModule: w.KnowledgeGachaProviderTransport,
      modelConfig: { baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', apiKey: 'e2e-secret' } });
    w.discoveryOpenResult = service.openGachaDiscoveryCandidate(poolId, candidateId).then(async (result: any) => { service.dispose(); await repository.close(); return result.session.id; });
  }, { profile: PROFILE, poolId, candidateId });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).discoveryCommitWaiting))).toBe(true);
  const blocked = await other.evaluate(async ({ profile, poolId, candidateId }) => {
    const w = window as any;
    let requests = 0;
    w.discoveryOtherApi = w.KnowledgeGachaExtensionService.createExtensionService({ profileId: profile, storage: localStorage,
      cardDomain: w.KnowledgeGachaCardDomain, providerModule: w.KnowledgeGachaProviderTransport,
      modelConfig: { model: 'fixture', apiKey: 'fixture-only' }, providerTransport: { complete: async () => { requests++; throw new Error('不应重复生成'); } } });
    try { await w.discoveryOtherApi.openGachaDiscoveryCandidate(poolId, candidateId); return { error: '', requests }; }
    catch (error: any) { return { error: error.message, requests }; }
  }, { profile: PROFILE, poolId, candidateId });
  expect(blocked.error).toContain('另一个窗口');
  expect(blocked.requests).toBe(0);
  await page.evaluate(() => (window as any).releaseDiscoveryCommit());
  const firstId = await page.evaluate(() => (window as any).discoveryOpenResult);
  const restored = await other.evaluate(async ({ poolId, candidateId }) => {
    const service = (window as any).discoveryOtherApi;
    const result = await service.openGachaDiscoveryCandidate(poolId, candidateId);
    service.dispose();
    return { id: result.session.id, restored: result.alreadyOpened };
  }, { poolId, candidateId });
  expect(restored).toEqual({ id: firstId, restored: true });
  expect((await readTestDatabase(page, PROFILE)).drafts).toHaveLength(1);
  await other.close();
});
