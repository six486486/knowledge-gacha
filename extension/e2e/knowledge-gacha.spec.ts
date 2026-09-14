import { readTestDatabase } from "./database";
import { artifactPath } from './artifacts';
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const NOW = Date.UTC(2026, 7, 28, 8);

async function openProfile(page: Page, profileId: string, options: { configured?: boolean; reducedMotion?: boolean; seed?: Record<string, unknown> } = {}): Promise<void> {
  const configured = options.configured !== false;
  const reducedMotion = options.reducedMotion === true;
  const database = createDatabase(options.seed || {});
  await page.addInitScript(({ id, db, withModel, reduceMotion }) => {
    if (window.sessionStorage.getItem("kg_e2e_seeded_profile") === id) return;
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("kg_web_profile_id", id);
    window.localStorage.setItem("kg_web_migration_v1", "complete");
    window.localStorage.setItem(`kg_extension_harness_v1:${id}`, JSON.stringify(db));
    if (withModel) {
      window.localStorage.setItem("kg_web_settings", JSON.stringify({ baseUrl: "http://127.0.0.1:8790/v1", model: "gpt-4o-mini", temperature: 0.3, reducedMotion: reduceMotion }));
      window.sessionStorage.setItem("kg_web_api_key", "e2e-secret");
    }
    window.sessionStorage.setItem("kg_e2e_seeded_profile", id);
  }, { id: profileId, db: database, withModel: configured, reduceMotion: reducedMotion });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "知识扭蛋机" })).toBeVisible();
}

async function openMore(page: Page): Promise<void> {
  if (!await page.getByRole("button", { name: "更多与设置" }).isVisible()) await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "首页", exact: true }).click();
  await page.getByRole("button", { name: "更多与设置" }).click();
  await expect(page.getByRole("heading", { name: "更多", exact: true })).toBeVisible();
}

