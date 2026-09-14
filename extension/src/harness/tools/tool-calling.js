(function (root, factory) {
  const utils = typeof module === "object" && module.exports
    ? require("../../shared/runtime-utils.js")
    : root.KnowledgeGachaRuntimeUtils;
  const commonJs = typeof module === "object" && module.exports;
  const rag = commonJs ? require("../rag/rag-service.js") : root.KnowledgeGachaHarnessRag;
  const memory = commonJs ? require("../memory/memory-service.js") : root.KnowledgeGachaHarnessMemory;
  const index = commonJs ? require("../../shared/material-index.js") : root.KnowledgeGachaMaterialIndex;
  const api = factory(utils, rag, memory, index);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaHarnessTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, rag, memory, index) {
  "use strict";

  const WRITE_TOOLS = new Set(["create_card", "schedule_review", "record_review_result"]);

  function toolDefinition(name) {
    const definitions = {
      get_learning_context: ["读取当前档案的显式偏好、近期事实、复习证据和卡册摘要", {}],
      search_knowledge: ["搜索扩展内保存的资料和卡片", { query: { type: "string" } }],
      get_document: ["读取一份扩展内资料", { documentId: { type: "string" } }],
      validate_card: ["校验待保存知识卡", { title: { type: "string" }, summary: { type: "string" } }],
      create_card: ["创建知识卡，需要用户确认", { title: { type: "string" }, summary: { type: "string" }, analogy: { type: "string" } }],
      schedule_review: ["调整复习计划，需要用户确认", { cardId: { type: "string" }, dueAt: { type: "number" } }]
    };
    const item = definitions[name] || [name, {}];
    return { type: "function", function: { name: name, description: item[0], parameters: { type: "object", properties: item[1], additionalProperties: false } } };
  }

  function parseToolArguments(value) {
    try {
      const parsed = JSON.parse(String(value || "{}"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      throw new Error("模型工具参数不是有效 JSON");
    }
  }

  function knowledgeResult(span) {
    return { type: span.type, id: span.cardId || span.documentId, title: span.title, text: span.text, score: span.score, evidenceRole: span.evidenceRole,
      source: span.type === "document" ? { documentId: span.documentId, version: span.version, startCharacter: span.startCharacter, pageNumber: span.pageNumber, headingPath: span.headingPath, locator: span.locator } : undefined };
  }

  function executeReadTool(db, name, input, timestamp) {
    if (name === "get_learning_context") {
      return {
        context: memory.learningContextForDb(db, timestamp, { mode: "recommendation" }),
        cardCount: db.learningState.cards.length,
        dueCount: db.learningState.cards.filter(function (card) { return card.dueAt <= timestamp; }).length,
        recentCards: db.learningState.cards.slice(0, 5).map(function (card) { return { id: card.id, title: card.title, summary: card.summary }; })
      };
    }
    if (name === "search_knowledge") {
      const query = String(input.query || "");
      return rag.createRagService({ readDb: function () { return db; } }).findSourceEvidence(query).map(function (span) {
        return { type: "document", id: span.documentId, title: span.title, text: span.text, score: span.score,
          source: { documentId: span.documentId, version: span.version, startCharacter: span.startCharacter, pageNumber: span.pageNumber, headingPath: span.headingPath, locator: span.locator } };
      }).concat(db.learningState.cards.map(function (card) {
        return { type: "card", id: card.id, title: card.title, text: card.summary, evidenceRole: "learning_background", score: index.score(query, card.title + " " + card.summary) };
      })).filter(function (hit) { return hit.score >= 0.18; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 5);
    }
    if (name === "get_document") {
      const document = db.documents.find(function (item) { return item.id === input.documentId; });
      return document ? { id: document.id, title: document.title, content: document.content } : { error: "not_found" };
    }
    if (name === "validate_card") return { valid: Boolean(input.title && input.summary), issues: input.title && input.summary ? [] : ["标题和解释不能为空"] };
    return { error: "unknown_tool" };
  }

  function executeWriteTool(db, name, input, cardDomain, timestamp) {
    if (name === "create_card") {
      const card = cardDomain.sanitizeCard(Object.assign(cardDomain.generateLocalCard(input.summary || input.title || "新知识"), input, { id: utils.id("card"), dueAt: timestamp + 86_400_000 }));
      db.learningState.cards.unshift(card);
      db.version += 1;
      return { created: true, cardId: card.id, title: card.title };
    }
    if (name === "schedule_review") {
      const card = db.learningState.cards.find(function (item) { return item.id === input.cardId; });
      if (!card) return { error: "not_found" };
      card.dueAt = Math.max(timestamp, Number(input.dueAt) || timestamp);
      db.version += 1;
      return { updated: true, cardId: card.id, dueAt: card.dueAt };
    }
    return { error: "unknown_tool" };
  }

  return {
    WRITE_TOOLS: WRITE_TOOLS,
    knowledgeResult: knowledgeResult,
    executeReadTool: executeReadTool,
    executeWriteTool: executeWriteTool,
    parseToolArguments: parseToolArguments,
    toolDefinition: toolDefinition
  };
});
