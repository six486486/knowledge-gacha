const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../src/backend/features/generation/card-quality.js');
const task = require('../src/harness/skills/skill-registry.js').loadTask('concept-card');
const records = require('./fixtures/acceptance-september-regressions.json');
const { checksFor, requestPayload } = require('./fixtures/quality-output.js');
const sample = id => structuredClone(records.find(row => row.id === id));
const local = row => quality.validate(row.candidate, row.context, task, false);

test('验收中的错误文字元组答案被本地定位，正确示例与历史记录保持不变', () => {
  const row = sample('sorting-answer'), before = JSON.stringify(row);
  const issues = local(row).issues;
  assert.deepEqual(issues.map(i => [i.code, i.field]), [['sorting_trace_mismatch', 'exercise.answer']]);
  assert.match(issues[0].message, /\[\["x",1\],\["x",3\],\["y",1\],\["y",3\]\]/);
  assert.equal(JSON.stringify(row), before);
  row.candidate.exercise.answer = '最终顺序为 ("x", 1)、("x", 3)、("y", 1)、("y", 3)。';
  assert.equal(local(row).passed, true, JSON.stringify(local(row).issues));
});

test('裸元组、方括号、不同分隔符和降序均按字面输入验证，不把计划复述当新增步骤', () => {
  for (const separator of ['、', ', ', '，']) for (const reverse of [false, true]) {
    const row = sample('sorting-answer');
    row.candidate.exercise.question = '输入为 ("x",3)、("y",1)、("x",1)、("y",3)，先按第二个元素' + (reverse ? '降序' : '升序') + '排序，再按第一个元素排序。最终结果是什么？';
    const tuples = reverse ? ['("x",3)', '("x",1)', '("y",3)', '("y",1)'] : ['("x",1)', '("x",3)', '("y",1)', '("y",3)'];
    row.candidate.exercise.answer = '最终结果为 ' + tuples.join(separator) + '。';
    row.candidate.exercise.answerExplanation = '主要键相同的记录保留前一步的相对顺序。';
    assert.equal(local(row).passed, true, JSON.stringify(local(row).issues));
    row.candidate.exercise.answer = '最终结果为 [' + tuples.join(',') + ']。';
    assert.equal(local(row).passed, true, JSON.stringify(local(row).issues));
    [tuples[1], tuples[2]] = [tuples[2], tuples[1]];
    row.candidate.exercise.answer = '最终结果为 ' + tuples.join(separator) + '。';
    assert.ok(local(row).issues.some(i => i.code === 'sorting_trace_mismatch'));
  }
});

test('文字字面量中的标点不改变值；生成文本中的调用不会执行', () => {
  const row = sample('sorting-answer');
  row.candidate.exercise.question = '输入为 ("b,a",2)、("a,b",1)，先按第二个元素排序，再按第一个元素排序。结果是什么？';
  row.candidate.exercise.answer = '最终结果为 ("a,b",1)、("b,a",2)。';
  row.candidate.exercise.answerExplanation = '按给定两个字段排序。';
  assert.equal(local(row).passed, true);
  row.candidate.exercise.answer = '最终结果为 (globalThis.__qaExecuted = 1,2)、("a",1)。';
  local(row);
  assert.equal(globalThis.__qaExecuted, undefined);
});

test('回忆题必须显式比对答案和题设，全true总评不能覆盖冲突或畸形比对', () => {
  for (const comparison of [undefined, {}, { equivalent: 'true', followsQuestion: true, reason: 'test' },
    { equivalent: true, followsQuestion: true, reason: '' }, { equivalent: false, followsQuestion: true, reason: '结果顺序不一致' },
    { equivalent: true, followsQuestion: false, reason: '改变了固定距离' }]) {
    const row = sample('fixed-distance');
    row.candidate.checks = checksFor(row.candidate);
    row.candidate.checks.find(c => c.rule === 'answerCorrectness').comparison = comparison;
    const result = quality.validate(row.candidate, row.context, task, true);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => ['recall_comparison_invalid', 'independent_answer_mismatch'].includes(i.code)));
  }
});

test('语义等价的不同措辞允许通过，但盲解看不到标准答案且审校收到双方', async () => {
  const row = sample('fixed-distance');
  row.candidate.exercise = { type: 'recall', question: '固定构图与拍摄距离，希望景深变浅，怎样调整光圈？',
    answer: '增大光圈。', answerExplanation: '其余条件相同，增大光圈会减小景深。', rubric: ['增大光圈'] };
  const requests = [];
  const api = quality.createQualityService({ task, getModelConfig: () => ({ model: 'fixture' }), transport: { complete: async (_, request) => {
    const p = requestPayload(request); requests.push(p);
    let output;
    if (p.operation === 'solve') {
      assert.equal(p.answer, undefined); assert.equal(p.candidate, undefined);
      output = { answerable: true, answer: '使用更大的光圈（更小的f值）。', basis: '在其余条件不变时景深变浅。', optionJudgments: [] };
    } else {
      assert.equal(p.candidate.exercise.answer, '增大光圈。');
      assert.match(p.independentAnswer.answer, /更小的f值/);
      output = { findings: [], checks: checksFor(p.candidate) };
    }
    return { content: JSON.stringify(output), provider: { model: 'fixture' }, finishReason: 'stop' };
  } } });
  assert.equal((await api.run(row.context, row.candidate, 'review')).status, 'ready');
  assert.deepEqual(requests.map(r => r.operation), ['solve', 'review']);
});