test("纯扩展模型测试直接连接 Provider，不需要本地 Harness", async ({ page }) => {
  await openProfile(page, "profile_e2e_model");
  await openMore(page);
  await page.getByRole("button", { name: /我的模型/ }).click();
  await expect(page.getByText(/不需要本机服务/)).toBeVisible();
  await expect(page.getByText("单卡质量评测", { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href*="evals/card-quality"]')).toHaveCount(0);
  await page.getByRole("button", { name: /保存并测试/ }).click();
  await expect(page.locator("#settings-status")).toContainText("连接成功");
  await expect(page.locator("#settings-status")).toContainText("gpt-4o-mini");
});

test("纯扩展制卡闭环：核对、模型生成、编辑、确认和恢复", async ({ page }) => {
  await openProfile(page, "profile_e2e_card");
  await page.getByRole("button", { name: "制卡", exact: true }).click();
  await page.getByRole("button", { name: /手动输入/ }).click();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("边际成本是每多生产一个单位额外增加的成本。");
  await page.getByRole("button", { name: "凝练成卡" }).click();
  await expect(page.getByRole("heading", { name: "知识扭蛋已出仓" })).toBeVisible();
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.getByRole("heading", { name: "查看解释和自测" })).toBeVisible();
  await page.getByText("手动修改内容", { exact: true }).click();
  await page.locator("#draft-analogy").fill("像多做一杯咖啡，只算新增原料。");
  await page.getByRole("button", { name: "核验修改" }).click();
  await expect(page.getByRole("button", { name: /收下并安排复习/ })).toBeEnabled();
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  await expect(page.getByRole("heading", { name: "边际成本" })).toBeVisible();
  await page.reload();
  await page.getByLabel("主导航").getByRole("button", { name: "卡册", exact: true }).click();
  await expect(page.getByText("边际成本")).toBeVisible();
});

test("伴学支持连续讨论，回答不会直接写入卡册", async ({ page }) => {
  await openProfile(page, "profile_e2e_agent");
  await page.getByRole("navigation").getByRole("button", { name: "伴学", exact: true }).click();
  await page.locator("#companion-input").fill("帮我理解边际成本");
  await page.locator("#companion-send").click();
  await expect(page.locator(".companion-message.is-assistant")).toHaveCount(1);
  await page.locator("#companion-input").fill("换个例子");
  await page.locator("#companion-send").click();
  await expect(page.locator(".companion-message.is-assistant")).toHaveCount(2);
  await page.reload();
  await page.getByLabel("主导航").getByRole("button", { name: "伴学", exact: true }).click();
  await expect(page.locator(".companion-message.is-assistant")).toHaveCount(2);
  const db = await readTestDatabase(page, "profile_e2e_agent");
  expect(db.learningState.cards).toHaveLength(0);
});

test("复习判分、掌握度和排期都由扩展后端业务服务更新", async ({ page }) => {
  const dueCard = card("card_e2e_review", "增量变化");
  await openProfile(page, "profile_e2e_review", { seed: { learningState: state([dueCard]) } });
  await expect(page.getByRole("button", { name: /今日复习 · 1/ })).toBeVisible();
  await page.getByRole("button", { name: /今日复习 · 1/ }).click();
  await page.getByRole("button", { name: /打开这颗复习扭蛋/ }).click();
  await expect(page.getByRole("heading", { name: "增量变化" })).toBeVisible();
  await page.locator('[data-answer="1"]').click();
  await expect(page.getByText("答对了，已形成一条作答证据。")).toBeVisible();
  await expect(page.getByText(/下次排期/)).toBeVisible();
});

test("扩展内资料引用可以回查并精确高亮", async ({ page }) => {
  const document = { id: "doc_e2e_citation", title: "检索依据", type: "text", mimeType: "text/plain", content: "第一段背景。知识扭蛋机使用检索证据来约束卡片结论。最后一段。", byteSize: 38, sourceUrl: null, createdAt: NOW, updatedAt: NOW };
  const quote = "检索证据";
  const start = document.content.indexOf(quote);
  const citation = { id: "citation_e2e", claim: "summary", chunkId: "chunk_e2e_citation", source: { documentId: document.id, title: document.title, type: "text", sourceUrl: null }, headingPath: [], quote, position: { pageNumber: null, startCharacter: start, endCharacter: start + quote.length } };
  const citedCard = card("card_e2e_citation", "可验证引用", [citation]);
  await openProfile(page, "profile_e2e_citation", { seed: { learningState: state([citedCard]), documents: [document] } });
  await page.getByLabel("主导航").getByRole("button", { name: "卡册", exact: true }).click();
  await page.getByText("可验证引用").click();
  await expect(page.locator('.card-sources')).not.toHaveAttribute('open', '');
  await page.locator('.card-sources > summary').click();
  await expect(page.getByText("1 条依据")).toBeVisible();
  await page.getByRole("button", { name: "查看依据" }).click();
  await expect(page.getByText("已定位原文片段")).toBeVisible();
  await expect(page.locator("mark")).toHaveText("检索证据");
});

test("记忆、工具审计与运行观测从扩展本地状态恢复", async ({ page }) => {
  const reviewCard = card("card_e2e_memory", "边际成本");
  const run = { id: "run_e2e_completed", status: "completed", skill: { name: "plain-explanation", version: "browser-v1" }, source: "agent_api", durationMs: 12, stepCount: 1, checkpointCount: 0, retryCount: 0, approvalCount: 0, errorCode: null, createdAt: NOW, completedAt: NOW + 12 };
  const trace = { sequence: 1, eventType: "run_completed", kind: "lifecycle", summary: "扩展内 Harness 运行完成", status: "completed", references: { stepId: null, checkpointId: null, approvalId: null }, error: null, occurredAt: NOW };
  await openProfile(page, "profile_e2e_observe", { seed: {
    learningState: state([reviewCard]),
    reviewEvents: [{ id: "review_event_e2e", cardId: reviewCard.id, title: reviewCard.title, correct: false, chosenIndex: 0, correctIndex: 1, answeredAt: NOW }],
    preferences: [{ id: "preference_e2e", category: "learning_format", value: "优先使用类比解释", source: "user_explicit", candidateId: null, enabled: true, createdAt: NOW, updatedAt: NOW }],
    runs: [run], traces: { [run.id]: [trace] },
    audit: [{ id: "audit_e2e", direction: "inbound", source: "internal", name: "search_knowledge", serverId: "extension-harness", connectionId: "browser-session", permissions: ["knowledge.read"], status: "completed", durationMs: 12, approvalRequired: false, occurredAt: NOW, errorCode: null }]
  } });
  await openMore(page);
  await page.getByRole("button", { name: /我的学习偏好/ }).click();
  await page.getByRole("tab", { name: "学习记录" }).click();
  await expect(page.getByRole("heading", { name: "边际成本" })).toBeVisible();
  await page.getByRole("button", { name: "返回更多" }).click();
  await page.locator('.more-help summary').click();
  await page.getByRole("button", { name: /运行记录/ }).click();
  await page.locator('.legacy-connection-records summary').click();
  await expect(page.getByText("search_knowledge")).toBeVisible();
  // The fixed historical fixture is outside the real 24-hour window.
  await expect(page.locator(".observability-run-card")).toHaveCount(0);
  await page.locator('[data-observability-window="all"]').click();
  await expect(page.locator(".observability-run-card")).toHaveCount(1);
  await expect(page.locator(".observability-run-card")).toContainText("大白话解释");
  await expect(page.locator(".observability-run-card")).toContainText("browser-v1");
  await page.locator(".observability-run-card").click();
  await expect(page.getByText("扩展内 Harness 运行完成")).toBeVisible();
  await expect(page.locator("#page")).not.toContainText(/e2e-secret|Authorization/);
});

test("第五步：明确兴趣立即改变发现排序，并可在偏好页撤销", async ({ page }) => {
  await openProfile(page, "profile_step5_feedback");
  await page.getByRole("button", { name: /发现新知识/ }).click();
  await page.getByRole("button", { name: "先随便看看" }).click();
  await expect(page.getByRole("heading", { name: "下一颗，学点真正新的" })).toBeVisible();
  const target = page.locator(".discovery-candidate").last();
  const topic = await target.getByRole("heading", { level: 3 }).innerText();
  await target.getByRole("button", { name: "喜欢这个方向" }).click();
  await expect(target.getByRole("button", { name: "已喜欢" })).toBeVisible();
  await page.getByRole("button", { name: /换个方向/ }).click();
  await expect(page.locator(".discovery-candidate").first()).toHaveClass(/mode-explicit_interest/);
  await expect(page.locator(".discovery-candidate").first()).toContainText("从你选择的");

  await page.getByRole("button", { name: "返回首页" }).click();
  await openMore(page);
  await page.getByRole("button", { name: /我的学习偏好/ }).click();
  await expect(page.getByRole("heading", { name: topic, exact: true })).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText(/还没有兴趣设置/)).toBeVisible();

  await page.getByRole("button", { name: "返回更多" }).click();
  await page.getByRole("button", { name: "返回首页" }).click();
  await page.getByRole("button", { name: /发现新知识/ }).click();
  await expect(page.locator(".discovery-candidate").first()).not.toHaveClass(/mode-explicit_interest/);
});

