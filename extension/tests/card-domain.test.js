const test = require("node:test");
const assert = require("node:assert/strict");

const domain = require("../src/frontend/domain/card-domain.js");

const fixedContext = { now: 1724630400000, random: function () { return 0.123; } };

test("解析带思考段和 Markdown 围栏的别名字段", function () {
  const content = '<think>内部分析</think>\n```json\n{"cards":[{"t":"边际成本","src":"多生产一个单位增加的成本","s":"它帮助判断增量决策","e":"像多做一杯咖啡","m":"只看新增部分","q":"应该关注什么？","o":["总成本","新增成本","沉没成本"],"c":"B"}]}\n```';
  const cards = domain.parseCardsResponse(content, "备用来源", fixedContext);

  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "ai_1724630400000_123");
  assert.equal(cards[0].title, "边际成本");
  assert.equal(cards[0].source, "多生产一个单位增加的成本");
  assert.equal(cards[0].correctIndex, 1);
  assert.deepEqual(cards[0].options, ["总成本", "新增成本", "沉没成本"]);
});

test("多卡数组明确待拆分，缺失教学字段不再自动补齐", function () {
  assert.throws(() => domain.parseCardsResponse('[{"title":"甲"},{"title":"乙"}]', "来源文本"), /待拆分/);
  const card = domain.parseCardsResponse('[{"title":"RAG","summary":"检索增强生成"}]', "来源文本", fixedContext)[0];
  assert.equal(card.analogy, "");
  assert.equal(card.mantra, "");
  assert.equal(card.question, "");
  assert.deepEqual(card.options, []);
});

test("非 JSON、空卡组和 JSON 标量会明确拒绝", function () {
  assert.throws(function () { domain.parseCardsResponse("普通文本", ""); }, /模型返回不是 JSON/);
  assert.throws(function () { domain.parseCardsResponse('{"cards":[]}', ""); }, /模型没有生成卡片/);
  assert.throws(function () { domain.parseCardsResponse("null", ""); }, /模型返回不是 JSON|模型没有生成卡片/);
});

test("平衡 JSON 识别不会被字符串中的括号和转义引号截断", function () {
  const source = '前缀 {"summary":"包含 } 和 \\\"引号\\\"","options":["A","B","C"]} 后缀';
  const json = domain.findBalancedJson(source);
  assert.deepEqual(JSON.parse(json), { summary: '包含 } 和 "引号"', options: ["A", "B", "C"] });
});

test("选项兼容旧输入格式，但不补齐缺失选项", function () {
  assert.deepEqual(domain.normalizeOptions({ A: "甲", B: "乙", C: "丙" }), ["甲", "乙", "丙"]);
  assert.deepEqual(domain.normalizeOptions("甲|乙"), ["甲", "乙"]);
  assert.deepEqual(domain.normalizeOptions(["甲", "乙", "丙", "丁"]), ["甲", "乙", "丙", "丁"]);
});

test("正确答案兼容字母、索引、序号、答案文本和越界值", function () {
  const options = ["甲", "乙", "丙"];
  assert.equal(domain.parseCorrectIndex("B", options), 1);
  assert.equal(domain.parseCorrectIndex(0, options), 0);
  assert.equal(domain.parseCorrectIndex("3", options), 2);
  assert.equal(domain.parseCorrectIndex("乙", options), 1);
  assert.equal(domain.parseCorrectIndex(-9, options), 0);
  assert.equal(domain.parseCorrectIndex(99, options), 2);
});

test("旧卡数据被规范化且关键用户状态保持不变", function () {
  const card = domain.sanitizeCard({
    id: "legacy-1",
    title: "  一个非常非常长的旧知识卡标题  ",
    summary: "  有   多余空格  ",
    options: { A: "甲", B: "乙", C: "丙" },
    correctIndex: "B",
    favorite: true,
    mastery: 4,
    reviewCount: 7,
    lastCorrectReviewDay: "2026-08-26-extra"
  }, fixedContext);

  assert.equal(card.id, "legacy-1");
  assert.equal(card.title, "一个非常非常长的旧知识卡标题");
  assert.equal(card.summary, "有 多余空格");
  assert.equal(card.correctIndex, 1);
  assert.equal(card.favorite, true);
  assert.equal(card.mastery, 4);
  assert.equal(card.reviewCount, 7);
  assert.equal(card.lastCorrectReviewDay, "2026-08-26");
  assert.deepEqual(card.citations, []);
});

