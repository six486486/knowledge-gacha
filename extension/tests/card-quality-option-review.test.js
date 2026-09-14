const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const oldTask = require("./fixtures/regressions/2026-09-03-v2.2.4-single-short-01--task-v2.2.4.js");
const recorded = require("./fixtures/regressions/2026-09-03-v2.2.4-single-short-01--run-2026-09-03.json").outputs;
const { qualityOutput, checksFor, requestPayload, verificationOutput } = require("./fixtures/quality-output.js");
const context = { evidence: [{ id: "material", kind: "text", text: "边际成本是每多生产一个单位额外增加的成本。" }], materialLength: 24 };
const optionCheck = candidate => candidate.checks.find(check => check.rule === "answerCorrectness");

test("真实导出的笼统全通过不能替代逐项核验，保留原始状态和文字", () => {
  const original = structuredClone(recorded);
  const candidate = recorded.cases[0].current;
  const material = JSON.parse(recorded.corpus)[0];
  const ctx = { evidence: [{ id: "material", kind: "text", text: material.text }] };
  assert.equal(candidate.status, "ready");
  assert.equal(quality.validate(candidate, ctx, oldTask, true).passed, true);
  assert.equal(quality.validate(candidate, ctx, task, false).passed, true);
  assert.ok(quality.validate(candidate, ctx, task, true).issues.some(issue => issue.code === "semantic_answerCorrectness"));
  assert.equal(candidate.exercise.misconceptions[1], candidate.exercise.misconceptions[2]);

  // Reviewer-authored fixture, not a real-model detection result. The recorded
  // explanation blames option 2 for claiming a change it explicitly does not claim.
  const reviewed = structuredClone(candidate);
  reviewed.checks = checksFor(reviewed);
  Object.assign(optionCheck(reviewed).optionChecks[2], {
    misconceptionCorrect: false,
    reason: "选项写内容可能仍然正确，说明却指责其认为内容已改变；错误实际在新鲜度判断。"
  });
  const result = quality.validate(reviewed, ctx, task, true);
  assert.ok(result.issues.some(issue => issue.field === "exercise.misconceptions.2"));
  assert.equal(result.passed, false);
  assert.deepEqual(recorded, original);
});

test("逐项核验必须完整、唯一且有布尔判断和具体结论", () => {
  for (const mutate of [
    c => { delete optionCheck(c).optionChecks; },
    c => { optionCheck(c).optionChecks.pop(); },
    c => { optionCheck(c).optionChecks[0] = null; },
    c => { optionCheck(c).optionChecks[0].index = 1; },
    c => { optionCheck(c).optionChecks[0].index = -1; },
    c => { optionCheck(c).optionChecks[0].index = 3; },
    c => { optionCheck(c).optionChecks[0].index = "0"; },
    c => { optionCheck(c).optionChecks[0].validAnswer = "false"; },
    c => { delete optionCheck(c).optionChecks[0].misconceptionCorrect; },
    c => { optionCheck(c).optionChecks[0].reason = " "; }
  ]) {
    const candidate = structuredClone(qualityOutput(context));
    mutate(candidate);
    assert.equal(quality.validate(candidate, context, task, true).passed, false);
  }
});

test("总判定为 true 也不能覆盖多解、无解、答案索引冲突或错误解释", () => {
  for (const mutate of [
    c => { optionCheck(c).optionChecks[0].validAnswer = true; },
    c => { optionCheck(c).optionChecks[1].validAnswer = false; },
    c => { optionCheck(c).optionChecks[2].misconceptionCorrect = false; },
    c => { c.exercise.correctIndex = 0; c.exercise.answer = c.exercise.options[0]; c.exercise.misconceptions = ["", "测试中的干扰项说明", "另一说明"]; }
  ]) {
    const candidate = structuredClone(qualityOutput(context));
    mutate(candidate);
    assert.equal(optionCheck(candidate).passed, true);
    assert.equal(quality.validate(candidate, context, task, true).passed, false);
  }
});

test("索引可乱序，相同解释不自动判错，回忆题不要求选择题记录", () => {
  const candidate = structuredClone(qualityOutput(context));
  optionCheck(candidate).optionChecks.reverse();
  candidate.exercise.misconceptions[0] = candidate.exercise.misconceptions[2] = "没有按新增收入减新增支出计算";
  assert.equal(quality.validate(candidate, context, task, true).passed, true);
  candidate.exercise.type = "recall";
  candidate.checks = checksFor(candidate);
  assert.equal(optionCheck(candidate).optionChecks, undefined);
  assert.equal(quality.validate(candidate, context, task, true).passed, true);
});

test("逐项失败进入一次定点修复，修改后重核；仍错则停止", async () => {
  for (const repairSucceeds of [true, false]) {
    const requests = [];
    const base = qualityOutput(context);
    const broken = structuredClone(base);
    broken.exercise.misconceptions[0] = "把固定房租当作增量";
    const service = quality.createQualityService({ task, getModelConfig: () => ({ model: "deepseek-v4-flash-vision-exp" }),
      transport: { complete: async (_config, request) => {
        const payload = requestPayload(request);
        requests.push(payload);
        let reply;
        if (payload.operation === "solve") reply = verificationOutput(payload);
        else if (payload.operation === "generate") reply = broken;
        else if (payload.operation === "repair") {
          assert.ok(payload.issues.some(issue => issue.field === "exercise.misconceptions.0"));
          reply = repairSucceeds ? { exercise: { misconceptions: base.exercise.misconceptions } } : {};
        } else {
          assert.equal(payload.candidate.checks, undefined);
          assert.equal(payload.candidate.quality, undefined);
          reply = { findings: [], checks: checksFor(payload.candidate) };
          if (payload.candidate.exercise.misconceptions[0] === broken.exercise.misconceptions[0]) {
            Object.assign(optionCheck(reply).optionChecks[0], {
              misconceptionCorrect: false, reason: "10 元选项漏扣原料成本，没有声称扣除了房租。"
            });
          }
        }
        return { content: JSON.stringify(reply), finishReason: "stop", provider: {
          model: "deepseek-v4-flash-vision-exp", latencyMs: 1, usage: { totalTokens: 30 }, thinkingPolicy: "non-thinking-v1"
        } };
      } }
    });
    const result = await service.run(context);
    assert.deepEqual(requests.map(request => request.operation), ["generate", "solve", "review", "repair", "review"]);
    assert.equal(result.status, repairSucceeds ? "ready" : "needs_revision");
    assert.equal(result.generation.calls.filter(call => call.operation === "repair").length, 1);
    assert.equal(optionCheck(result).optionChecks[0].misconceptionCorrect, repairSucceeds);
  }
});