test("第五步：可添加兴趣和主题难度、查看并清除近期事实，窄侧栏不横向溢出", async ({ page }) => {
  await openProfile(page, "profile_step5_editor", { configured: false, seed: { recentLearningEvents: [{ id: "recent_step5",
    type: "recommendation_exposure", topicLabel: "缓存一致性", occurredAt: NOW, createdAt: NOW }] } });
  await page.getByRole("button", { name: /发现新知识/ }).click();
  await page.getByRole("button", { name: "先随便看看" }).click();
  await expect(page.getByRole("heading", { name: "先连接你的模型" })).toBeVisible();
  await expect(page.locator(".discovery-candidate")).toHaveCount(0);
  await page.getByRole("button", { name: "返回首页" }).click();
  await openMore(page);
  await page.getByRole("button", { name: /我的学习偏好/ }).click();

  await page.getByRole("button", { name: "调整兴趣", exact: true }).click();
  await page.getByRole("button", { name: /设计与表达/ }).click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: /摄影/ }).click();
  await page.getByRole("button", { name: "保存兴趣", exact: true }).click();
  await expect(page.getByRole("heading", { name: "摄影" })).toBeVisible();

  await page.getByRole("button", { name: "添加学习偏好" }).click();
  await page.getByRole("radio", { name: /内容难度/ }).check();
  await page.getByRole("radio", { name: "指定主题", exact: true }).check();
  await page.getByRole("textbox", { name: "主题名称" }).fill("摄影");
  await page.getByLabel("难度", { exact: true }).selectOption("advanced");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect(page.getByRole("heading", { name: "进阶一些", exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "学习记录" }).click();
  await page.getByRole("button", { name: "近期活动", exact: true }).click();
  await expect(page.getByText("近 30 天上下文")).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清除近期" }).click();
  await expect(page.getByText(/近 30 天没有推荐/)).toBeVisible();

  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.getByRole("tab", { name: "难度与表达", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "待确认建议", exact: true })).toBeVisible();
});

test("第七步：具体候选、真实理由、打开收下和返回列表形成完整闭环", async ({ page }) => {
  const existing = { ...card("card_step7_cache", "缓存基础"), contentVersion: 2, learningUnitId: "unit_step7_cache",
    learningObjective: "能解释缓存怎样复用旧结果", knowledgeType: "mechanism",
    example: { type: "example", text: "相同查询复用上次结果。", origin: "authored" }, boundaries: "", exerciseIds: [] };
  await page.setViewportSize({ width: 320, height: 520 });
  await openProfile(page, "profile_step7_discovery", { reducedMotion: true, seed: { learningState: state([existing]) } });
  await expect(page.locator("body")).toHaveClass(/reduce-motion/);
  await page.getByRole("button", { name: /发现新知识/ }).click();
  await page.getByRole("button", { name: "先随便看看" }).click();
  const candidates = page.locator(".discovery-candidate");
  await expect(candidates).toHaveCount(3);
  await expect(candidates.first().getByRole("heading", { level: 3 })).toBeVisible();
  await expect(candidates.first().locator(".discovery-novelty")).toContainText("这次新增");
  await expect(page.locator("#page")).not.toContainText(/薄弱强化|相邻知识|惊喜探索/);

  const related = candidates.filter({ hasText: "缓存基础" }).first();
  await related.getByRole("button", { name: "查看依据" }).click();
  await expect(page.getByRole("button", { name: "查看《缓存基础》" })).toBeVisible();
  await page.getByRole("button", { name: "知道了" }).click();

  const target = candidates.last();
  const topic = await target.getByRole("heading", { level: 3 }).innerText();
  const novelty = await target.locator(".discovery-novelty p").innerText();
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 160));
  await target.getByRole("button", { name: "打开学习" }).click();
  await expect(page.getByRole("heading", { name: "查看解释和自测" })).toBeVisible();
  await expect(page.locator(".gacha-draft-card")).toContainText(topic);
  await expect(page.locator(".gacha-draft-card")).toContainText(novelty);
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  await expect(page.locator(".discovery-after-save")).toContainText("已从发现候选收下");
  await expect(page.getByRole("button", { name: "继续这个方向" })).toBeVisible();
  await page.getByRole("button", { name: "返回候选列表", exact: true }).click();
  await expect(page.locator(".discovery-candidate.status-saved")).toContainText(topic);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const firstOpen = page.locator("[data-discovery-open]").first();
  await firstOpen.focus();
  await expect(firstOpen).toBeFocused();
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");
});

