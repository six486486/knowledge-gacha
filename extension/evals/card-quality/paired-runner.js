(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaPairedEvaluation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MODEL = "deepseek-v4-flash-vision-exp";
  const FORMAT = "card-quality-evaluation-v1";
  const QUICK_IDS = ["short-01", "short-03", "short-05", "short-08", "multi-01", "image-02", "insufficient-03", "condition-02"];
  const TARGETED_IDS = ["short-05", "short-01", "short-03", "short-08", "image-02"];
  const MODES = {
    single: { label: "单样本评测", maxRequests: 7, maxTokens: 18000 },
    targeted: { label: "定向检查", maxRequests: 31, maxTokens: 70000 },
    quick: { label: "快速检查", maxRequests: 49, maxTokens: 110000 },
    current: { label: "仅测新版", maxRequests: 110, maxTokens: 240000 },
    paired: { label: "完整新旧对比", maxRequests: 134, maxTokens: 300000 }
  };

  function selectCases(cases, mode, caseId) {
    if (!MODES[mode]) throw new Error("未知评测方式");
    if (mode === "single") {
      const sample = cases.find(item => item.id === caseId);
      if (!sample) throw new Error("单样本评测需要指定有效素材 ID（例如 short-05）");
      return [sample];
    }
    if (caseId !== undefined) throw new Error("指定素材只能使用单样本评测方式");
    if (mode === "targeted") return TARGETED_IDS.map(id => cases.find(sample => sample.id === id)).filter(Boolean);
    return mode === "quick" ? cases.filter(sample => QUICK_IDS.includes(sample.id)) : cases;
  }

  function createReport(cases, task, baseline, model, mode = "paired") {
    if (mode === "single" && cases.length !== 1) throw new Error("单样本评测必须且只能包含一份素材");
    return { format: FORMAT, executedAt: new Date().toISOString(), model: model || MODEL, temperature: 0.3,
      promptVersion: task.version, baselineVersion: baseline.version, corpus: JSON.stringify(cases),
      evaluationMode: mode, requestProfile: task.requestProfile || "provider-default",
      budget: { maxRequests: null, maxTokens: null, requestsUsed: 0, knownTokens: 0, missingUsage: 0 },
      status: "not_started", reviewers: [], learningExperiment: false, cases: [] };
  }

  function canResume(report, cases, task, baseline, model, mode = "paired") {
    return report && (mode !== "single" || cases.length === 1) && report.format === FORMAT && report.model === model && report.temperature === 0.3 &&
      (report.evaluationMode || "paired") === mode && (report.requestProfile || "provider-default") === (task.requestProfile || "provider-default") &&
      report.promptVersion === task.version && report.baselineVersion === baseline.version && report.corpus === JSON.stringify(cases);
  }

  async function run(options) {
    const { cases, task, baseline, config, transport, service, loadImage, checkpoint, shouldStop } = options;
    const mode = options.mode || "paired";
    const report = options.report || createReport(cases, task, baseline, config.model, mode);
    if (!canResume(report, cases, task, baseline, config.model, mode)) throw new Error("评测版本、方式或素材已变化，请导出已有记录后重新开始。");
    const budget = report.budget;
    for (const key of ["maxRequests", "maxTokens"]) {
      if (options.limits && Object.hasOwn(options.limits, key)) {
        if (!Number.isSafeInteger(options.limits[key]) || options.limits[key] <= 0) throw new Error("预算必须是正整数");
        budget[key] = options.limits[key];
      }
    }
    const boundedTransport = { complete: async function (settings, request) {
      if ((budget.maxRequests !== null && budget.requestsUsed >= budget.maxRequests) ||
          (budget.maxTokens !== null && budget.knownTokens >= budget.maxTokens)) {
        throw Object.assign(new Error("已达到评测预算"), { code: "EVAL_BUDGET_REACHED" });
      }
      budget.requestsUsed += 1;
      // Reserve the attempt before dispatch so a closed page cannot silently reset its budget.
      budget.missingUsage += 1;
      if (checkpoint) await checkpoint(report);
      try {
        const result = await transport.complete(settings, request);
        const total = result.provider?.usage?.totalTokens;
        if (Number.isFinite(total) && total >= 0) { budget.knownTokens += total; budget.missingUsage -= 1; }
        return result;
      } catch (error) {
        if (error.sent === false) { budget.requestsUsed -= 1; budget.missingUsage -= 1; }
        else if (Number.isFinite(error.provider?.usage?.totalTokens)) {
          budget.knownTokens += error.provider.usage.totalTokens;
          budget.missingUsage -= 1;
        }
        throw error;
      } finally { if (checkpoint) await checkpoint(report); }
    } };
    report.status = "running";
    delete report.failure;
    for (const sample of cases) {
      if (shouldStop && shouldStop()) { report.status = "paused"; break; }
      const previous = report.cases.find(item => item.id === sample.id);
      if (previous && previous.current) continue;
      // Older checkpoints kept output-limit failures in attempts. Finalize the
      // last one without another request; move it so usage is not counted twice.
      const previousAttempt = previous?.currentAttempts?.at(-1);
      if (outputLimitCall(previousAttempt)) {
        previous.current = previous.currentAttempts.pop();
        if (checkpoint) await checkpoint(report);
        continue;
      }
      let image;
      try { image = sample.imagePath ? await loadImage(sample.imagePath) : undefined; }
      catch { report.status = "blocked"; report.failure = { caseId: sample.id, code: "image_load_failed" }; break; }
      const record = previous || { id: sample.id, category: sample.category, expectedStatus: sample.expectedStatus, old: null, current: null, ratings: null };
      if (!previous) report.cases.push(record);
      const fixedConfig = Object.assign({}, config, { temperature: 0.3 });
      if (mode === "paired" && !record.old) {
        const content = [{ type: "text", text: (sample.userGoal ? sample.userGoal + "\n\n" : "") + sample.text }];
        if (image) content.push({ type: "image_url", image_url: { url: image.dataUrl } });
        const started = Date.now();
        try {
          const result = await boundedTransport.complete(fixedConfig, { messages: [{ role: "system", content: baseline.prompt },
            { role: "user", content: content.length === 1 ? content[0].text : content }], temperature: 0.3, response_format: { type: "json_object" } });
          record.old = { rawOutput: result.content, provider: result.provider };
          try { record.old.card = baseline.parse(result.content, sample.text); }
          catch { record.old.error = "parse_failed"; }
        } catch (error) {
          // Never serialize upstream error messages or config: either may contain credentials.
          record.oldFailures = (record.oldFailures || []).concat({ code: safeErrorCode(error), latencyMs: Date.now() - started, httpStatus: Number(error.status) || null,
            sent: error.sent !== false, usage: error.provider?.usage || null });
          report.status = error.code === "EVAL_BUDGET_REACHED" ? "budget_reached" : "blocked";
          report.failure = { caseId: sample.id, ...record.oldFailures.at(-1) };
          break;
        }
        if (checkpoint) await checkpoint(report);
      }
      const context = { materialLength: sample.text.length, userGoal: sample.userGoal, relatedCards: [], image,
        evidence: sample.text ? [{ id: "material", kind: "text", text: sample.text, title: sample.title, startCharacter: 0 }] : [{ id: "image", kind: "image", title: sample.title }] };
      const attempt = record.currentAttempts?.at(-1);
      const resume = attempt?.generation?.resume;
      const result = await service.run(context, resume ? attempt : undefined, resume ? "resume" : undefined, { transport: boundedTransport });
      // Include work before a budget pause in sample latency, without counting the user's pause.
      if (resume) result.generation.elapsedMs += attempt.generation.elapsedMs;
      if (result.generation.calls.some(call => call.error)) {
        // A length failure is an evaluated failure, not a transient connection
        // failure. Pause once, then allow remaining samples without paying to
        // repeat this exact request. Other errors keep their existing retry path.
        if (outputLimitCall(result)) record.current = result;
        else record.currentAttempts = (record.currentAttempts || []).concat(result);
        const failed = result.generation.calls.filter(call => call.error).at(-1);
        report.status = failed.error === "EVAL_BUDGET_REACHED" ? "budget_reached" : "blocked";
        report.failure = { caseId: sample.id, side: "current", operation: failed.operation,
          code: safeErrorCode({ code: failed.error }), httpStatus: failed.httpStatus || null, latencyMs: failed.latencyMs };
        break;
      }
      record.current = result;
      if (checkpoint) await checkpoint(report);
    }
    if (report.status === "running") report.status = "awaiting_ai_review";
    report.updatedAt = new Date().toISOString();
    if (checkpoint) await checkpoint(report);
    return report;
  }

  function safeErrorCode(error) {
    return ["MODEL_TIMEOUT", "MODEL_UNAVAILABLE", "MODEL_INVALID_RESPONSE", "MODEL_HTTP_ERROR", "MODEL_PERMISSION_REQUIRED", "MODEL_PERMISSION_DENIED", "MODEL_OUTPUT_LIMIT", "EVAL_BUDGET_REACHED", "MODEL_NON_THINKING_UNSUPPORTED", "MODEL_THINKING_NOT_DISABLED"].includes(error && error.code) ? error.code : "request_failed";
  }

  function outputLimitCall(result) {
    const call = result?.generation?.calls?.at(-1);
    return call?.error === "MODEL_OUTPUT_LIMIT" ? call : null;
  }

  function progress(report, total) {
    const completed = report?.cases?.filter(record => record.current) || [];
    return { processed: completed.length, outputLimited: completed.filter(record => outputLimitCall(record.current)).length,
      total: total, remaining: total - completed.length };
  }

  function failureMessage(report) {
    if (!report || !report.failure) return "";
    const failure = report.failure;
    // Existing checkpoints only had current_request_failed. Recover their stage
    // and original code from the saved attempt so refreshing also improves them.
    const record = report.cases.find(item => item.id === failure.caseId);
    const failedCall = outputLimitCall(record?.current) || (failure.side === "current" || failure.code === "current_request_failed"
      ? record?.currentAttempts?.at(-1)?.generation?.calls?.filter(call => call.error).at(-1) : null);
    const code = safeErrorCode({ code: failedCall?.error || failure.code });
    const status = Number(failedCall?.httpStatus || failure.httpStatus);
    const phase = { generate: "新版生成", repair: "新版自动修复", review: "新版语义核验" }[failedCall?.operation || failure.operation] || "旧版生成";
    const latency = failedCall?.latencyMs ?? failure.latencyMs;
    const reasons = { MODEL_TIMEOUT: "模型响应超时", MODEL_UNAVAILABLE: "无法连接模型服务", MODEL_INVALID_RESPONSE: "模型服务返回了无效 JSON",
      MODEL_PERMISSION_REQUIRED: "需要重新确认模型服务域名权限", MODEL_PERMISSION_DENIED: "模型服务域名权限未获允许",
      MODEL_OUTPUT_LIMIT: "回复达到输出上限，按失败保留且不重复请求；已有结果可导出", EVAL_BUDGET_REACHED: "已达到预算，尚未发送此请求；可导出结果或调高预算后继续",
      MODEL_NON_THINKING_UNSUPPORTED: "该型号不支持关闭思考或尚未适配，未发送请求", MODEL_THINKING_NOT_DISABLED: "服务仍返回思考内容或用量，已停止；请确认服务支持关闭思考",
      MODEL_HTTP_ERROR: "模型服务拒绝了请求", request_failed: "请求未完成" };
    const reason = failure.code === "image_load_failed" ? "素材图片加载失败" : phase + "失败：" + reasons[code];
    const details = [failure.caseId, failure.code === "image_load_failed" ? failure.code : code];
    if (Number.isInteger(status) && status >= 400 && status <= 599) details.push("HTTP " + status);
    if (code === "MODEL_OUTPUT_LIMIT" && Number.isFinite(failedCall?.requestOptions?.max_tokens)) details.push("输出上限 " + failedCall.requestOptions.max_tokens + " token");
    if (Number.isFinite(latency) && latency >= 0) details.push("耗时 " + (latency / 1000).toFixed(1) + " 秒");
    return reason + "（" + details.join("，") + "）。";
  }

  function exportBundle(report, cases, randomBit) {
    const blind = [], key = [];
    for (const sample of cases) {
      const record = report.cases.find(item => item.id === sample.id);
      const versions = (report.evaluationMode || "paired") !== "paired" ? ["current"] : randomBit() ? ["old", "current"] : ["current", "old"];
      for (const [i, version] of versions.entries()) {
        const value = record && record[version];
        const label = sample.id + "-" + (i === 0 ? "A" : "B");
        key.push({ label, version });
        blind.push({ label, input: sample.text, imagePath: sample.imagePath || null, userGoal: sample.userGoal,
          expectedObjective: sample.expectedObjective, keyEvidence: sample.keyEvidence, criticalErrors: sample.criticalErrors,
          status: value?.status || (value?.card ? "ready" : value?.error ? "failed" : "not_run"), card: value?.card || null,
          exercise: value?.exercise || null, evidence: value?.evidence || [],
          scores: { accuracy: null, explanation: null, focus: null, exercise: null, grounding: null },
          reviewer: "", criticalError: null, disputed: false, notes: "" });
      }
    }
    return { format: FORMAT, outputs: report, blindReview: blind, reviewKey: key };
  }

  return { MODEL, FORMAT, MODES, selectCases, createReport, canResume, run, exportBundle, failureMessage, outputLimitCall, progress };
});
