(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./runtime-utils.js") : root.KnowledgeGachaRuntimeUtils);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaKnowledgeSchema = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils) {
  "use strict";

  const SCHEMA_VERSION = 8;
  function sourceId(documentId) { return "source_" + documentId; }
  function topicLabel(value) { return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120); }
  function topicId(value) { const label = topicLabel(value).toLocaleLowerCase(); return label ? "topic_" + utils.stableToken(label).slice(0, 16) : null; }

  function cardSourceIds(card) {
    return Array.from(new Set([].concat(card.sourceIds || [],
      card.sourceSnapshot && card.sourceSnapshot.sourceId || [],
      (card.citations || []).map(function (span) { return span.source.sourceId || sourceId(span.source.documentId); }))));
  }

  function upgradeDb(db) {
    db.sources = db.sources || [];
    db.learningUnits = db.learningUnits || [];
    db.exercises = db.exercises || [];
    db.materials = db.materials || [];
    db.materialChunks = db.materialChunks || [];
    db.knowledgePlans = db.knowledgePlans || [];
    db.cardBatches = db.cardBatches || [];
    db.discoveryPools = Array.isArray(db.discoveryPools) ? db.discoveryPools : [];
    db.reviewEvents = Array.isArray(db.reviewEvents) ? db.reviewEvents : [];
    db.reviewAttempts = Array.isArray(db.reviewAttempts) ? db.reviewAttempts : [];
    db.reviewDeferrals = Array.isArray(db.reviewDeferrals) ? db.reviewDeferrals : [];
    db.reviewMutations = Array.isArray(db.reviewMutations) ? db.reviewMutations : [];
    db.reviewEventCorrections = Array.isArray(db.reviewEventCorrections) ? db.reviewEventCorrections : [];
    db.reviewSettings = db.reviewSettings && typeof db.reviewSettings === "object" ? db.reviewSettings : {};
    db.reviewSettings.dailyGoal = Math.max(1, Math.min(20, Math.floor(Number(db.reviewSettings.dailyGoal) || 3)));
    db.reviewSettings.scheduleVersion = db.reviewSettings.scheduleVersion || "review-schedule-v2";
    db.recentLearningEvents = Array.isArray(db.recentLearningEvents) ? db.recentLearningEvents : [];
    db.memoryMutations = Array.isArray(db.memoryMutations) ? db.memoryMutations : [];
    db.memoryVersion = Math.max(1, Number(db.memoryVersion) || 1);
    db.preferences = Array.isArray(db.preferences) ? db.preferences : [];
    db.candidates = Array.isArray(db.candidates) ? db.candidates : [];
    db.learningState = db.learningState && typeof db.learningState === "object" ? db.learningState : { cards: [], pending: [], totalDraws: 0, reviewDay: {} };
    db.learningState.cards = Array.isArray(db.learningState.cards) ? db.learningState.cards : [];
    db.learningState.pending = Array.isArray(db.learningState.pending) ? db.learningState.pending : [];
    db.learningState.reviewDay = db.learningState.reviewDay && typeof db.learningState.reviewDay === "object" ? db.learningState.reviewDay : {};
    db.learningState.reviewDay.answered = Math.max(0, Math.floor(Number(db.learningState.reviewDay.answered) || 0));
    db.learningState.reviewDay.completed = db.learningState.reviewDay.answered >= db.reviewSettings.dailyGoal;
    db.learningState.reviewDay.continueAfterGoal = db.learningState.reviewDay.continueAfterGoal === true;
    db.learningState.reviewDay.lastLearningUnitId = db.learningState.reviewDay.lastLearningUnitId || null;
    db.knowledgePlans.forEach(function (plan) {
      plan.units.forEach(function (target) {
        let unit = db.learningUnits.find(function (item) { return item.id === target.id; });
        if (!unit) { unit = { id: target.id }; db.learningUnits.push(unit); }
        Object.assign(unit, { topic: target.title, topicId: target.topicId || unit.topicId || topicId(target.title), learningObjective: target.learningObjective, materialId: plan.materialId, planId: plan.id,
          evidenceIds: target.evidenceIds, selected: target.selected, disposition: target.disposition });
      });
    });
    function ensureSource(documentId, metadata) {
      const id = sourceId(documentId);
      let source = db.sources.find(function (item) { return item.id === id; });
      if (!source) {
        source = Object.assign({ id: id, documentId: documentId, version: 1, retention: "excerpt", status: "excerpt_only", scope: "selected_text" }, metadata);
        db.sources.push(source);
      }
      return source;
    }
    db.documents.forEach(function (document) {
      ensureSource(document.id, { type: document.type, title: document.title, url: document.sourceUrl || null, capturedAt: document.createdAt,
        retention: "full_text", status: "available", scope: document.scope || "full_text" });
    });
    db.sources.forEach(function (source) {
      const exists = db.documents.some(function (document) { return document.id === source.documentId; });
      if (["full_text", "original"].includes(source.retention) && !exists) source.status = "removed";
      if (exists) { source.status = "available"; source.retention = db.documents.find(function (doc) { return doc.id === source.documentId; }).originalAssetId ? "original" : "full_text"; }
    });
    [].concat(db.learningState.cards, db.learningState.pending || []).forEach(function (card) {
      card.schemaVersion = SCHEMA_VERSION;
      card.version = card.version || 1;
      card.learningUnitId = card.learningUnitId || "unit_" + card.id;
      if (!db.learningUnits.some(function (unit) { return unit.id === card.learningUnitId; })) {
        db.learningUnits.push({ id: card.learningUnitId, topic: card.title, topicId: topicId(card.title), learningObjective: card.learningObjective || "", legacyCardId: card.contentVersion === 2 ? null : card.id });
      }
      const unit = db.learningUnits.find(function (item) { return item.id === card.learningUnitId; });
      if (card.contentVersion === 2) { unit.topic = card.title; unit.learningObjective = card.learningObjective; }
      unit.topicId = unit.topicId || topicId(unit.topic || card.title);
      card.topicId = unit.topicId;
      card.reviewScheduleVersion = card.reviewScheduleVersion || "legacy-card-schedule";
      card.learningStage = card.learningStage || (Number(card.reviewCount) > 0 ? "review" : "scheduled");
      // Legacy questions remain usable, but migration never invents objectives or answer rationales.
      if (card.contentVersion !== 2 && card.question && Array.isArray(card.options) && card.options.length && Number.isInteger(card.correctIndex) && card.options[card.correctIndex]) {
        const exerciseId = "exercise_legacy_" + card.id;
        if (!db.exercises.some(function (item) { return item.id === exerciseId; })) db.exercises.push({ id: exerciseId, cardId: card.id, learningUnitId: card.learningUnitId,
          version: 1, type: "choice", question: card.question, options: card.options, correctIndex: card.correctIndex, answer: card.options[card.correctIndex], answerExplanation: "", rubric: [], misconceptions: [], legacy: true });
        card.exerciseIds = card.exerciseIds || [exerciseId];
      }
      (card.citations || []).forEach(function (span) {
        const source = ensureSource(span.source.documentId, { type: span.source.type, title: span.source.title, url: span.source.sourceUrl || null, capturedAt: card.createdAt });
        span.source.sourceId = source.id;
        span.source.version = span.source.version || source.version;
      });
      const snapshot = card.sourceSnapshot;
      if (snapshot) {
        const source = snapshot.sourceId && db.sources.find(function (item) { return item.id === snapshot.sourceId; }) ||
          ensureSource(snapshot.fullSourceDocumentId || "doc_snapshot_" + card.id, { type: snapshot.sourceType, title: snapshot.title, url: snapshot.url, capturedAt: snapshot.capturedAt,
            status: snapshot.fullSourceDocumentId ? "removed" : "excerpt_only" });
        snapshot.sourceId = source.id;
        snapshot.sourceVersion = snapshot.sourceVersion || source.version;
        snapshot.status = source.status;
        snapshot.scope = source.scope;
        snapshot.fullSourceDocumentId = source.status === "available" ? source.documentId : null;
        if (snapshot.selectionId) {
          const document = db.documents.find(function (doc) { return doc.id === source.documentId; });
          const selection = document?.selections?.find(function (item) { return item.id === snapshot.selectionId; });
          snapshot.originalAvailable = Boolean(document?.originalAssetId);
          snapshot.retainedRanges = selection?.ranges || [];
          if (document && !selection && !document.originalAssetId) { snapshot.status = "excerpt_only"; snapshot.fullSourceDocumentId = null; }
        }
      }
      card.sourceIds = cardSourceIds(card);
    });
    db.reviewEvents.forEach(function (event) {
      const card = db.learningState.cards.find(function (item) { return item.id === event.cardId; });
      event.learningUnitId = event.learningUnitId || card?.learningUnitId || null;
      event.topicId = event.topicId || card?.topicId || null;
      event.evidenceKind = event.evidenceKind || "historical_review";
      if (!Object.hasOwn(event, "hintUsed")) event.hintUsed = null;
      event.assessment = event.assessment || (event.chosenIndex == null ? "self" : "choice");
      event.scoringMethod = event.scoringMethod || (event.assessment === "self" ? "self_assessment" : "stored_choice_answer");
      event.scheduleVersion = event.scheduleVersion || "legacy-card-schedule";
      event.errorType = event.errorType || (event.correct === true ? "none" : "unknown");
      event.errorCause = event.errorCause || { code: event.errorType, label: event.errorType === "none" ? "无错误" : "暂未确定", status: event.errorType === "unknown" ? "unknown" : "recorded", basis: null };
    });
    db.reviewAttempts.forEach(function (attempt) {
      attempt.status = ["active", "answered", "abandoned"].includes(attempt.status) ? attempt.status : "abandoned";
      attempt.hintUsed = attempt.hintUsed === true;
      attempt.exerciseVersion = Math.max(1, Number(attempt.exerciseVersion) || 1);
    });
    db.preferences.forEach(function (preference) {
      preference.enabled = preference.enabled !== false;
      preference.version = Math.max(1, Number(preference.version) || 1);
      preference.sourceAction = preference.sourceAction || preference.source || "legacy_preference";
      preference.scope = preference.scope && typeof preference.scope === "object" ? preference.scope : { type: ["learning_format", "custom"].includes(preference.category) ? "global" : "topic" };
      if (preference.scope.type === "topic") {
        preference.topicLabel = topicLabel(preference.topicLabel || preference.value);
        preference.topicId = preference.topicId || topicId(preference.topicLabel);
        preference.scope.topicId = preference.scope.topicId || preference.topicId;
      }
      if (preference.scope.type === "unit" && !preference.scope.unitId && preference.unitId) preference.scope.unitId = preference.unitId;
    });
    db.discoveryPools.forEach(function (pool) {
      if (pool.poolVersion !== "discovery-pool-v2.1") {
        if (["active", "empty"].includes(pool.status)) pool.status = "stale";
        return;
      }
      pool.planVersion = pool.planVersion || "discovery-plan-v2";
      pool.openedDraftIds = Array.isArray(pool.openedDraftIds) ? pool.openedDraftIds : [];
      pool.sessionSeenTargetKeys = Array.isArray(pool.sessionSeenTargetKeys) ? pool.sessionSeenTargetKeys : [];
      pool.metrics = Object.assign({ exposed: 0, opened: 0, saved: 0, feedback: 0, generationFailures: 0 }, pool.metrics || {});
      (pool.candidates || []).forEach(function (candidate) {
        candidate.feedback = Array.isArray(candidate.feedback) ? candidate.feedback : [];
        candidate.relatedCardIds = Array.isArray(candidate.relatedCardIds) ? candidate.relatedCardIds : [];
        candidate.relatedLearningUnitIds = Array.isArray(candidate.relatedLearningUnitIds) ? candidate.relatedLearningUnitIds : [];
        candidate.sourceRefs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [];
      });
    });
    db.schemaVersion = SCHEMA_VERSION;
    return db;
  }

  function removeFullSource(db, documentId) {
    db.documents = db.documents.filter(function (document) { return document.id !== documentId; });
    db.sources.forEach(function (source) {
      if (source.documentId === documentId) source.status = "removed";
    });
    // A confirmed session is only a receipt. It must not retain a second copy of the source.
    db.drafts.forEach(function (draft) {
      if (draft.status === "confirmed") delete draft.material;
    });
    db.materials.forEach(function (material) {
      if (material.retainedDocumentId === documentId && material.completedAt) { delete material.text; delete material.image; delete material.blocks; }
    });
    upgradeDb(db);
  }

  return { SCHEMA_VERSION: SCHEMA_VERSION, sourceId: sourceId, topicLabel: topicLabel, topicId: topicId, cardSourceIds: cardSourceIds, upgradeDb: upgradeDb, removeFullSource: removeFullSource };
});