test("第六步：提示、保存误区与用户纠正沿同一复习事件回查", async ({ page }) => {
  const item = {
    ...card("card_step6_evidence", "缓存适用条件"), contentVersion: 2, version: 1, learningUnitId: "unit_step6_evidence",
    learningObjective: "能判断缓存规则的适用条件", knowledgeType: "concept", boundaries: "必须先核对题干条件。",
    example: { type: "example", text: "先看条件再使用规则。", origin: "authored" }, exerciseIds: ["exercise_step6_evidence"]
  };
  const exercise = { id: "exercise_step6_evidence", cardId: item.id, learningUnitId: item.learningUnitId, version: 1, type: "choice",
    question: "新场景中首先应该做什么？", options: ["忽略条件直接套用", "先核对题干条件", "应用后再检查"], correctIndex: 1,
    answer: "先核对题干条件", answerExplanation: "条件成立后才能应用。", rubric: ["识别条件"],
    misconceptions: ["忽略题干中的必要条件", "", "步骤顺序错误"] };
  await openProfile(page, "profile_step6_evidence", { configured: false, seed: { learningState: state([item]), exercises: [exercise] } });
  await page.getByRole("button", { name: /今日复习 · 1/ }).click();
  await page.getByRole("button", { name: /打开这颗复习扭蛋/ }).click();
  await expect(page.getByText("条件成立后才能应用。", { exact: true })).toHaveCount(0);
  await expect(page.locator(".answer-line")).toHaveCount(0);
  await page.getByRole("button", { name: "看一个提示" }).click();
  await expect(page.getByText(/提示：/)).toBeVisible();
  await page.locator('[data-answer="0"]').click();
  await expect(page.getByText(/本次错因：缺少前提/)).toBeVisible();
  await page.getByRole("button", { name: "纠正错因记录" }).click();
  await page.getByLabel("更符合的错因").selectOption("concept_confusion");
  await page.getByLabel("补充说明（可选）").fill("我把两个条件混在一起了");
  await page.getByRole("button", { name: "追加纠正" }).click();
  await expect(page.locator("#toast")).toContainText("错因纠正已追加");
  const db = await readTestDatabase(page, "profile_step6_evidence");
  expect(db.reviewEvents).toHaveLength(1);
  expect(db.reviewEvents[0].hintUsed).toBe(true);
  expect(db.reviewEvents[0].errorType).toBe("missing_prerequisite");
  expect(db.reviewEventCorrections).toHaveLength(1);
  expect(db.reviewEventCorrections[0].errorType).toBe("concept_confusion");
});

test("第六步：每日目标完成后仍可继续，未来新卡也可主动提前学习", async ({ page }) => {
  const first = card("card_step6_goal_a", "目标甲");
  const second = card("card_step6_goal_b", "目标乙");
  await openProfile(page, "profile_step6_goal", { configured: false, seed: { learningState: state([first, second]), reviewSettings: { dailyGoal: 1 } } });
  await page.getByRole("button", { name: /今日复习 · 2/ }).click();
  await page.getByRole("button", { name: /打开这颗复习扭蛋/ }).click();
  await page.locator('[data-answer="1"]').click();
  await page.getByRole("button", { name: "查看今日完成状态" }).click();
  await expect(page.getByRole("heading", { name: /今天的建议目标已完成/ })).toBeVisible();
  await page.getByRole("button", { name: "继续今天的复习" }).click();
  await expect(page.getByRole("button", { name: /打开这颗复习扭蛋/ })).toBeVisible();

  const future = card("card_step6_future", "分批新卡");
  future.learningStage = "new";
  future.initialLearningCompletedAt = null;
  future.dueAt = Date.now() + 86_400_000;
  await openProfile(page, "profile_step6_future", { configured: false, seed: { learningState: state([future]) } });
  await page.getByRole("button", { name: "查看复习" }).click();
  await expect(page.getByRole("heading", { name: /还有 1 张新卡已分批排入/ })).toBeVisible();
  await page.getByRole("button", { name: "提前学下一张新卡" }).click();
  await expect(page.getByRole("button", { name: /打开这颗复习扭蛋/ })).toBeVisible();
});

test("首页与更多保持主任务优先并适配窄侧边栏", async ({ page }) => {
  await openProfile(page, "profile_e2e_layout", { configured: false });
  await expect(page.getByRole("button", { name: /投入第一段知识/ })).toBeVisible();
  await expect(page.locator("#page")).not.toContainText(/问 Agent|Skill|RAG|MCP/);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await openMore(page);
  await expect(page.getByRole("button", { name: /我的模型/ })).toBeVisible();
  await expect(page.locator("#open-agent")).toHaveCount(0);
  await expect(page.getByRole("navigation").getByRole("button", { name: "伴学", exact: true })).toBeVisible();
});

