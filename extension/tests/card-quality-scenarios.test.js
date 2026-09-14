const test = require("node:test");
const assert = require("node:assert/strict");
const quality = require("../src/backend/features/generation/card-quality.js");
const task = require("../src/harness/skills/skill-registry.js").loadTask("concept-card");
const recorded = require("./fixtures/scenario-quality-cases.json");
const copy = id => structuredClone(recorded.find(row => row.id === id));
const issues = (sample, code) => quality.validate(sample.candidate, sample.context, task, false).issues.filter(issue => issue.code === code);

test("已放行的时间状态错误可本地定位，正确的已完成状态与原始记录保留", () => {
  for (const [id, count] of [["short-07", 2], ["short-07-correct", 0]]) {
    const sample = copy(id), before = JSON.stringify(sample);
    const result = issues(sample, "timeline_state_mismatch");
    assert.equal(result.length, count, JSON.stringify(result));
    if (count) assert.deepEqual(result.map(issue => issue.field), ["exercise.answer", "exercise.answerExplanation"]);
    assert.equal(JSON.stringify(sample), before);
  }
});

test("时间检查使用实际时序，保留仍未完成、同时完成、否定句及有条件的通用规则", () => {
  const question = (first, second, third) => `p1 在 ${first} 后 resolve('a')，p2 在 ${second} 后 resolve('b')，p3 在 ${third} 后 reject('error')。调用 Promise.all([p1, p2, p3]) 后，结果怎样？`;
  for (const [q, answer, bad] of [
    [question('10ms','20ms','30ms'), 'p1和p2仍会继续执行。', true],
    [question('10ms','20ms','30ms'), '其他任务（p1 和 p2）不会被取消，它们仍会继续执行。', true],
    [question('30ms','40ms','10ms'), '其他任务（p1 和 p2）不会被取消，它们仍会继续执行。', false],
    [question('10ms','20ms','10ms'), 'p1仍在执行。', false],
    [question('0.01s','20毫秒','0.03秒'), 'p1和p2继续运行。', true],
    [question('10ms','40ms','30ms'), 'p1已完成，p2仍会继续执行。', false],
    [question('10ms','40ms','30ms'), 'p2仍会继续执行，p1已完成。', false],
    [question('10ms','40ms','30ms'), 'p1和p2仍会继续执行。', true],
    [question('10ms','20ms','30ms'), 'p1和p2不会继续执行。', false],
    [question('10ms','20ms','30ms'), '不能认为p1和p2仍会继续执行。', false],
    [question('10ms','20ms','30ms'), '“p1仍会继续执行”的说法是错误的。', false],
    [question('10ms','20ms','30ms'), 'p1和p2不会被取消并仍会继续执行。', true],
    [question('10ms','20ms','30ms'), '如果p1和p2尚未完成，它们仍会继续执行。', false],
    [question('10ms','20ms','30ms'), '在5ms时，p1和p2仍会继续执行。', false],
    [question('10ms','20ms','30ms'), '一般而言其他任务不会被取消。', false],
    [question('10ms','20ms','30ms'), '其他尚未完成的任务会继续执行。', false],
    [question('10ms','20ms','30ms'), 'p1和p2已完成，没有被取消。', false],
    [question('10ms','20ms','30ms').replace('p2 在 20ms 后', 'p2在未知时刻'), 'p1和p2仍会继续执行。', false],
    [question('10ms','20ms','30ms') + '观察在5ms时的任务状态。', 'p1和p2仍会继续执行。', false],
    [question('10ms','20ms','30ms') + '这些任务在不同时启动。', 'p1和p2仍会继续执行。', false],
    [question('10ms','20ms','30ms').replaceAll('p1','download').replaceAll('p2','render'), 'download和render继续执行。', true]
  ]) {
    const sample = copy('short-07-correct');
    Object.assign(sample.candidate.exercise, { question: q, answer, answerExplanation: '本例整体拒绝。', rubric: ['判断整体拒绝'] });
    assert.equal(issues(sample, 'timeline_state_mismatch').length > 0, bad, answer + '\n' + q);
  }
});

test("图片的一次观察不能推广一般性质，有图注依据、具体全称和否定提醒仍可用", () => {
  assert.equal(issues(copy('image-01'), 'image_scope_unverified').length, 1);
  assert.equal(issues(copy('image-01-correct'), 'image_scope_unverified').length, 0);
  for (const [text, source, bad] of [
    ['用户空间通常没有图形元素。', '', true],
    ['左侧一般为空。', '', true],
    ['左侧始终为空。', '', true],
    ['本图左侧没有矩形，中间所有矩形都是白色。', '', false],
    ['本图两个矩形一般大小。', '', false],
    ['不能把这张图解释成用户空间通常没有图形。', '', false],
    ['本图空白并不意味着用户空间通常没有图形。', '', false],
    ['“用户空间通常为空”的结论不成立。', '', false],
    ['该模型的左区通常为空。', '图注：此示意模型的左区通常为空。', false],
    ['左侧始终为空。', '图例写明：左侧始终为空。', false],
    ['左侧通常为空。', 'Caption: the left area is usually empty in this model.', false]
  ]) {
    const sample = copy('image-01-correct');
    sample.candidate.card.summary = text;
    if (source) sample.context.evidence.push({ id:'caption', kind:'text', text:source });
    assert.equal(issues(sample, 'image_scope_unverified').length > 0, bad, text);
  }
});

test("来源和任务类型不匹配时不套用时间或图片规则，畸形字段保留结构错误", () => {
  const sample = copy('short-07');
  sample.context.evidence[0].text = '另一个完全不同的任务。';
  assert.equal(issues(sample, 'timeline_state_mismatch').length, 0);
  const text = copy('short-05');
  text.candidate.card.summary = '用户空间通常没有图形。';
  assert.equal(issues(text, 'image_scope_unverified').length, 0);
  for (const value of [null, {}, [], 42]) {
    const item = copy('short-07-correct');
    item.candidate.exercise.question = value;
    assert.doesNotThrow(() => quality.validate(item.candidate, item.context, task, false));
    assert.equal(quality.validate(item.candidate, item.context, task, false).passed, false);
  }
});

test("时间问题一次修复同步改答案和解释，修复后重新核验且不改传入卡片", async () => {
  const sample = copy('short-07'), fixed = copy('short-07-correct');
  const before = JSON.stringify(sample.candidate), calls = [];
  const { requestPayload, checksFor } = require('./fixtures/quality-output.js');
  const service = quality.createQualityService({ task, getModelConfig: () => ({ model:'fixture' }), transport:{ complete:async(_config, request) => {
    const input=requestPayload(request); calls.push(input.operation);
    let output;
    if(input.operation==='repair') {
      assert.ok(input.issues.some(issue=>issue.code==='timeline_state_mismatch'));
      output={exercise:fixed.candidate.exercise};
    } else if(input.operation==='solve') output={answerable:true,answer:fixed.candidate.exercise.answer,basis:fixed.candidate.exercise.answerExplanation,optionJudgments:[]};
    else if(input.operation==='review') output={findings:[],checks:checksFor(input.candidate)};
    else assert.fail('不应重新生成已有草稿');
    return { content:JSON.stringify(output),finishReason:'stop',provider:{model:'fixture',latencyMs:1} };
  } } });
  const pending={...sample.candidate,generation:{resume:{independentReview:true,reviewed:false,repairUsed:false}}};
  const output=await service.run(sample.context,pending,'resume');
  assert.equal(output.status,'ready',JSON.stringify(output.quality));
  assert.deepEqual(calls,['repair','solve','review']);
  assert.equal(JSON.stringify(sample.candidate),before);
});
