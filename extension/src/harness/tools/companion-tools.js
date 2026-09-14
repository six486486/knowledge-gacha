(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("../core/companion-session.js") : root.KnowledgeGachaCompanionSession);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaCompanionTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (sessions) {
  "use strict";
  const string = function (max) { return { type: "string", minLength: 1, maxLength: max }; };
  const DEFINITIONS = Object.freeze({
    activate_skill: { label: "调整教学方式", description: "自动方式下，用户学习目标变化时加载对应教学能力。已激活的能力和普通追问直接沿用；每轮最多切换一次。", properties: { name: { type: "string", enum: ["companion-explain", "companion-compare", "companion-practice"] } }, required: ["name"] },
    search_knowledge: { label: "查找相关知识", description: "搜索当前档案已保存的卡片和保留原文。相关性分数不是答案正确率。", properties: { query: string(500) }, required: ["query"] },
    read_source: { label: "阅读来源片段", description: "读取本轮已返回引用的相邻原文，保留位置和版本。", properties: { referenceId: string(80) }, required: ["referenceId"] },
    read_card: { label: "查看知识卡片", description: "读取当前档案的一张卡片及最小引用；不读取练习答案。", properties: { cardId: string(180) }, required: ["cardId"] },
    get_learning_context: { label: "查看学习背景", description: "读取允许使用的偏好或复习证据。当前背景已在上下文中，仅在需要另一张卡或整体学习概况时调用 overview；聊天不更新掌握程度。", properties: { scope: { type: "string", enum: ["current", "overview"] }, cardId: string(180) }, required: ["scope"] },
    propose_card: { label: "准备制卡建议", description: "提出可由用户点击的制卡建议，不创建或保存卡片。referenceIds 只接受本轮返回的引用，空数组表示模型讲解。", properties: { goal: string(300), referenceIds: { type: "array", items: string(80), maxItems: 5, uniqueItems: true } }, required: ["goal", "referenceIds"] },
    propose_review: { label: "准备练习入口", description: "建议用户进入已有卡片的正式复习，不修改排期或答题记录。", properties: { cardId: string(180) }, required: ["cardId"] },
    propose_preference: { label: "准备偏好建议", description: "用户明确要求记住讲解形式时才使用。scope=discussion 仅本讨论，topic 指定主题，global 所有讨论。修改同范围偏好时提交完整的新内容；用户点击后保存。", properties: { value: string(160), scope: { type: "string", enum: ["discussion", "topic", "global"] }, topicLabel: string(80) }, required: ["value"] }
  });
  function definitions(session) {
    const scope = sessions.scopes(session);
    return Object.keys(DEFINITIONS).filter(function (name) {
      if (name === "activate_skill") return session.mode === "auto";
      if (!session.useKnowledge && ["search_knowledge", "read_card"].includes(name)) return false;
      if (name === "get_learning_context") return scope.usePreferences || scope.useLearningRecords;
      if (name === "propose_preference") return scope.usePreferences;
      return true;
    }).map(function (name) {
      const item = DEFINITIONS[name];
      return { type: "function", function: { name: name, description: item.description,
        parameters: { type: "object", properties: item.properties, required: item.required, additionalProperties: false } } };
    });
  }
  function parse(name, value, session) {
    if (!definitions(session).some(function (item) { return item.function.name === name; })) throw new Error("本次讨论不允许这个工具");
    let args;
    try { args = JSON.parse(value); } catch (_) { throw new Error("工具参数必须是 JSON 对象"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
    const spec = DEFINITIONS[name];
    if (Object.keys(args).some(function (key) { return !Object.hasOwn(spec.properties, key); }) || spec.required.some(function (key) { return !Object.hasOwn(args, key); })) throw new Error("工具参数字段不符合契约");
    Object.keys(args).forEach(function (key) {
      const rule = spec.properties[key], value = args[key];
      if (rule.type === "string" && (typeof value !== "string" || !value.trim() || value.length > (rule.maxLength || 1000) || rule.enum && !rule.enum.includes(value))) throw new Error("工具参数无效：" + key);
      if (rule.type === "array" && (!Array.isArray(value) || value.length > rule.maxItems || new Set(value).size !== value.length || value.some(function (id) { return typeof id !== "string" || !id || id.length > rule.items.maxLength; }))) throw new Error("引用列表无效");
    });
    if (name === "propose_preference" && (args.scope === "topic" ? !args.topicLabel : args.topicLabel !== undefined)) throw new Error("主题偏好需要 topicLabel；其他范围不填写主题");
    return args;
  }
  function card(db, id) {
    const value = db.learningState.cards.find(function (item) { return item.id === id; });
    if (!value) throw Object.assign(new Error("卡片已不存在"), { code: "CARD_UNAVAILABLE" });
    return value;
  }
  function validReference(ref, session, db) {
    if (ref.kind === "context") return session.context?.kind === "text" && session.context.text.slice(ref.start || 0, (ref.start || 0) + ref.quote.length) === ref.quote;
    if (ref.kind === "card") {
      if (!session.useKnowledge && session.context?.cardId !== ref.cardId) return false;
      const value = db.learningState.cards.find(function (item) { return item.id === ref.cardId; });
      return Boolean(value && (value.version || 1) === ref.version && [value.title, value.summary, value.learningObjective, value.boundaries, value.example?.text].filter(Boolean).join("\n").includes(ref.quote));
    }
    if (!session.useKnowledge && session.context?.cardId !== ref.cardId) return false;
    const source = db.sources.find(function (item) { return item.documentId === ref.documentId; });
    const doc = db.documents.find(function (item) { return item.id === ref.documentId; });
    if (doc) return Boolean(source && source.version === ref.version && doc.content.slice(ref.start, ref.start + ref.quote.length) === ref.quote);
    if (ref.cardId) {
      const value = db.learningState.cards.find(function (item) { return item.id === ref.cardId; });
      return Boolean(value && (value.citations || []).some(function (citation) { return citation.quote === ref.quote && citation.source?.documentId === ref.documentId && (citation.source.version || 1) === ref.version; }));
    }
    return false;
  }
  function addReference(turn, ref) {
    if (!ref.quote) return null;
    const existing = turn.references.find(function (item) { return item.kind === ref.kind && item.documentId === ref.documentId && item.cardId === ref.cardId && item.start === ref.start && item.quote === ref.quote; });
    if (existing) return existing;
    if (turn.references.length >= 20) return null;
    ref.id = "S" + (turn.references.length + 1);
    turn.references.push(ref); return ref;
  }
  function cardReferences(value, turn) {
    const refs = [];
    const summary = addReference(turn, { kind: "card", cardId: value.id, version: value.version || 1, title: value.title,
      quote: String(value.summary || value.title).slice(0, 1600), evidenceRole: "learning_background" });
    if (summary) refs.push(summary);
    (value.citations || []).slice(0, 3).forEach(function (citation) {
      if (!citation.quote || citation.quote.length > 2400 || !citation.source?.documentId) return;
      const ref = addReference(turn, { kind: "document", cardId: value.id, documentId: citation.source.documentId,
        version: citation.source.version || 1, title: citation.source.title || value.title, quote: citation.quote,
        start: Number(citation.position?.startCharacter) || 0, pageNumber: citation.position?.pageNumber || null,
        sourceUrl: citation.source.sourceUrl || citation.source.url || null, evidenceRole: "saved_excerpt" });
      if (ref) refs.push(ref);
    });
    return refs;
  }
  async function execute(name, args, session, turn, context) {
    const db = context.readDb();
    if (name === "search_knowledge") {
      const found = await context.searchKnowledge(args.query, { limit: 4 });
      const latest = context.readDb();
      const refs = [];
      found.results.forEach(function (hit) {
        if (hit.type === "card") {
          const value = latest.learningState.cards.find(function (item) { return item.id === hit.cardId; });
          if (value) refs.push(...cardReferences(value, turn).slice(0, 1));
        } else {
          const ref = { kind: "document", documentId: hit.documentId, version: hit.version, start: hit.startCharacter,
            title: hit.title, quote: hit.text.slice(0, 1600), pageNumber: hit.pageNumber || hit.locator?.pageNumber || null,
            sourceUrl: latest.documents.find(function (item) { return item.id === hit.documentId; })?.sourceUrl || null, evidenceRole: hit.evidenceRole || "saved_source" };
          if (validReference(ref, session, latest)) { const added = addReference(turn, ref); if (added) refs.push(added); }
        }
      });
      return { references: refs, found: refs.length > 0, code: refs.length ? "FOUND" : "NO_RESULTS", note: refs.length ? "相关片段不一定包含完整答案；必要时继续读取并判断条件。" : "知识库没有找到对应依据；可换用具体概念检索，或说明资料缺口。", strategy: found.trace?.strategy || "lexical" };
    }
    if (name === "read_source") {
      const ref = turn.references.find(function (item) { return item.id === args.referenceId; });
      if (!ref || !validReference(ref, session, db)) throw Object.assign(new Error("引用不存在、范围已关闭或来源已更新，请重新查找"), { code: "SOURCE_UNAVAILABLE" });
      if (ref.kind !== "document" || !db.documents.some(function (doc) { return doc.id === ref.documentId; })) return { reference: ref, retained: "excerpt_only" };
      const doc = db.documents.find(function (item) { return item.id === ref.documentId; });
      const start = Math.max(0, ref.start - 500);
      return { reference: addReference(turn, Object.assign({}, ref, { id: undefined, start: start, quote: doc.content.slice(start, start + 3200) })) };
    }
    if (name === "read_card") {
      const value = card(db, args.cardId);
      return { cardId: value.id, title: value.title, learningObjective: value.learningObjective || "", boundaries: value.boundaries || "", references: cardReferences(value, turn) };
    }
    if (name === "get_learning_context") {
      const cacheKey = JSON.stringify([args.scope, args.cardId || session.context?.cardId || null]);
      turn.learningContextCache = turn.learningContextCache || {};
      if (Object.hasOwn(turn.learningContextCache, cacheKey)) return Object.assign({}, turn.learningContextCache[cacheKey], { reused: true });
      const result = context.learningContext(session, args); turn.learningContextCache[cacheKey] = result; return result;
    }
    if (name === "propose_card") {
      if (args.referenceIds.some(function (id) { const ref = turn.references.find(function (item) { return item.id === id; }); return !ref || !validReference(ref, session, db); })) throw new Error("制卡依据必须来自本次真实引用");
      return { action: { id: context.id("action"), kind: "card", title: "整理成卡片", goal: args.goal, referenceIds: args.referenceIds, status: "proposed" }, note: "仅已展示建议，用户尚未生成或保存卡片。" };
    }
    if (name === "propose_review") {
      const value = card(db, args.cardId);
      return { action: { id: context.id("action"), kind: "review", title: "练习「" + value.title + "」", cardId: value.id, status: "proposed" }, note: "用户点击后进入正式复习，尚未记录作答或改期。" };
    }
    if (name === "propose_preference") return { action: { id: context.id("action"), kind: "preference", title: args.scope === "discussion" ? "用于本次讨论" : "记住讲解偏好", value: args.value,
      scope: args.scope || "global", topicLabel: args.topicLabel || null, status: "proposed" }, note: "等待用户确认保存；不视为掌握证据。" };
    throw new Error("不支持的工具");
  }
  return { DEFINITIONS: DEFINITIONS, definitions: definitions, parse: parse, execute: execute, validReference: validReference, addReference: addReference, cardReferences: cardReferences };
});
