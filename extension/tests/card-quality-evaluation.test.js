const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const runner = require("../evals/card-quality/paired-runner.js");
const baseline = require("../evals/card-quality/baseline-v1.cjs");
const quality = require("../src/backend/features/generation/card-quality.js");
const provider = require("../src/backend/provider/provider-transport.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const { qualityOutput, requestPayload } = require("./fixtures/quality-output.js");
const corpus = require("../evals/card-quality/cases.json");
const config = { model: runner.MODEL, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-secret-must-not-export", temperature: 0.3 };

test("新旧评测都强制关闭思考，服务违约后立即停止并计入已发生用量", async () => {
  for (const violationSide of ["old", "current"]) {
    const requests = [];
    const transport = provider.createProviderTransport({ fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      const old = body.messages[0].content === baseline.prompt;
      const output = old ? { cards: [{ title: "Mock 基线", summary: "Mock" }] } : qualityOutput(requestPayload(body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output),
        reasoning_content: old === (violationSide === "old") ? "do-not-save-private-reasoning" : "" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
    } });
    const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
    const report = await runner.run({ cases: corpus.slice(0, 1), task, baseline, config, transport, service });
    assert.equal(report.status, "blocked");
    assert.equal(report.failure.code, "MODEL_THINKING_NOT_DISABLED");
    assert.equal(requests.length, violationSide === "old" ? 1 : 2);
    assert.ok(requests.every(request => request.thinking.type === "disabled"));
    assert.equal(report.budget.knownTokens, requests.length * 30);
    assert.equal(report.budget.missingUsage, 0);
    if (violationSide === "old") assert.equal(report.cases[0].oldFailures[0].usage.totalTokens, 30);
    else assert.equal(report.cases[0].currentAttempts[0].generation.calls[0].usage.totalTokens, 30);
    assert.equal(report.cases[0].current, null);
    assert.ok(!JSON.stringify(report).includes("do-not-save-private-reasoning"));
    assert.ok(!JSON.stringify(report).includes(config.apiKey));
    assert.match(runner.failureMessage(report), /服务仍返回思考/);
  }
});

test("未适配型号在评测中不发送请求、不消耗请求预算，错误信息可诊断", async () => {
  let sent = 0;
  const unsupportedConfig = { ...config, model: "unknown-deployment" };
  const transport = provider.createProviderTransport({ fetchImpl: async () => { sent += 1; } });
  const service = quality.createQualityService({ task, transport, getModelConfig: () => unsupportedConfig });
  const report = await runner.run({ cases: corpus.slice(0, 1), task, baseline, config: unsupportedConfig, transport, service, mode: "current" });
  assert.equal(sent, 0);
  assert.equal(report.budget.requestsUsed, 0);
  assert.equal(report.budget.missingUsage, 0);
  assert.equal(report.failure.code, "MODEL_NON_THINKING_UNSUPPORTED");
  assert.equal(report.cases[0].currentAttempts[0].generation.calls[0].sent, false);
});

test("快速检查覆盖五类材料和五个既有关键问题，仅运行新版且不能混入配对评测", async () => {
  const cases = runner.selectCases(corpus, "quick");
  assert.equal(cases.length, 8);
  assert.equal(new Set(cases.map(sample => sample.category)).size, 5);
  for (const id of ["short-01", "short-03", "short-05", "short-08", "image-02"]) assert.ok(cases.some(sample => sample.id === id));
  const env = setup(cases);
  const report = await runner.run({ ...env.options, mode: "quick", limits: runner.MODES.quick });
  assert.equal(report.status, "awaiting_ai_review");
  assert.ok(report.cases.every(record => !record.old && record.current));
  assert.equal(env.requests.filter(item => requestPayload(item.request).operation === "generate").length, 8);
  assert.ok(env.requests.every(item => item.request.messages[0].content !== baseline.prompt));
  const bundle = runner.exportBundle(report, cases, () => 0);
  assert.equal(bundle.blindReview.length, 8);
  assert.ok(bundle.reviewKey.every(item => item.version === "current"));
  assert.equal(runner.canResume(report, cases, task, baseline, config.model, "current"), false);
  assert.equal(runner.canResume(report, cases, { ...task, requestProfile: "different" }, baseline, config.model, "quick"), false);
  assert.equal(report.budget.requestsUsed, env.requests.length);
  assert.equal(report.budget.knownTokens, env.requests.length * 30);
  assert.equal(report.budget.missingUsage, 0);
  assert.ok(!JSON.stringify(bundle).includes(config.apiKey));
});

test("请求预算在独立核验前停止，调高后只续跑核验而不重复生成或放宽门槛", async () => {
  const cases = corpus.filter(sample => sample.imagePath).slice(0, 1);
  const env = setup(cases);
  const report = await runner.run({ ...env.options, mode: "current", limits: { maxRequests: 3, maxTokens: 1000 } });
  assert.equal(report.status, "budget_reached");
  assert.equal(env.requests.length, 3);
  assert.equal(report.cases[0].current, null);
  const attempt = report.cases[0].currentAttempts[0];
  assert.ok(attempt.card);
  assert.equal(attempt.status, "needs_revision");
  assert.equal(attempt.generation.calls.at(-1).sent, false);
  assert.equal(report.budget.knownTokens, 90);
  assert.match(runner.failureMessage(report), /已达到预算.*尚未发送/);
  await runner.run({ ...env.options, mode: "current", report, limits: { maxRequests: 4, maxTokens: 1000 } });
  assert.equal(report.status, "awaiting_ai_review");
  assert.deepEqual(env.requests.map(item => requestPayload(item.request).operation), ["observe_image", "generate", "solve", "review"]);
  assert.equal(report.cases[0].current.status, "ready");
  assert.equal(report.budget.requestsUsed, 4);
  assert.equal(report.budget.knownTokens, 120);
  assert.equal(report.budget.missingUsage, 0);
  assert.equal(requestPayload(env.requests[3].request).candidate.generation, undefined);
});

test("token 预算覆盖修复和后续核验，续跑不再生成或第二次修复", async () => {
  const operations = [];
  const transport = { complete: async (_settings, request) => {
    const payload = requestPayload(request);
    operations.push(payload.operation);
    const output = qualityOutput(payload);
    if (payload.operation === "generate") output.card.boundaries = "缺少边界依据";
    if (payload.operation === "repair") return { content: JSON.stringify({ card: { boundaries: "" } }), provider: { model: config.model, latencyMs: 1, usage: { totalTokens: 40 } } };
    return { content: JSON.stringify(output), provider: { model: config.model, latencyMs: 1, usage: { totalTokens: 40 } } };
  } };
  const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
  const options = { cases: corpus.slice(0, 1), task, baseline, config, transport, service, mode: "current" };
  const report = await runner.run({ ...options, limits: { maxRequests: 10, maxTokens: 40 } });
  assert.equal(report.status, "budget_reached");
  assert.deepEqual(operations, ["generate"]);
  await runner.run({ ...options, report, limits: { maxRequests: 10, maxTokens: 80 } });
  assert.equal(report.status, "budget_reached");
  assert.deepEqual(operations, ["generate", "repair"]);
  await runner.run({ ...options, report, limits: { maxRequests: 10, maxTokens: 160 } });
  assert.equal(report.status, "awaiting_ai_review");
  assert.deepEqual(operations, ["generate", "repair", "solve", "review"]);
  assert.equal(report.cases[0].current.status, "ready");
  assert.equal(report.budget.knownTokens, 160);
});

test("缺失用量不当作免费调用；请求上限仍生效，配对旧版也受预算约束", async () => {
  const env = setup(corpus.slice(0, 2));
  const original = env.options.transport.complete;
  env.options.transport.complete = async (...args) => { const result = await original(...args); delete result.provider.usage; return result; };
  const report = await runner.run({ ...env.options, limits: { maxRequests: 4, maxTokens: 1000 } });
  assert.equal(report.status, "budget_reached");
  assert.equal(report.failure.caseId, "short-02");
  assert.equal(env.requests.length, 4);
  assert.equal(report.budget.knownTokens, 0);
  assert.equal(report.budget.missingUsage, 4);
  assert.equal(report.cases[0].current.status, "ready");
  assert.ok(env.checkpoints.some(value => value.budget.requestsUsed === 1 && value.budget.missingUsage === 1));
  await assert.rejects(runner.run({ ...env.options, report, limits: { maxRequests: 0 } }), /预算必须是正整数/);
});

function setup(cases = corpus, intercept) {
  const requests = [], checkpoints = [];
  const transport = { complete: async (settings, request) => {
    requests.push({ settings, request });
    if (intercept) intercept(settings, request);
    const old = request.messages[0].content === baseline.prompt;
    return { content: JSON.stringify(old ? { cards: [{ title: "Mock 旧卡", summary: "Mock 输出，仅验证评测流程", question: "Mock 题目", options: ["甲", "乙", "丙"], correctIndex: 0 }] } : qualityOutput(requestPayload(request))),
      provider: { model: "fixture-model", latencyMs: 3, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } };
  } };
  const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
  return { requests, checkpoints, options: { cases, task, baseline, config, transport, service,
    loadImage: async path => ({ dataUrl: "data:image/gif;base64," + readFileSync(resolve(__dirname, "../evals/card-quality", path)).toString("base64") }),
    checkpoint: report => checkpoints.push(JSON.parse(JSON.stringify(report))) } };
}

test("输出上限按失败计入样本，续跑只处理其余素材，历史用量不重复", async () => {
  for (const phase of ["generate", "repair", "solve", "review"]) {
    const cases = [corpus[0], corpus[1]];
    const requests = [];
    const transport = { complete: async (_config, request) => {
      const payload = requestPayload(request); requests.push(payload);
      const first = requests.filter(p => p.operation === "generate").length === 1;
      const output = qualityOutput(payload);
      if (first && phase !== "generate" && payload.operation === "generate") output.card.boundaries = "需要补引用";
      if (first && ["solve", "review"].includes(phase) && payload.operation === "repair") return { content: '{"card":{"boundaries":""}}', provider: { model: config.model, latencyMs: 1, usage: { totalTokens: 30 } } };
      return { content: first && payload.operation === phase ? '{"card":' : JSON.stringify(output), finishReason: first && payload.operation === phase ? "length" : "stop",
        provider: { model: config.model, latencyMs: 1, usage: { totalTokens: 30 } } };
    } };
    const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
    const options = { cases, task, baseline, config, transport, service, mode: "current" };
    const report = await runner.run(options);
    assert.equal(report.status, "blocked");
    assert.equal(report.cases[0].current.status, "needs_revision");
    assert.equal(report.cases[0].current.quality.passed, false);
    assert.equal(report.cases[0].currentAttempts, undefined);
    assert.deepEqual(runner.progress(report, 2), { processed: 1, outputLimited: 1, total: 2, remaining: 1 });
    assert.match(runner.failureMessage(report), /按失败保留且不重复请求/);
    assert.match(runner.failureMessage(report), new RegExp("输出上限 " + task.requestOptions(config.model, phase).max_tokens));
    const firstCount = requests.length;
    await runner.run({ ...options, report });
    assert.equal(requests.length, firstCount + 3);
    assert.equal(report.status, "awaiting_ai_review");
    assert.equal(report.budget.knownTokens, requests.length * 30);
    assert.equal(report.budget.requestsUsed, requests.length);
    assert.equal(report.failure, undefined);
    assert.deepEqual(runner.progress(report, 2), { processed: 2, outputLimited: 1, total: 2, remaining: 0 });
    const exported = runner.exportBundle(report, cases, () => 0);
    assert.equal(exported.blindReview.length, 2);
    assert.equal(exported.blindReview[0].status, "needs_revision");
  }
});

test("真实 v2.1.2 中断检查点保留两份结果及两次截断用量，不再重发 short-05", async () => {
  const report = structuredClone(require("./fixtures/regressions/2026-09-03-v2.1.2-interrupted--run-interrupted.json").outputs);
  const cases = JSON.parse(report.corpus);
  const saved = structuredClone(report.cases);
  const compatibleTask = require("./fixtures/regressions/2026-09-03-v2.1.2-interrupted--task-v2.1.2.js");
  const requests = [];
  const transport = { complete: async (_config, request) => {
    const payload = requestPayload(request); requests.push(payload);
    assert.notEqual(payload.userGoal, cases.find(sample => sample.id === "short-05").userGoal);
    return { content: JSON.stringify(qualityOutput(payload)), provider: { model: config.model, latencyMs: 1, usage: { totalTokens: 30 } } };
  } };
  const service = quality.createQualityService({ task: compatibleTask, transport, getModelConfig: () => config });
  await runner.run({ cases, task: compatibleTask, baseline, config, transport, service, report, mode: "quick", loadImage: async () => ({ dataUrl: "data:image/gif;base64,fixture" }) });
  assert.deepEqual(report.cases.slice(0, 2), saved.slice(0, 2));
  const failed = report.cases.find(sample => sample.id === "short-05");
  assert.deepEqual(failed.current, saved[2].currentAttempts[1]);
  assert.deepEqual(failed.currentAttempts, [saved[2].currentAttempts[0]]);
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(report.budget.requestsUsed, 6 + requests.length);
  assert.equal(report.budget.knownTokens, 16469 + requests.length * 30);
  const allCalls = report.cases.flatMap(sample => [sample.current, ...(sample.currentAttempts || [])].flatMap(result => result.generation.calls));
  assert.equal(allCalls.reduce((sum, call) => sum + call.usage.totalTokens, 0), report.budget.knownTokens);
  assert.equal(allCalls.length, report.budget.requestsUsed);
  assert.deepEqual(runner.progress(report, 8), { processed: 8, outputLimited: 1, total: 8, remaining: 0 });
});

test("24 份素材同模型同温度配对，图片同源，导出 48 条未评分记录且不含配置", async () => {
  const env = setup();
  const report = await runner.run(env.options);
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(report.cases.length, 24);
  assert.equal(report.learningExperiment, false);
  assert.ok(env.requests.every(({ settings, request }) => settings.model === runner.MODEL && request.temperature === (request.messages[0].content === baseline.prompt || ["generate", "repair", "revise"].includes(requestPayload(request).operation) ? 0.3 : 0)));
  const oldRequests = env.requests.filter(item => item.request.messages[0].content === baseline.prompt);
  const newRequests = env.requests.filter(item => item.request.messages[0].content === task.instructions && requestPayload(item.request).operation === "generate");
  assert.equal(oldRequests.length, 24);
  assert.equal(newRequests.length, 24);
  corpus.forEach((sample, index) => {
    const content = oldRequests[index].request.messages.at(-1).content;
    const text = Array.isArray(content) ? content[0].text : content;
    assert.equal(text, (sample.userGoal ? sample.userGoal + "\n\n" : "") + sample.text);
    const payload = requestPayload(newRequests[index].request);
    assert.equal(payload.userGoal, sample.userGoal);
    assert.equal(payload.sources[0].text || "", sample.text);
    if (sample.imagePath) {
      const observations = env.requests.filter(item => item.request.messages[0].content === task.instructionsFor("observe_image"));
      const imageIndex = corpus.slice(0, index).filter(item => item.imagePath).length;
      assert.equal(content[1].image_url.url, observations[imageIndex].request.messages.at(-1).content[1].image_url.url);
      assert.ok(payload.sources[0].observations.length);
    }
  });
  const bundle = runner.exportBundle(report, corpus, () => 1);
  assert.equal(bundle.blindReview.length, 48);
  assert.equal(new Set(bundle.blindReview.map(item => item.label)).size, 48);
  assert.ok(bundle.blindReview.every(item => item.reviewer === "" && Object.values(item.scores).every(score => score === null)));
  assert.ok(!JSON.stringify(bundle).includes(config.apiKey));
  assert.ok(!JSON.stringify(bundle).includes(config.baseUrl));
  assert.equal(new Set(env.checkpoints.filter(item => item.cases.at(-1)?.old && !item.cases.at(-1).current).map(item => item.cases.at(-1).id)).size, 24);
});

test("旧版认证失败立即暂停，错误正文和密钥不进入结果，可重试失败版本", async () => {
  let fail = true;
  const env = setup(corpus.slice(0, 2), () => {
    if (fail) throw Object.assign(new Error(config.apiKey), { code: "MODEL_HTTP_ERROR", status: 401 });
  });
  const report = await runner.run(env.options);
  assert.equal(report.status, "blocked");
  assert.equal(env.requests.length, 1);
  assert.equal(report.failure.httpStatus, 401);
  assert.ok(!JSON.stringify(report).includes(config.apiKey));
  fail = false;
  await runner.run({ ...env.options, report });
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(env.requests.length, 9);
  assert.equal(report.cases[0].oldFailures.length, 1);
});

test("新版请求失败保留旧版结果与失败用量，续跑不重复调用旧版", async () => {
  let fail = true;
  const env = setup(corpus.slice(0, 1), (_settings, request) => {
    if (fail && request.messages[0].content === task.instructions) throw Object.assign(new Error("fixture failure"), { code: "MODEL_TIMEOUT" });
  });
  const report = await runner.run(env.options);
  assert.equal(report.status, "blocked");
  assert.equal(report.cases[0].current, null);
  assert.equal(report.cases[0].currentAttempts[0].generation.calls[0].error, "MODEL_TIMEOUT");
  assert.equal(report.failure.code, "MODEL_TIMEOUT");
  assert.equal(report.failure.operation, "generate");
  assert.match(runner.failureMessage(report), /新版生成失败：模型响应超时/);
  fail = false;
  await runner.run({ ...env.options, report });
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(env.requests.filter(item => item.request.messages[0].content === baseline.prompt).length, 1);
  assert.equal(env.requests.length, 5);
});

test("暂停续跑跳过已完成素材，模型或提示变化不混入同一评测", async () => {
  const env = setup(corpus.slice(0, 2));
  const report = await runner.run({ ...env.options, shouldStop: () => env.requests.length >= 2 });
  assert.equal(report.status, "paused");
  assert.equal(report.cases.length, 1);
  await assert.rejects(runner.run({ ...env.options, report, config: { ...config, model: "another-model" } }), /版本、方式或素材已变化/);
  await assert.rejects(runner.run({ ...env.options, report, task: { ...task, version: "next" } }), /版本、方式或素材已变化/);
  await runner.run({ ...env.options, report });
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(env.requests.length, 8);
});

test("图片加载失败不发送缺图请求，修复资源后能继续", async () => {
  const env = setup(corpus.filter(sample => sample.imagePath).slice(0, 1));
  const report = await runner.run({ ...env.options, loadImage: async () => { throw new Error("missing"); } });
  assert.equal(report.status, "blocked");
  assert.equal(report.failure.code, "image_load_failed");
  assert.equal(env.requests.length, 0);
  await runner.run({ ...env.options, report });
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(env.requests.length, 5);
});

test("点击授权后旧版完成，再生成新版时没有用户手势也能连续请求", async () => {
  let gesture = true, granted = false, permissionRequests = 0, modelRequests = 0;
  const chromeApi = {
    permissions: {
      contains(_value, callback) { callback(granted); },
      request(_value, callback) {
        permissionRequests += 1;
        if (!gesture) throw new Error("This function must be called during a user gesture");
        granted = true;
        callback(true);
      }
    },
    runtime: { sendMessage(message, callback) {
      modelRequests += 1;
      gesture = false; // The first model response arrives after the click's activation expires.
      const old = message.request.messages[0].content === baseline.prompt;
      callback({ ok: true, data: { content: JSON.stringify(old ? { cards: [{ title: "Mock 基线", summary: "Mock" }] } : qualityOutput(requestPayload(message.request))),
        provider: { model: "fixture-model", latencyMs: 10, usage: { totalTokens: 20 } } } });
    } }
  };
  const transport = provider.createProviderTransport({ chromeApi });
  const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
  await transport.ensurePermission(config.baseUrl);
  const report = await runner.run({ cases: corpus.slice(0, 1), task, baseline, config, transport, service });
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(permissionRequests, 1);
  assert.equal(modelRequests, 4);
  assert.equal(report.cases[0].current.status, "ready");
});

test("新版输出不合格时在点击手势过期后仍能自动修复，质量门槛保持有效", async () => {
  let gesture = true, granted = false, permissionRequests = 0;
  const operations = [];
  const chromeApi = {
    permissions: {
      contains(_value, callback) { callback(granted); },
      request(_value, callback) {
        permissionRequests += 1;
        if (!gesture) throw new Error("This function must be called during a user gesture");
        granted = true;
        callback(true);
      }
    },
    runtime: { sendMessage(message, callback) {
      const old = message.request.messages[0].content === baseline.prompt;
      const payload = old ? null : requestPayload(message.request);
      operations.push(payload?.operation || "baseline");
      const output = old ? { cards: [{ title: "Mock 基线", summary: "Mock" }] } : qualityOutput(payload);
      if (payload?.operation === "generate") {
        gesture = false;
        output.exercise.misconceptions.pop();
        output.card.boundaries = "需要独立依据的边界";
      }
      if (payload?.operation === "repair") {
        assert.ok(payload.issues.some(issue => issue.code === "misconceptions"));
        assert.ok(payload.issues.some(issue => issue.code === "evidence_boundaries"));
      }
      callback({ ok: true, data: { content: JSON.stringify(output), provider: { model: "fixture-model", latencyMs: 10 } } });
    } }
  };
  const transport = provider.createProviderTransport({ chromeApi });
  const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
  await transport.ensurePermission(config.baseUrl);
  const report = await runner.run({ cases: corpus.slice(0, 1), task, baseline, config, transport, service });
  assert.equal(report.status, "awaiting_ai_review");
  assert.equal(permissionRequests, 1);
  assert.deepEqual(operations, ["baseline", "generate", "repair", "solve", "review"]);
  assert.equal(report.cases[0].current.quality.passed, true);
  assert.equal(report.cases[0].current.generation.rounds.length, 2);
});

test("旧检查点恢复自动修复阶段，HTTP 错误码穿透质量服务和评测器且不导出正文", async () => {
  const env = setup(corpus.slice(0, 1), (_settings, request) => {
    if (request.messages[0].content === task.instructions) throw Object.assign(new Error(config.apiKey), { code: "MODEL_HTTP_ERROR", status: 429 });
  });
  const report = await runner.run(env.options);
  assert.equal(report.failure.httpStatus, 429);
  assert.equal(report.cases[0].currentAttempts[0].generation.calls[0].httpStatus, 429);
  assert.match(runner.failureMessage(report), /新版生成失败.*HTTP 429/);
  assert.ok(!JSON.stringify(report).includes(config.apiKey));
  report.failure = { caseId: "short-01", code: "current_request_failed" };
  report.cases[0].currentAttempts = [{ generation: { calls: [{ operation: "generate", latencyMs: 7010 }, { operation: "repair", error: "request_failed", latencyMs: 0 }] } }];
  assert.match(runner.failureMessage(report), /新版自动修复失败.*request_failed.*耗时 0.0 秒/);
  assert.ok(!runner.failureMessage(report).includes("current_request_failed"));
});
