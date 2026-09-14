(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const utils = commonJs ? require("../../shared/runtime-utils.js") : root.KnowledgeGachaRuntimeUtils;
  const schema = commonJs ? require("../../shared/knowledge-schema.js") : root.KnowledgeGachaKnowledgeSchema;
  const policy = commonJs ? require("./memory-policy.js") : root.KnowledgeGachaMemoryPolicy;
  const projection = commonJs ? require("./learning-context.js") : root.KnowledgeGachaLearningContext;
  const api = factory(utils, schema, policy, projection);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaHarnessMemory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, schema, policy, projection) {
  "use strict";

  const { mutationId, withMutation, preferenceFor, savePreference, invalidateRecommendationCache, recordLearningEventInDb } = policy;
  const { unitEvidence, learningContextForDb } = projection;

  function createMemoryService(context) {
    const readDb = context.readDb;
    const mutate = context.mutate;
    const now = context.now;
    const requestId = context.requestId;

    function listConceptMasteries() {
      const db = readDb();
      const timestamp = now();
      const concepts = (db.learningUnits || []).map(function (unit) { return unitEvidence(db, unit, timestamp); }).filter(Boolean);
      return Promise.resolve({ concepts: concepts, requestId: requestId() });
    }

    function listPreferenceMemories() { return Promise.resolve({ memories: utils.clone(readDb().preferences), requestId: requestId() }); }
    function listMemoryCandidates() { return Promise.resolve({ candidates: readDb().candidates, requestId: requestId() }); }

    function discoveryInterestsForDb(db) {
      const interests = db.preferences.filter(function (item) { return item.category === "topic_interest"; });
      return {
        interests: utils.clone(interests.filter(function (item) { return item.enabled !== false; })),
        memoryVersion: Math.max(1, Number(db.memoryVersion) || 1),
        revision: JSON.stringify(interests.map(function (item) { return [item.id, item.version, item.enabled !== false]; }).sort(function (a, b) { return a[0].localeCompare(b[0]); })),
        completed: Boolean(db.discoveryInterestSetup?.completedAt || interests.length || db.discoveryPools.length)
      };
    }

    function getDiscoveryInterests() { return Promise.resolve(Object.assign(discoveryInterestsForDb(readDb()), { requestId: requestId() })); }

    async function saveDiscoveryInterests(input) {
      input = input || {};
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withMutation(db, mutationId(input), "save_discovery_interests", timestamp, function () {
          let changed = false;
          if (!input.skip) {
            if (input.revision !== discoveryInterestsForDb(db).revision) throw Object.assign(new Error("兴趣已在其他窗口更新，请重新载入后再调整"), { code: "INTERESTS_CHANGED" });
            if (!Array.isArray(input.topics) || input.topics.length > 100) throw new Error("请选择有效的兴趣主题");
            const topics = new Map();
            input.topics.forEach(function (value) {
              if (typeof value !== "string" || !value.trim() || value.normalize("NFKC").trim().length > 120) throw new Error("兴趣主题须为 1–120 个字符");
              const label = schema.topicLabel(value);
              topics.set(schema.topicId(label), label);
            });
            db.preferences.forEach(function (item) {
              if (item.category === "topic_interest" && item.enabled !== false && !topics.has(item.topicId || schema.topicId(item.topicLabel || item.value))) {
                item.enabled = false; item.version = Number(item.version || 0) + 1; item.updatedAt = timestamp; changed = true;
              }
            });
            topics.forEach(function (label, topicId) {
              const existing = preferenceFor(db, "topic_interest", { type: "topic", topicId: topicId });
              if (existing && existing.enabled !== false) return;
              savePreference(db, { category: "topic_interest", value: label, topicLabel: label, topicId: topicId,
                scope: { type: "topic", topicId: topicId }, source: "user_explicit", sourceAction: "interest_picker" }, timestamp);
              changed = true;
            });
            if (changed) invalidateRecommendationCache(db);
          }
          if (!db.discoveryInterestSetup?.completedAt) db.discoveryInterestSetup = { completedAt: timestamp };
          return Object.assign(discoveryInterestsForDb(db), { changed: changed });
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function createPreferenceMemory(input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const id = mutationId(input);
        const result = withMutation(db, id, "create_preference", timestamp, function () {
          const memory = savePreference(db, Object.assign({}, input, { source: "user_explicit" }), timestamp);
          invalidateRecommendationCache(db);
          return { memory: memory };
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function updatePreferenceMemory(memoryId, input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withMutation(db, mutationId(input), "update_preference", timestamp, function () {
          const item = db.preferences.find(function (memory) { return memory.id === memoryId; });
          if (!item) throw new Error("偏好不存在");
          const next = Object.assign({}, item, input, { id: memoryId, source: item.source });
          if (input.value !== undefined && ["topic_interest", "topic_downrank"].includes(item.category)) {
            next.topicLabel = String(input.value);
            next.topicId = null;
            next.scope = { type: "topic" };
          }
          const memory = savePreference(db, next, timestamp);
          invalidateRecommendationCache(db);
          return { memory: memory };
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function deletePreferenceMemory(memoryId, input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withMutation(db, mutationId(typeof input === "string" ? { mutationId: input } : input), "delete_preference", timestamp, function () {
          const memory = db.preferences.find(function (item) { return item.id === memoryId; });
          if (!memory) return { deletedId: memoryId, memory: null };
          db.preferences = db.preferences.filter(function (item) { return item.id !== memoryId; });
          invalidateRecommendationCache(db);
          return { deletedId: memoryId, memory: memory };
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function confirmMemoryCandidate(candidateId, input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withMutation(db, mutationId(typeof input === "string" ? { mutationId: input } : input), "confirm_candidate", timestamp, function () {
          const candidate = db.candidates.find(function (item) { return item.id === candidateId; });
          if (!candidate || !candidate.eligibleForConfirmation) throw new Error("候选尚未达到确认门槛");
          const memory = savePreference(db, {
            category: candidate.category, value: candidate.value, topicLabel: candidate.topicLabel,
            topicId: candidate.topicId, learningUnitId: candidate.learningUnitId, scope: candidate.scope,
            source: "user_confirmed_candidate", sourceAction: "candidate_confirmation"
          }, timestamp);
          memory.candidateId = candidate.id;
          candidate.status = "confirmed";
          candidate.confirmedPreferenceId = memory.id;
          candidate.updatedAt = timestamp;
          invalidateRecommendationCache(db);
          return { candidate: candidate, memory: memory };
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function ignoreMemoryCandidate(candidateId, input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withMutation(db, mutationId(typeof input === "string" ? { mutationId: input } : input), "ignore_candidate", timestamp, function () {
          const candidate = db.candidates.find(function (item) { return item.id === candidateId; });
          if (!candidate) throw new Error("候选不存在");
          candidate.status = "ignored";
          candidate.updatedAt = timestamp;
          return { candidate: candidate, memory: null };
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function getLearningContext(input) {
      return Promise.resolve({ context: learningContextForDb(readDb(), now(), input || {}), requestId: requestId() });
    }

    function recordLearningEvent(input) {
      return Promise.resolve(mutate(function (db) {
        const result = recordLearningEventInDb(db, input || {}, now());
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function clearRecentLearningContext(input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withMutation(db, mutationId(input), "clear_recent_context", timestamp, function () {
          const clearedCount = (db.recentLearningEvents || []).length;
          db.recentLearningEvents = [];
          invalidateRecommendationCache(db);
          return { clearedCount: clearedCount };
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    return {
      getDiscoveryInterests: getDiscoveryInterests,
      saveDiscoveryInterests: saveDiscoveryInterests,
      createPreferenceMemory: createPreferenceMemory,
      confirmMemoryCandidate: confirmMemoryCandidate,
      clearRecentLearningContext: clearRecentLearningContext,
      deletePreferenceMemory: deletePreferenceMemory,
      getLearningContext: getLearningContext,
      ignoreMemoryCandidate: ignoreMemoryCandidate,
      listConceptMasteries: listConceptMasteries,
      listMemoryCandidates: listMemoryCandidates,
      listPreferenceMemories: listPreferenceMemories,
      recordLearningEvent: recordLearningEvent,
      updatePreferenceMemory: updatePreferenceMemory
    };
  }


  return { RECENT_DAYS: policy.RECENT_DAYS, applyExplicitFeedbackInDb: policy.applyExplicitFeedbackInDb, createMemoryService: createMemoryService,
    learningContextForDb: learningContextForDb, recordLearningEventInDb: recordLearningEventInDb };
});
