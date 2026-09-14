import { expect, test, type Page } from '@playwright/test';
import { readTestDatabase } from './database';

const PROFILE = 'profile_discovery_interests';

async function open(page: Page, options: { configured?: boolean; seed?: any } = {}) {
  await page.addInitScript(({ profile, configured, seed }) => {
    if (sessionStorage.getItem('interest_qa_seeded')) return;
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_extension_harness_v1:' + profile, JSON.stringify({
      version: 1, migrations: ['local_storage_v1'], learningState: { cards: [], pending: [], totalDraws: 0, reviewDay: {} }, ...seed
    }));
    if (configured) {
      localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', reducedMotion: true }));
      sessionStorage.setItem('kg_web_api_key', 'e2e-secret');
    }
    sessionStorage.setItem('interest_qa_seeded', 'true');
  }, { profile: PROFILE, configured: options.configured !== false, seed: options.seed || {} });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '知识扭蛋机', exact: true })).toBeVisible();
}

function requestsFor(page: Page) {
  const requests: any[] = [];
  page.on('request', request => {
    if (request.url().startsWith('http://127.0.0.1:8790/v1/chat/completions')) {
      const body = request.postDataJSON();
      requests.push(JSON.parse(body.messages.at(-1).content));
    }
  });
  return requests;
}

async function choosePhotography(page: Page) {
  await page.getByRole('button', { name: /设计与表达/ }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: /^摄影/ }).click();
}