test('比对失败进入一次修复，同题仅改答案复用盲解，旧通过标记不能跳过新比对', async () => {
  for (const repaired of [false, true]) {
    const row = sample('fixed-distance'), requests = [];
    row.candidate.exercise.question = '固定ISO，希望亮度降低，怎样调整快门？';
    row.candidate.exercise.answer = '只改变ISO。';
    const api = quality.createQualityService({ task, getModelConfig: () => ({ model: 'fixture' }), transport: { complete: async (_, request) => {
      const p = requestPayload(request); requests.push(p);
      const checks = p.operation === 'review' ? checksFor(p.candidate) : null;
      if (checks) checks.find(c => c.rule === 'answerCorrectness').comparison = {
        equivalent: p.candidate.exercise.answer === '缩短曝光时间。', followsQuestion: p.candidate.exercise.answer === '缩短曝光时间。', reason: '只能调整题设允许的量' };
      const output = p.operation === 'generate' ? row.candidate : p.operation === 'solve' ? { answerable: true, answer: '缩短曝光时间。', basis: '固定ISO，用更快快门减小进光量', optionJudgments: [] } :
        p.operation === 'review' ? { findings: [], checks } : repaired ? { exercise: { answer: '缩短曝光时间。' } } : {};
      return { content: JSON.stringify(output), provider: { model: 'fixture' }, finishReason: 'stop' };
    } } });
    const output = await api.run(row.context);
    assert.equal(output.status, repaired ? 'ready' : 'needs_revision');
    assert.deepEqual(requests.map(r => r.operation), ['generate', 'solve', 'review', 'repair', 'review']);
  }
});

test('原验收的固定距离冲突和有限样本保证有本地边界检查', () => {
  for (const [id, code] of [['fixed-distance', 'question_condition_conflict'], ['finite-clt', 'finite_sample_unverified']]) {
    const row = sample(id), original = JSON.stringify(row);
    assert.ok(local(row).issues.some(i => i.code === code));
    assert.equal(JSON.stringify(row), original);
  }
});

test('允许调整距离的题、明确否定错误建议和只调整光圈均不误拦', () => {
  const row = sample('fixed-distance');
  for (const answer of ['增大光圈，不改变拍摄距离。', '不能通过缩短拍摄距离达到目标。', '改变拍摄距离会违反题设，只能增大光圈。']) {
    row.candidate.exercise.answer = answer;
    row.candidate.exercise.answerExplanation = '其余条件不变，增大光圈。';
    row.candidate.exercise.rubric = ['增大光圈'];
    assert.ok(!local(row).issues.some(i => i.code === 'question_condition_conflict'), answer);
  }
  row.candidate.exercise.question = '允许改变拍摄距离，希望景深变浅，怎样调整？';
  row.candidate.exercise.answer = '缩短拍摄距离。';
  assert.ok(!local(row).issues.some(i => i.code === 'question_condition_conflict'));
});

test('CLT不误拦渐近陈述、明确的不保证及已给误差前提', () => {
  const row = sample('finite-clt');
  for (const text of ['n=100不能保证任意分布的近似精度。', '不能认为n=100足够大。', '样本量趋于无穷时，标准化均值依分布收敛。']) {
    row.candidate.exercise.answerExplanation = text;
    assert.ok(!local(row).issues.some(i => i.code === 'finite_sample_unverified'), text);
  }
  row.context.evidence.push({ id: 'bound', kind: 'text', text: '本题已通过Berry-Esseen估计给出误差上界0.01。' });
  row.candidate.exercise.answerExplanation = '该误差要求下n=100足够大。';
  assert.ok(!local(row).issues.some(i => i.code === 'finite_sample_unverified'));
});

test('等号检查覆盖其/该变量写法，明确原文支持、否定和严格规则不误伤', () => {
  const row = sample('cache-boundary');
  assert.ok(local(row).issues.some(i => i.code === 'boundary_unverified'));
  for (const text of ['age 小于 max-age 时新鲜。', '不能认为age 未超过其 max-age 就一定新鲜。']) {
    row.candidate.card.example.text = text;
    assert.ok(!local(row).issues.some(i => i.code === 'boundary_unverified'), text);
  }
  row.context.evidence.push({ id: 'boundary', kind: 'text', text: '测试规则：age <= max-age 时允许。' });
  row.candidate.card.example.text = 'age未超过该max-age时允许。';
  assert.ok(!local(row).issues.some(i => i.code === 'boundary_unverified'));
});
