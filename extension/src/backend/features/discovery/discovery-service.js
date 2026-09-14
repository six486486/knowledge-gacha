(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const utils = commonJs ? require("../../../shared/runtime-utils.js") : root.KnowledgeGachaRuntimeUtils;
  const schema = commonJs ? require("../../../shared/knowledge-schema.js") : root.KnowledgeGachaKnowledgeSchema;
  const planner = commonJs ? require("./discovery-planner.js") : root.KnowledgeGachaDiscoveryPlanner;
  const ranking = commonJs ? require("./discovery-ranking.js") : root.KnowledgeGachaDiscoveryRanking;
  const api = factory(utils, schema, planner, ranking);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaBackendDiscovery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, schema, planner, ranking) {
  "use strict";

  const POOL_VERSION = "discovery-pool-v2.1";
  const CACHE_MS = 24 * 60 * 60 * 1000;

  function preferenceApplies(preference, seed, targetUnitId, topicId) {
    const scope = preference.scope || {};
    if (scope.type === "global") return true;
    if (scope.type === "unit") return scope.unitId === seed.baseLearningUnitId || scope.unitId === targetUnitId;
    return scope.topicId === seed.baseTopicId || scope.topicId === topicId;
  }

  function difficultyLabel(value) { return value === "foundation" ? "入门" : value === "challenge" ? "进阶" : "标准"; }

  function evidenceLabel(value) {
    return value === "saved_source" ? "来自保存资料" : value === "card_extension" ? "已有卡片延伸"
      : value === "review_evidence" ? "来自复习证据" : "模型建议";
  }

  function reasonSourceType(code) {
    if (code === "explicit_interest") return "preference";
    if (code === "weak_review_evidence") return "review_event";
    if (code === "recent_card") return "card";
    return "exploration_rule";
  }

  function candidateRecord(outline, seed, preferences, contextVersion, timestamp, similarities) {
    const conceptKey = planner.targetKey(outline);
    const learningUnitId = "unit_discovery_" + utils.stableToken(conceptKey).slice(0, 20);
    const topicId = schema.topicId(outline.topic);
    const applied = preferences.filter(function (preference) { return preferenceApplies(preference, seed, learningUnitId, topicId); });
    const downranked = applied.some(function (preference) { return preference.category === "topic_downrank"; });
    const excluded = applied.some(function (preference) { return preference.category === "unit_exclusion"; });
    const familiar = applied.some(function (preference) { return preference.category === "self_familiarity"; });
    const difficulty = outline.difficulty;
    const reasonType = reasonSourceType(seed.reasonCode);
    const reasonSourceId = seed.preferenceId || (reasonType === "review_event" ? seed.baseLearningUnitId : reasonType === "card" ? seed.relatedCardId : "discovery-general-v2");
    const reasons = [{ code: seed.reasonCode, sourceType: reasonType, sourceId: reasonSourceId, summary: seed.reason }];
    const difficultyPreference = planner.difficultyPreference(applied, seed, learningUnitId, topicId);
    const targetDifficulty = planner.preferredDifficulty(difficultyPreference);
    if (difficultyPreference) reasons.push({ code: "difficulty_preference", sourceType: "preference", sourceId: difficultyPreference.id,
      summary: difficulty === targetDifficulty ? "内容难度符合你偏好的“" + difficultyLabel(targetDifficulty) + "”"
        : "你偏好“" + difficultyLabel(targetDifficulty) + "”，这条内容为“" + difficultyLabel(difficulty) + "”，已降低推荐优先级" });
    const scored = ranking.score(outline, seed, { targetDifficulty: targetDifficulty, downranked: downranked, familiar: familiar }, similarities);
    return {
      id: utils.id("discovery_candidate"), poolVersion: POOL_VERSION, mode: seed.mode,
      label: seed.mode === "explicit_interest" ? "兴趣延伸" : seed.mode === "weak_extension" ? "补充理解" : seed.mode === "card_extension" ? "继续这个方向" : "换个视角",
      badge: evidenceLabel(seed.evidenceStatus), topic: outline.topic, topicId: topicId, learningUnitId: learningUnitId,
      conceptKey: conceptKey, semanticSignature: planner.semanticText([outline.topic, outline.learningObjective, outline.newKnowledge].join("|")),
      learningObjective: outline.learningObjective, newKnowledge: outline.newKnowledge, knowledgeText: outline.knowledgeText, relationship: seed.relationship,
      difficulty: difficulty, targetDifficulty: targetDifficulty, evidenceStatus: seed.evidenceStatus, evidenceLabel: evidenceLabel(seed.evidenceStatus),
      relatedCardIds: seed.relatedCardId ? [seed.relatedCardId] : [], relatedLearningUnitIds: seed.baseLearningUnitId ? [seed.baseLearningUnitId] : [],
      sourceRefs: utils.clone(seed.sourceRefs || []), reasonSummary: seed.reason, reasons: reasons,
      appliedPreferenceIds: applied.map(function (preference) { return preference.id; }), contextMemoryVersion: contextVersion,
      seedId: seed.id, seedAnchor: seed.anchor, baseTopicId: seed.baseTopicId || null,
      score: scored.score, scoreComponents: scored.components, excluded: excluded, familiar: familiar,
      status: "available", exposedAt: timestamp, feedback: []
    };
  }

  function repeatsExisting(candidate, request, similarities) {
    return (request.exclusions.existing || []).some(function (item) {
      const sameBase = candidate.relatedLearningUnitIds.includes(item.learningUnitId);
      if (sameBase) return similarities.sameTarget(candidate, item) || planner.nearDuplicate(candidate.newKnowledge, item.summary) || planner.nearDuplicate(
        candidate.learningObjective + " " + candidate.newKnowledge,
        item.learningObjective + " " + item.summary
      );
      return similarities.sameTarget(candidate, item);
    });
  }

  function selectDiverse(candidates, seenKeys, request, similarities) {
    const selected = [];
    const ranked = candidates.filter(function (candidate) {
      if (candidate.excluded || seenKeys.has(candidate.conceptKey) || seenKeys.has(candidate.semanticSignature)) return false;
      if (repeatsExisting(candidate, request, similarities)) return false;
      return !(request.exclusions.seenTargets || []).some(function (previous) { return similarities.sameTarget(candidate, previous); });
    }).sort(function (a, b) { return b.score - a.score || a.topic.localeCompare(b.topic, "zh-CN"); });
    while (ranked.length && selected.length < 3) {
      ranked.sort(function (a, b) {
        const aPenalty = ranking.diversityPenalty(a, selected, similarities);
        const bPenalty = ranking.diversityPenalty(b, selected, similarities);
        return (b.score - bPenalty) - (a.score - aPenalty) || a.topic.localeCompare(b.topic, "zh-CN");
      });
      const explorationIndex = request.preferExploration && selected.length === 2 && !selected.some(function (item) { return item.mode === "controlled_exploration"; })
        ? ranked.findIndex(function (item) { return item.mode === "controlled_exploration"; }) : -1;
      const candidate = explorationIndex >= 0 ? ranked.splice(explorationIndex, 1)[0] : ranked.shift();
      if (selected.some(function (item) { return similarities.sameTarget(item, candidate); })) continue;
      candidate.diversityPenalty = ranking.diversityPenalty(candidate, selected, similarities);
      candidate.selectionScore = candidate.score - candidate.diversityPenalty;
      selected.push(candidate);
    }
    return selected;
  }

  function discoveryPool(db, timestamp, memoryApi, options) {
    options = options || {};
    const learningContext = memoryApi.learningContextForDb(db, timestamp, { mode: "recommendation" });
    const request = options.request || planner.buildSeedRequest(db, learningContext, timestamp, options);
    const seeds = new Map(request.seeds.map(function (seed) { return [seed.id, seed]; }));
    const preferences = learningContext.explicitPreferences || [];
    const seen = new Set(request.exclusions.seenTargetKeys || []);
    const similarities = options.similarities || ranking.lexicalComparison();
    const prepared = (options.outlines || []).map(function (outline) {
      const seed = seeds.get(outline.seedId);
      return seed ? candidateRecord(outline, seed, preferences, learningContext.version, timestamp, similarities) : null;
    }).filter(Boolean);
    const ranked = selectDiverse(prepared, seen, request, similarities);
    const usedPreferenceIds = Array.from(new Set(ranked.flatMap(function (candidate) { return candidate.appliedPreferenceIds; })));
    return {
      id: utils.id("discovery_pool"), runId: utils.id("run"), poolVersion: POOL_VERSION, planVersion: planner.PLAN_VERSION,
      rankingVersion: ranking.VERSION, rankingStrategy: similarities.strategy,
      status: ranked.length ? "active" : "empty", batch: db.discoveryPools.length + 1, candidates: ranked,
      contextSummary: { enabledPreferenceCount: learningContext.explicitPreferences.length,
        observedReviewUnitCount: learningContext.learnedUnits.filter(function (item) { return item.evidenceKind === "observed_review"; }).length,
        recentCardCount: Math.min(5, db.learningState.cards.length) },
      usedPreferenceIds: usedPreferenceIds, candidateMemoriesUsed: 0, contextMemoryVersion: learningContext.version,
      sessionSeenTargetKeys: Array.from(new Set([].concat(Array.from(seen), ranked.flatMap(function (candidate) { return [candidate.conceptKey, candidate.semanticSignature]; })))).slice(-120),
      sessionSeenTargets: [].concat(request.exclusions.seenTargets || [], ranked.map(function (candidate) {
        return { conceptKey: candidate.conceptKey, topic: candidate.topic, learningObjective: candidate.learningObjective,
          seedAnchor: candidate.seedAnchor, baseTopicId: candidate.baseTopicId };
      })).slice(-80),
      selectedCandidateId: null, openedDraftIds: [], generation: options.generation || null,
      metrics: { planned: prepared.length, notSelected: prepared.length - ranked.length, exposed: ranked.length, opened: 0, saved: 0, feedback: 0, generationFailures: 0 },
      createdAt: timestamp, updatedAt: timestamp
    };
  }

  function discoveryOpeningText(candidate) {
    return ["主题：" + candidate.topic, "学习目标：" + candidate.learningObjective, "必须新增：" + candidate.newKnowledge,
      "与已有知识的关系：" + candidate.relationship, "依据状态：" + candidate.evidenceLabel,
      "知识说明（模型生成，未经外部来源验证）：" + candidate.knowledgeText].join("\n");
  }

  function createDiscoveryService(context) {
    const memoryApi = { learningContextForDb: context.learningContextForDb, recordLearningEventInDb: context.recordLearningEventInDb,
      applyExplicitFeedbackInDb: context.applyExplicitFeedbackInDb };
    const openingCandidates = new Map();

    async function createGachaDiscoveryPool(refreshFromPoolId, input) {
      input = input || {};
      const snapshot = context.readDb();
      const timestamp = context.now();
      if (!refreshFromPoolId) {
        const reusable = (snapshot.discoveryPools || []).find(function (pool) {
          return pool.poolVersion === POOL_VERSION && pool.rankingVersion === ranking.VERSION && ["active", "empty"].includes(pool.status) && pool.contextMemoryVersion === snapshot.memoryVersion
            && timestamp - Number(pool.createdAt) < CACHE_MS;
        });
        if (reusable) return { pool: reusable, reused: true, requestId: context.requestId() };
      }
      const previous = refreshFromPoolId && snapshot.discoveryPools.find(function (pool) { return pool.id === refreshFromPoolId; });
      const seenTargetKeys = previous ? previous.sessionSeenTargetKeys || previous.candidates.flatMap(function (candidate) { return [candidate.conceptKey, candidate.semanticSignature]; }) : [];
      const seenTargets = previous ? previous.sessionSeenTargets || previous.candidates : [];
      const learningContext = memoryApi.learningContextForDb(snapshot, timestamp, { mode: "recommendation" });
      const request = planner.buildSeedRequest(snapshot, learningContext, timestamp, { seenTargetKeys: seenTargetKeys,
        seenTargets: seenTargets,
        refreshIndex: previous ? Number(previous.refreshIndex || 1) + 1 : 1, direction: input.direction });
      let planned;
      try { planned = await context.planDiscoveryCandidates(request); }
      catch (error) {
        if (previous) context.mutate(function (db) {
          const stored = db.discoveryPools.find(function (pool) { return pool.id === previous.id; });
          if (stored) { stored.metrics = stored.metrics || {}; stored.metrics.generationFailures = Number(stored.metrics.generationFailures || 0) + 1; stored.lastGenerationError = error.code || "MODEL_REQUEST_FAILED"; }
        });
        throw error;
      }
      const similarities = await ranking.prepare(request, planned.outlines, context.embedding);
      return context.mutate(function (db) {
        if (db.memoryVersion !== request.contextMemoryVersion) throw new Error("学习偏好已变化，请重新准备发现候选");
        const currentPrevious = refreshFromPoolId && db.discoveryPools.find(function (pool) { return pool.id === refreshFromPoolId; });
        if (currentPrevious) { currentPrevious.status = "refreshed"; currentPrevious.updatedAt = timestamp; }
        const pool = discoveryPool(db, timestamp, memoryApi, { request: request, outlines: planned.outlines, generation: planned.generation, similarities: similarities });
        pool.refreshIndex = request.refreshIndex;
        db.discoveryPools.unshift(pool);
        db.discoveryPools = db.discoveryPools.slice(0, 20);
        pool.candidates.forEach(function (candidate) {
          memoryApi.recordLearningEventInDb(db, { eventId: "exposure:" + pool.id + ":" + candidate.id,
            type: "recommendation_exposure", poolId: pool.id, candidateId: candidate.id,
            learningUnitId: candidate.learningUnitId, topicId: candidate.topicId, topicLabel: candidate.topic,
            invalidateCache: false, advanceVersion: false }, timestamp);
        });
        pool.contextMemoryVersion = db.memoryVersion;
        if (context.recordDiscoveryRun) context.recordDiscoveryRun(db, pool, "completed", planned.generation);
        return { pool: pool, reused: false, requestId: context.requestId() };
      });
    }

    function listGachaDiscoveryPools() {
      return Promise.resolve({ pools: context.readDb().discoveryPools, requestId: context.requestId() });
    }

    function openGachaDiscoveryCandidate(poolId, candidateId) {
      const key = poolId + ":" + candidateId;
      if (openingCandidates.has(key)) return openingCandidates.get(key);
      const pending = Promise.resolve().then(function () {
        return generateDiscoveryDraft(poolId, candidateId);
      }).finally(function () { openingCandidates.delete(key); });
      openingCandidates.set(key, pending);
      return pending;
    }

    async function generateDiscoveryDraft(poolId, candidateId) {
      const db = context.readDb();
      const pool = db.discoveryPools.find(function (item) { return item.id === poolId; });
      const candidate = pool && pool.candidates.find(function (item) { return item.id === candidateId; });
      if (!candidate) throw new Error("发现候选不存在");
      if (!["available", "opened", "saved"].includes(candidate.status)) throw new Error("这条发现候选当前不可打开");
      if (candidate.openedDraftId) {
        const existing = db.drafts.find(function (draft) { return draft.id === candidate.openedDraftId; });
        if (existing) return { pool: pool, session: existing, alreadyOpened: true, requestId: context.requestId() };
      }
      const openingText = discoveryOpeningText(candidate);
      const source = { type: "discovery", title: "发现候选：" + candidate.topic, topicId: candidate.topicId,
        learningUnitId: candidate.learningUnitId, url: null, capturedAt: context.now(), evidenceStatus: candidate.evidenceStatus };
      const checked = await context.checkGachaCardSources({ text: openingText, source: source });
      const draft = await context.createGachaCardDraft({ text: openingText,
        userGoal: candidate.learningObjective + "\n必须新增：" + candidate.newKnowledge + "\n目标难度：" + difficultyLabel(candidate.targetDifficulty || candidate.difficulty)
          + "；按这个难度选择前置知识、解释步骤和例子，不得只改难度标签。\n不得复述关联卡摘要。", source: source,
        topicId: candidate.topicId, learningUnitId: candidate.learningUnitId, discoveryEvidence: candidate.sourceRefs,
        discoveryContext: { poolId: pool.id, candidateId: candidate.id, conceptKey: candidate.conceptKey, topic: candidate.topic,
          learningObjective: candidate.learningObjective, newKnowledge: candidate.newKnowledge, relatedCardIds: candidate.relatedCardIds,
          knowledgeText: candidate.knowledgeText,
          evidenceStatus: candidate.evidenceStatus, contextMemoryVersion: candidate.contextMemoryVersion },
        sourcePlan: { checkId: checked.check.id, duplicateAction: "create_new", targetCardId: null, saveFullSource: false } });
      const result = context.mutate(function (next) {
        const stored = next.discoveryPools.find(function (item) { return item.id === poolId; });
        const storedCandidate = stored?.candidates.find(function (item) { return item.id === candidateId; });
        if (!stored || !storedCandidate || stored.status === "dismissed" || !["available", "opened", "saved"].includes(storedCandidate.status)) {
          next.drafts = next.drafts.filter(function (item) { return item.id !== draft.session.id || item.status === "confirmed"; });
          return null;
        }
        stored.selectedCandidateId = candidateId;
        stored.openedDraftIds = Array.from(new Set([].concat(stored.openedDraftIds || [], draft.session.id)));
        stored.updatedAt = context.now(); storedCandidate.status = "opened"; storedCandidate.openedDraftId = draft.session.id; storedCandidate.openedAt = context.now();
        stored.metrics.opened = Number(stored.metrics?.opened || 0) + 1;
        memoryApi.recordLearningEventInDb(next, { eventId: "discovery_open:" + poolId + ":" + candidateId,
          type: "discovery_opened", poolId: poolId, candidateId: candidateId, learningUnitId: candidate.learningUnitId,
          topicId: candidate.topicId, topicLabel: candidate.topic, invalidateCache: false, advanceVersion: false }, context.now());
        return { pool: stored, session: draft.session, alreadyOpened: false, requestId: context.requestId() };
      });
      if (!result) throw new Error("发现候选已移除或已变化，本次未保留新草稿");
      return result;
    }

    function sendGachaDiscoveryFeedback(poolId, input) {
      input = input || {};
      return Promise.resolve(context.mutate(function (db) {
        const pool = db.discoveryPools.find(function (item) { return item.id === poolId; });
        if (!pool) throw new Error("发现池不存在");
        if (input.action === "end_session" || input.action === "dismiss") {
          pool.status = "dismissed"; pool.updatedAt = context.now();
          return { pool: pool, preference: null, transient: true, requestId: context.requestId() };
        }
        const candidate = pool.candidates.find(function (item) { return item.id === input.candidateId; });
        if (!candidate) throw new Error("发现候选不存在");
        if (input.action === "dismiss_candidate") {
          candidate.status = "dismissed";
          candidate.feedback = (candidate.feedback || []).concat({ action: input.action, appliedAt: context.now(), transient: true });
          pool.metrics.feedback = Number(pool.metrics?.feedback || 0) + 1; pool.updatedAt = context.now();
          return { pool: pool, candidate: candidate, preference: null, transient: true, requestId: context.requestId() };
        }
        const action = input.action === "not_interested" ? "less_topic" : input.action;
        const applied = memoryApi.applyExplicitFeedbackInDb(db, { action: action, mutationId: input.mutationId,
          poolId: pool.id, candidateId: candidate.id, topic: candidate.topic, topicId: candidate.topicId, learningUnitId: candidate.learningUnitId }, context.now());
        if (!applied.alreadyApplied) {
          if (action !== "like_topic") candidate.status = "feedback_applied";
          else if (!["opened", "saved"].includes(candidate.status)) candidate.status = "available";
          candidate.feedback = (candidate.feedback || []).concat({ action: action, preferenceId: applied.preference?.id || null, appliedAt: context.now(), transient: false });
          pool.metrics.feedback = Number(pool.metrics?.feedback || 0) + 1; pool.updatedAt = context.now();
        }
        return Object.assign({ pool: pool, candidate: candidate, transient: false, requestId: context.requestId() }, applied);
      }));
    }

    return { createGachaDiscoveryPool: createGachaDiscoveryPool, listGachaDiscoveryPools: listGachaDiscoveryPools,
      openGachaDiscoveryCandidate: openGachaDiscoveryCandidate, sendGachaDiscoveryFeedback: sendGachaDiscoveryFeedback };
  }

  return { POOL_VERSION: POOL_VERSION, RANKING_VERSION: ranking.VERSION, createDiscoveryService: createDiscoveryService, discoveryOpeningText: discoveryOpeningText, discoveryPool: discoveryPool };
});
