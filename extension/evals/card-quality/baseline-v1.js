// Frozen step-01 production prompt and teaching-field normalization, for paired evaluation only.
(function (root, factory) {
  const common = typeof module === "object" && module.exports;
  const api = factory(common ? require("../../src/frontend/domain/card-domain.js") : root.KnowledgeGachaCardDomain);
  if (common) module.exports = api;
  else root.KnowledgeGachaQualityBaseline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (domain) {
const prompt = '你是知识卡生成器。只输出 JSON：{"cards":[{"title":"不超过12字","source":"来源片段","summary":"核心解释","plainSummary":"大白话","analogy":"生活类比","mantra":"记忆口诀","question":"一道题","options":["选项A","选项B","选项C"],"correctIndex":0}]}。不得输出思考过程。';
function parse(content, rawText) {
  const payload = domain.extractJson(content);
  let cards = payload.cards || payload.data || payload.result || payload.items || payload;
  if (!Array.isArray(cards)) cards = [cards];
  if (!cards.length) throw new Error("模型没有生成卡片");
  const c = cards[0], get = (keys) => domain.firstValue(c, keys), norm = domain.normalizeText;
  const source = norm(get(["source", "src", "来源", "原文", "片段"]) || rawText).slice(0, 120);
  const title = norm(get(["title", "t", "标题", "知识点", "name"]) || "知识点 1").slice(0, 12);
  const options = domain.normalizeOptions(get(["options", "o", "选项", "choices", "answers"])).slice(0, 3);
  while (options.length < 3) options.push(["用自己的话解释它", "只把名词背下来", "先收藏以后再说"][options.length]);
  return { title, source, summary: norm(get(["summary", "s", "解释", "简述", "description"]) || `它的重点是：${source}`),
    analogy: norm(get(["example", "e", "lifeExample", "analogy", "a", "例子", "生活例子", "类比", "比喻"])) || domain.fallbackAnalogy(title, source),
    mantra: norm(get(["mantra", "m", "口诀", "记忆点", "一句话"])) || domain.fallbackMantra(title, source),
    plainSummary: norm(get(["plainSummary", "plain", "p", "人话", "说人话", "人话解释"])).slice(0, 96),
    question: norm(get(["question", "q", "题目", "quiz"]) || `理解「${title}」最该先抓什么？`), options,
    correctIndex: domain.parseCorrectIndex(get(["correctIndex", "correct_index", "answerIndex", "c", "answer", "正确选项", "答案"]), options) };
}
return { prompt, parse, version: "concept-card-v1-step01" };
});