function createDatabase(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1, version: 1, learningState: state([]), migrations: ["local_storage_v1"], drafts: [], sourceChecks: [], documents: [], discoveryPools: [], reviewEvents: [], preferences: [], candidates: [], runs: [], traces: {}, pendingRuns: {}, audit: [],
    ...overrides
  };
}

function state(cards: ReturnType<typeof card>[]): Record<string, unknown> {
  return { cards, pending: [], totalDraws: cards.length, reviewDay: { day: "2026-08-28", answered: 0, completed: false } };
}

function card(id: string, title: string, citations: unknown[] = []) {
  return {
    id, title, source: "E2E 自动化资料", summary: "只关注当前决策新增的变化。", analogy: "像多做一杯咖啡时只看新增原料。", mantra: "只看新增", plainSummary: "先看新增部分。",
    question: "当前最应该关注什么？", options: ["总量", "新增变化", "无关历史"], correctIndex: 1, citations,
    color: "#ff6f61", favorite: false, mastery: 0, reviewCount: 0, lastCorrectReviewDay: "", createdAt: NOW, updatedAt: NOW, dueAt: 1
  };
}


async function importCardMaterial(page: Page, name = "成本.md", content = "边际成本是每多生产一个单位额外增加的成本。\n\n保留完整背景，供日后继续制卡。") {
  await page.getByRole("button", { name: "制卡", exact: true }).click();
  await expect(page.getByRole("button", { name: /导入文件/ })).toBeVisible();
  await page.locator("#source-file-input").setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(content) });
  await expect(page.getByRole("textbox", { name: "制卡素材", exact: true })).toHaveValue(content);
}

async function generateAndOpen(page: Page) {
  await page.getByRole("button", { name: "凝练成卡" }).click();
  if (await page.getByRole("button", { name: "仍然新建", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "仍然新建", exact: true }).click();
    await page.getByRole("button", { name: "凝练成卡" }).click();
  }
  await expect(page.getByRole("heading", { name: "知识扭蛋已出仓" })).toBeVisible();
  await page.getByRole("button", { name: "打开", exact: true }).click();
}

test("第二步：默认预览解释和自测，局部重做保留修改并展示实测信息", async ({ page }) => {
  await openProfile(page, "profile_step2_partial");
  await importCardMaterial(page);
  await page.getByRole("textbox", { name: "这次想学会什么？（可选）" }).fill("能判断增加一件产品是否值得");
  await generateAndOpen(page);
  await expect(page.getByRole("region", { name: "自测预览" })).toBeVisible();
  await expect(page.locator("#draft-title")).not.toBeVisible();
  await page.getByText("展开答案与要点", { exact: true }).click();
  await expect(page.getByText("4 元", { exact: true }).last()).toBeVisible();
  await expect(page.locator(".generation-metrics")).toContainText("tokens");
  await page.getByText("手动修改内容", { exact: true }).click();
  await page.locator("#draft-title").fill("增加产品数量时如何判断新增成本与收益是否值得");
  await page.locator("#draft-summary").fill("用户修改的解释：比较新增成本和新增收益，保留固定支出的边界。");
  await expect(page.locator("#draft-confirm")).toBeDisabled();
  await page.getByRole("button", { name: "换个例子", exact: true }).click();
  await expect(page.locator("#draft-confirm")).toBeEnabled();
  await expect(page.getByRole("heading", { name: "增加产品数量时如何判断新增成本与收益是否值得" })).toBeVisible();
  await expect(page.locator(".gacha-draft-card")).toContainText("用户修改的解释");
  await expect(page.locator(".gacha-draft-card")).toContainText("加做一份点心");
  await page.getByRole("button", { name: "题目太简单", exact: true }).click();
  await expect(page.locator(".draft-exercise")).toContainText("加做两杯");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: artifactPath("test-results/step02-draft-320.png"), fullPage: true });
  await page.locator("#draft-confirm").click();
  await expect(page.locator(".result-card")).toContainText("用户修改的解释");
  const db = await readTestDatabase(page, "profile_step2_partial");
  expect(db.exercises).toHaveLength(1);
  expect(db.exercises[0].answer).toBe("6 元");
  expect(db.drafts[0].edits.length).toBeGreaterThan(0);
});

