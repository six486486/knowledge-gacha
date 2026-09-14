const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentHarness } = require('../src/harness/core/agent-harness.js');
const registry = require('../src/harness/skills/skill-registry.js');
const telemetry = require('../src/backend/infrastructure/observability/trace-service.js');
const domain = require('../src/frontend/domain/card-domain.js');

function fixture(responses) {
  let db = { runs: [], traces: {}, pendingRuns: {}, learningState: { cards: [] } }, sequence = 0, time = 1000;
  const requests = [];
  function harness() {
    return createAgentHarness({ readDb: () => structuredClone(db), writeDb: next => { db = structuredClone(next); },
      mutate: fn => { const next = structuredClone(db); fn(next); db = next; }, now: () => time,
      id: prefix => prefix + ++sequence, requestId: () => 'req', cardDomain: domain,
      telemetry: { ...telemetry, recordAudit() {} }, getModelConfig: () => ({}),
      transport: { complete: async (_, request) => {
        requests.push(structuredClone(request)); time += 20;
        const response = responses.shift(); if (typeof response === 'function') return response();
        if (response instanceof Error) throw response;
        return response;
      } }
    });
  }
  return { harness, requests, db: () => db, advance: ms => { time += ms; } };
}
const answer = { content: '完成', toolCalls: [], provider: { model: 'test', latencyMs: 4 } };
const write = { ...answer, content: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'create_card',
  arguments: JSON.stringify({ title: 'RAG', summary: '先检索再生成', analogy: '开卷答题' }) } }] };

test('run response, stored version and actual activated instructions agree; approval replay preserves the snapshot', async () => {
  const f = fixture([write, answer]), h = f.harness();
  const waiting = await h.runAgent({ userInput: '保存卡片' });
  assert.deepEqual(waiting.run.skill, { name: 'concept-card', version: registry.activate('concept-card').version });
  assert.equal(f.db().runs[0].skill.version, waiting.run.skill.version);
  assert.match(f.requests[0].messages[0].content, /Skill=concept-card/);
  // Simulate a persisted run from a different prompt version, then a page reload.
  const pending = f.db().pendingRuns[waiting.run.id];
  pending.skillVersion = '0.9.0'; pending.messages[0].content = 'captured 0.9.0 instructions';
  f.db().runs[0].skill.version = '0.9.0';
  f.advance(1000);
  const completed = await f.harness().continueAgent(waiting.run.id, { approvalId: waiting.approval.id, decision: 'approve' });
  assert.equal(completed.run.skill.version, '0.9.0');
  assert.equal(f.requests[1].messages[0].content, 'captured 0.9.0 instructions');
  assert.equal(f.db().runs[0].durationMs, 1040);
  assert.equal(f.db().runs[0].approvalCount, 1);
  assert.deepEqual(f.db().traces[waiting.run.id].map(event => event.eventType), ['approval_requested', 'run_completed']);
});
test('failed runs are visible without storing provider error contents; legacy rows retain their original version', async () => {
  const f = fixture([new Error('private provider token and response body')]);
  await assert.rejects(f.harness().runAgent({ userInput: '解释术语' }), /private provider/);
  assert.equal(f.db().runs[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.db()), /private provider/);
  const legacy = fixture([write, answer]), h = legacy.harness();
  const waiting = await h.runAgent({ userInput: '保存卡片' });
  delete legacy.db().pendingRuns[waiting.run.id].skillVersion;
  delete legacy.db().pendingRuns[waiting.run.id].messages;
  legacy.db().runs[0].skill.version = 'browser-v1';
  await h.continueAgent(waiting.run.id, { approvalId: waiting.approval.id, decision: 'reject' });
  assert.equal(legacy.db().runs[0].skill.version, 'browser-v1');
  assert.equal(legacy.db().runs[0].continuationSkill.version, registry.activate('concept-card').version);
  assert.ok(legacy.requests[1].messages[0].content.includes(registry.activate('concept-card').instructions));
});
test('a failed final model answer can be retried after reload without executing the approved write twice', async () => {
  const f = fixture([write, new Error('offline'), new Error('still offline'), answer]), h = f.harness();
  const waiting = await h.runAgent({ userInput: '保存卡片' });
  const decision = { approvalId: waiting.approval.id, decision: 'approve' };
  await assert.rejects(h.continueAgent(waiting.run.id, decision), /offline/);
  assert.equal(f.db().learningState.cards.length, 1);
  assert.equal(f.db().runs[0].status, 'failed');
  await assert.rejects(f.harness().continueAgent(waiting.run.id, decision), /still offline/);
  assert.equal(f.db().runs[0].retryCount, 1);
  await f.harness().continueAgent(waiting.run.id, decision);
  assert.equal(f.db().learningState.cards.length, 1);
  assert.equal(f.db().runs[0].status, 'completed');
  assert.equal(f.db().runs[0].retryCount, 2);
  assert.deepEqual(f.db().traces[waiting.run.id].map(event => event.status), ['waiting_approval', 'failed', 'failed', 'completed']);
  await assert.rejects(h.continueAgent(waiting.run.id, decision), /已经处理/);
});

