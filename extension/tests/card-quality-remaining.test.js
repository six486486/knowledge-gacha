const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../src/backend/features/generation/card-quality.js');
const task = require('../src/harness/skills/definitions/concept-card/task.js');
const recorded = require('./fixtures/remaining-quality-cases.json');
const copy = id => structuredClone(recorded.find(row => row.id === id));
const validate = sample => quality.validate(sample.candidate, sample.context, task, false);
const sorting = sample => validate(sample).issues.filter(issue => /sorting_trace|generated_trace/.test(issue.code));

test('历史正确排序可逐步核对；错误中间状态和错误最终答案分别阻止收下', () => {
  const sample = copy('short-03'), before = JSON.stringify(sample);
  assert.equal(validate(sample).passed, true);
  assert.equal(JSON.stringify(sample), before);
  const wrongStep = copy('short-03');
  wrongStep.candidate.card.example.text = wrongStep.candidate.card.example.text.replace("[(2, 'a'), (1, 'a'), (1, 'b')]", "[(1, 'a'), (2, 'a'), (1, 'b')]");
  assert.equal(sorting(wrongStep)[0].code, 'sorting_trace_mismatch');
  assert.match(sorting(wrongStep)[0].message, /第1步/);
  const wrongAnswer = copy('short-03');
  wrongAnswer.candidate.exercise.answer = "[(2, 'a'), (2, 'x'), (1, 'y')]";
  assert.deepEqual(sorting(wrongAnswer).map(issue => issue.field), ['exercise.answer']);
  const aliases = copy('short-03');
  aliases.candidate.exercise.question = aliases.candidate.exercise.question.replace('第二个元素', '第二个元素（次要键）').replace('第一个元素', '第一个元素（主要键）');
  aliases.candidate.exercise.answer = aliases.candidate.exercise.answer.replace('第二个元素', '次要键').replace('第一个元素', '主要键');
  assert.deepEqual(sorting(aliases), []);
  aliases.candidate.exercise.question = aliases.candidate.exercise.question.replace('次要键', '字母').replace('主要键', '数字');
  aliases.candidate.exercise.answer = aliases.candidate.exercise.answer.replace('次要键', '字母').replace('主要键', '数字');
  assert.deepEqual(sorting(aliases), []);
});

test('排序支持数字比较、稳定的同键顺序、逐键降序和列表记录，拒绝猜测不支持的代码', () => {
  for (const [text, expected] of [
    ["列表 [(2, 'b'), (10, 'a'), (2, 'a')]，先按第二个元素排序得到 [(10, 'a'), (2, 'a'), (2, 'b')]，再按第一个元素降序排序得到 [(10, 'a'), (2, 'a'), (2, 'b')]。", null],
    ["列表 [(2, 'b'), (10, 'a'), (2, 'a')]，先按第二个元素排序得到 [(10, 'a'), (2, 'a'), (2, 'b')]，再按第一个元素降序排序得到 [(10, 'a'), (2, 'b'), (2, 'a')]。", 'sorting_trace_mismatch'],
    ['列表 [[-1, 4], [2, 3], [-1, 2]]，先按第二个元素排序得到 [[-1, 2], [2, 3], [-1, 4]]，再按第一个元素排序得到 [[-1, 2], [-1, 4], [2, 3]]。', null],
    ['列表 [(1, 2), (2, 1)]，先按第二个元素排序，再按第一个元素排序，最终 [(1, 2), (2, 1)]。', null],
    ['列表 [(1, 2), (2, 1)]，先按第二个元素排序，再按第一个元素排序（降序），最终 [(1, 2), (2, 1)]。', 'generated_trace_unverified'],
    ['列表 [(1, 2), (2, 1)]，先按第二个元素排序，再按未知字段排序，最终 [(1, 2), (2, 1)]。', 'generated_trace_unverified'],
    ["列表 [(1, 2), (2, 1)]，先用 sorted(items, key=lambda x: x[1]) 排序，再用别的函数排序。", 'generated_trace_unverified'],
    ["列表 [(1, 2), (2, 1)]，先按第二个元素排序，再按第一个元素排序，最终 [(1, 2), (globalThis.untrustedExecution = 1, 1)]。", 'generated_trace_unverified']
  ]) {
    const sample = copy('short-03'); sample.candidate.card.example.text = text;
    assert.equal(sorting(sample)[0]?.code || null, expected, text);
  }
  assert.equal(globalThis.untrustedExecution, undefined);
});

