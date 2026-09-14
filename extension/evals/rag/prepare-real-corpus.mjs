import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// An old, immutable release is intentional: this is retrieval data, not a
// claim about the current FastAPI API. Redistributing these docs is MIT-licensed.
const revision = '40e33e492dbf4af6172997f4e3238a32e56cbe26';
const repository = 'https://github.com/fastapi/fastapi';
const files = {
  dev: ['tutorial/path-params.md', 'tutorial/query-params.md', 'tutorial/body.md', 'tutorial/response-model.md',
    'tutorial/header-params.md', 'tutorial/cookie-params.md', 'tutorial/response-status-code.md', 'tutorial/body-multiple-params.md'],
  test: ['tutorial/dependencies/sub-dependencies.md', 'tutorial/dependencies/dependencies-with-yield.md',
    'tutorial/background-tasks.md', 'tutorial/cors.md', 'tutorial/request-files.md', 'tutorial/handling-errors.md',
    'tutorial/middleware.md', 'tutorial/sql-databases.md', 'tutorial/security/oauth2-jwt.md',
    'advanced/custom-response.md', 'advanced/testing-dependencies.md', 'advanced/websockets.md']
};
const output = resolve(import.meta.dirname, 'real-sources');
mkdirSync(output, { recursive: true });
const manifest = { version: 'fastapi-zh-0.115.0-v1', repository, revision, license: 'MIT',
  sourceScope: '20 official Chinese documentation files; queries and answer spans are project-authored, not production user traffic.', documents: [] };
async function download(path) {
  const url = `https://raw.githubusercontent.com/fastapi/fastapi/${revision}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Source download failed: ${response.status} ${path}`);
  return { url, bytes: Buffer.from(await response.arrayBuffer()) };
}
const license = await download('LICENSE');
writeFileSync(resolve(output, 'LICENSE.fastapi.txt'), license.bytes);
for (const [split, paths] of Object.entries(files)) for (const path of paths) {
  const id = path.replace(/\.md$/, '').replaceAll('/', '-');
  const { url, bytes } = await download('docs/zh/docs/' + path);
  const localPath = 'documents/' + id + '.md';
  mkdirSync(dirname(resolve(output, localPath)), { recursive: true });
  writeFileSync(resolve(output, localPath), bytes);
  manifest.documents.push({ id, split, path: localPath, sourceUrl: url, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`Saved ${id} (${bytes.length} bytes)`);
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
