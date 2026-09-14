(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaCompanionSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const LIMITS = Object.freeze({ sessions: 80, messages: 120, input: 4000, context: 12000, history: 24000, tools: 4, requests: 8, duration: 180000 });
  const MODES = Object.freeze({ auto: "自动", explain: "讲解", compare: "比较", practice: "陪练" });
  function scopes(session) {
    return { usePreferences: typeof session.usePreferences === "boolean" ? session.usePreferences : session.useMemory !== false,
      useLearningRecords: typeof session.useLearningRecords === "boolean" ? session.useLearningRecords : session.useMemory !== false };
  }
  function text(value, max, label) {
    if (typeof value !== "string" || !value.trim()) throw new Error((label || "内容") + "不能为空");
    if (value.length > max) throw new Error((label || "内容") + "最多 " + max + " 字");
    return value.trim();
  }
  function contextFor(input, db, timestamp) {
    if (!input || input.kind === "none") return null;
    if (input.kind === "card") {
      const card = db.learningState.cards.find(function (item) { return item.id === input.cardId; });
      if (!card) throw new Error("这张卡片已不存在，请重新选择");
      return { kind: "card", cardId: card.id, title: card.title, version: card.version || 1,
        text: [card.summary, card.learningObjective, card.boundaries, card.example?.text].filter(Boolean).join("\n").slice(0, LIMITS.context),
        topicId: card.topicId || null, learningUnitId: card.learningUnitId, capturedAt: timestamp };
    }
    if (input.kind !== "text") throw new Error("不支持这种讨论材料");
    return { kind: "text", text: text(input.text, LIMITS.context, "讨论材料"), title: String(input.title || "本次材料").slice(0, 120),
      sourceUrl: /^https?:\/\//i.test(String(input.sourceUrl || "")) ? String(input.sourceUrl).slice(0, 2000) : null,
      capturedAt: timestamp };
  }
  function history(messages) {
    const groups = [];
    let pending;
    messages.forEach(function (message) {
      if (message.role === "user") pending = message;
      if (message.role === "assistant" && message.status === "completed" && pending) {
        groups.push([{ role: "user", content: pending.content }, { role: "assistant", content: message.content }]); pending = null;
      }
    });
    let size = 0;
    const kept = [];
    for (const group of groups.slice(-12).reverse()) {
      const length = group.reduce(function (sum, message) { return sum + message.content.length; }, 0);
      if (size + length > LIMITS.history) break;
      size += length; kept.unshift(...group);
    }
    return { messages: kept, omittedTurns: groups.length - kept.length / 2 };
  }
  function publicSession(session, active) {
    const result = JSON.parse(JSON.stringify(session));
    Object.assign(result, scopes(session));
    if (result.turn) {
      const turn = result.turn;
      result.turn = { id: turn.id, status: turn.status, startedAt: turn.startedAt, finishedAt: turn.finishedAt,
        error: turn.error || null, requestCount: turn.requestCount, toolCount: turn.toolCount, steps: turn.steps,
        skill: turn.skill, omittedTurns: turn.omittedTurns, memory: turn.memory, contextStats: turn.contextStats,
        compaction: turn.compaction, skillActivations: turn.skillActivations || 0, active: Boolean(active) };
    }
    result.messages.forEach(function (message) {
      (message.actions || []).forEach(function (action) { delete action.referenceIds; delete action.sourceReferences; delete action.material; });
    });
    return result;
  }
  return { LIMITS: LIMITS, MODES: MODES, scopes: scopes, text: text, contextFor: contextFor, history: history, publicSession: publicSession };
});