test("图片缺少依据后可补充图注重新生成，稍后打开保留图片与文字", async ({ page }, testInfo) => {
  const profile = 'profile_image_caption', errors: string[] = [], requests: any[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:8790/v1/chat/completions', async route => {
    const request = route.request().postDataJSON(), body = request.messages.at(-1).content;
    const input = JSON.parse(Array.isArray(body) ? body.find((part: any) => part.type === 'text').text : body);
    requests.push(input);
    if (input.operation !== 'observe_image') return route.continue();
    // No invented state labels: generation must request a caption first.
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: request.model, choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ observations: ['右侧列标签为 Disk，列中有蓝色矩形。'], legend: [] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
  });
  await openProfile(page, profile, { seed: { learningState: state([card('caption_existing', '已有卡片')]) } });
  const before = await readTestDatabase(page, profile);
  await page.locator('[data-view="feed"]').click();
  await page.locator('#image-input').setInputFiles(resolve('extension/evals/card-quality/materials/commit-3.gif'));
  await expect(page.getByRole('textbox', { name: '图注或补充说明' })).toBeVisible();
  await page.locator('#feed-goal').fill('能识别图中的原始数据');
  await page.locator('#generate-card').click();
  await expect(page.getByRole('listitem').filter({ hasText: '请补充图例或相邻段落' })).toBeVisible();
  await expect(page.locator('#draft-confirm')).toBeDisabled();
  await page.locator('#draft-material').click();
  const image = await page.getByRole('img', { name: '已捕获的知识素材' }).getAttribute('src');
  const caption = '图注：蓝色矩形表示原始数据。每多生产一个单位额外增加的成本，称为边际成本。';
  await page.getByRole('textbox', { name: '图注或补充说明' }).fill(caption);
  await expect(page.getByRole('textbox', { name: '图注或补充说明' })).toHaveValue(caption);
  await expect(page.getByRole('img', { name: '已捕获的知识素材' })).toHaveAttribute('src', image!);
  await expect(page.getByRole('img', { name: '已捕获的知识素材' })).toHaveCSS('object-fit', 'contain');
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('image-caption-320.png'), fullPage: true });
  await page.locator('#generate-card').click();
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  const observations = requests.filter(input => input.operation === 'observe_image').length;
  await page.getByText('手动修改内容', { exact: true }).click();
  await page.locator('#draft-title').fill('补充图注后的草稿');
  await page.getByRole('button', { name: '核验修改', exact: true }).click();
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  expect(requests.filter(input => input.operation === 'observe_image')).toHaveLength(observations);
  expect(requests.some(input => input.operation === 'generate' && input.sources.some((source: any) => source.kind === 'text' && source.text === caption))).toBe(true);
  await page.getByRole('button', { name: '稍后打开', exact: true }).click();
  await page.reload();
  await page.locator('[data-view="feed"]').click();
  await page.locator('#feed-draw').click();
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.locator('#draft-title')).toHaveValue('补充图注后的草稿');
  await expect(page.locator('#draft-confirm')).toBeEnabled();
  const after = await readTestDatabase(page, profile);
  const restored = after.drafts.find((draft: any) => draft.card?.title === '补充图注后的草稿');
  expect(restored.material.image.dataUrl).toBe(image);
  expect(restored.material.text).toBe(caption);
  expect(after.learningState).toEqual(before.learningState);
  expect(after.reviewEvents).toEqual(before.reviewEvents);
  expect(errors).toEqual([]);
});

test("产品验收：模型设置在窄屏和放大布局中可操作且不展示评测入口", async ({ page }, testInfo) => {
  await openProfile(page, "profile_acceptance_model_layout", { configured: false });
  await openMore(page);
  await page.getByRole("button", { name: /我的模型/ }).click();
  for (const width of [320, 480]) for (const zoom of [1, 1.25, 1.5]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator("#model-base-url")).toBeVisible();
    await expect(page.getByText("单卡质量评测", { exact: true })).toHaveCount(0);
    await expect(page.locator('a[href*="evals/card-quality"]')).toHaveCount(0);
    await page.locator("#model-name").focus();
    await expect(page.locator("#model-name")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`model-${width}-zoom-${zoom}.png`), fullPage: true });
  }
});

test("错误答案草稿可恢复，多概念材料转入可编辑学习清单", async ({ page }) => {
  await openProfile(page, "profile_step2_blocked");
  await importCardMaterial(page, "错误.txt", "INVALID_ANSWER_TEST 边际成本是每多生产一个单位额外增加的成本。");
  await page.getByRole("button", { name: "凝练成卡", exact: true }).click();
  await expect(page.locator(".quality-issues")).toContainText("正确答案与选项索引不一致");
  await expect(page.locator("#draft-confirm")).toBeDisabled();
  await page.getByRole("button", { name: "稍后打开", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "制卡", exact: true }).click();
  await page.locator("#feed-draw").click();
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".quality-issues")).toContainText("正确答案与选项索引不一致");
  await page.getByRole("button", { name: "调整材料或目标", exact: true }).click();
  await page.getByRole("textbox", { name: "制卡素材", exact: true }).fill("MULTI_CONCEPT_TEST 缓存新鲜度、Python 排序、事务提交是不同知识目标。");
  await page.getByRole("button", { name: "凝练成卡", exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习清单与卡组', exact: true })).toBeVisible();
  await expect(page.locator('.knowledge-unit')).toHaveCount(1);
  const db = await readTestDatabase(page, "profile_step2_blocked");
  expect(db.learningState.cards).toHaveLength(0);
  expect(db.drafts).toHaveLength(0);
  expect(db.knowledgePlans).toHaveLength(1);
  expect(db.materials[0].text).toContain('MULTI_CONCEPT_TEST');
});

