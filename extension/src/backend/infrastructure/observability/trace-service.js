(function (root, factory) {
  const skills = typeof module === "object" && module.exports
    ? require("../../../harness/skills/skill-registry.js")
    : root.KnowledgeGachaHarnessSkills;
  const api = factory(skills);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaBackendObservability = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (skills) {
  "use strict";

  const HARNESS_VERSION = "browser-one-tool-v2";
  const ERROR_MESSAGES = {
    card_quality_not_ready: "卡片尚未通过质量检查，请补充材料或修改草稿。",
    agent_answer_failed_after_decision: "操作决定已生效，结果回答失败；重试会复用已保存的工具结果。",
    agent_tool_failed: "工具执行失败，请检查输入后重试。",
    agent_run_failed: "助手执行失败，请检查模型连接和输入后重试。",
    discovery_generation_failed: "发现规划未完成，请重试。"
  };
  function skillReference(skill) {
    const active = typeof skill === "string" ? skills.activate(skill) : skill;
    return { name: active.name, version: active.version };
  }

  function recordRun(db, runId, skill, status, timestamp, durationMs, stepCount, details) {
    const extra = details || {};
    const existing = db.runs.findIndex(function (item) { return item.id === runId; });
    const previous = existing >= 0 ? db.runs[existing] : null;
    const terminal = ["completed", "failed", "cancelled"].includes(status);
    const occurredAt = extra.occurredAt ?? timestamp;
    const reference = skillReference(skill);
    const recordedVersion = extra.promptVersion?.match(/\+skill\.(.+)$/);
    if (recordedVersion) reference.version = recordedVersion[1];
    const run = {
      id: runId,
      status: status,
      skill: reference,
      harnessVersion: extra.source === "extension_workflow" ? null : (previous ? previous.harnessVersion || null : HARNESS_VERSION),
      source: extra.source || "extension_harness",
      durationMs: durationMs,
      durationBasis: extra.durationBasis || "wall_clock_including_approval",
      stepCount: stepCount,
      checkpointCount: 0,
      retryCount: extra.retryCount ?? previous?.retryCount ?? 0,
      approvalCount: previous?.approvalCount || (status === "waiting_approval" ? 1 : 0),
      errorCode: extra.errorCode || null,
      createdAt: previous?.createdAt ?? timestamp,
      completedAt: terminal ? occurredAt : null
    };
    if (extra.promptVersion) run.promptVersion = extra.promptVersion;
    if (extra.operation) run.operation = extra.operation;
    if (extra.continuationSkill) run.continuationSkill = skillReference(extra.continuationSkill);
    if (existing >= 0) db.runs[existing] = run;
    else db.runs.unshift(run);
    const events = db.traces[runId] || [];
    events.push({
      sequence: events.length + 1,
      eventType: status === "waiting_approval" ? "approval_requested" : "run_" + status,
      kind: status === "waiting_approval" ? "approval" : "lifecycle",
      summary: status === "completed" ? (run.source === "extension_workflow" ? "产品工作流执行完成" : "扩展内 Harness 运行完成") : status === "failed" ? "运行未完成，可查看失败原因" : status === "running" ? "正在执行学习任务" : status === "cancelled" ? "任务已停止" : "写工具等待用户确认",
      status: status,
      references: { stepId: null, checkpointId: null, approvalId: null },
      error: extra.errorCode ? { code: extra.errorCode, message: ERROR_MESSAGES[extra.errorCode] || "运行未完成，请检查后重试。" } : null,
      skill: extra.continuationSkill ? skillReference(extra.continuationSkill) : reference,
      occurredAt: occurredAt
    });
    db.traces[runId] = events;
  }

  function harnessResponse(runId, skill, status, answer, approval, model, toolSteps, requestIdValue) {
    return {
      status: status,
      run: { id: runId, status: status, skill: skillReference(skill), harnessVersion: HARNESS_VERSION },
      answer: answer,
      approval: approval,
      model: model,
      toolSteps: toolSteps,
      requestId: requestIdValue
    };
  }

  function observability(db, filters, requestIdValue, timestamp) {
    const snapshotAt = timestamp ?? Date.now();
    const window = ["24h", "7d", "all"].includes(filters.window) ? filters.window : "24h";
    const since = window === "all" ? -Infinity : snapshotAt - (window === "7d" ? 7 : 1) * 86400000;
    const runs = db.runs.filter(function (run) {
      return run.createdAt >= since && (!filters.status || filters.status === "all" || run.status === filters.status)
        && (!filters.skill || filters.skill === "all" || run.skill.name === filters.skill)
        && (!filters.source || filters.source === "all" || run.source === filters.source);
    });
    const completed = runs.filter(function (run) { return run.status === "completed"; });
    const terminal = runs.filter(function (run) { return ["completed", "failed", "cancelled"].includes(run.status); });
    const durations = terminal.filter(function (run) { return ["wall_clock_including_approval", "generation_elapsed"].includes(run.durationBasis); }).map(function (run) { return run.durationMs; }).filter(function (value) { return Number.isFinite(value) && value >= 0; }).sort(function (a, b) { return a - b; });
    const retryingRuns = runs.filter(function (run) { return run.retryCount > 0; }).length;
    const approvalRuns = runs.filter(function (run) { return run.approvalCount; }).length;
    const errorCounts = new Map();
    runs.forEach(function (run) { if (run.errorCode) errorCounts.set(run.errorCode, (errorCounts.get(run.errorCode) || 0) + 1); });
    return {
      snapshotAt: snapshotAt,
      filters: { window: window, status: filters.status || "all", skill: filters.skill || "all", source: filters.source || "all" },
      options: { skills: Object.keys(skills.SKILLS), sources: Array.from(new Set(["extension_harness"].concat(db.runs.map(function (run) { return run.source; }).filter(Boolean)))) },
      metrics: {
        totalRuns: runs.length,
        terminalRuns: terminal.length,
        successfulRuns: completed.length,
        successRate: terminal.length ? completed.length / terminal.length : null,
        durationSampleCount: durations.length,
        p95DurationMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
        retryingRuns: retryingRuns,
        retryRate: runs.length ? retryingRuns / runs.length : null,
        averageSteps: runs.length ? runs.reduce(function (sum, run) { return sum + (run.stepCount || 0); }, 0) / runs.length : null,
        approvalRuns: approvalRuns,
        approvalRate: runs.length ? approvalRuns / runs.length : null
      },
      statusDistribution: ["queued", "running", "waiting_approval", "completed", "failed", "cancelled"].map(function (status) {
        const count = runs.filter(function (run) { return run.status === status; }).length;
        return { status: status, count: count, rate: runs.length ? count / runs.length : null };
      }),
      errorDistribution: Array.from(errorCounts, function ([code, count]) { return { code: code, count: count, rate: count / runs.length }; }),
      recentRuns: runs.slice(0, Math.max(1, Math.min(50, Number(filters.limit) || 20))),
      requestId: requestIdValue
    };
  }

  function createObservabilityService(context) {
    return {
      getObservabilityDashboard: function (filters) {
        return Promise.resolve(observability(context.readDb(), filters || {}, context.requestId(), context.now?.()));
      },
      getAgentTrace: function (runId) {
        const db = context.readDb();
        const run = db.runs.find(function (item) { return item.id === runId; });
        if (!run) return Promise.reject(new Error("运行记录不存在"));
        const items = db.traces[runId] || [];
        return Promise.resolve({
          run: { id: run.id, status: run.status, version: 1, skill: run.skill, harnessVersion: run.harnessVersion || null, eventCount: items.length },
          replay: { afterSequence: 0, lastSequence: items.length, hasMore: false },
          items: items,
          requestId: context.requestId()
        });
      }
    };
  }

  return {
    createObservabilityService: createObservabilityService,
    harnessResponse: harnessResponse,
    observability: observability,
    recordRun: recordRun
  };
});