test('首次进入发现选择领域和标签，键盘、自定义主题和重开生效', async ({ page }, testInfo) => {
  const requests = requestsFor(page);
  await open(page);
  await expect(page.getByRole('region', { name: '选择学习兴趣' })).toHaveCount(0);
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  await expect(page.locator('#capture-manual')).toBeVisible();
  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await page.locator('#home-discovery').click();
  await expect(page.getByRole('heading', { name: '想发现哪些新知识？' })).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: /计算机与 AI/ }).click();
  await page.getByRole('button', { name: /心理与行为/ }).click();
  for (const width of [480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`interest-domains-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const ai = page.getByRole('button', { name: /^AI 应用/ });
  await ai.focus();
  await page.keyboard.press('Space');
  await expect(ai).toHaveAttribute('aria-pressed', 'true');
  await expect(ai).toBeFocused();
  await page.getByRole('button', { name: /^认知偏差/ }).click();
  await page.getByLabel('也可以自己添加兴趣').fill('数据库索引');
  await page.getByLabel('也可以自己添加兴趣').press('Enter');
  await expect(page.getByRole('button', { name: /^数据库索引/ })).toHaveAttribute('aria-pressed', 'true');
  for (const width of [320, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`interest-tags-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByRole('button', { name: /计算机与 AI/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(ai).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '开始推荐', exact: true }).click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  expect(requests).toHaveLength(1);
  expect(requests[0].seeds.filter((seed: any) => seed.mode === 'explicit_interest').map((seed: any) => seed.anchor).sort()).toEqual(['AI 应用', '数据库索引', '认知偏差'].sort());
  const db = await readTestDatabase(page, PROFILE);
  expect(db.preferences.filter((item: any) => item.enabled).map((item: any) => item.value).sort()).toEqual(['AI 应用', '数据库索引', '认知偏差'].sort());
  expect(db.learningState.cards).toHaveLength(0);
  await page.reload();
  await page.locator('#home-discovery').click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  await expect(page.getByRole('region', { name: '选择学习兴趣' })).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

test('跳过引导不保存试选兴趣，不配置模型也能选择且重开不再打断', async ({ page }) => {
  const requests = requestsFor(page);
  await open(page, { configured: false });
  await page.locator('#home-discovery').click();
  await page.getByRole('button', { name: /计算机与 AI/ }).click();
  await page.getByRole('button', { name: '先随便看看', exact: true }).click();
  await expect(page.getByRole('heading', { name: '先连接你的模型' })).toBeVisible();
  let db = await readTestDatabase(page, PROFILE);
  expect(db.preferences).toHaveLength(0);
  expect(db.discoveryInterestSetup.completedAt).toBeGreaterThan(0);
  await page.reload();
  await page.locator('#home-discovery').click();
  await expect(page.getByRole('heading', { name: '先连接你的模型' })).toBeVisible();
  await page.getByRole('button', { name: '调整兴趣', exact: true }).click();
  await choosePhotography(page);
  await page.getByRole('button', { name: '保存兴趣', exact: true }).click();
  await expect(page.getByRole('heading', { name: '先连接你的模型' })).toBeVisible();
  db = await readTestDatabase(page, PROFILE);
  expect(db.preferences.map((item: any) => item.value)).toEqual(['摄影']);
  expect(requests).toHaveLength(0);
});

test('旧兴趣回填同一选择器，取消或原样保存不重建推荐', async ({ page }) => {
  const requests = requestsFor(page);
  await open(page, { seed: { preferences: [
    { id: 'old-photo', category: 'topic_interest', value: '摄影', topicLabel: '摄影', enabled: true, version: 2, source: 'user_explicit', createdAt: 1 },
    { id: 'old-custom', category: 'topic_interest', value: '咖啡萃取', topicLabel: '咖啡萃取', enabled: true, version: 1, source: 'user_explicit', createdAt: 1 },
    { id: 'old-format', category: 'learning_format', value: '先给例子', enabled: true, version: 1, scope: { type: 'global' }, createdAt: 1 }
  ] } });
  await page.locator('#home-discovery').click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  const before = await readTestDatabase(page, PROFILE);
  await page.getByRole('button', { name: '调整兴趣', exact: true }).click();
  await expect(page.getByRole('button', { name: /设计与表达/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('button', { name: /^摄影/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^咖啡萃取/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '保存兴趣', exact: true }).click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  expect(requests).toHaveLength(1);
  expect((await readTestDatabase(page, PROFILE)).preferences).toEqual(before.preferences);
  await page.getByRole('button', { name: '调整兴趣', exact: true }).click();
  await page.getByRole('button', { name: /自然科学/ }).click();
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  expect((await readTestDatabase(page, PROFILE)).preferences).toEqual(before.preferences);
  expect(requests).toHaveLength(1);
});

test('兴趣保存失败保留选择并可重试，成功前不请求推荐', async ({ page }) => {
  const requests = requestsFor(page);
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
      delete w.KnowledgeGachaExtensionService; w.KnowledgeGachaExtensionService = module;
      const create = module.createExtensionService;
      module.createExtensionService = (...args: any[]) => {
        const service = create(...args), save = service.saveDiscoveryInterests;
        let failed = false;
        service.saveDiscoveryInterests = async (...input: any[]) => {
          if (!failed) { failed = true; throw new Error('测试存储空间不足'); }
          return save(...input);
        };
        return service;
      };
    } });
  });
  await open(page);
  await page.locator('#home-discovery').click();
  await choosePhotography(page);
  await page.locator('#interest-custom').fill('\u2100'.repeat(50));
  await page.getByRole('button', { name: '开始推荐', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('最多 120 个字符');
  await expect(page.locator('#interest-custom')).toHaveValue('\u2100'.repeat(50));
  expect((await readTestDatabase(page, PROFILE)).preferences).toHaveLength(0);
  expect(requests).toHaveLength(0);
  await page.locator('#interest-custom').fill('');
  await page.getByRole('button', { name: '开始推荐', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('存储空间不足');
  await expect(page.getByRole('button', { name: /^摄影/ })).toHaveAttribute('aria-pressed', 'true');
  expect((await readTestDatabase(page, PROFILE)).preferences).toHaveLength(0);
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '开始推荐', exact: true }).click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
  expect(requests).toHaveLength(1);
});

test('迟到的兴趣读取和保存结果不会跳离用户正在编辑的制卡页', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    Object.defineProperty(w, 'KnowledgeGachaExtensionService', { configurable: true, set(module) {
      delete w.KnowledgeGachaExtensionService; w.KnowledgeGachaExtensionService = module;
      const create = module.createExtensionService;
      module.createExtensionService = (...args: any[]) => {
        const service = create(...args);
        for (const method of ['getDiscoveryInterests', 'saveDiscoveryInterests']) {
          const original = service[method]; let delayed = false;
          service[method] = async (...input: any[]) => {
            const result = await original(...input);
            if (!delayed) {
              delayed = true; w[method + 'Waiting'] = true;
              await new Promise<void>(resolve => { w[method + 'Release'] = resolve; });
            }
            return result;
          };
        }
        return service;
      };
    } });
  });
  await open(page);
  await page.locator('#home-discovery').click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).getDiscoveryInterestsWaiting))).toBe(true);
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  await page.locator('#capture-manual').click();
  await page.getByLabel('制卡素材', { exact: true }).fill('这份手动笔记不要被兴趣选择打断。');
  await page.evaluate(() => (window as any).getDiscoveryInterestsRelease());
  await expect(page.getByLabel('制卡素材', { exact: true })).toHaveValue('这份手动笔记不要被兴趣选择打断。');
  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await page.locator('#home-discovery').click();
  await choosePhotography(page);
  await page.getByRole('button', { name: '开始推荐', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).saveDiscoveryInterestsWaiting))).toBe(true);
  await page.getByLabel('主导航').getByRole('button', { name: '制卡', exact: true }).click();
  await page.evaluate(() => (window as any).saveDiscoveryInterestsRelease());
  await expect(page.getByLabel('制卡素材', { exact: true })).toHaveValue('这份手动笔记不要被兴趣选择打断。');
  await page.getByLabel('主导航').getByRole('button', { name: '首页', exact: true }).click();
  await page.locator('#home-discovery').click();
  await expect(page.locator('.discovery-candidate')).toHaveCount(3);
});