test("第二步：回忆题收下后仍展示要点，复习记录明确是自评", async ({ page }) => {
  await openProfile(page, "profile_step2_recall");
  await importCardMaterial(page, "回忆.txt", "RECALL_TEST 边际成本是每多生产一个单位额外增加的成本。");
  await generateAndOpen(page);
  await expect(page.getByRole("textbox", { name: "尝试回答", exact: true })).toBeVisible();
  await page.locator("#draft-confirm").click();
  await expect(page.locator(".result-card")).toBeVisible();
  await page.evaluate(async () => {
    const repository = (window as any).KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: 'profile_step2_recall' });
    const db = await repository.get('state', 'current'); db.learningState.cards[0].dueAt = 0;
    await repository.put('state', 'current', db); await repository.close();
  });
  await page.reload();
  await page.getByRole("button", { name: /今日复习 · 1/ }).click();
  await page.getByRole("button", { name: /打开这颗复习扭蛋/ }).click();
  await page.getByRole("textbox", { name: "回忆作答" }).fill("原来的月租不随这次增加产品而变化。");
  await expect(page.getByText("因为决策不会改变该支出", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "对照答案与要点" }).click();
  await page.getByRole("button", { name: "已答出要点" }).click();
  await expect(page.getByText("已记录你的自评。", { exact: true })).toBeVisible();
});

test("文件直接制卡：关闭开关只留片段，卡片可回查且没有资料管理入口", async ({ page }) => {
  await openProfile(page, "profile_step1_excerpt");
  await importCardMaterial(page);
  await expect(page.getByRole("switch", { name: "随卡片保留原文" })).not.toBeChecked();
  await generateAndOpen(page);
  await expect(page.locator(".gacha-draft-card")).not.toContainText(/已核对|参考已确认偏好/);
  await expect(page.locator('.draft-evidence > summary')).toHaveText('查看原文（1 处）');
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  await page.locator('.card-sources > summary').click();
  await expect(page.getByText("仅保留片段", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看依据", exact: true }).click();
  await expect(page.getByText("仅保留最小依据", { exact: true })).toBeVisible();
  await expect(page.locator("mark")).toHaveText("每多生产一个单位额外增加的成本");
  await expect(page.getByRole("button", { name: "打开已保留原文" })).toHaveCount(0);
  const db = await readTestDatabase(page, "profile_step1_excerpt");
  expect(db.documents).toHaveLength(0);
  expect(db.learningState.cards).toHaveLength(1);
  await page.reload();
  await openMore(page);
  await expect(page.getByRole("button", { name: /我的资料/ })).toHaveCount(0);
});

test("完整来源可打开并继续制卡；移除全文保留收藏、依据和卡片", async ({ page }) => {
  await openProfile(page, "profile_step1_full");
  await importCardMaterial(page);
  await page.getByRole("switch", { name: "随卡片保留原文" }).click();
  await generateAndOpen(page);
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  await page.locator('.card-sources > summary').click();
  await page.getByRole("button", { name: "打开已保留原文" }).click();
  await expect(page.getByRole("textbox", { name: "已保留原文" })).toContainText("保留完整背景");
  await page.getByRole("button", { name: "用选中内容制卡" }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材", exact: true })).toContainText("保留完整背景");
  await generateAndOpen(page);
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  // The click starts an async IndexedDB commit; observe completion before reading its index.
  await expect.poll(async () => (await readTestDatabase(page, "profile_step1_full")).learningState.cards.length).toBe(2);
  let db = await readTestDatabase(page, "profile_step1_full");
  expect(db.documents).toHaveLength(1);
  expect(db.learningState.cards).toHaveLength(2);
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  await page.locator('.card-sources > summary').click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "移除原文附件", exact: true }).click();
  await expect(page.getByText("原文已移除", { exact: true })).toBeAttached();
  await page.locator('.card-sources > summary').click();
  await expect(page.getByText("原文已移除", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "已收藏", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看依据", exact: true }).click();
  await expect(page.getByText("原文已移除 · 已保留最小依据")).toBeVisible();
  await expect(page.locator("mark")).toHaveText("每多生产一个单位额外增加的成本");
  await page.reload();
  db = await readTestDatabase(page, "profile_step1_full");
  expect(db.documents).toHaveLength(0);
  expect(db.learningState.cards).toHaveLength(2);
  expect(db.learningState.cards.every((card: any) => card.sourceSnapshot.status === "removed")).toBe(true);
});

test("历史材料可恢复，长文件明确范围且窄屏不溢出", async ({ page }) => {
  await openProfile(page, "profile_step1_history", { seed: { documents: [{ id: "doc_history", title: "历史笔记", type: "text", content: "这是旧版保存的原文材料，用于从历史继续整理知识。", byteSize: 90, createdAt: NOW }] } });
  await page.getByRole("button", { name: "制卡", exact: true }).click();
  await expect(page.locator("#historical-materials")).toHaveCount(0);
  await openMore(page);
  await page.getByRole("button", { name: /历史材料/ }).click();
  await page.getByRole("button", { name: "继续制卡", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "已保留原文" })).toContainText("旧版保存");
  await page.getByRole("button", { name: "用选中内容制卡" }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材", exact: true })).toContainText("旧版保存");
  await page.locator("#source-file-input").setInputFiles({ name: "长文件.txt", mimeType: "text/plain", buffer: Buffer.from("背景".repeat(7000) + "目标知识用于选择范围") });
  await expect(page.locator(".capture-reading-note")).toContainText("当前范围：1–14010");
  await page.getByText("查看全部文字并选择范围").click();
  await page.locator("#material-full-text").evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(14000, node.value.length));
  await page.getByRole("button", { name: "使用选中内容", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材", exact: true })).toHaveValue("目标知识用于选择范围");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: artifactPath("test-results/step01-feed-320.png"), fullPage: true });
});

test("草稿稍后恢复编辑，放弃不留全文；确认失败可再次收下", async ({ page }) => {
  await openProfile(page, "profile_step1_recovery");
  await importCardMaterial(page);
  await page.getByRole("switch", { name: "随卡片保留原文" }).click();
  await generateAndOpen(page);
  await page.getByText("手动修改内容", { exact: true }).click();
  await page.locator("#draft-title").fill("可恢复标题");
  await page.getByRole("button", { name: "稍后打开", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "制卡", exact: true }).click();
  await page.locator("#feed-draw").click();
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator("#draft-title")).toHaveValue("可恢复标题");
  await page.getByRole("button", { name: "放弃草稿", exact: true }).click();
  let db = await readTestDatabase(page, "profile_step1_recovery");
  expect(db.documents).toHaveLength(0);
  expect(db.drafts).toHaveLength(0);
  await importCardMaterial(page);
  await page.getByRole("switch", { name: "随卡片保留原文" }).click();
  await generateAndOpen(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "state" && key === "profile_step1_recovery:current" && value.drafts.some((draft: any) => draft.status === "confirmed")) {
        IDBObjectStore.prototype.put = original;
        throw new Error("存储空间不足，请重试");
      }
      return original.call(this, value, key);
    };
  });
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  await expect(page.getByRole("heading", { name: "查看解释和自测" })).toBeVisible();
  await expect(page.locator("#toast")).toContainText("存储空间不足");
  db = await readTestDatabase(page, "profile_step1_recovery");
  expect(db.documents).toHaveLength(0);
  expect(db.learningState.cards).toHaveLength(0);
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  await page.locator('.card-sources > summary').click();
  await expect(page.getByText("已保留原文", { exact: true })).toBeVisible();
});


