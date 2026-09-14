const test = require("node:test");
const assert = require("node:assert/strict");

const domain = require("../src/frontend/domain/card-domain.js");
const storageModule = require("../src/frontend/settings/browser-storage.js");

class MemoryStorage {
  constructor(initial) {
    this.values = new Map(Object.entries(initial || {}));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function createAdapter(initial, sessionInitial) {
  const persistent = new MemoryStorage(initial);
  const session = new MemoryStorage(sessionInitial);
  const adapter = storageModule.createStorageAdapter(persistent, session, {
    sanitizeCard: domain.sanitizeCard,
    normalizeText: domain.normalizeText,
    defaultBaseUrl: "https://example.test/v1",
    defaultModel: "test-model",
    dailyReviewLimit: 3,
    createProfileId: function () { return "fixedprofile123"; }
  });
  return { adapter: adapter, persistent: persistent, session: session };
}

test("空存储返回稳定默认值", function () {
  const result = createAdapter();
  assert.deepEqual(result.adapter.loadCards(), []);
  assert.deepEqual(result.adapter.loadPending(), []);
  assert.deepEqual(result.adapter.loadSettings(), {
    baseUrl: "https://example.test/v1",
    model: "test-model",
    temperature: 0.7,
    reducedMotion: null
  });
  assert.equal(result.adapter.loadTotalDraws(), 0);
});

test("卡片和待打开列表可往返，并在读取时兼容旧字段", function () {
  const result = createAdapter();
  result.adapter.saveCards([{ id: "c1", title: " 卡片 ", options: ["A", "B", "C"], correctIndex: "B" }]);
  result.adapter.savePending([{ id: "p1", title: "待打开" }]);

  const cards = result.adapter.loadCards();
  const pending = result.adapter.loadPending();
  assert.equal(cards[0].title, "卡片");
  assert.equal(cards[0].correctIndex, 1);
  assert.equal(pending[0].id, "p1");
  assert.equal(pending[0].options.length, 0);
});

test("损坏 JSON 和错误数据类型不会阻断启动", function () {
  const keys = storageModule.KEYS;
  const result = createAdapter({
    [keys.cards]: "{broken",
    [keys.pending]: JSON.stringify({ not: "an array" }),
    [keys.settings]: "["
  });
  assert.deepEqual(result.adapter.loadCards(), []);
  assert.deepEqual(result.adapter.loadPending(), []);
  assert.equal(result.adapter.loadSettings().model, "test-model");
});

test("设置温度执行上下界限制且非法值回退", function () {
  const key = storageModule.KEYS.settings;
  assert.equal(createAdapter({ [key]: JSON.stringify({ temperature: -2 }) }).adapter.loadSettings().temperature, 0.2);
  assert.equal(createAdapter({ [key]: JSON.stringify({ temperature: 9 }) }).adapter.loadSettings().temperature, 1.2);
  assert.equal(createAdapter({ [key]: JSON.stringify({ temperature: "invalid" }) }).adapter.loadSettings().temperature, 0.7);
});

test("减弱动画设置兼容系统默认并保留显式开关", function () {
  const key = storageModule.KEYS.settings;
  assert.equal(createAdapter().adapter.loadSettings().reducedMotion, null);
  assert.equal(createAdapter({ [key]: JSON.stringify({ reducedMotion: true }) }).adapter.loadSettings().reducedMotion, true);
  assert.equal(createAdapter({ [key]: JSON.stringify({ reducedMotion: false }) }).adapter.loadSettings().reducedMotion, false);
  assert.equal(createAdapter({ [key]: JSON.stringify({ reducedMotion: "true" }) }).adapter.loadSettings().reducedMotion, null);
});

test("抽卡总数拒绝负数和非数字并保存非负值", function () {
  const key = storageModule.KEYS.totalDraws;
  assert.equal(createAdapter({ [key]: "-4" }).adapter.loadTotalDraws(), 0);
  assert.equal(createAdapter({ [key]: "NaN" }).adapter.loadTotalDraws(), 0);
  const result = createAdapter();
  result.adapter.saveTotalDraws(5);
  assert.equal(result.adapter.loadTotalDraws(), 5);
  result.adapter.saveTotalDraws(-3);
  assert.equal(result.adapter.loadTotalDraws(), 0);
});

test("每日复习状态跨日重置且完成目标后仍保留继续作答数", function () {
  const key = storageModule.KEYS.reviewDay;
  const today = new Date(2026, 7, 26, 12, 0, 0).getTime();
  const sameDay = createAdapter({ [key]: JSON.stringify({ day: "2026-08-26", answered: 99, completed: false }) });
  assert.deepEqual(sameDay.adapter.loadReviewDay(today), { day: "2026-08-26", answered: 99, completed: false, continueAfterGoal: false, lastLearningUnitId: null });

  const oldDay = createAdapter({ [key]: JSON.stringify({ day: "2026-08-25", answered: 2, completed: true }) });
  assert.deepEqual(oldDay.adapter.loadReviewDay(today), { day: "2026-08-26", answered: 0, completed: false });
});

test("清空学习数据但保留服务端档案和迁移标记", function () {
  const initial = {};
  Object.values(storageModule.KEYS).forEach(function (key) { initial[key] = "value"; });
  initial[storageModule.KEYS.profileId] = "profile_existing123";
  initial[storageModule.KEYS.migration] = "complete";
  const result = createAdapter(initial, { [storageModule.KEYS.apiKey]: "legacy" });
  result.adapter.clearAll();
  storageModule.CLEARABLE_KEYS.forEach(function (key) {
    assert.equal(result.persistent.getItem(key), null);
  });
  assert.equal(result.persistent.getItem(storageModule.KEYS.profileId), "profile_existing123");
  assert.equal(result.persistent.getItem(storageModule.KEYS.migration), "complete");
  assert.equal(result.session.getItem(storageModule.KEYS.apiKey), null);
});

test("模型设置与 API Key 可恢复，密钥可选择会话或本地持久保存", function () {
  const keys = storageModule.KEYS;
  const result = createAdapter();
  result.adapter.saveSettings({ baseUrl: "https://model.example/v1", model: "user-model", temperature: 0.6, reducedMotion: true });
  result.adapter.saveApiKey("session-secret", false);
  assert.equal(result.adapter.loadSettings().model, "user-model");
  assert.equal(result.adapter.loadSettings().reducedMotion, true);
  assert.equal(result.adapter.loadApiKey(), "session-secret");
  assert.equal(result.adapter.hasPersistentApiKey(), false);
  assert.equal(result.persistent.getItem(keys.apiKey), null);
  assert.equal(result.session.getItem(keys.apiKey), "session-secret");

  result.adapter.saveApiKey("persistent-secret", true);
  assert.equal(result.adapter.loadApiKey(), "persistent-secret");
  assert.equal(result.adapter.hasPersistentApiKey(), true);
  assert.equal(result.persistent.getItem(keys.apiKey), "persistent-secret");
  assert.equal(result.session.getItem(keys.apiKey), null);

  result.adapter.clearApiKey();
  assert.equal(result.adapter.loadApiKey(), "");
});

test("本地档案 ID 稳定生成且损坏值会被替换", function () {
  const first = createAdapter();
  assert.equal(first.adapter.getOrCreateProfileId(), "profile_fixedprofile123");
  assert.equal(first.adapter.getOrCreateProfileId(), "profile_fixedprofile123");
  const invalid = createAdapter({ [storageModule.KEYS.profileId]: "../bad" });
  assert.equal(invalid.adapter.getOrCreateProfileId(), "profile_fixedprofile123");
});

test("学习快照去重并可整体缓存", function () {
  const keys = storageModule.KEYS;
  const duplicate = { id: "same-card", title: "同一张卡" };
  const result = createAdapter({
    [keys.cards]: JSON.stringify([duplicate, duplicate]),
    [keys.pending]: JSON.stringify([duplicate, { id: "pending-only", title: "待打开" }]),
    [keys.totalDraws]: "2.9",
    [keys.reviewDay]: JSON.stringify({ day: "2026-08-26", answered: 1, completed: false })
  });
  const snapshot = result.adapter.loadLearningStateSnapshot(new Date(2026, 7, 26, 12).getTime());
  assert.deepEqual(snapshot.cards.map(function (card) { return card.id; }), ["same-card"]);
  assert.deepEqual(snapshot.pending.map(function (card) { return card.id; }), ["pending-only"]);
  assert.equal(snapshot.totalDraws, 2);
  snapshot.totalDraws = 5;
  assert.equal(result.adapter.saveLearningStateSnapshot(snapshot), true);
  assert.equal(result.adapter.loadTotalDraws(), 5);
});

test("迁移与脏同步标记可独立推进", function () {
  const result = createAdapter();
  assert.equal(result.adapter.isMigrationComplete(), false);
  assert.equal(result.adapter.isSyncDirty(), false);
  result.adapter.markMigrationComplete();
  result.adapter.markSyncDirty();
  assert.equal(result.adapter.isMigrationComplete(), true);
  assert.equal(result.adapter.isSyncDirty(), true);
  result.adapter.markSyncClean();
  assert.equal(result.adapter.isSyncDirty(), false);
});
