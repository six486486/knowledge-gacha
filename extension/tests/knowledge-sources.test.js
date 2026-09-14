const test = require("node:test");
const assert = require("node:assert/strict");
const domain = require("../src/frontend/domain/card-domain.js");
const { createExtensionService, DB_KEY } = require("../src/backend/application/extension-service.js");
const { memoryStorage } = require("../src/shared/runtime-utils.js");

const { qualityOutput, requestPayload } = require("./fixtures/quality-output.js");

const NOW = 1788300000000;
const KEY = DB_KEY + ":default";
const TEXT = "边际成本是每多生产一个单位额外增加的成本。\n\n" + "这段是完整背景，不应在关闭保留时永久保存。".repeat(30);
function fixture(seed) {
  const storage = memoryStorage();
  if (seed) storage.setItem(KEY, JSON.stringify(seed));
  const service = createExtensionService({ storage, cardDomain: domain, providerModule: {}, now: () => NOW,
    providerTransport: { complete: async (_, request) => ({ content: JSON.stringify(qualityOutput(requestPayload(request))), provider: { model: "test", latencyMs: 1 } }) } });
  return { storage, service, db: () => JSON.parse(storage.getItem(KEY) || "{}") };
}
async function draft(f, retain = false, source = {}, text = TEXT, plan = {}) {
  return (await f.service.createGachaCardDraft({ text, source: { type: "file", title: "成本.md", capturedAt: NOW, ...source },
    sourcePlan: { saveFullSource: retain, duplicateAction: "create_new", ...plan } })).session;
}
async function confirm(f, retain = false, source = {}, text = TEXT, plan = {}) {
  const session = await draft(f, retain, source, text, plan);
  return f.service.confirmGachaCardDraft(session.id);
}

test("关闭保留时仅存真实片段和关系，确认后清掉草稿全文", async () => {
  const f = fixture();
  const result = await confirm(f);
  const db = f.db();
  assert.equal(db.schemaVersion, 8);
  assert.equal(db.documents.length, 0);
  assert.equal(db.sources.length, 1);
  assert.equal(db.learningUnits.length, 1);
  assert.equal(db.drafts[0].material, undefined);
  assert.ok(!JSON.stringify(db).includes(TEXT));
  const card = result.card;
  assert.equal(card.citations[0].claim, "summary");
  assert.equal(card.citations[0].quote, "每多生产一个单位额外增加的成本");
  assert.equal(card.sourceSnapshot.status, "excerpt_only");
  assert.equal(card.sourceSnapshot.fullSourceDocumentId, null);
  const resolved = await f.service.resolveCitation(card.citations[0]);
  assert.equal(resolved.status, "excerpt_only");
  assert.equal(resolved.excerpt.highlight, card.citations[0].quote);
});

test("开启保留在确认时保存完整选定范围；重复确认不重建、不改排期", async () => {
  const f = fixture();
  const session = await draft(f, true);
  assert.equal(f.db().documents.length, 0);
  assert.equal(f.db().sources.length, 0);
  const first = await f.service.confirmGachaCardDraft(session.id);
  const saved = f.db();
  const second = await f.service.confirmGachaCardDraft(session.id);
  assert.deepEqual(f.db(), saved);
  assert.equal(first.card.id, second.card.id);
  assert.equal((await f.service.getDocument(first.card.sourceSnapshot.fullSourceDocumentId)).document.content, TEXT);
  assert.equal((await f.service.resolveCitation(first.card.citations[0])).status, "available");
  await f.service.deleteCards([first.card.id]);
  assert.throws(() => f.service.confirmGachaCardDraft(session.id), /后来已删除/);
});

test("放弃草稿不产生永久来源；材料和编辑可恢复且不被24条限额清掉", async () => {
  const f = fixture();
  const first = await draft(f, true);
  await f.service.updateGachaCardDraft(first.id, { title: "编辑后的标题" });
  assert.equal((await f.service.getGachaCardDraft(first.id)).session.material.text, TEXT);
  for (let index = 0; index < 24; index++) await draft(f);
  assert.equal((await f.service.listGachaCardDrafts()).sessions.length, 25);
  assert.equal((await f.service.getGachaCardDraft(first.id)).session.card.title, "编辑后的标题");
  await f.service.discardGachaCardDraft(first.id);
  assert.equal(f.db().documents.length, 0);
  assert.equal(f.db().learningState.cards.length, 0);
  assert.ok(!f.db().drafts.some(item => item.id === first.id));
});