test("旧版材料草稿从更多恢复，继续制卡并清理临时材料", async ({ page }) => {
  const source = { type: "file", title: "成本.md", capturedAt: NOW };
  await openProfile(page, "profile_step1_material", { seed: { drafts: [{
    id: "draft_existing_material", status: "material", source, createdAt: NOW, updatedAt: NOW,
    material: { text: "边际成本是每多生产一个单位额外增加的成本。\n\n保留完整背景，供日后继续制卡。", source }
  }] } });
  await page.reload();
  await page.getByRole("button", { name: "制卡", exact: true }).click();
  await expect(page.getByRole("region", { name: "材料草稿" })).toHaveCount(0);
  await openMore(page);
  await page.getByRole("button", { name: /历史材料/ }).click();
  await page.getByRole("region", { name: "材料草稿" }).getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材", exact: true })).toContainText("保留完整背景");
  await generateAndOpen(page);
  await page.getByRole("button", { name: /收下并安排复习/ }).click();
  await page.locator('.card-sources > summary').click();
  await expect(page.getByText("仅保留片段", { exact: true })).toBeVisible();
  const db = await readTestDatabase(page, "profile_step1_material");
  expect(db.drafts).toHaveLength(1);
  expect(db.drafts[0].status).toBe("confirmed");
  expect(db.drafts[0].material).toBeUndefined();
  expect(db.documents).toHaveLength(0);
  await page.getByRole("button", { name: "制卡", exact: true }).click();
  await expect(page.getByRole("region", { name: "材料草稿" })).toHaveCount(0);
  await openMore(page);
  await expect(page.getByRole("button", { name: /历史材料/ })).toHaveCount(0);
});

test("从历史材料放弃旧草稿，只移除该草稿并保留其他材料", async ({ page }) => {
  const source = { type: "manual", title: "旧草稿", capturedAt: NOW };
  await openProfile(page, "profile_material_history_discard", { seed: {
    drafts: [{ id: "draft_discard_history", status: "material", source, createdAt: NOW, updatedAt: NOW, material: { text: "准备放弃的旧草稿。", source } }],
    documents: [{ id: "doc_keep_history", title: "保留的历史笔记", type: "text", content: "这份历史笔记仍可继续制卡。", byteSize: 60, createdAt: NOW }]
  } });
  await openMore(page);
  await page.getByRole("button", { name: /历史材料/ }).click();
  await page.getByRole("region", { name: "材料草稿" }).getByRole("button", { name: "放弃", exact: true }).click();
  await expect(page.getByRole("region", { name: "材料草稿" })).toHaveCount(0);
  await expect(page.getByText("保留的历史笔记", { exact: true })).toBeVisible();
  await page.reload();
  const db = await readTestDatabase(page, "profile_material_history_discard");
  expect(db.drafts).toHaveLength(0);
  expect(db.documents.map((document: any) => document.id)).toEqual(["doc_keep_history"]);
  await openMore(page);
  await page.getByRole("button", { name: /历史材料/ }).click();
  await page.getByRole("button", { name: "继续制卡", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "已保留原文" })).toHaveValue("这份历史笔记仍可继续制卡。");
});