test('已知输入的 isclose 得到确定真假，显式容差和未知参数不会被默认值覆盖', () => {
  assert.ok(validate(copy('condition-02')).issues.some(issue => issue.code === 'deterministic_result'));
  for (const [text, bad] of [
    ['math.isclose(0.1+0.1+0.1, 0.3) 返回 True。', false],
    ['math.isclose(0.1+0.1+0.1, 0.3) 返回 False。', true],
    ['math.isclose(0.1+0.1+0.1, 0.3) 可能返回 True。', true],
    ['math.isclose(0.1+0.1+0.1, 0.3) 在合适容差下可返回 True。', true],
    ['math.isclose(0.1+0.1+0.1, 0.3) 在默认容差下返回 True。', false],
    ['math.isclose(0.1+0.1+0.1, 0.3, rel_tol=0, abs_tol=0) 返回 False。', false],
    ['math.isclose(0.1+0.1+0.1, 0.3, abs_tol=1e-12, rel_tol=0) 返回 True。', false],
    ['math.isclose(0, 1e-12) 返回 False。', false],
    ['math.isclose(0, 1e-12, abs_tol=1e-12) 返回 True。', false],
    ['math.isclose((0.1+0.1)+0.1, 0.3) 返回 True。', false],
    ['math.isclose(a, b) 可能返回 True，取决于输入。', false],
    ['math.isclose(0, 1, abs_tol=tolerance) 可能返回 True。', false],
    ['math.isclose(0, 1, rel_tol=-1) 将抛出 ValueError。', false],
    ['math.isclose(0.3, 0.3) 返回 True；若改变输入或容差，另一次调用的结果可能不同。', false],
    ['错误地认为 math.isclose(0.1+0.1+0.1, 0.3) 返回 False。', false],
    ['“math.isclose(0.1+0.1+0.1, 0.3) 可能返回 False”的说法不成立。', false],
    ['math.isclose(globalThis.untrustedExecution = 1, 0) 返回 False。', false]
  ]) {
    const sample = copy('condition-02'); sample.candidate.card.example.text = text;
    assert.equal(validate(sample).issues.some(issue => issue.code === 'deterministic_result'), bad, text);
  }
  assert.equal(globalThis.untrustedExecution, undefined);
});

test('浮点题中明确赋值可核对；未知、重复赋值和变量改变不能猜测', () => {
  for (const [question, answer, bad] of [
    ['给定 a = 0.1 + 0.1 + 0.1，b = 0.3。结果是什么？', 'math.isclose(a, b) 的结果可能为 True。', true],
    ['给定 a = 0.1 + 0.1 + 0.1，b = 0.3。结果是什么？', 'math.isclose(a, b) 返回 True。', false],
    ['给定 a = 0.1 + 0.1 + 0.1，b = 0.3。结果是什么？', 'math.isclose(a, b, rel_tol=0, abs_tol=0) 返回 False。', false],
    ['给定两个未知的浮点数 a、b。', 'math.isclose(a, b) 可能返回 True。', false],
    ['a = 1，b = 1，随后 a = 2。', 'math.isclose(a, b) 可能返回 True。', false],
    ['a = 1，b = 1，随后 a += 1。', 'math.isclose(a, b) 可能返回 True。', false],
    ['a = 1，b = 1，接着修改 a。', 'math.isclose(a, b) 可能返回 True。', false]
  ]) {
    const sample = copy('condition-02');
    sample.candidate.card.example.text = 'math.isclose(0.1+0.1+0.1, 0.3) 返回 True。';
    Object.assign(sample.candidate.exercise, { question, answer });
    assert.equal(validate(sample).issues.some(issue => issue.code === 'deterministic_result'), bad, question + answer);
  }
});