test("确认写入失败不留下部分卡片或来源，原草稿可重试", async () => {
  const f = fixture();
  const session = await draft(f, true);
  const before = f.storage.getItem(KEY);
  const write = f.storage.setItem;
  f.storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.throws(() => f.service.confirmGachaCardDraft(session.id), /QuotaExceededError/);
  assert.equal(f.storage.getItem(KEY), before);
  assert.equal((await f.service.getGachaCardDraft(session.id)).session.status, "ready");
  f.storage.setItem = write;
  await f.service.confirmGachaCardDraft(session.id);
  assert.equal(f.db().learningState.cards.length, 1);
  assert.equal(f.db().documents.length, 1);
});

test("同一保留原文继续制卡复用全文，删除一张卡不清理其他引用", async () => {
  const f = fixture();
  const first = await confirm(f, true);
  const documentId = first.card.sourceSnapshot.fullSourceDocumentId;
  const second = await confirm(f, true, { documentId }, TEXT.slice(25));
  assert.notEqual(first.card.id, second.card.id);
  assert.notEqual(first.card.learningUnitId, second.card.learningUnitId);
  assert.equal(f.db().documents.length, 1);
  assert.equal(f.db().sources.length, 1);
  assert.equal((await f.service.listDocuments()).documents[0].linkedCardCount, 2);
  await f.service.deleteCards([first.card.id], { removeUnusedSources: true });
  assert.equal(f.db().documents.length, 1);
  assert.equal((await f.service.resolveCitation(second.card.citations[0])).status, "available");
  await f.service.deleteCards([second.card.id], { removeUnusedSources: true });
  assert.equal(f.db().documents.length, 0);
});

test("移除共享原文保留卡片收藏、复习事件和最小依据，独立移除来源信息只作用于指定卡", async () => {
  const f = fixture();
  const first = await confirm(f, true);
  const documentId = first.card.sourceSnapshot.fullSourceDocumentId;
  const second = await confirm(f, false, { documentId });
  const state = (await f.service.loadLearningState()).state;
  state.cards[0].favorite = true;
  state.cards.find(card => card.id === second.card.id).dueAt = NOW - 1;
  await f.service.replaceLearningState(state);
  const opened = await f.service.openGachaReview(second.card.id);
  const storedExercise = f.db().exercises.find(question => question.id === opened.question.exerciseId);
  await f.service.answerGachaReview(second.card.id, { attemptId: opened.question.attemptId, chosenIndex: storedExercise.correctIndex,
    exerciseId: opened.question.exerciseId, exerciseVersion: opened.question.exerciseVersion, mutationId: "source-review-once" });
  const before = f.db();
  await f.service.deleteDocument(documentId);
  const after = f.db();
  assert.deepEqual(after.reviewEvents, before.reviewEvents);
  assert.equal(after.learningState.cards[0].favorite, true);
  assert.equal(after.learningState.cards[0].reviewCount, before.learningState.cards[0].reviewCount);
  for (const card of after.learningState.cards) {
    assert.equal(card.sourceSnapshot.status, "removed");
    assert.equal(card.sourceSnapshot.fullSourceDocumentId, null);
    assert.equal((await f.service.resolveCitation(card.citations[0])).status, "removed");
  }
  await f.service.removeCardSourceInfo(second.card.id);
  const cards = (await f.service.loadLearningState()).state.cards;
  assert.equal(cards.find(card => card.id === second.card.id).citations.length, 0);
  assert.equal(cards.find(card => card.id === second.card.id).sourceSnapshot, null);
  assert.equal(cards.find(card => card.id === first.card.id).citations.length, 2);
});

test("旧同名卡按ID独立迁移，历史资料不丢失、不伪造无出处卡引用", async () => {
  const a = domain.sanitizeCard({ id: "legacy_a", title: "同名", favorite: true, mastery: 3, reviewCount: 5 });
  const b = domain.sanitizeCard({ id: "legacy_b", title: "同名", source: "模型生成内容" });
  const oldDocument = { id: "doc_legacy", title: "历史.md", type: "text", content: TEXT, byteSize: 100, createdAt: NOW };
  const f = fixture({ schemaVersion: 1, learningState: { cards: [a, b], pending: [], totalDraws: 2, reviewDay: {} }, documents: [oldDocument], reviewEvents: [{ cardId: a.id, correct: true }] });
  const state = (await f.service.loadLearningState()).state;
  assert.notEqual(state.cards[0].learningUnitId, state.cards[1].learningUnitId);
  assert.equal(state.cards[0].favorite, true);
  assert.equal(state.cards[0].reviewCount, 5);
  assert.equal(state.cards[1].citations.length, 0);
  assert.equal(state.cards[1].sourceSnapshot, null);
  assert.equal((await f.service.listDocuments()).documents[0].linkedCardCount, 0);
  await f.service.replaceLearningState(state);
  assert.equal(f.db().learningUnits.length, 2);
  assert.equal(f.db().learningUnits[0].legacyCardId, a.id);
  assert.equal(f.db().documents[0].content, TEXT);
});

