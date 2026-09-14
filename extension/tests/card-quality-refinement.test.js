const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../src/backend/features/generation/card-quality.js');
const task = require('../src/harness/skills/skill-registry.js').loadTask('concept-card');
const fixtures = require('./fixtures/content-refinement-regressions.json');
const { requestPayload, checksFor } = require('./fixtures/quality-output.js');
const sample = id => structuredClone(fixtures.find(row => row.id === id));
const issues = row => quality.validate(row.candidate, row.context, task, false).issues;
const codes = row => issues(row).map(i => i.code);

test('原样剩余样本定位到具体字段，不修改材料或历史草稿', () => {
  for (const [id, code, field] of [['short-08', 'transaction_context', 'card.example.text'],
    ['image-01', 'image_answer_leak', 'exercise.question'], ['sensitivity', 'term_conflation', 'card.summary'],
    ['iso', 'term_conflation', 'card.summary'], ['rule72', 'approximation_derivation', 'card.summary']]) {
    const row = sample(id), before = JSON.stringify(row);
    assert.ok(issues(row).some(i => i.code === code && i.field === field), id);
    assert.equal(JSON.stringify(row), before);
  }
});

test('术语校验不误拦正确区别、明确否定和错误写法引用', () => {
  for (const text of ['灵敏度是真实阳性中的检出率，不等于总体准确率。',
    '不能说灵敏度就是准确率。', '检测准确率（灵敏度）的写法不准确。',
    '不要写检测准确率（灵敏度）。', '灵敏度为0.98，后验概率约4.7%。']) {
    const row = sample('sensitivity'); row.candidate.card.summary = text;
    assert.ok(!codes(row).includes('term_conflation'), text);
  }
});

test('术语错误覆盖答案、解释和要点，不把错误选项本身视作断言', () => {
  const row = sample('sensitivity'); row.candidate.card.summary = '后验概率不等于灵敏度。';
  row.candidate.exercise.answer = '灵敏度就是准确率。';
  row.candidate.exercise.answerExplanation = '灵敏度等同于检测准确率。';
  row.candidate.exercise.rubric = ['检测准确率（灵敏度）'];
  assert.deepEqual(issues(row).filter(i => i.code === 'term_conflation').map(i => i.field),
    ['exercise.answer', 'exercise.answerExplanation', 'exercise.rubric.0']);
  row.candidate.exercise = { type: 'choice', question: '哪项正确？', options: ['灵敏度就是准确率。', '两者不同'],
    answer: '两者不同', correctIndex: 1, answerExplanation: '前者在真实阳性群体内计算。', rubric: ['区分分母'], misconceptions: ['两者不同', ''] };
  assert.ok(!codes(row).includes('term_conflation'));
});

test('ISO校验保留亮度、固定ISO补偿与原文显式术语约定', () => {
  for (const text of ['画面亮度由光圈、快门和ISO共同影响。',
    '相同ISO下，f/4和1/125秒与f/2.8和1/250秒进光近似相等。',
    '不能认为曝光量由光圈、快门和ISO共同决定。']) {
    const row = sample('iso'); row.candidate.card.summary = text;
    assert.ok(!codes(row).includes('term_conflation'), text);
  }
  const row = sample('iso'); row.context.evidence.push({ id: 'definition', kind: 'text', text: '本文的曝光量指最终照片亮度。' });
  assert.ok(!codes(row).includes('term_conflation'));
});

test('72经验法则可以使用，不能把0.693直接换算成72', () => {
  for (const [text, bad] of [
    ['ln2≈0.693，换算成百分数即n≈72/(100r)。', true],
    ['ln2≈0.693，换算成百分数后得到72/(100r)。', true],
    ['ln2≈0.693，换算成百分数约为69.3，72是便于心算的经验调整。', false],
    ['72法则估计为72/8=9期，不等于精确值。', false],
    ['0.693不能直接换算成72。', false],
    ['不能认为0.693换算成百分数等于72。', false],
    ['0.693换算成72的说法是错误的。', false]
  ]) {
    const row = sample('sensitivity'); row.candidate.card.summary = text;
    assert.equal(codes(row).includes('approximation_derivation'), bad, text);
  }
});

