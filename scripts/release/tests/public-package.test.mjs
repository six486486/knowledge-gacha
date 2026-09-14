import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { zipSync } from 'fflate';
import { collectFiles, isPrivatePath } from '../public-files.mjs';
import { auditPublic } from '../audit-public.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'kg-public-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('public file selection excludes credentials and local state but retains runtime licenses and models', () => {
  for (const file of ['.git/config', '.tmp-browser-qa/provider.local.json', '.tmp-preview/profile', '.ENV.local', 'extension/test-results/report.json', 'extension/evals/demo/results/out.json', 'node_modules/pkg/index.js', 'key.pem', 'backup.zip']) assert.equal(isPrivatePath(file), true, file);
  for (const file of ['extension/screenshot.html', 'extension/vendor/embedding/LICENSE-bge.txt', 'extension/vendor/embedding/models/model.onnx', 'extension/tests/fixtures/regressions/case.json']) assert.equal(isPrivatePath(file), false, file);
});

test('curated directory export excludes nested private files without dropping public assets', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'extension', '.tmp-test'), { recursive: true });
  await writeFile(join(root, 'extension', 'screenshot.html'), '<!doctype html>');
  await writeFile(join(root, 'extension', 'LICENSE.txt'), 'Public license');
  await writeFile(join(root, 'extension', '.tmp-test', 'profile.json'), '{}');
  await writeFile(join(root, 'extension', 'provider.local.json'), '{}');
  assert.deepEqual(await collectFiles(root, ['extension']), ['extension/LICENSE.txt', 'extension/screenshot.html']);
  await assert.rejects(collectFiles(root, ['../outside']), /outside source root/);
});

test('private credential comparison checks plain, JSON-escaped and base64 bytes, including binary assets', async t => {
  const root = await temporary(t), source = join(root, 'source');
  await mkdir(source);
  const apiKey = 'e2e-' + randomBytes(24).toString('hex') + '"\\';
  const config = join(root, 'provider.local.json');
  await writeFile(config, JSON.stringify({ apiKey }));
  await writeFile(join(source, 'plain.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(apiKey)]));
  await writeFile(join(source, 'escaped.txt'), JSON.stringify(apiKey));
  await writeFile(join(source, 'encoded.txt'), Buffer.from(apiKey).toString('base64'));
  const result = await auditPublic(source, { privateConfig: config });
  assert.equal(result.passed, false);
  assert.deepEqual(result.findings.filter(f => f.kind === 'known-private-credential').map(f => f.file).sort(), ['encoded.txt', 'escaped.txt', 'plain.bin']);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('archive audit inspects packaged entries and permits the public extension identity key', async t => {
  const root = await temporary(t), archive = join(root, 'extension.zip');
  await writeFile(archive, zipSync({ 'manifest.json': Buffer.from(JSON.stringify({ manifest_version: 3, key: 'public-extension-identity' })), 'vendor/LICENSE.txt': Buffer.from('Public license') }));
  assert.equal((await auditPublic(archive)).passed, true);
  await writeFile(archive, zipSync({ 'provider.local.json': Buffer.from('{}') }));
  const result = await auditPublic(archive);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some(f => f.kind === 'excluded-file'));
});
