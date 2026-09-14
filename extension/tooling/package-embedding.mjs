import { createRequire } from 'node:module';
import { mkdir, cp, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'vendor/embedding');
const transformerRoot = resolve(dirname(require.resolve('@huggingface/transformers')), '..');
const ortRoot = resolve(dirname(require.resolve('onnxruntime-web')), '..');
const revision = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
const model = 'bge-small-zh-v1.5';
const modelRoot = resolve(target, 'models', model);
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
await mkdir(target, { recursive: true });
// Keep vendored JavaScript readable for source review; the release ZIP compresses it.
await build({ entryPoints: [resolve(transformerRoot, 'dist/transformers.web.min.js')], outfile: resolve(target, 'transformers.web.js'),
  bundle: true, format: 'esm', platform: 'browser', minify: false });
await cp(resolve(transformerRoot, 'LICENSE'), resolve(target, 'LICENSE-transformers.txt'));
const ortCommit = (await readFile(resolve(ortRoot, '__commit.txt'), 'utf8')).trim();
for (const [name, url] of [
  ['LICENSE-onnxruntime.txt', `https://raw.githubusercontent.com/microsoft/onnxruntime/${ortCommit}/LICENSE`],
  ['LICENSE-bge.txt', 'https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/LICENSE']
]) {
  try { await access(resolve(target, name)); }
  catch {
    if (!process.argv.includes('--download')) throw new Error('Missing embedding license: ' + name);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Could not prepare license: ' + name);
    await writeFile(resolve(target, name), await response.text());
  }
}
for (const name of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  await cp(resolve(ortRoot, 'dist', name), resolve(target, name));
}
for (const name of files) {
  const destination = resolve(modelRoot, name);
  try { await access(destination); }
  catch {
    if (!process.argv.includes('--download')) throw new Error('Missing local embedding assets. Run npm run package:embedding -- --download.');
    const url = `https://huggingface.co/Xenova/${model}/resolve/${revision}/${name}`;
    const result = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!result.ok) throw new Error(`Model download failed (${result.status}): ${name}`);
    const bytes = Buffer.from(await result.arrayBuffer());
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    console.log(`Prepared ${name}: ${bytes.length} bytes`);
  }
}
const digest = createHash('sha256').update(await readFile(resolve(modelRoot, 'onnx/model_quantized.onnx'))).digest('hex');
if (digest !== '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc') throw new Error('Pinned embedding model checksum mismatch');
const versions = { model: 'Xenova/' + model, upstream: 'BAAI/' + model, revision, sha256: digest, license: 'MIT',
  transformers: JSON.parse(await readFile(resolve(transformerRoot, 'package.json'), 'utf8')).version,
  onnxruntime: JSON.parse(await readFile(resolve(ortRoot, 'package.json'), 'utf8')).version,
  dimensions: 512, dtype: 'q8', pooling: 'cls', maxLength: 512 };
await writeFile(resolve(target, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('Packaged local Chinese embedding runtime and pinned quantized model.');
