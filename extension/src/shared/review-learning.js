(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaReviewLearning = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY = 24 * 60 * 60 * 1000;
  const DEFAULT_DAILY_GOAL = 3;
  const MAX_DAILY_GOAL = 20;
  const SCHEDULE_VERSION = "review-schedule-v2";
  const MASTERY_VERSION = "review-mastery-v1";
  const LEVEL_LABELS = {
    insufficient_evidence: "证据不足",
    learning: "正在学习",
    familiar: "较熟悉",
    multiple_verified: "多次验证"
  };
  const ERROR_LABELS = {
    none: "无错误",
    unknown: "暂未确定",
    missing_prerequisite: "缺少前提",
    concept_confusion: "混淆概念",
    step_order: "步骤顺序错误",
    supported_misconception: "选项对应的具体误区"
  };

  function dailyGoal(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(1, Math.min(MAX_DAILY_GOAL, Math.floor(number))) : DEFAULT_DAILY_GOAL;
  }

  function correctionFor(event, corrections) {
    return (corrections || []).filter(function (item) { return item.reviewEventId === event.id; })
      .sort(function (a, b) { return Number(b.correctedAt) - Number(a.correctedAt); })[0] || null;
  }

  function effectiveErrorCause(event, corrections) {
    const correction = correctionFor(event, corrections);
    if (correction) return {
      code: correction.errorType,
      label: ERROR_LABELS[correction.errorType] || correction.errorLabel || ERROR_LABELS.unknown,
      status: "user_corrected",
      basis: { type: "user_correction", correctionId: correction.id, note: correction.note || "" }
    };
    if (event && event.errorCause && typeof event.errorCause === "object") return event.errorCause;
    const code = event && event.errorType || (event && event.correct === true ? "none" : "unknown");
    return { code: code, label: ERROR_LABELS[code] || ERROR_LABELS.unknown, status: code === "unknown" ? "unknown" : "recorded", basis: null };
  }

  function masterySnapshot(events, timestamp, corrections) {
    const ordered = (events || []).filter(function (event) { return typeof event.correct === "boolean"; })
      .slice().sort(function (a, b) { return Number(a.answeredAt) - Number(b.answeredAt); });
    const correctCount = ordered.filter(function (event) { return event.correct; }).length;
    const incorrectCount = ordered.length - correctCount;
    const noHintCorrectCount = ordered.filter(function (event) { return event.correct && event.hintUsed !== true; }).length;
    const exerciseCount = new Set(ordered.map(function (event) { return event.exerciseId + "@" + (event.exerciseVersion || 1); })).size;
    let consecutiveNoHintCorrect = 0;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const event = ordered[index];
      if (!event.correct || event.hintUsed === true) break;
      consecutiveNoHintCorrect += 1;
    }
    let level = "insufficient_evidence";
    if (ordered.length) level = "learning";
    if (correctCount >= 2 && noHintCorrectCount >= 2 && ordered.at(-1)?.correct) level = "familiar";
    if (correctCount >= 3 && noHintCorrectCount >= 3 && exerciseCount >= 2 && consecutiveNoHintCorrect >= 2) level = "multiple_verified";
    const last = ordered.at(-1) || null;
    const latestWrong = ordered.slice().reverse().find(function (event) { return !event.correct; }) || null;
    const latestCause = latestWrong ? effectiveErrorCause(latestWrong, corrections) : { code: "none", label: ERROR_LABELS.none, status: "recorded", basis: null };
    const accuracy = ordered.length ? correctCount / ordered.length : null;
    return {
      masteryLevel: level,
      masteryLabel: LEVEL_LABELS[level],
      evidenceState: !ordered.length ? "insufficient_evidence" : ordered.length < 2 ? "limited_evidence" : level === "multiple_verified" ? "multiple_verified" : accuracy >= 0.8 ? "recently_successful" : accuracy >= 0.45 ? "mixed_evidence" : "needs_support",
      reviewCount: ordered.length,
      correctCount: correctCount,
      incorrectCount: incorrectCount,
      noHintCorrectCount: noHintCorrectCount,
      hintUsedCount: ordered.filter(function (event) { return event.hintUsed === true; }).length,
      exerciseCount: exerciseCount,
      consecutiveNoHintCorrect: consecutiveNoHintCorrect,
      accuracyRate: accuracy,
      errorCause: latestCause,
      lastReviewedAt: last ? last.answeredAt : null,
      calculationVersion: MASTERY_VERSION,
      calculatedAt: timestamp
    };
  }

  function scheduleForAnswer(events, correct, hintUsed, timestamp) {
    const ordered = (events || []).slice().sort(function (a, b) { return Number(a.answeredAt) - Number(b.answeredAt); });
    let priorStreak = 0;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const event = ordered[index];
      if (!event.correct || event.hintUsed === true) break;
      priorStreak += 1;
    }
    const intervals = [1, 3, 7, 14, 30];
    const intervalDays = !correct || hintUsed === true ? 1 : intervals[Math.min(priorStreak, intervals.length - 1)];
    return { dueAt: timestamp + intervalDays * DAY, intervalDays: intervalDays, version: SCHEDULE_VERSION };
  }

  function classifyMisconception(value) {
    const text = String(value || "").normalize("NFKC").trim();
    if (!text) return "unknown";
    if (/前提|条件|忽略|缺少|漏掉|未考虑/.test(text)) return "missing_prerequisite";
    if (/顺序|先后|步骤|次序/.test(text)) return "step_order";
    if (/混淆|混为|当成|误把|区别|不区分/.test(text)) return "concept_confusion";
    return "supported_misconception";
  }

  function choiceErrorCause(exercise, chosenIndex, correct) {
    if (correct) return { code: "none", label: ERROR_LABELS.none, status: "recorded", basis: null };
    const misconception = Array.isArray(exercise.misconceptions) ? String(exercise.misconceptions[chosenIndex] || "").trim() : "";
    if (!misconception) return {
      code: "unknown", label: ERROR_LABELS.unknown, status: "unknown",
      basis: { type: "insufficient_option_evidence", exerciseId: exercise.id, exerciseVersion: exercise.version || 1, optionIndex: chosenIndex }
    };
    const code = classifyMisconception(misconception);
    return {
      code: code,
      label: ERROR_LABELS[code] || ERROR_LABELS.supported_misconception,
      detail: misconception,
      status: "supported",
      basis: { type: "saved_misconception", exerciseId: exercise.id, exerciseVersion: exercise.version || 1, optionIndex: chosenIndex, text: misconception }
    };
  }

  function legacyMasteryValue(level) {
    return { insufficient_evidence: 0, learning: 1, familiar: 3, multiple_verified: 5 }[level] || 0;
  }

  return {
    DAY: DAY,
    DEFAULT_DAILY_GOAL: DEFAULT_DAILY_GOAL,
    MAX_DAILY_GOAL: MAX_DAILY_GOAL,
    SCHEDULE_VERSION: SCHEDULE_VERSION,
    MASTERY_VERSION: MASTERY_VERSION,
    LEVEL_LABELS: LEVEL_LABELS,
    ERROR_LABELS: ERROR_LABELS,
    dailyGoal: dailyGoal,
    masterySnapshot: masterySnapshot,
    scheduleForAnswer: scheduleForAnswer,
    classifyMisconception: classifyMisconception,
    choiceErrorCause: choiceErrorCause,
    effectiveErrorCause: effectiveErrorCause,
    legacyMasteryValue: legacyMasteryValue
  };
});
