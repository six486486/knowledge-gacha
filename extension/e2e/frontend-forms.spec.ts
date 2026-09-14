import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { readTestDatabase } from './database';
import { resolve } from 'node:path';

async function open(page: Page, profile: string) {
  await page.addInitScript(profile => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kg_web_profile_id', profile);
    localStorage.setItem('kg_web_migration_v1', 'complete');
    localStorage.setItem('kg_web_settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-4o-mini', reducedMotion: true }));
    sessionStorage.setItem('kg_web_api_key', 'e2e-form-fixture');
    const now = Date.now();
    const card = { id: 'form-card', title: '缓存适用条件', source: '表单测试材料', summary: '先核对条件再使用规则。',
      analogy: '先看门牌再进门。', mantra: '先看条件', plainSummary: '核对适用条件。', question: '首先应该做什么？',
      options: ['忽略条件', '核对条件', '事后再看'], correctIndex: 1, citations: [], favorite: false, mastery: 0,
      reviewCount: 0, lastCorrectReviewDay: '', createdAt: now, updatedAt: now, dueAt: 1, color: '#ff6f61',
      contentVersion: 2, version: 1, learningUnitId: 'form-unit', learningObjective: '判断缓存规则的适用条件',
      knowledgeType: 'concept', boundaries: '必须先核对题干条件。',
      example: { type: 'example', text: '先看条件再使用规则。', origin: 'authored' }, exerciseIds: ['form-exercise'] };
    localStorage.setItem(`kg_extension_harness_v1:${profile}`, JSON.stringify({
      schemaVersion: 1, version: 1, migrations: ['local_storage_v1'],
      learningState: { cards: [card], pending: [], totalDraws: 1, reviewDay: { day: '', answered: 0, completed: false } },
      drafts: [], sourceChecks: [], documents: [], discoveryPools: [], reviewEvents: [], preferences: [],
      candidates: [], runs: [], traces: {}, pendingRuns: {}, audit: [],
      exercises: [{ id: 'form-exercise', cardId: card.id, learningUnitId: 'form-unit', version: 1, type: 'choice',
        question: '新场景中首先应该做什么？', options: ['忽略条件直接套用', '先核对题干条件', '应用后再检查'], correctIndex: 1,
        answer: '先核对题干条件', answerExplanation: '条件成立后才能应用。', rubric: ['识别条件'],
        misconceptions: ['忽略题干中的必要条件', '', '步骤顺序错误'] }]
    }));
  }, profile);
  await page.goto('/');
}

async function separated(before: Locator, after: Locator, minimum = 12) {
  const a = (await before.boundingBox())!;
  const b = (await after.boundingBox())!;
  expect(b.y - a.y - a.height, '相邻内容组需要独立间距，文字不能贴住边框、阴影或前一个输入框').toBeGreaterThanOrEqual(minimum);
}