test('IndexedDB atomically persists the approved effect and replay result across actual service recreation', async t => {
  const { IDBFactory } = require('fake-indexeddb');
  const { createMaterialRepository } = require('../src/backend/infrastructure/storage/material-repository.js');
  const { createExtensionService } = require('../src/backend/application/extension-service.js');
  const utils = require('../src/shared/runtime-utils.js');
  const indexedDB = new IDBFactory(), storage = utils.memoryStorage(), responses = [write, new Error('offline'), answer];
  const services = [];
  const create = () => {
    const repository = createMaterialRepository({ indexedDB, profileId: 'approval-replay' });
    const service = createExtensionService({ repository, storage, profileId: 'approval-replay', cardDomain: domain, providerModule: {}, embedding: false,
      providerTransport: { complete: async () => { const response = responses.shift(); if (response instanceof Error) throw response; return response; } },
      modelConfig: { model: 'test', apiKey: 'local-test-only' } });
    services.push({ service, repository }); return { service, repository };
  };
  t.after(async () => { for (const item of services) { item.service.dispose(); await item.repository.close(); } });
  const first = create(), waiting = await first.service.runAgent({ userInput: '保存卡片' });
  const decision = { approvalId: waiting.approval.id, decision: 'approve' };
  await assert.rejects(first.service.continueAgent(waiting.run.id, decision), /offline/);
  const persisted = await first.repository.get('state', 'current');
  assert.equal(persisted.learningState.cards.length, 1);
  assert.equal(persisted.pendingRuns[waiting.run.id].resolution.approved, true);
  assert.equal(persisted.pendingRuns[waiting.run.id].skillVersion, registry.activate('concept-card').version);
  const reopened = create();
  await reopened.service.continueAgent(waiting.run.id, decision);
  const result = await reopened.service.loadLearningState();
  assert.equal(result.state.cards.length, 1);
  assert.equal(Object.keys((await reopened.repository.get('state', 'current')).pendingRuns).length, 0);
});
test('concurrent continuation cannot duplicate writes while the first answer is pending', async () => {
  let release;
  const f = fixture([write, () => new Promise(resolve => { release = resolve; })]), h = f.harness();
  const waiting = await h.runAgent({ userInput: '保存卡片' });
  const decision = { approvalId: waiting.approval.id, decision: 'approve' };
  const first = h.continueAgent(waiting.run.id, decision);
  await assert.rejects(h.continueAgent(waiting.run.id, decision), /正在处理/);
  release(answer); await first;
  assert.equal(f.db().learningState.cards.length, 1);
});
test('dashboard applies time/source filters to all metrics before pagination and calculates real success rate and p95', () => {
  const db = { runs: [], traces: {} }, now = 10 * 86400000;
  for (let i = 1; i <= 20; i++) telemetry.recordRun(db, String(i), 'plain-explanation', i === 20 ? 'failed' : 'completed', now - 1000, i, 1, { errorCode: i === 20 ? 'failed_code' : null });
  telemetry.recordRun(db, 'old', 'plain-explanation', 'completed', now - 2 * 86400000, 99999, 1);
  telemetry.recordRun(db, 'other-source', 'plain-explanation', 'failed', now, 99999, 1); db.runs[0].source = 'imported-history';
  const dashboard = telemetry.observability(db, { window: '24h', source: 'extension_harness', limit: 1 }, 'req', now);
  assert.equal(dashboard.recentRuns.length, 1);
  assert.equal(dashboard.metrics.totalRuns, 20);
  assert.equal(dashboard.metrics.terminalRuns, 20);
  assert.equal(dashboard.metrics.successRate, 19 / 20);
  assert.equal(dashboard.metrics.p95DurationMs, 19);
  assert.deepEqual(dashboard.errorDistribution, [{ code: 'failed_code', count: 1, rate: 1 / 20 }]);
  assert.equal(telemetry.observability(db, { window: '7d', source: 'extension_harness' }, 'req', now).metrics.totalRuns, 21);
  const legacy = { ...db.runs[1], id: 'legacy', durationBasis: undefined, durationMs: 99999 };
  db.runs.push(legacy);
  assert.equal(telemetry.observability(db, { source: 'extension_harness' }, 'req', now).metrics.durationSampleCount, 20);
});

test('workflow generation records the task resource version, not the helper harness; old draft saves keep their original prompt version', () => {
  const db = { runs: [], traces: {} };
  telemetry.recordRun(db, 'draft', 'concept-card', 'completed', 1000, 100, 0, { source: 'extension_workflow', promptVersion: 'concept-card-v2.4.0+skill.0.8.0',
    durationBasis: 'generation_elapsed', occurredAt: 1100 });
  assert.equal(db.runs[0].skill.version, '0.8.0');
  assert.equal(db.runs[0].harnessVersion, null);
  assert.equal(db.runs[0].completedAt, 1100);
  assert.equal(db.traces.draft[0].skill.version, '0.8.0');
  telemetry.recordRun(db, 'saved', 'concept-card', 'completed', 2000, 0, 1, { source: 'extension_workflow',
    operation: 'save_card', promptVersion: db.runs[0].promptVersion, durationBasis: 'save_event', occurredAt: 2000 });
  assert.equal(db.runs[0].skill.version, '0.8.0');
  assert.equal(telemetry.observability(db, { window: 'all' }, 'req', 3000).metrics.durationSampleCount, 1);
});
