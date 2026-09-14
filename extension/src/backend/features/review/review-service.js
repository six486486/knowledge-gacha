(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const utils = commonJs ? require("../../../shared/runtime-utils.js") : root.KnowledgeGachaRuntimeUtils;
  const learning = commonJs ? require("../../../shared/review-learning.js") : root.KnowledgeGachaReviewLearning;
  const api = factory(utils, learning);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaBackendReview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, learning) {
  "use strict";

  const ERROR_TYPES = new Set(["unknown", "missing_prerequisite", "concept_confusion", "step_order", "supported_misconception"]);

  function cleanText(value, limit) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, limit || 500);
  }

  function reviewSettings(db) {
    return { dailyGoal: learning.dailyGoal(db.reviewSettings?.dailyGoal), scheduleVersion: learning.SCHEDULE_VERSION };
  }

  function dayState(db, timestamp) {
    const day = utils.localDay(timestamp);
    const stored = db.learningState.reviewDay;
    if (!stored || stored.day !== day) return { day: day, answered: 0, completed: false, continueAfterGoal: false, lastLearningUnitId: null };
    const goal = reviewSettings(db).dailyGoal;
    return Object.assign({}, stored, { answered: Math.max(0, Number(stored.answered) || 0), completed: Number(stored.answered) >= goal,
      continueAfterGoal: stored.continueAfterGoal === true, lastLearningUnitId: stored.lastLearningUnitId || null });
  }

  function ensureStoredDay(db, timestamp) {
    const current = dayState(db, timestamp);
    db.learningState.reviewDay = current;
    return current;
  }

  function unitEvents(db, card) {
    return (db.reviewEvents || []).filter(function (event) {
      return event.learningUnitId && event.learningUnitId === card.learningUnitId || event.cardId === card.id;
    });
  }

  function reviewSnapshot(db, card, timestamp) {
    return learning.masterySnapshot(unitEvents(db, card), timestamp, db.reviewEventCorrections);
  }

  function reviewReasons(card, snapshot) {
    const reasons = [{ code: "due_card", sourceType: "card", sourceId: card.id, summary: "这张卡已经到达复习时间。" }];
    if (snapshot.incorrectCount && snapshot.errorCause.code !== "none") {
      reasons.unshift({ code: "recent_error", sourceType: "review_event", sourceId: snapshot.errorCause.basis?.correctionId || snapshot.errorCause.basis?.exerciseId || card.id,
        summary: snapshot.errorCause.code === "unknown" ? "此前有一次错误，但现有作答依据不足以确定具体错因。" : "此前练习记录显示需要继续处理：“" + snapshot.errorCause.label + "”。" });
    }
    return reasons;
  }

  function reviewDifficulty(snapshot) {
    return snapshot.masteryLevel === "multiple_verified" ? "challenge" : snapshot.masteryLevel === "familiar" ? "standard" : "foundation";
  }

  function reviewPresentation(db, card, timestamp, learningContextForDb) {
    const context = learningContextForDb ? learningContextForDb(db, timestamp, { mode: "review", topicId: card.topicId, learningUnitId: card.learningUnitId })
      : { explicitPreferences: [], appliedPreferenceIds: [], learnedUnits: [] };
    const snapshot = reviewSnapshot(db, card, timestamp);
    const difficultyPreference = context.explicitPreferences.find(function (item) { return item.category === "difficulty_preference"; });
    const formatPreference = context.explicitPreferences.find(function (item) { return item.category === "learning_format"; });
    const difficulty = difficultyPreference?.value === "foundational" ? "foundation" : difficultyPreference?.value === "advanced" ? "challenge" : reviewDifficulty(snapshot);
    return { context: context, evidence: context.learnedUnits[0] || null, snapshot: snapshot, difficulty: difficulty, explanationMode: formatPreference?.value || "concise" };
  }

  function activeAttempt(db, cardId) {
    return (db.reviewAttempts || []).filter(function (attempt) { return attempt.cardId === cardId && attempt.status === "active"; })
      .sort(function (a, b) { return Number(b.openedAt) - Number(a.openedAt); })[0] || null;
  }

  function activeDeferral(db, cardId, timestamp) {
    return (db.reviewDeferrals || []).filter(function (item) { return item.cardId === cardId && Number(item.until) > timestamp; })
      .sort(function (a, b) { return Number(b.createdAt) - Number(a.createdAt); })[0] || null;
  }

  function queueRecords(db, timestamp) {
    const reviewDay = dayState(db, timestamp);
    return (db.learningState.cards || []).filter(function (card) { return Number(card.dueAt) <= timestamp; }).map(function (card) {
      return { card: card, attempt: activeAttempt(db, card.id), deferral: activeDeferral(db, card.id, timestamp), snapshot: reviewSnapshot(db, card, timestamp) };
    }).filter(function (item) { return !item.deferral; }).sort(function (a, b) {
      const activeDifference = Number(Boolean(b.attempt)) - Number(Boolean(a.attempt));
      if (activeDifference) return activeDifference;
      const adjacentDifference = Number(a.card.learningUnitId === reviewDay.lastLearningUnitId) - Number(b.card.learningUnitId === reviewDay.lastLearningUnitId);
      if (adjacentDifference) return adjacentDifference;
      const levels = { insufficient_evidence: 0, learning: 1, familiar: 2, multiple_verified: 3 };
      return levels[a.snapshot.masteryLevel] - levels[b.snapshot.masteryLevel] || Number(a.card.dueAt) - Number(b.card.dueAt) || a.card.id.localeCompare(b.card.id);
    });
  }

  function stagedNewCards(db, timestamp) {
    return (db.learningState.cards || []).filter(function (card) {
      return card.learningStage === "new" && !card.initialLearningCompletedAt && Number(card.dueAt) > timestamp;
    }).sort(function (a, b) { return Number(a.dueAt) - Number(b.dueAt) || a.id.localeCompare(b.id); });
  }

  function reviewOverview(db, timestamp, requestIdValue, learningContextForDb) {
    const settings = reviewSettings(db);
    const reviewDay = dayState(db, timestamp);
    const due = queueRecords(db, timestamp);
    const deferredCount = (db.learningState.cards || []).filter(function (card) { return Number(card.dueAt) <= timestamp && activeDeferral(db, card.id, timestamp); }).length;
    const staged = stagedNewCards(db, timestamp);
    const goalReached = reviewDay.answered >= settings.dailyGoal;
    const status = due.length ? (goalReached && !reviewDay.continueAfterGoal ? "goal_reached" : "ready") : "no_due_reviews";
    const record = status === "ready" ? due[0] : null;
    const presentation = record ? reviewPresentation(db, record.card, timestamp, learningContextForDb) : null;
    const overview = {
      asOf: timestamp,
      status: status,
      dueCount: due.length,
      deferredCount: deferredCount,
      newCardCount: staged.length,
      nextNewCardDueAt: staged[0]?.dueAt || null,
      dailyAnswered: reviewDay.answered,
      dailyGoal: settings.dailyGoal,
      goalReached: goalReached,
      continuingAfterGoal: reviewDay.continueAfterGoal,
      remainingToday: Math.max(0, settings.dailyGoal - reviewDay.answered),
      canContinue: Boolean(goalReached && due.length || staged.length),
      capsule: record ? {
        cardId: record.card.id,
        dueAt: record.card.dueAt,
        activeAttemptId: record.attempt?.id || null,
        learningStage: record.card.learningStage || "scheduled",
        canGenerateVariant: Boolean((record.card.citations || []).some(function (citation) { return citation && citation.quote; })),
        masteryScore: null,
        masteryLevel: presentation.snapshot.masteryLevel,
        masteryLabel: presentation.snapshot.masteryLabel,
        learningEvidence: presentation.evidence,
        difficulty: presentation.difficulty,
        explanationMode: presentation.explanationMode,
        appliedPreferenceIds: presentation.context.appliedPreferenceIds,
        reasons: reviewReasons(record.card, presentation.snapshot)
      } : null,
      candidateMemoriesUsed: 0,
      scheduleVersion: learning.SCHEDULE_VERSION,
      masteryVersion: learning.MASTERY_VERSION
    };
    if (requestIdValue) overview.requestId = requestIdValue;
    return overview;
  }

  function derivedRecallExercise(card, base) {
    const rubric = [card.learningObjective, card.boundaries].map(function (item) { return cleanText(item, 240); }).filter(Boolean).slice(0, 2);
    if (!rubric.length) rubric.push("说出“" + cleanText(card.title, 80) + "”的核心含义", "说明一个适用条件或应用要点");
    const answer = cleanText(card.summary || card.plainSummary || card.source || card.title, 2000);
    return {
      id: "exercise_review_recall_" + utils.stableToken(card.learningUnitId + ":" + card.id).slice(0, 20),
      cardId: card.id,
      learningUnitId: card.learningUnitId,
      version: 1,
      type: "recall",
      purpose: "retrieval_variant",
      origin: "deterministic_card_review",
      variantOf: base?.id || null,
      question: "请先用自己的话解释“" + cleanText(card.title, 80) + "”，再说明它成立的条件或一个应用要点。",
      options: [],
      correctIndex: null,
      answer: answer,
      answerExplanation: answer,
      rubric: rubric,
      misconceptions: [],
      hint: "先回想它解决什么问题，再找题目中的条件、步骤或边界。",
      createdAt: card.createdAt || 0
    };
  }

  function ensureReviewVariants(db, card) {
    const exercises = (db.exercises || []).filter(function (item) { return (card.exerciseIds || []).includes(item.id); });
    if (!exercises.some(function (item) { return item.origin === "deterministic_card_review"; })) {
      const variant = derivedRecallExercise(card, exercises[0]);
      if (!db.exercises.some(function (item) { return item.id === variant.id; })) db.exercises.push(variant);
      card.exerciseIds = Array.from(new Set([].concat(card.exerciseIds || [], variant.id)));
      return true;
    }
    return false;
  }

  function chooseExercise(db, card) {
    const exercises = (db.exercises || []).filter(function (item) { return (card.exerciseIds || []).includes(item.id); });
    if (!exercises.length) return card;
    const recent = unitEvents(db, card).slice().sort(function (a, b) { return Number(b.answeredAt) - Number(a.answeredAt); });
    const lastUsed = new Map();
    recent.forEach(function (event) { if (!lastUsed.has(event.exerciseId)) lastUsed.set(event.exerciseId, Number(event.answeredAt)); });
    return exercises.slice().sort(function (a, b) {
      return (lastUsed.has(a.id) ? 1 : 0) - (lastUsed.has(b.id) ? 1 : 0) ||
        Number(a.origin === "deterministic_card_review") - Number(b.origin === "deterministic_card_review") ||
        (lastUsed.get(a.id) || 0) - (lastUsed.get(b.id) || 0) || a.id.localeCompare(b.id);
    })[0];
  }

  function exerciseSnapshot(exercise) {
    return {
      id: exercise.id,
      version: exercise.version || 1,
      type: exercise.type || "choice",
      purpose: exercise.purpose || "saved_exercise",
      origin: exercise.origin || (exercise.legacy ? "legacy_card" : "generated_card"),
      variantOf: exercise.variantOf || null,
      question: cleanText(exercise.question, 2000),
      options: Array.isArray(exercise.options) ? exercise.options.map(function (item) { return cleanText(item, 1000); }) : [],
      correctIndex: Number.isInteger(exercise.correctIndex) ? exercise.correctIndex : null,
      answer: cleanText(exercise.answer, 3000),
      answerExplanation: cleanText(exercise.answerExplanation, 3000),
      rubric: Array.isArray(exercise.rubric) ? exercise.rubric.map(function (item) { return cleanText(item, 1000); }).filter(Boolean) : [],
      misconceptions: Array.isArray(exercise.misconceptions) ? exercise.misconceptions.map(function (item) { return cleanText(item, 1000); }) : [],
      hint: cleanText(exercise.hint, 1000) || "先找出题目中的关键条件，再回想核心解释，不必急着看答案。"
    };
  }

  function publicQuestion(card, attempt, presentation) {
    const exercise = attempt.exerciseSnapshot;
    return {
      attemptId: attempt.id,
      cardId: card.id,
      learningUnitId: card.learningUnitId,
      cardVersion: attempt.cardVersion,
      exerciseId: exercise.id,
      exerciseVersion: exercise.version,
      exerciseOrigin: exercise.origin,
      type: exercise.type,
      title: card.title,
      question: exercise.question,
      options: exercise.options,
      hintAvailable: true,
      answerAvailable: exercise.type === "recall",
      hintUsed: attempt.hintUsed === true,
      answerRevealed: Boolean(attempt.answerRevealedAt),
      savedResponse: attempt.responseText || "",
      savedHint: attempt.hintUsed ? exercise.hint : "",
      revealedAnswer: attempt.answerRevealedAt ? { answer: exercise.answer, answerExplanation: exercise.answerExplanation, rubric: utils.clone(exercise.rubric) } : null,
      difficulty: presentation.difficulty,
      explanationMode: presentation.explanationMode,
      appliedPreferenceIds: presentation.context.appliedPreferenceIds,
      learningEvidence: presentation.evidence,
      masteryLevel: presentation.snapshot.masteryLevel,
      masteryLabel: presentation.snapshot.masteryLabel,
      reasons: reviewReasons(card, presentation.snapshot)
    };
  }

  function inputFingerprint(cardId, attempt, input) {
    return utils.stableToken(JSON.stringify({ cardId: cardId, attemptId: attempt.id, exerciseId: attempt.exerciseId, exerciseVersion: attempt.exerciseVersion,
      chosenIndex: input.chosenIndex, selfAssessedCorrect: input.selfAssessedCorrect, responseText: cleanText(input.responseText, 2000) }));
  }

  function feedbackFromEvent(event, dailyGoal) {
    const exercise = event.exerciseSnapshot || {};
    return {
      cardId: event.cardId,
      reviewEventId: event.id,
      attemptId: event.attemptId || null,
      correct: event.correct,
      chosenIndex: event.chosenIndex,
      correctIndex: exercise.correctIndex ?? event.correctIndex,
      assessment: event.assessment,
      scoringMethod: event.scoringMethod,
      correctAnswer: exercise.answer || (exercise.options || [])[exercise.correctIndex] || "",
      explanation: exercise.answerExplanation || (event.correct ? "这次回答符合已保存答案。" : "请对照核心解释和具体误区，按排期再次练习。"),
      rubric: exercise.rubric || [],
      errorCause: event.errorCause || { code: event.errorType || "unknown", label: learning.ERROR_LABELS[event.errorType] || learning.ERROR_LABELS.unknown, status: "unknown", basis: null },
      mastery: event.legacyMasteryAfter,
      masteryLevel: event.masteryLevelAfter || "learning",
      masteryLabel: event.masteryLabelAfter || learning.LEVEL_LABELS.learning,
      masteryVersion: event.masteryVersion || learning.MASTERY_VERSION,
      reviewCount: event.reviewCountAfter,
      dueAt: event.dueAtAfter,
      intervalDays: event.intervalDays,
      scheduleVersion: event.scheduleVersion,
      hintUsed: event.hintUsed,
      durationMs: event.durationMs,
      dailyAnswered: event.dailyAnsweredAfter,
      dailyGoal: dailyGoal,
      dailyCompleted: event.dailyAnsweredAfter >= dailyGoal,
      applied: true
    };
  }

  function rememberReviewMutation(db, id, action, fingerprint, result, timestamp) {
    if (!id) return;
    db.reviewMutations = (db.reviewMutations || []).filter(function (item) { return item.id !== id; });
    db.reviewMutations.push({ id: id, action: action, fingerprint: fingerprint, result: utils.clone(result), appliedAt: timestamp });
    db.reviewMutations = db.reviewMutations.filter(function (item) { return Number(item.appliedAt) >= timestamp - 90 * learning.DAY; }).slice(-600);
  }

  function withReviewMutation(db, input, action, timestamp, operation) {
    const id = cleanText(input?.mutationId, 180);
    const fingerprint = utils.stableToken(JSON.stringify(Object.assign({}, input, { mutationId: undefined })));
    const prior = id && (db.reviewMutations || []).find(function (item) { return item.id === id; });
    if (prior) {
      if (prior.action !== action || prior.fingerprint !== fingerprint) throw new Error("同一操作标识不能用于不同的复习修改");
      return Object.assign(utils.clone(prior.result), { alreadyApplied: true });
    }
    const result = Object.assign(operation(), { alreadyApplied: false });
    rememberReviewMutation(db, id, action, fingerprint, result, timestamp);
    return result;
  }

  function nextNewCardDueAt(cards, timestamp, goal, groupId) {
    const count = (cards || []).filter(function (card) { return card.releaseGroupId === groupId && card.learningStage === "new" && !card.initialLearningCompletedAt; }).length;
    return timestamp + (1 + Math.floor(count / learning.dailyGoal(goal))) * learning.DAY;
  }

  function createReviewService(context) {
    const readDb = context.readDb;
    const mutate = context.mutate;
    const now = context.now;
    const requestId = context.requestId;
    const learningContextForDb = context.learningContextForDb;
    const recordLearningEventInDb = context.recordLearningEventInDb;

    function getGachaReview() {
      return Promise.resolve(reviewOverview(readDb(), now(), requestId(), learningContextForDb));
    }

    function openGachaReview(cardId, input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        db.reviewDeferrals = (db.reviewDeferrals || []).filter(function (item) { return Number(item.until) > timestamp - 7 * learning.DAY; });
        const overview = reviewOverview(db, timestamp, null, learningContextForDb);
        const card = db.learningState.cards.find(function (item) { return item.id === cardId; });
        if (!card) throw new Error("复习卡不存在");
        if (overview.status !== "ready" || overview.capsule?.cardId !== cardId) throw new Error(overview.status === "goal_reached" ? "今日目标已完成，可选择继续后再打开" : "这张卡当前不在复习队列中");
        let attempt = activeAttempt(db, card.id);
        if (!attempt) {
          ensureReviewVariants(db, card);
          const requestedExercise = input?.exerciseId && (db.exercises || []).find(function (item) { return item.id === input.exerciseId && (card.exerciseIds || []).includes(item.id); });
          const exercise = requestedExercise || chooseExercise(db, card);
          const snapshot = exerciseSnapshot(exercise);
          attempt = { id: utils.id("review_attempt"), cardId: card.id, cardVersion: card.version || 1, learningUnitId: card.learningUnitId,
            exerciseId: snapshot.id, exerciseVersion: snapshot.version, exerciseSnapshot: snapshot, status: "active", hintUsed: false,
            responseText: "", openedAt: timestamp, updatedAt: timestamp };
          db.reviewAttempts.push(attempt);
          db.reviewAttempts = db.reviewAttempts.filter(function (item) { return Number(item.openedAt) >= timestamp - 180 * learning.DAY || item.status === "active"; }).slice(-1000);
          db.version += 1;
        }
        const presentation = reviewPresentation(db, card, timestamp, learningContextForDb);
        return { review: reviewOverview(db, timestamp, null, learningContextForDb), question: publicQuestion(card, attempt, presentation), resumed: attempt.openedAt !== timestamp, requestId: requestId() };
      }));
    }

    function getGachaReviewHint(cardId, input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const attempt = (db.reviewAttempts || []).find(function (item) { return item.id === input?.attemptId && item.cardId === cardId && item.status === "active"; });
        if (!attempt) throw new Error("复习尝试不存在或已经结束");
        attempt.hintUsed = true;
        attempt.hintViewedAt = attempt.hintViewedAt || timestamp;
        attempt.updatedAt = timestamp;
        db.version += 1;
        return { attemptId: attempt.id, hint: attempt.exerciseSnapshot.hint, hintUsed: true, requestId: requestId() };
      }));
    }

    function revealGachaReviewAnswer(cardId, input) {
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const attempt = (db.reviewAttempts || []).find(function (item) { return item.id === input?.attemptId && item.cardId === cardId && item.status === "active"; });
        if (!attempt) throw new Error("复习尝试不存在或已经结束");
        if (attempt.exerciseSnapshot.type !== "recall") throw new Error("选择题会在提交后显示答案");
        attempt.responseText = cleanText(input?.responseText, 2000);
        attempt.answerRevealedAt = attempt.answerRevealedAt || timestamp;
        attempt.updatedAt = timestamp;
        db.version += 1;
        return { attemptId: attempt.id, answer: attempt.exerciseSnapshot.answer, answerExplanation: attempt.exerciseSnapshot.answerExplanation,
          rubric: attempt.exerciseSnapshot.rubric, responseText: attempt.responseText, requestId: requestId() };
      }));
    }

    function answerGachaReview(cardId, input) {
      input = input || {};
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const card = db.learningState.cards.find(function (item) { return item.id === cardId; });
        if (!card) throw new Error("复习卡不存在");
        const attempt = input.attemptId ? (db.reviewAttempts || []).find(function (item) { return item.id === input.attemptId && item.cardId === cardId; }) : activeAttempt(db, cardId);
        if (!attempt) throw new Error("请重新打开这道复习题");
        if (attempt.exerciseSnapshot.type !== "recall" && (!Number.isInteger(input.chosenIndex) || input.chosenIndex < 0 || input.chosenIndex >= attempt.exerciseSnapshot.options.length)) throw new Error("请先完成本题作答");
        const fingerprint = inputFingerprint(cardId, attempt, input);
        const mutationId = cleanText(input.mutationId, 180);
        const duplicate = mutationId && (db.reviewEvents || []).find(function (event) { return event.mutationId === mutationId; });
        if (duplicate) {
          if (duplicate.inputFingerprint !== fingerprint) throw new Error("同一操作标识不能提交不同答案");
          return { feedback: feedbackFromEvent(duplicate, reviewSettings(db).dailyGoal), next: reviewOverview(db, timestamp, null, learningContextForDb), alreadyApplied: true, requestId: requestId() };
        }
        if (attempt.status !== "active") throw new Error("这道题已经提交，不能重复计入");
        if (input.exerciseId && (input.exerciseId !== attempt.exerciseId || Number(input.exerciseVersion) !== attempt.exerciseVersion)) throw new Error("题目版本已变化，请重新打开");
        const exercise = attempt.exerciseSnapshot;
        const selfAssessment = exercise.type === "recall";
        const chosen = selfAssessment ? null : Number(input.chosenIndex);
        if (selfAssessment && !attempt.answerRevealedAt) throw new Error("请先尝试作答并对照要点，再完成自评");
        if (selfAssessment ? typeof input.selfAssessedCorrect !== "boolean" : !Number.isInteger(chosen) || chosen < 0 || chosen >= exercise.options.length) throw new Error("请先完成本题作答");
        const correct = selfAssessment ? input.selfAssessedCorrect : chosen === exercise.correctIndex;
        const priorEvents = unitEvents(db, card);
        const schedule = learning.scheduleForAnswer(priorEvents, correct, attempt.hintUsed, timestamp);
        const errorCause = selfAssessment ? (correct ? { code: "none", label: learning.ERROR_LABELS.none, status: "recorded", basis: null }
          : { code: "unknown", label: learning.ERROR_LABELS.unknown, status: "unknown", basis: { type: "self_assessment_without_specific_cause", attemptId: attempt.id } })
          : learning.choiceErrorCause(exercise, chosen, correct);
        const reviewDay = ensureStoredDay(db, timestamp);
        reviewDay.answered += 1;
        reviewDay.completed = reviewDay.answered >= reviewSettings(db).dailyGoal;
        reviewDay.lastLearningUnitId = card.learningUnitId;
        const event = {
          id: utils.id("review_event"), mutationId: mutationId || null, inputFingerprint: fingerprint, attemptId: attempt.id,
          cardId: card.id, cardVersion: attempt.cardVersion, learningUnitId: card.learningUnitId, topicId: card.topicId,
          exerciseId: exercise.id, exerciseVersion: exercise.version, exerciseSnapshot: utils.clone(exercise),
          assessment: selfAssessment ? "self" : "choice", scoringMethod: selfAssessment ? "self_assessment" : "stored_choice_answer", evidenceKind: "observed_review",
          title: card.title, responseText: selfAssessment ? cleanText(input.responseText || attempt.responseText, 2000) : null,
          selfAssessedCorrect: selfAssessment ? input.selfAssessedCorrect : null, correct: correct, hintUsed: attempt.hintUsed,
          hintViewedAt: attempt.hintViewedAt || null, answerRevealedBeforeAssessment: Boolean(attempt.answerRevealedAt),
          durationMs: Number.isFinite(Number(input.durationMs)) ? Math.max(0, Number(input.durationMs)) : Math.max(0, timestamp - Number(attempt.openedAt)),
          serverElapsedMs: Math.max(0, timestamp - Number(attempt.openedAt)), chosenIndex: chosen, correctIndex: exercise.correctIndex,
          errorType: errorCause.code, errorCause: errorCause, intervalDays: schedule.intervalDays, dueAtAfter: schedule.dueAt,
          scheduleVersion: schedule.version, dailyAnsweredAfter: reviewDay.answered, answeredAt: timestamp
        };
        db.reviewEvents.push(event);
        const snapshot = reviewSnapshot(db, card, timestamp);
        event.masteryLevelAfter = snapshot.masteryLevel;
        event.masteryLabelAfter = snapshot.masteryLabel;
        event.masteryVersion = snapshot.calculationVersion;
        event.reviewCountAfter = snapshot.reviewCount;
        event.legacyMasteryAfter = learning.legacyMasteryValue(snapshot.masteryLevel);
        card.reviewCount = snapshot.reviewCount;
        card.mastery = event.legacyMasteryAfter;
        card.updatedAt = timestamp;
        card.dueAt = schedule.dueAt;
        card.reviewScheduleVersion = schedule.version;
        card.learningStage = "review";
        card.initialLearningCompletedAt = card.initialLearningCompletedAt || timestamp;
        if (correct) card.lastCorrectReviewDay = utils.localDay(timestamp);
        attempt.status = "answered";
        attempt.reviewEventId = event.id;
        attempt.responseText = event.responseText || attempt.responseText;
        attempt.answeredAt = timestamp;
        attempt.updatedAt = timestamp;
        if (recordLearningEventInDb) recordLearningEventInDb(db, {
          eventId: "recent:" + event.id, type: "review_answered", cardId: card.id, learningUnitId: card.learningUnitId,
          topicId: card.topicId, topicLabel: card.title, correct: correct, hintUsed: event.hintUsed, durationMs: event.durationMs, errorType: event.errorType
        }, timestamp);
        db.version += 1;
        return { feedback: feedbackFromEvent(event, reviewSettings(db).dailyGoal), next: reviewOverview(db, timestamp, null, learningContextForDb), alreadyApplied: false, requestId: requestId() };
      }));
    }

    function setGachaReviewGoal(input) {
      input = input || {};
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withReviewMutation(db, input, "set_daily_goal", timestamp, function () {
          db.reviewSettings.dailyGoal = learning.dailyGoal(input.dailyGoal);
          db.reviewSettings.scheduleVersion = learning.SCHEDULE_VERSION;
          const day = ensureStoredDay(db, timestamp);
          day.completed = day.answered >= db.reviewSettings.dailyGoal;
          if (!day.completed) day.continueAfterGoal = false;
          db.version += 1;
          return { dailyGoal: db.reviewSettings.dailyGoal };
        });
        return Object.assign(result, { review: reviewOverview(db, timestamp, null, learningContextForDb), requestId: requestId() });
      }));
    }

    function continueGachaReview(input) {
      input = input || {};
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withReviewMutation(db, input, "continue_review", timestamp, function () {
          const day = ensureStoredDay(db, timestamp);
          day.continueAfterGoal = true;
          let releasedCardId = null;
          if (!queueRecords(db, timestamp).length) {
            const next = stagedNewCards(db, timestamp)[0];
            if (next) { next.dueAt = timestamp; next.manuallyReleasedAt = timestamp; releasedCardId = next.id; }
          }
          db.version += 1;
          return { releasedCardId: releasedCardId };
        });
        return Object.assign(result, { review: reviewOverview(db, timestamp, null, learningContextForDb), requestId: requestId() });
      }));
    }

    function deferGachaReview(cardId, input) {
      input = input || {};
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withReviewMutation(db, input, "defer_review:" + cardId, timestamp, function () {
          const card = db.learningState.cards.find(function (item) { return item.id === cardId; });
          if (!card) throw new Error("复习卡不存在");
          const action = ["later", "tomorrow", "skip_today"].includes(input.action) ? input.action : "later";
          const local = new Date(timestamp);
          if (action === "tomorrow") local.setHours(32, 0, 0, 0);
          else if (action === "skip_today") local.setHours(24, 0, 0, 0);
          const until = action === "later" ? timestamp + 60 * 60 * 1000 : local.getTime();
          db.reviewDeferrals.push({ id: utils.id("review_deferral"), cardId: card.id, learningUnitId: card.learningUnitId, action: action, until: until, createdAt: timestamp });
          const attempt = activeAttempt(db, card.id);
          if (attempt) { attempt.status = "abandoned"; attempt.abandonedReason = action; attempt.updatedAt = timestamp; }
          db.version += 1;
          return { cardId: card.id, action: action, until: until };
        });
        return Object.assign(result, { review: reviewOverview(db, timestamp, null, learningContextForDb), requestId: requestId() });
      }));
    }

    function correctGachaReviewEvent(eventId, input) {
      input = input || {};
      return Promise.resolve(mutate(function (db) {
        const timestamp = now();
        const result = withReviewMutation(db, input, "correct_review_event:" + eventId, timestamp, function () {
          const event = db.reviewEvents.find(function (item) { return item.id === eventId; });
          if (!event) throw new Error("复习事件不存在");
          const errorType = cleanText(input.errorType, 80);
          if (!ERROR_TYPES.has(errorType)) throw new Error("请选择可识别的错因类型");
          const correction = { id: utils.id("review_correction"), reviewEventId: event.id, previousErrorType: learning.effectiveErrorCause(event, db.reviewEventCorrections).code,
            errorType: errorType, errorLabel: learning.ERROR_LABELS[errorType], note: cleanText(input.note, 500), source: "user_correction", correctedAt: timestamp };
          db.reviewEventCorrections.push(correction);
          if (recordLearningEventInDb) recordLearningEventInDb(db, { eventId: "recent:" + correction.id, type: "review_error_corrected", cardId: event.cardId,
            learningUnitId: event.learningUnitId, topicId: event.topicId, topicLabel: event.title }, timestamp);
          db.version += 1;
          return { correction: correction };
        });
        return Object.assign(result, { requestId: requestId() });
      }));
    }

    function getGachaReviewEvidence(cardId) {
      const db = readDb();
      const card = db.learningState.cards.find(function (item) { return item.id === cardId; });
      if (!card) return Promise.reject(new Error("复习卡不存在"));
      const events = unitEvents(db, card).slice().sort(function (a, b) { return Number(b.answeredAt) - Number(a.answeredAt); });
      const eventIds = new Set(events.map(function (event) { return event.id; }));
      return Promise.resolve({ cardId: card.id, learningUnitId: card.learningUnitId, events: utils.clone(events),
        corrections: utils.clone((db.reviewEventCorrections || []).filter(function (item) { return eventIds.has(item.reviewEventId); })),
        mastery: reviewSnapshot(db, card, now()), requestId: requestId() });
    }

    return {
      answerGachaReview: answerGachaReview,
      continueGachaReview: continueGachaReview,
      correctGachaReviewEvent: correctGachaReviewEvent,
      deferGachaReview: deferGachaReview,
      getGachaReview: getGachaReview,
      getGachaReviewEvidence: getGachaReviewEvidence,
      getGachaReviewHint: getGachaReviewHint,
      openGachaReview: openGachaReview,
      revealGachaReviewAnswer: revealGachaReviewAnswer,
      setGachaReviewGoal: setGachaReviewGoal,
      planWeakPointReview: function () { return Promise.resolve(reviewOverview(readDb(), now(), requestId(), learningContextForDb)); }
    };
  }

  return {
    createReviewService: createReviewService,
    derivedRecallExercise: derivedRecallExercise,
    ensureReviewVariants: ensureReviewVariants,
    nextNewCardDueAt: nextNewCardDueAt,
    reviewDifficulty: reviewDifficulty,
    reviewOverview: reviewOverview,
    reviewReasons: reviewReasons,
    reviewSnapshot: reviewSnapshot
  };
});