async function capture(page: Page, testInfo: TestInfo, name: string, anchor?: Locator) {
  if (anchor) await anchor.evaluate(element => {
    const viewport = document.querySelector('#page-viewport')!;
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 18;
  });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function noClipping(page: Page) {
  const overflow = await page.locator('#page').evaluate(element => {
    const viewport = document.querySelector('#page-viewport')!.getBoundingClientRect();
    return element.getBoundingClientRect().left + element.scrollWidth > viewport.right;
  });
  expect(overflow).toBe(false);
  await expect(page.locator('.nav-dock')).toBeInViewport({ ratio: 1 });
}

for (const viewport of [{ width: 320, height: 520 }, { width: 480, height: 720 }]) {
  test(`素材输入和学习目标在 ${viewport.width}px 下分组清晰，填写、调整高度和恢复均正常`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await open(page, `profile_form_material_${viewport.width}`);
    await page.getByRole('navigation').getByRole('button', { name: '制卡', exact: true }).click();
    await page.locator('#capture-manual').click();
    await capture(page, testInfo, 'manual-empty', page.locator('.capture-source-card'));
    await separated(page.locator('.capture-source-card'), page.locator('label[for="feed-goal"]'), 16);
    const text = '边际成本是每多生产一个单位额外增加的成本。';
    await page.locator('#feed-text').fill(text);
    await page.locator('#feed-goal').fill('能判断是否值得增加产量');
    await page.locator('#feed-text').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#feed-goal')).toBeFocused();
    await page.locator('#feed-text').evaluate(element => { element.style.height = '280px'; });
    await separated(page.locator('.capture-source-card'), page.locator('label[for="feed-goal"]'), 16);
    await noClipping(page);
    await capture(page, testInfo, 'manual-filled', page.locator('.capture-source-card'));
    await page.getByRole('navigation').getByRole('button', { name: '首页', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: '制卡', exact: true }).click();
    await expect(page.locator('#feed-text')).toHaveValue(text);
    await expect(page.locator('#feed-goal')).toHaveValue('能判断是否值得增加产量');
  });

  test(`图片预览、图注和目标在 ${viewport.width}px 下不相贴，移除后可重新输入`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await open(page, `profile_form_image_${viewport.width}`);
    await page.getByRole('navigation').getByRole('button', { name: '制卡', exact: true }).click();
    await page.locator('#image-input').setInputFiles({ name: '示意图.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64') });
    await expect(page.getByRole('img', { name: '已捕获的知识素材' })).toBeVisible();
    await capture(page, testInfo, 'image-caption', page.locator('.capture-source-card'));
    await separated(page.locator('.capture-preview'), page.locator('label[for="feed-text"]'));
    await separated(page.locator('.capture-source-card'), page.locator('label[for="feed-goal"]'), 16);
    await page.locator('#feed-text').fill('图中展示了新增成本和新增收入。');
    await page.locator('#clear-image').click();
    await expect(page.locator('.capture-preview')).toHaveCount(0);
    await page.locator('#capture-manual').click();
    await page.locator('#feed-text').fill('重新选择后的新材料。');
    await expect(page.locator('#feed-text')).toHaveValue('重新选择后的新材料。');
    await noClipping(page);
  });

  test(`展开草稿编辑在 ${viewport.width}px 下各字段有间距，核验仍保留修改`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await open(page, `profile_form_draft_${viewport.width}`);
    await page.getByRole('navigation').getByRole('button', { name: '制卡', exact: true }).click();
    await page.locator('#capture-manual').click();
    await page.locator('#feed-text').fill('边际成本是每多生产一个单位额外增加的成本。');
    await page.locator('#generate-card').click();
    await expect(page.getByRole('heading', { name: '知识扭蛋已出仓' })).toBeVisible();
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await separated(page.locator('.gacha-draft-card'), page.locator('.gacha-draft-card + .meta'));
    await page.locator('.draft-editor > summary').click();
    await capture(page, testInfo, 'draft-editor', page.locator('.draft-editor'));
    await separated(page.locator('.draft-editor > summary'), page.locator('label[for="draft-title"]'));
    const fields = ['draft-title', 'draft-objective', 'draft-summary', 'draft-example', 'draft-boundaries', 'draft-analogy'];
    for (let i = 1; i < fields.length; i++) await separated(page.locator(`#${fields[i - 1]}`), page.locator(`label[for="${fields[i]}"]`));
    await page.locator('#draft-title').fill('边际成本的增量判断');
    await page.getByRole('button', { name: '核验修改', exact: true }).click();
    await expect(page.locator('.result-title')).toHaveText('边际成本的增量判断');
    await page.locator('#draft-confirm').click();
    expect((await readTestDatabase(page, `profile_form_draft_${viewport.width}`)).learningState.cards.some((card: { title: string }) => card.title === '边际成本的增量判断')).toBe(true);
    await noClipping(page);
  });
}