test('原子性例子不扩大到隔离性；明确假设或给出隔离依据时不误拦', () => {
  const texts = ['两项修改全部生效，不能由此判断硬件是否同时写入。',
    '不能仅凭原子性判断其他事务是否看到修改。', '假设其他事务看到全部修改，能否证明硬件同时写入？'];
  for (const text of texts) {
    const row = sample('short-08'); row.candidate.card.example.text = text; row.candidate.exercise.question = text;
    assert.ok(!codes(row).includes('transaction_context'), text);
  }
  const row = sample('short-08');
  row.context.evidence.push({ id: 'isolation', kind: 'text', text: 'WAL模式下已开始读取的事务继续看到原有快照，即使其他连接提交修改。' });
  assert.ok(!codes(row).includes('transaction_context'));
});

test('图题允许位置回忆、翻译和纠错；无图的普通题不受影响', () => {
  const row = sample('image-01');
  row.candidate.exercise.question = '回忆图中两个有矩形堆叠的区域名称及它们的左右关系。';
  assert.ok(!codes(row).includes('image_answer_leak'));
  const translation = sample('image-01'); translation.context.userGoal = '能翻译三个英文标签';
  assert.ok(!codes(translation).includes('image_answer_leak'));
  const correction = sample('image-01'); correction.candidate.exercise.question += '这是否正确？请纠正错误映射。';
  assert.ok(!codes(correction).includes('image_answer_leak'));
  const text = sample('image-01'); text.context.evidence = [{ id: 'material', kind: 'text', text: '文字材料' }];
  assert.ok(!codes(text).includes('image_answer_leak'));
});

test('完整图示映射后只问一个区域仍泄露答案；排序题区分目标优先级与执行步骤', () => {
  const image = sample('image-01'); image.candidate.exercise.answer = '最右侧是Disk区域。';
  assert.ok(codes(image).includes('image_answer_leak'));
  image.candidate.exercise.question = '最右侧区域上方标签为“Disk”，该区域对应用户内存、系统缓冲区还是磁盘？';
  assert.ok(codes(image).includes('image_answer_leak'));
  image.candidate.exercise.question = '最右侧区域顶部标注为“Disk”。这个最右侧区域对应哪一类存储位置？';
  assert.ok(codes(image).includes('image_answer_leak'));
  image.candidate.exercise.question = '标有“Disk”的区域在图中哪个位置？';
  assert.ok(!codes(image).includes('image_answer_leak'));
  const row = sample('sensitivity');
  row.context.evidence = [{ id: 'sorting', kind: 'text', text: 'Python稳定排序先次要键后主要键，同键保留相对顺序。' }];
  for (const [question, leaked] of [
    ['需要先按次要键升序、再按主要键升序排列，应该按什么顺序执行排序？', true],
    ['目标是主要键升序，同主要键时次要键升序，应按什么顺序执行排序？', false],
    ['先按次要键再按主要键，请计算给定记录的最终结果。', false],
    ['有人先按次要键再按主要键，这是否正确？', false]
  ]) { row.candidate.exercise.question = question; assert.equal(codes(row).includes('exercise_answer_leak'), leaked, question); }
});

test('术语修复仅返回被定位字段，继续走原有盲解和审校流程', async () => {
  const row = sample('sensitivity'), original = JSON.stringify(row), operations = [];
  const api = quality.createQualityService({ task, getModelConfig: () => ({ model: 'fixture' }), transport: { complete: async (_, request) => {
    const p = requestPayload(request); operations.push(p.operation);
    let content;
    if (p.operation === 'generate') content = row.candidate;
    if (p.operation === 'repair') {
      assert.match(request.messages[0].content, /term_conflation|灵敏度/);
      content = { card: { summary: row.candidate.card.summary.replace('检测准确率（灵敏度）', '灵敏度') } };
    }
    if (p.operation === 'solve') content = { answerable: true, answer: row.candidate.exercise.answer, basis: 'Mock固定算法结果，仅测试流程。', optionJudgments: [] };
    if (p.operation === 'review') content = { findings: [], checks: checksFor(p.candidate) };
    return { content: JSON.stringify(content), provider: { model: 'fixture' }, finishReason: 'stop' };
  } } });
  const output = await api.run(row.context);
  assert.equal(output.status, 'ready', JSON.stringify(output.quality.issues));
  assert.deepEqual(operations, ['generate', 'repair', 'solve', 'review']);
  const { id, version, ...exerciseContent } = row.candidate.exercise;
  assert.deepEqual(output.exercise, exerciseContent);
  assert.deepEqual(output.card.example, row.candidate.card.example);
  assert.equal(JSON.stringify(row), original);
});