test('排序规则应用题不能倒置题设的执行顺序或将主次键的同键规则写反', () => {
  const sample = copy('short-03');
  sample.candidate.exercise.question = '要求先按姓名排序，再按年龄排序。请写出正确顺序。';
  sample.candidate.exercise.answer = '先按年龄排序，再按姓名排序。';
  sample.candidate.card.example.text = '先按年龄（次要键）排序，再按姓名（主要键）排序。由于稳定性，年龄相同的记录会保持姓名排序后的顺序。';
  assert.deepEqual(validate(sample).issues.filter(issue => issue.code.startsWith('sorting_priority')).map(issue => issue.code), ['sorting_priority_ambiguous', 'sorting_priority_mismatch']);
  sample.candidate.exercise.question = '要求以姓名为主要键、年龄为次要键。执行顺序是什么？';
  sample.candidate.card.example.text = '先按年龄（次要键）排序，再按姓名（主要键）排序。由于稳定性，姓名相同的记录会保持年龄排序后的顺序。';
  assert.ok(!validate(sample).issues.some(issue => issue.code.startsWith('sorting_priority')));
});

test('事务题定位提交后丢失的未明前提，保留提交前失败与明确反例', () => {
  const sample = copy('short-08');
  assert.ok(validate(sample).issues.some(issue => issue.code === 'transaction_context' && issue.requiresNewQuestion));
  for (const question of [
    '事务在提交过程中系统崩溃，恢复后修改全部消失。这是否说明硬件同时写入？',
    '事务提交成功，全部修改可见。这是否说明硬件在同一瞬间完成写入？',
    '某实现提交成功后故障，恢复后修改全部丢失。这是否违反持久性？',
    '把“提交后系统崩溃但全部修改消失”当作原子性的解释，这一说法是否成立？'
  ]) {
    sample.candidate.exercise.question = question;
    assert.ok(!validate(sample).issues.some(issue => issue.code === 'transaction_context'), question);
  }
  sample.candidate.exercise.question = copy('short-08').candidate.exercise.question;
  sample.context.evidence[0].text += '在本实验的非持久配置下，提交后崩溃可能导致修改丢失。';
  assert.ok(!validate(sample).issues.some(issue => issue.code === 'transaction_context'));
});

test('图片图注支持状态改述，缺图注和无关图注仍被阻止；畸形评分字段不使流程崩溃', () => {
  const image = require('./fixtures/scenario-quality-cases.json').find(row => row.id === 'image-01-correct');
  for (const [caption, text, bad] of [
    ['', '页面尚未修改。', true],
    ['图注：这是一个矩形。', '页面尚未修改。', true],
    ['图注：页面尚未被修改。', '页面尚未修改。', false],
    ['图注：页面已修改。', '页面已提交。', true],
    ['图注：删除日志才是提交点，图中日志仍然存在。', '本图尚未提交。', false],
    ['图注：页面保持原样。', '图中保留原数据。', false]
  ]) {
    const sample = structuredClone(image);
    sample.candidate.card.example.text = text;
    if (caption) sample.context.evidence.push({ id: 'caption', kind: 'text', text: caption });
    assert.equal(validate(sample).issues.some(issue => issue.code === 'image_claim_unverified' && issue.field === 'card.example.text'), bad, text + caption);
  }
  const sample = structuredClone(image); sample.candidate.exercise.rubric = { wrong: 'shape' };
  assert.doesNotThrow(() => validate(sample));
  assert.equal(validate(sample).passed, false);
  sample.candidate.exercise.rubric = ['指出位置'];
  sample.candidate.card.example.text = 'OS Buffers 下方有白色矩形，表示系统缓冲区中有内容。';
  assert.ok(validate(sample).issues.some(issue => issue.code === 'image_claim_unverified'));
  sample.candidate.card.example.text = 'OS Buffers 下方有白色矩形。';
  assert.ok(!validate(sample).issues.some(issue => issue.code === 'image_claim_unverified'));
});

test('自拟新数字的示例不能标为来源已有示例，相同数据的改述仍可用', () => {
  const sample = copy('condition-02');
  sample.candidate.card.example = { type: 'example', origin: 'source', text: '0.1 + 0.1 + 0.1 == 0.3 为 False。' };
  assert.ok(!validate(sample).issues.some(issue => issue.code === 'example_origin'));
  sample.candidate.card.example.text = '累加得到 0.30000000000000004。';
  assert.ok(validate(sample).issues.some(issue => issue.code === 'example_origin'));
  sample.candidate.card.example.origin = 'authored';
  assert.ok(!validate(sample).issues.some(issue => issue.code === 'example_origin'));
});