test('偏好编辑提示与输入框分组，短窗口中可取消和保存', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 520 });
  await open(page, 'profile_form_preference');
  await page.getByRole('button', { name: '更多与设置' }).click();
  await page.getByRole('button', { name: /我的学习偏好/ }).click();
  await page.getByRole('button', { name: '添加学习偏好', exact: true }).click();
  await page.getByRole('button', { name: '先举例，再解释', exact: true }).click();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await page.locator('.preference-memory').getByRole('button', { name: '编辑', exact: true }).click();
  await capture(page, testInfo, 'preference-editor');
  await separated(page.locator('#modal-content .privacy-note'), page.locator('label[for="preference-value"]'));
  await page.locator('#preference-value').fill('先讲例子，再解释适用边界。');
  await page.locator('#preference-cancel').click();
  await expect(page.locator('.preference-memory')).not.toContainText('适用边界');
  await page.locator('.preference-memory').getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#preference-value').fill('先讲例子，再解释适用边界。');
  await page.locator('#preference-save').click();
  await expect(page.locator('.preference-memory')).toContainText('先讲例子,再解释适用边界。');
});

test('错因纠正弹窗字段对齐且分组明确，取消和提交保持原复习记录', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 520 });
  await open(page, 'profile_form_review');
  await page.getByRole('navigation').getByRole('button', { name: '复习', exact: true }).click();
  await page.getByRole('button', { name: /打开这颗复习扭蛋/ }).click();
  await page.locator('[data-answer="0"]').click();
  await page.getByRole('button', { name: '纠正错因记录' }).click();
  await capture(page, testInfo, 'review-correction');
  await separated(page.locator('#review-cause-type'), page.locator('label[for="review-cause-note"]'));
  const select = (await page.locator('#review-cause-type').boundingBox())!;
  const note = (await page.locator('#review-cause-note').boundingBox())!;
  expect(select.width).toBeCloseTo(note.width, 0);
  expect(select.height).toBeGreaterThanOrEqual(40);
  await page.locator('#review-cause-type').selectOption('concept_confusion');
  await page.locator('#review-cause-note').fill('我混淆了两个条件。');
  await page.locator('#review-cause-cancel').click();
  expect((await readTestDatabase(page, 'profile_form_review')).reviewEventCorrections || []).toHaveLength(0);
  await page.getByRole('button', { name: '纠正错因记录' }).click();
  await page.locator('#review-cause-type').selectOption('concept_confusion');
  await page.locator('#review-cause-note').fill('我混淆了两个条件。');
  await page.locator('#review-cause-save').click();
  const db = await readTestDatabase(page, 'profile_form_review');
  expect(db.reviewEvents).toHaveLength(1);
  expect(db.reviewEventCorrections).toHaveLength(1);
  expect(db.reviewEventCorrections[0].errorType).toBe('concept_confusion');
});

test('文档校对在短窄窗口和展开原页后仍有明确分组，确认后保留修改', async ({ page }, testInfo) => {
  await open(page, 'profile_form_import');
  await page.getByRole('navigation').getByRole('button', { name: '制卡', exact: true }).click();
  await page.locator('#source-file-input').setInputFiles(resolve(__dirname, '../tests/fixtures/documents/chinese.pdf'));
  await expect(page.locator('#import-page-range')).toBeEnabled();
  await page.locator('#import-page-range').fill('1');
  await page.locator('#import-parse').click();
  await expect(page.locator('#import-use')).toBeEnabled();
  await page.locator('[data-preview-page="1"]').click();
  for (const viewport of [{ width: 320, height: 520 }, { width: 480, height: 720 }]) {
    await page.setViewportSize(viewport);
    await separated(page.locator('#import-page-image'), page.locator('label[for="import-correction"]'));
    await separated(page.locator('#import-correction'), page.locator('#modal-content .form-section + .meta'), 8);
    await capture(page, testInfo, `document-correction-${viewport.width}`);
  }
  await page.locator('#import-show-page').click();
  await expect(page.locator('.import-original-image')).toBeVisible();
  await separated(page.locator('#import-page-image'), page.locator('label[for="import-correction"]'));
  await page.locator('#import-correction').fill('校对后的材料：每增加一件产品，应当比较额外的成本与收益。');
  await page.locator('#import-correct').click();
  await page.locator('#import-use').click();
  await expect(page.locator('#feed-text')).toHaveValue(/校对后的材料/);
  await separated(page.locator('.capture-source-card'), page.locator('label[for="feed-goal"]'), 16);
  await noClipping(page);
});