test("明确合并保留学习单元和全部学习状态，模型输出不成为伪造依据", async () => {
  const f = fixture();
  const first = await confirm(f);
  const state = (await f.service.loadLearningState()).state;
  Object.assign(state.cards[0], { favorite: true, mastery: 4, reviewCount: 9, lastCorrectReviewDay: "2026-09-01" });
  await f.service.replaceLearningState(state);
  const result = await confirm(f, false, {}, "第二份材料的原文用于补充原卡，与上一份有所不同。", { duplicateAction: "merge", targetCardId: first.card.id });
  assert.equal(result.card.learningUnitId, first.card.learningUnitId);
  assert.equal(result.card.version, 2);
  assert.equal(result.card.favorite, true);
  assert.equal(result.card.mastery, 4);
  assert.equal(result.card.reviewCount, 9);
  assert.equal(result.card.lastCorrectReviewDay, "2026-09-01");
  assert.equal(result.card.citations.length, 4);
  assert.ok(result.card.citations.every(span => !span.quote.includes("模型编造")));
});

test("拒绝超长未选范围的输入，图片与发现主题不伪造文字依据", async () => {
  const f = fixture();
  await assert.rejects(draft(f, true, {}, "字".repeat(12001)), /12000/);
  const imageDraft = (await f.service.createGachaCardDraft({ text: "", image: { dataUrl: "data:image/png;base64,abc" }, source: { type: "image", title: "图" }, sourcePlan: { saveFullSource: true } })).session;
  const image = await f.service.confirmGachaCardDraft(imageDraft.id);
  assert.equal(image.card.citations.length, 0);
  assert.equal(image.card.sourceSnapshot.status, "unavailable");
  await assert.rejects(f.service.createGachaDiscoveryPool(), /配置模型/);
  assert.equal(f.db().documents.length, 0);
});

test("原文回查按位置和版本核对，重复文字不能掩盖错误位置", async () => {
  const f = fixture();
  const result = await confirm(f, true);
  const span = result.card.citations[0];
  await assert.rejects(f.service.resolveCitation({ ...span, position: { ...span.position, startCharacter: 20 } }), /位置|变化/);
  await assert.rejects(f.service.resolveCitation({ ...span, source: { ...span.source, version: 2 } }), /版本/);
});

test("重复导入相同来源不重复全文，相同段落按实际选定范围定位", async () => {
  const f = fixture();
  const text = "重复段落用于学习。\n重复段落用于学习。";
  const first = await confirm(f, true, {}, text);
  await confirm(f, true, {}, text);
  assert.equal(f.db().documents.length, 1);
  const start = text.indexOf("\n") + 1;
  const reused = await confirm(f, false, { documentId: first.card.sourceSnapshot.fullSourceDocumentId, range: { start, end: text.length } }, text.slice(start));
  assert.equal(reused.card.citations[0].position.startCharacter, start);
  assert.equal((await f.service.resolveCitation(reused.card.citations[0])).status, "available");
});

test("生成前可以保存材料草稿，成功生成后替换草稿而不入库原文", async () => {
  const f = fixture();
  const material = { text: TEXT, source: { type: "file", title: "暂存.md" } };
  const saved = await f.service.saveGachaMaterialDraft(material);
  const edited = await f.service.saveGachaMaterialDraft({ ...material, text: "修改后的材料" }, saved.session.id);
  assert.equal(saved.session.id, edited.session.id);
  assert.equal((await f.service.listGachaCardDrafts()).sessions[0].material.text, "修改后的材料");
  assert.equal(f.db().documents.length, 0);
  assert.equal(f.db().sources.length, 0);
  await f.service.createGachaCardDraft({ ...material, materialDraftId: saved.session.id });
  assert.equal(f.db().drafts.length, 1);
  assert.equal(f.db().drafts[0].status, "ready");
  assert.equal(f.db().documents.length, 0);
});
