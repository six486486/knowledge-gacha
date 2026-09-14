const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const runner = require("../evals/card-quality/paired-runner.js");
const baseline = require("../evals/card-quality/baseline-v1.cjs");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const quality = require("../src/backend/features/generation/card-quality.js");
const provider = require("../src/backend/provider/provider-transport.js");
const corpus = require("../evals/card-quality/cases.json");
const { qualityOutput, requestPayload } = require("./fixtures/quality-output.js");

test("单样本明确选择一份，缺失、未知或与批量方式冲突的选择不会退回整套", () => {
  for (const sample of corpus) assert.deepEqual(runner.selectCases(corpus, "single", sample.id), [sample]);
  for (const id of [undefined, "", "missing", "short-01,short-05"]) assert.throws(() => runner.selectCases(corpus, "single", id), /有效素材 ID/);
  assert.throws(() => runner.selectCases(corpus, "quick", "short-05"), /只能使用单样本/);
  assert.throws(() => runner.createReport(corpus, task, baseline, runner.MODEL, "single"), /只能包含一份/);
  assert.deepEqual(runner.MODES.single, { label: "单样本评测", maxRequests: 7, maxTokens: 18000 });
  assert.equal(runner.selectCases(corpus, "quick").length, 8);
  assert.equal(runner.selectCases(corpus, "targeted").length, 5);
});

test("单样本图片在预算暂停后只续跑核验，导出一份且不能换素材或混入批量续跑", async () => {
  const cases = runner.selectCases(corpus, "single", "image-02");
  const config = { model: runner.MODEL, baseUrl: "https://fixture.invalid/v1", apiKey: "single-fixture-key" };
  const requests = [];
  const transport = provider.createProviderTransport({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const payload = requestPayload(body);
    return new Response(JSON.stringify({ model: runner.MODEL, choices: [{ message: { content: JSON.stringify(qualityOutput(payload)) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  } });
  const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
  const options = { cases, task, baseline, config, transport, service, mode: "single",
    loadImage: async path => {
      assert.equal(path, cases[0].imagePath);
      return { dataUrl: "data:image/gif;base64,single-image-fixture" };
    } };
  const paused = await runner.run({ ...options, limits: { maxRequests: 1, maxTokens: 8000 } });
  assert.equal(paused.status, "budget_reached");
  assert.equal(paused.failure.operation, "generate");
  const report = JSON.parse(JSON.stringify(paused)); // A restored checkpoint.
  assert.equal(runner.canResume(report, cases, task, baseline, runner.MODEL, "single"), true);
  assert.equal(runner.canResume(report, runner.selectCases(corpus, "single", "short-05"), task, baseline, runner.MODEL, "single"), false);
  assert.equal(runner.canResume(report, cases, task, baseline, runner.MODEL, "current"), false);
  await assert.rejects(runner.run({ ...options, cases: corpus, report }), /评测版本、方式或素材已变化/);
  assert.equal(requests.length, 1);
  await runner.run({ ...options, report, limits: runner.MODES.single });
  assert.equal(report.status, "awaiting_ai_review");
  assert.deepEqual(requests.map(body => requestPayload(body).operation), ["observe_image", "generate", "solve", "review"]);
  assert.ok(requests.every(body => body.thinking.type === "disabled"));
  assert.ok(requests[0].messages.at(-1).content.some(part => part.type === "image_url" && part.image_url.url.endsWith("single-image-fixture")));
  assert.ok(requests.slice(1).every(body => typeof body.messages.at(-1).content === "string"));
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].id, "image-02");
  assert.equal(report.cases[0].old, null);
  assert.equal(report.cases[0].current.status, "ready");
  assert.equal(report.budget.requestsUsed, 4);
  assert.equal(report.budget.knownTokens, 120);
  const bundle = runner.exportBundle(report, cases, () => { throw new Error("单样本不应生成随机配对"); });
  assert.equal(bundle.blindReview.length, 1);
  assert.equal(bundle.blindReview[0].imagePath, cases[0].imagePath);
  assert.equal(bundle.blindReview[0].scores.accuracy, null);
  assert.deepEqual(bundle.reviewKey, [{ label: "image-02-A", version: "current" }]);
  assert.equal(JSON.stringify(bundle).includes(config.apiKey), false);
  await runner.run({ ...options, report });
  assert.equal(requests.length, 4); // Finished means no next sample or repeat.
});

test("单样本 CLI 可零调用准备记录，错误 ID 和冲突参数不创建输出", t => {
  const directory = mkdtempSync(join(tmpdir(), "kg-single-eval-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = resolve(__dirname, "../evals/card-quality/run.mjs");
  const out = join(directory, "prepared");
  const result = execFileSync(process.execPath, [cli, "--prepare", "--case", "short-05", "--out", out], { encoding: "utf8" });
  assert.match(result, /0 次请求/);
  const report = JSON.parse(readFileSync(join(out, "outputs.json"), "utf8"));
  assert.equal(report.evaluationMode, "single");
  assert.deepEqual(JSON.parse(report.corpus).map(sample => sample.id), ["short-05"]);
  assert.equal(report.budget.maxRequests, 7);
  assert.equal(report.budget.maxTokens, 18000);
  assert.equal(report.budget.knownTokens, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "blind-review.json"), "utf8")).length, 1);
  for (const args of [["--case", "missing"], ["--case"], ["--mode", "single"], ["--case", "short-05", "--mode", "paired"]]) {
    const invalid = spawnSync(process.execPath, [cli, "--prepare", "--out", join(directory, "invalid"), ...args], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.equal(existsSync(join(directory, "invalid")), false);
  }
});