test("卡片保留最小来源快照并过滤危险地址和非法完整资料 ID", function () {
  const card = domain.sanitizeCard({
    title: "来源卡",
    sourceSnapshot: {
      sourceType: "selection",
      title: "  网页标题  ",
      url: "https://example.com/note",
      excerpt: "  一段   被捕获的原文  ",
      capturedAt: 123,
      fullSourceDocumentId: "doc_saved_1"
    }
  }, fixedContext);
  assert.deepEqual(card.sourceSnapshot, {
    sourceType: "selection",
    title: "网页标题",
    url: "https://example.com/note",
    excerpt: "一段   被捕获的原文",
    capturedAt: 123,
    fullSourceDocumentId: "doc_saved_1",
    sourceId: null,
    sourceVersion: 1,
    status: "excerpt_only",
    scope: "selected_text"
  });
  const unsafe = domain.sanitizeCard({ sourceSnapshot: {
    sourceType: "unknown",
    title: "来源",
    url: "javascript:alert(1)",
    excerpt: "保留这一段",
    fullSourceDocumentId: "../../secret"
  } }, fixedContext);
  assert.equal(unsafe.sourceSnapshot.sourceType, "manual");
  assert.equal(unsafe.sourceSnapshot.url, null);
  assert.equal(unsafe.sourceSnapshot.fullSourceDocumentId, null);
});

test("引用数据保留精确原文，过滤越界、危险 URL 和重复项", function () {
  const valid = {
    id: "citation_web_1",
    claim: "summary",
    chunkId: "chunk_web_1",
    source: { documentId: "doc_web_1", title: "RAG 笔记", type: "webpage", sourceUrl: "https://example.com/rag" },
    headingPath: ["检索", "融合"],
    quote: "向量\n检索",
    position: { startCharacter: 10, endCharacter: 15, pageNumber: null }
  };
  const citations = domain.normalizeCitations([
    valid,
    valid,
    { ...valid, id: "citation_bad_range", position: { startCharacter: 10, endCharacter: 16, pageNumber: null } },
    { ...valid, id: "citation_bad_url", source: { ...valid.source, sourceUrl: "javascript:alert(1)" } }
  ]);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].quote, "向量\n检索");
  assert.deepEqual(citations[0].headingPath, ["检索", "融合"]);
});

test("旧卡的非法 ID、颜色、计数和时间被收敛到服务端合约", function () {
  const card = domain.sanitizeCard({
    id: "bad/card:id",
    title: "旧卡",
    color: "red",
    favorite: 1,
    mastery: 99,
    reviewCount: "2.9",
    lastCorrectReviewDay: "not-a-day",
    createdAt: -1,
    updatedAt: "invalid",
    dueAt: null
  }, fixedContext);
  assert.equal(card.id, "bad_card_id");
  assert.equal(card.color, domain.COLORS[0]);
  assert.equal(card.favorite, true);
  assert.equal(card.mastery, 5);
  assert.equal(card.reviewCount, 2);
  assert.equal(card.lastCorrectReviewDay, "");
  assert.equal(card.createdAt, 1_724_630_400_000);
  assert.equal(card.updatedAt, 1_724_630_400_000);
  assert.equal(card.dueAt, 0);
});

test("定义句优先提取真实概念，修复兜底标题偏移回归", function () {
  const text = "边际成本指多生产一个单位额外增加的成本。做产品定价时，它能帮助判断新增用户是否赚钱。";
  assert.equal(domain.pickKeywords(text)[0], "边际成本");
  assert.equal(domain.generateLocalCard(text, null, fixedContext).title, "边际成本");
});

test("X 是定义句优先使用主语作为本地兜底标题", function () {
  const text = "机会成本是选择一个方案时，放弃的其他方案中价值最高的那个收益。它帮助我们比较真正的取舍。";
  assert.equal(domain.generateLocalCard(text, null, fixedContext).title, "机会成本");
});

test("空文字的图片投喂仍能生成结构完整的确定性卡片", function () {
  const card = domain.generateLocalCard("", { name: "note.png" }, fixedContext);
  assert.equal(card.id, "demo_1724630400000_123");
  assert.equal(card.title, "图片信息");
  assert.match(card.source, /图片里的信息/);
  assert.equal(card.options.length, 3);
  assert.equal(card.options[card.correctIndex], "用自己的话解释「图片信息」");
});

test("样例建议要求三条完整内容", function () {
  const valid = JSON.stringify({ samples: [
    { title: "概念一", text: "这是第一条足够长的知识点解释内容，用于验证样例解析。" },
    { title: "概念二", text: "这是第二条足够长的知识点解释内容，用于验证样例解析。" },
    { title: "概念三", text: "这是第三条足够长的知识点解释内容，用于验证样例解析。" }
  ] });
  assert.equal(domain.parseSampleSuggestions(valid).length, 3);
  assert.throws(function () { domain.parseSampleSuggestions('{"samples":[{"title":"不足","text":"太短"}]}'); }, /没有返回 3 条知识点/);
});
