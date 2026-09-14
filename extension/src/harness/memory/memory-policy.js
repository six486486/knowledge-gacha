(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const utils = commonJs ? require("../../shared/runtime-utils.js") : root.KnowledgeGachaRuntimeUtils;
  const schema = commonJs ? require("../../shared/knowledge-schema.js") : root.KnowledgeGachaKnowledgeSchema;
  const api = factory(utils, schema);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaMemoryPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, schema) {
  "use strict";

  const DAY = 24 * 60 * 60 * 1000;
  const RECENT_DAYS = 30;
  const VALID_CATEGORIES = new Set(["topic_interest", "topic_downrank", "unit_exclusion", "difficulty_preference", "learning_format", "self_familiarity", "custom"]);
  const FEEDBACK_ACTIONS = new Set(["like_topic", "less_topic", "exclude_unit", "already_familiar", "too_simple", "too_hard"]);

  function cleanText(value, limit) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, limit || 160);
  }

  function mutationId(input, fallback) {
    return cleanText(input && (input.mutationId || input.eventId) || fallback || "", 180) || null;
  }

  function keyForScope(scope) {
    if (scope?.type === "unit") return "unit:" + cleanText(scope.unitId, 180);
    if (scope?.type === "topic") return "topic:" + cleanText(scope.topicId, 180);
    return "global";
  }

  function activePreferences(db) {
    return (db.preferences || []).filter(function (item) { return item.enabled !== false; });
  }

  function recentEvents(db, timestamp) {
    const cutoff = timestamp - RECENT_DAYS * DAY;
    return (db.recentLearningEvents || []).filter(function (event) {
      return Number(event.occurredAt || event.createdAt || 0) >= cutoff;
    }).slice(-800);
  }

  function pruneRecent(db, timestamp) { db.recentLearningEvents = recentEvents(db, timestamp); }

  function invalidateRecommendationCache(db) {
    db.memoryVersion = Math.max(1, Number(db.memoryVersion) || 1) + 1;
    (db.discoveryPools || []).forEach(function (pool) {
      if (["active", "empty"].includes(pool.status)) pool.status = "stale";
    });
  }

  function rememberMutation(db, id, action, result, timestamp) {
    if (!id) return;
    db.memoryMutations = (db.memoryMutations || []).filter(function (item) { return item.id !== id; });
    db.memoryMutations.push({ id: id, action: action, result: utils.clone(result), appliedAt: timestamp });
    db.memoryMutations = db.memoryMutations.filter(function (item) { return item.appliedAt >= timestamp - 90 * DAY; }).slice(-600);
  }

  function withMutation(db, id, action, timestamp, operation) {
    const prior = id && (db.memoryMutations || []).find(function (item) { return item.id === id; });
    if (prior) return Object.assign(utils.clone(prior.result), { alreadyApplied: true });
    const result = Object.assign(operation(), { alreadyApplied: false });
    rememberMutation(db, id, action, result, timestamp);
    return result;
  }

  function normalizedScope(category, input) {
    const source = input && input.scope && typeof input.scope === "object" ? input.scope : {};
    const unitId = cleanText(source.unitId || input?.learningUnitId || input?.unitId, 180);
    const topicLabel = schema.topicLabel(input?.topicLabel || input?.topic || (category === "topic_interest" || category === "topic_downrank" ? input?.value : ""));
    const id = cleanText(source.topicId || input?.topicId, 180) || schema.topicId(topicLabel);
    if (["unit_exclusion", "self_familiarity"].includes(category) && unitId) return { type: "unit", unitId: unitId };
    if (["topic_interest", "topic_downrank", "difficulty_preference"].includes(category) && id) return { type: "topic", topicId: id };
    if (source.type === "unit" && unitId) return { type: "unit", unitId: unitId };
    if (source.type === "topic" && id) return { type: "topic", topicId: id };
    return { type: "global" };
  }

  function preferenceFor(db, category, scope) {
    const key = keyForScope(scope);
    return (db.preferences || []).find(function (item) {
      return item.category === category && keyForScope(item.scope) === key;
    });
  }

  function savePreference(db, input, timestamp) {
    const category = VALID_CATEGORIES.has(input.category) ? input.category : "custom";
    const scope = normalizedScope(category, input);
    const topicLabel = scope.type === "topic" ? schema.topicLabel(input.topicLabel || input.topic || input.value) : schema.topicLabel(input.topicLabel || input.topic);
    let value = cleanText(input.value || topicLabel, 240);
    if (category === "difficulty_preference" && !["foundational", "balanced", "advanced"].includes(value)) value = "balanced";
    if (!value) throw new Error("偏好内容不能为空");
    let item = input.id && (db.preferences || []).find(function (memory) { return memory.id === input.id; });
    if (!item) item = preferenceFor(db, category, scope);
    if (!item) {
      item = { id: utils.id("preference"), createdAt: timestamp, version: 0 };
      db.preferences.push(item);
    }
    Object.assign(item, {
      category: category,
      value: value,
      scope: scope,
      topicLabel: topicLabel || null,
      topicId: scope.type === "topic" ? scope.topicId : cleanText(input.topicId, 180) || schema.topicId(topicLabel),
      learningUnitId: scope.type === "unit" ? scope.unitId : cleanText(input.learningUnitId || input.unitId, 180) || null,
      enabled: input.enabled !== false,
      source: input.source || item.source || "user_explicit",
      sourceAction: input.sourceAction || item.sourceAction || "preference_editor",
      version: Math.max(0, Number(item.version) || 0) + 1,
      updatedAt: timestamp
    });
    return item;
  }

  function recordLearningEventInDb(db, input, timestamp) {
    const occurredAt = Number(input.occurredAt) || timestamp;
    pruneRecent(db, timestamp);
    const id = mutationId(input, input.type + ":" + [input.cardId, input.learningUnitId, input.topicId, occurredAt].filter(Boolean).join(":"));
    const existing = (db.recentLearningEvents || []).find(function (event) { return event.id === id; });
    if (existing) return { event: existing, alreadyApplied: true };
    const event = {
      id: id || utils.id("learning_event"),
      type: cleanText(input.type, 80),
      cardId: cleanText(input.cardId, 180) || null,
      learningUnitId: cleanText(input.learningUnitId || input.unitId, 180) || null,
      topicId: cleanText(input.topicId, 180) || schema.topicId(input.topicLabel || input.topic),
      topicLabel: schema.topicLabel(input.topicLabel || input.topic) || null,
      poolId: cleanText(input.poolId, 180) || null,
      candidateId: cleanText(input.candidateId, 180) || null,
      action: cleanText(input.action, 80) || null,
      correct: typeof input.correct === "boolean" ? input.correct : null,
      hintUsed: typeof input.hintUsed === "boolean" ? input.hintUsed : null,
      durationMs: Number.isFinite(Number(input.durationMs)) ? Math.max(0, Number(input.durationMs)) : null,
      errorType: cleanText(input.errorType, 80) || null,
      occurredAt: occurredAt,
      createdAt: timestamp
    };
    db.recentLearningEvents.push(event);
    pruneRecent(db, timestamp);
    if (input.invalidateCache !== false) invalidateRecommendationCache(db);
    else if (input.advanceVersion !== false) db.memoryVersion = Math.max(1, Number(db.memoryVersion) || 1) + 1;
    return { event: event, alreadyApplied: false };
  }

  function applyExplicitFeedbackInDb(db, input, timestamp) {
    const action = cleanText(input.action, 80);
    if (!FEEDBACK_ACTIONS.has(action)) throw new Error("不支持的推荐反馈");
    const id = mutationId(input, "feedback:" + [input.poolId, input.candidateId, action].filter(Boolean).join(":"));
    return withMutation(db, id, "explicit_feedback", timestamp, function () {
      const topicLabel = schema.topicLabel(input.topicLabel || input.topic);
      const topicId = cleanText(input.topicId, 180) || schema.topicId(topicLabel);
      const learningUnitId = cleanText(input.learningUnitId || input.unitId, 180);
      const mapping = {
        like_topic: { category: "topic_interest", value: topicLabel, sourceAction: action },
        less_topic: { category: "topic_downrank", value: topicLabel, sourceAction: action },
        exclude_unit: { category: "unit_exclusion", value: topicLabel || learningUnitId, sourceAction: action },
        already_familiar: { category: "self_familiarity", value: topicLabel || learningUnitId, sourceAction: action },
        too_simple: { category: "difficulty_preference", value: "advanced", sourceAction: action },
        too_hard: { category: "difficulty_preference", value: "foundational", sourceAction: action }
      };
      const preference = savePreference(db, Object.assign(mapping[action], {
        topicLabel: topicLabel,
        topicId: topicId,
        learningUnitId: learningUnitId,
        source: "user_explicit",
        enabled: true
      }), timestamp);
      invalidateRecommendationCache(db);
      const recorded = recordLearningEventInDb(db, {
        eventId: id ? id + ":event" : null,
        type: "explicit_feedback",
        action: action,
        poolId: input.poolId,
        candidateId: input.candidateId,
        learningUnitId: learningUnitId,
        topicId: topicId,
        topicLabel: topicLabel,
        invalidateCache: false,
        advanceVersion: false
      }, timestamp);
      return { preference: preference, event: recorded.event };
    });
  }


  return { RECENT_DAYS: RECENT_DAYS, cleanText: cleanText, mutationId: mutationId, activePreferences: activePreferences, recentEvents: recentEvents,
    invalidateRecommendationCache: invalidateRecommendationCache, withMutation: withMutation, preferenceFor: preferenceFor, savePreference: savePreference,
    recordLearningEventInDb: recordLearningEventInDb, applyExplicitFeedbackInDb: applyExplicitFeedbackInDb };
});
