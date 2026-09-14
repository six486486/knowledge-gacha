const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../src/backend/features/generation/card-quality.js');
const task = require('../src/harness/skills/skill-registry.js').loadTask('concept-card');
const { qualityOutput, requestPayload } = require('./fixtures/quality-output.js');
const context = { evidence: [{ id: 'material', kind: 'text', text: '边际成本是每多生产一个单位额外增加的成本。' }] };

test('示例枚举只归一化大小写和空白，未知类型与缺失来源分别报告且不猜测', () => {
  const original = qualityOutput(context);
  original.card.example.type = ' Contrast ';
  original.card.example.origin = ' Authored ';
  const parsed = quality.parse(JSON.stringify(original));
  assert.equal(parsed.card.example.type, 'contrast');
  assert.equal(parsed.card.example.origin, 'authored');
  assert.equal(parsed.card.example.text, original.card.example.text);
  assert.equal(original.card.example.origin, ' Authored ');
  assert.equal(quality.validate(parsed, context, task, false).passed, true);
  parsed.card.example.type = 'scenario';
  let issues = quality.validate(parsed, context, task, false).issues;
  assert.deepEqual(issues.map(item => item.code), ['example_type']);
  assert.equal(issues[0].field, 'card.example.type');
  delete parsed.card.example.origin;
  issues = quality.validate(parsed, context, task, false).issues;
  assert.deepEqual(issues.map(item => item.code), ['example_origin_missing', 'example_type']);
  assert.equal(parsed.card.example.origin, undefined);
});

test('示例字段由一次定向修复补齐，保留正文和引用并重新完成核验', async () => {
  for (const [field, origin] of [['type', 'authored'], ['origin', 'authored'], ['type', 'source']]) {
    const output = qualityOutput(context);
    if (origin === 'source') {
      output.card.example = { type: 'example', origin, text: context.evidence[0].text };
      output.evidence.push({ claim: 'example', evidenceId: 'material', quote: context.evidence[0].text });
    }
    const before = structuredClone(output.card.example);
    delete output.card.example[field];
    const operations = [];
    const service = quality.createQualityService({ task, getModelConfig: () => ({ model: 'fixture' }),
      transport: { complete: async (_config, request) => {
        const payload = requestPayload(request);
        operations.push(payload.operation);
        let reply = payload.operation === 'generate' ? output : qualityOutput(payload);
        if (payload.operation === 'repair') {
          assert.equal(payload.issues[0].code, field === 'type' ? 'example_type' : 'example_origin_missing');
          const prompt = request.messages[0].content;
          assert.ok(prompt.includes('example_type只修正type'));
          assert.ok(!prompt.includes('authored | source'));
          reply = { card: { example: { [field]: before[field] } } };
        }
        return { content: JSON.stringify(reply), finishReason: 'stop', provider: { model: 'fixture', latencyMs: 1 } };
      } } });
    const result = await service.run(context);
    assert.equal(result.status, 'ready', JSON.stringify(result.quality));
    assert.deepEqual(result.card.example, before);
    assert.deepEqual(result.evidence, JSON.parse(JSON.stringify(output.evidence)));
    assert.deepEqual(operations, ['generate', 'repair', 'solve', 'review']);
  }
});

test('修复仍缺来源时保留失败草稿，不猜来源也不循环请求', async () => {
  const output = qualityOutput(context);
  delete output.card.example.origin;
  const operations = [];
  const service = quality.createQualityService({ task, getModelConfig: () => ({ model: 'fixture' }),
    transport: { complete: async (_config, request) => {
      operations.push(requestPayload(request).operation);
      return { content: JSON.stringify(output), finishReason: 'stop', provider: { model: 'fixture', latencyMs: 1 } };
    } } });
  const result = await service.run(context);
  assert.equal(result.status, 'needs_revision');
  assert.ok(result.quality.issues.some(issue => issue.code === 'example_origin_missing'));
  assert.deepEqual(operations, ['generate', 'repair']);
  assert.equal(result.card.example.origin, undefined);
});

test('模型提纲中的例子不能冒充原文示例，真实材料中的同一例子仍可引用', () => {
  const output = qualityOutput(context);
  const quote = '0.1 + 0.1 + 0.1 == 0.3 为 False。';
  output.card.example = { type: 'example', origin: 'source', text: quote };
  output.evidence.push({ claim: 'example', evidenceId: 'example_source', quote });
  const source = { id: 'example_source', kind: 'text', text: quote, origin: 'discovery_outline' };
  const material = { evidence: [...context.evidence, source] };
  assert.ok(quality.validate(output, material, task, false).issues.some(issue => issue.code === 'example_origin'));
  source.origin = 'saved_source';
  assert.ok(!quality.validate(output, material, task, false).issues.some(issue => issue.code === 'example_origin'));
  source.origin = 'discovery_outline';
  output.card.example.origin = 'authored';
  assert.ok(!quality.validate(output, material, task, false).issues.some(issue => issue.code === 'example_origin'));
});