test('Promise 摘要区分不会取消与尚未完成的任务继续，保留明确条件和否定提醒', () => {
  const fixture = require('./fixtures/scenario-quality-cases.json').find(row => row.id === 'short-07-correct');
  for (const [summary, bad] of [
    ['Promise.all 拒绝时不会取消其他任务，其他任务仍会继续执行。', true],
    ['Promise.all 拒绝时不会取消其他已启动的任务，其他任务仍会继续运行。', true],
    ['Promise.all 不会取消其他已启动的任务，尚未完成的其他任务仍会继续执行。', false],
    ['如果尚未完成，其他任务仍会继续执行。', false],
    ['不会取消其他任务，不意味着其他任务仍会继续执行。', false],
    ['“其他任务仍会继续执行”这一说法不成立。', false]
  ]) {
    const sample = structuredClone(fixture); sample.candidate.card.summary = summary;
    assert.equal(validate(sample).issues.some(issue => issue.code === 'task_continuation_scope'), bad, summary);
  }
});

test('数值与事务问题均沿一次修复及重新核验路径处理，不修改原始卡片', async () => {
  const { requestPayload, checksFor } = require('./fixtures/quality-output.js');
  for (const id of ['short-08', 'condition-02']) {
    const sample = copy(id), before = JSON.stringify(sample), calls = [];
    const fixed = structuredClone(sample.candidate);
    if (id === 'short-08') fixed.exercise.question = 'SQLite 事务的修改表现为全有或全无，能否据此说明磁盘写入发生在同一瞬间？';
    else fixed.card.example.text = 'math.isclose(0.1+0.1+0.1, 0.3) 在默认容差下返回 True；精确比较 0.1+0.1+0.1 == 0.3 返回 False。';
    const service = quality.createQualityService({ task, getModelConfig: () => ({ model: 'fixture' }), transport: { complete: async (_config, request) => {
      const input = requestPayload(request); calls.push(input.operation);
      const result = input.operation === 'repair' ? { card: fixed.card, exercise: fixed.exercise } : input.operation === 'solve' ?
        { answerable: true, optionJudgments: [], answer: fixed.exercise.answer, basis: fixed.exercise.answerExplanation } : { findings: [], checks: checksFor(input.candidate) };
      return { content: JSON.stringify(result), finishReason: 'stop', provider: { model: 'fixture', latencyMs: 1 } };
    } } });
    const output = await service.run(sample.context, { ...sample.candidate, generation: { resume: { independentReview: true, repairUsed: false, reviewed: false } } }, 'resume');
    assert.equal(output.status, 'ready', JSON.stringify(output.quality));
    assert.deepEqual(calls, ['repair', 'solve', 'review']);
    assert.equal(JSON.stringify(sample), before);
  }
});

test('同一图片的复核和局部修改复用原观察记录，重新生成仍重新观察', async () => {
  const source = require('./fixtures/scenario-quality-cases.json').find(row => row.id === 'image-01-correct');
  const { requestPayload, checksFor } = require('./fixtures/quality-output.js');
  const sample = structuredClone(source), calls = [];
  sample.context.image = { dataUrl: 'data:image/png;base64,fixture-image' };
  const observed = sample.context.evidence.find(item => item.kind === 'image');
  sample.candidate.generation = { imageObservation: { observations: observed.observations, legend: observed.legend || [] } };
  const before = JSON.stringify(sample);
  const service = quality.createQualityService({ task, getModelConfig: () => ({ model: 'fixture' }), transport: { complete: async (_config, request) => {
    const input = requestPayload(request); calls.push(input.operation);
    const output = input.operation === 'observe_image' ? sample.candidate.generation.imageObservation : input.operation === 'solve' ?
      { answerable: true, optionJudgments: [], answer: sample.candidate.exercise.answer, basis: sample.candidate.exercise.answerExplanation } :
      input.operation === 'review' ? { findings: [], checks: checksFor(input.candidate) } : sample.candidate;
    return { content: JSON.stringify(output), finishReason: 'stop', provider: { model: 'fixture', latencyMs: 1 } };
  } } });
  for (const action of ['review', 'summary', 'example', 'exercise']) {
    calls.length = 0;
    const output = await service.run(sample.context, sample.candidate, action);
    assert.equal(output.status, 'ready', JSON.stringify(output.quality));
    assert.ok(!calls.includes('observe_image'));
    assert.deepEqual(output.generation.imageObservation, sample.candidate.generation.imageObservation);
  }
  calls.length = 0;
  await service.run(sample.context);
  assert.equal(calls[0], 'observe_image');
  assert.equal(JSON.stringify(sample), before);
});
