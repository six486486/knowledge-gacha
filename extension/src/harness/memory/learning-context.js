(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const utils = commonJs ? require("../../shared/runtime-utils.js") : root.KnowledgeGachaRuntimeUtils;
  const schema = commonJs ? require("../../shared/knowledge-schema.js") : root.KnowledgeGachaKnowledgeSchema;
  const reviewLearning = commonJs ? require("../../shared/review-learning.js") : root.KnowledgeGachaReviewLearning;
  const policy = commonJs ? require("./memory-policy.js") : root.KnowledgeGachaMemoryPolicy;
  const api = factory(utils, schema, reviewLearning, policy);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaLearningContext = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, schema, reviewLearning, policy) {
  "use strict";

  const RECENT_DAYS = policy.RECENT_DAYS;
  const activePreferences = policy.activePreferences;

  function unitEvidence(db, unit, timestamp) {
    const cards = [].concat(db.learningState?.cards || [], db.learningState?.pending || []).filter(function (card) { return card.learningUnitId === unit.id; });
    const cardIds = new Set(cards.map(function (card) { return card.id; }));
    const events = (db.reviewEvents || []).filter(function (event) { return event.learningUnitId === unit.id || cardIds.has(event.cardId); });
    const label = unit.topic || cards[0]?.title || "未命名知识点";
    const topicId = unit.topicId || cards[0]?.topicId || schema.topicId(label);
    if (events.length) {
      const last = events.slice().sort(function (a, b) { return Number(b.answeredAt) - Number(a.answeredAt); })[0];
      const snapshot = reviewLearning.masterySnapshot(events, timestamp, db.reviewEventCorrections);
      return {
        conceptId: "concept_" + utils.stableToken(unit.id), learningUnitId: unit.id, topicId: topicId, label: label,
        evidenceKind: "observed_review", evidenceState: snapshot.evidenceState,
        reviewCount: snapshot.reviewCount, correctCount: snapshot.correctCount, incorrectCount: snapshot.incorrectCount, accuracyRate: snapshot.accuracyRate,
        hintUsedCount: snapshot.hintUsedCount, noHintCorrectCount: snapshot.noHintCorrectCount, exerciseCount: snapshot.exerciseCount,
        masteryScore: null, masteryLevel: snapshot.masteryLevel, masteryLabel: snapshot.masteryLabel,
        errorCause: snapshot.errorCause.code, errorCauseEvidence: snapshot.errorCause, lastReviewedAt: last.answeredAt,
        calculationVersion: snapshot.calculationVersion, calculatedAt: timestamp, updatedAt: last.answeredAt
      };
    }
    if (cards.length) {
      const values = cards.map(function (card) { return Number(card.mastery); }).filter(Number.isFinite);
      return {
        conceptId: "concept_" + utils.stableToken(unit.id), learningUnitId: unit.id, topicId: topicId, label: label,
        evidenceKind: "legacy_card_state", evidenceState: "unknown", reviewCount: 0, correctCount: 0, incorrectCount: 0,
        accuracyRate: null, legacyScore: values.length ? values.reduce(function (sum, value) { return sum + value; }, 0) / values.length : null,
        masteryScore: null, masteryLevel: "unknown", errorCause: "unknown", lastReviewedAt: null,
        calculationVersion: "legacy-state-v1", calculatedAt: timestamp, updatedAt: cards[0].updatedAt || cards[0].createdAt || timestamp
      };
    }
    return null;
  }

  function preferenceApplies(item, input) {
    if (!input || input.mode === "recommendation") return true;
    if (item.scope?.type === "global") return true;
    if (item.scope?.type === "topic") return Boolean(input.topicId && input.topicId === item.scope.topicId);
    if (item.scope?.type === "unit") return Boolean(input.learningUnitId && input.learningUnitId === item.scope.unitId);
    return false;
  }

  function publicPreference(item) {
    return {
      id: item.id, category: item.category, value: item.value, scope: utils.clone(item.scope || { type: "global" }),
      topicId: item.topicId || null, topicLabel: item.topicLabel || null, learningUnitId: item.learningUnitId || null,
      sourceAction: item.sourceAction, version: item.version, updatedAt: item.updatedAt
    };
  }

  function learningContextForDb(db, timestamp, input) {
    input = Object.assign({}, input || {});
    input.mode = input.mode || (input.topicId || input.learningUnitId ? "scoped" : "recommendation");
    const preferences = activePreferences(db).filter(function (item) { return preferenceApplies(item, input); });
    const allEvidence = (db.learningUnits || []).map(function (unit) { return unitEvidence(db, unit, timestamp); }).filter(Boolean);
    const evidence = input.learningUnitId ? allEvidence.filter(function (item) { return item.learningUnitId === input.learningUnitId; })
      : input.mode === "recommendation" ? allEvidence : [];
    const recent = policy.recentEvents(db, timestamp).filter(function (event) {
      if (input.mode === "recommendation") return true;
      if (input.learningUnitId) return event.learningUnitId === input.learningUnitId;
      if (input.topicId) return event.topicId === input.topicId;
      return false;
    }).slice().sort(function (a, b) { return b.occurredAt - a.occurredAt; }).slice(0, 60);
    const explicitPreferences = preferences.map(publicPreference);
    return {
      version: Math.max(1, Number(db.memoryVersion) || 1),
      generatedAt: timestamp,
      profileScope: "current_profile",
      taskScope: { mode: input.mode || "recommendation", topicId: input.topicId || null, learningUnitId: input.learningUnitId || null },
      explicitPreferences: explicitPreferences,
      appliedPreferenceIds: explicitPreferences.map(function (item) { return item.id; }),
      interests: explicitPreferences.filter(function (item) { return item.category === "topic_interest"; }),
      downrankedTopics: explicitPreferences.filter(function (item) { return item.category === "topic_downrank"; }),
      excludedUnits: explicitPreferences.filter(function (item) { return item.category === "unit_exclusion"; }),
      recentFacts: recent.map(function (event) { return {
        eventId: event.id, type: event.type, cardId: event.cardId, learningUnitId: event.learningUnitId, topicId: event.topicId,
        topicLabel: event.topicLabel, action: event.action, occurredAt: event.occurredAt
      }; }),
      learnedUnits: evidence,
      reviewSummary: {
        observedUnitCount: evidence.filter(function (item) { return item.evidenceKind === "observed_review"; }).length,
        legacyUnitCount: evidence.filter(function (item) { return item.evidenceKind === "legacy_card_state"; }).length,
        reviewEventCount: evidence.reduce(function (sum, item) { return sum + item.reviewCount; }, 0),
        incorrectCount: evidence.reduce(function (sum, item) { return sum + item.incorrectCount; }, 0),
        errorCause: evidence.find(function (item) { return item.errorCause && !["none", "unknown"].includes(item.errorCause); })?.errorCause || "unknown"
      },
      recentWindowDays: RECENT_DAYS
    };
  }


  return { unitEvidence: unitEvidence, learningContextForDb: learningContextForDb };
});
