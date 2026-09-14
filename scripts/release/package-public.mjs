import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { collectFiles } from './public-files.mjs';
import { auditPublic } from './audit-public.mjs';
import { validateExtensionPackage } from './extension-browser-smoke.mjs';

const root = resolve(import.meta.dirname, '../..');
const index = process.argv.indexOf('--out');
if (index < 0 || !process.argv[index + 1]) throw new Error('Provide --out with a new output directory');
const output = resolve(process.argv[index + 1]);
const source = join(output, 'source'), runtime = join(output, 'extension');
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const sourceFiles = await collectFiles(root, [
  'README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes',
  'package.json', 'package-lock.json', 'extension', 'scripts', 'docs/public', 'docs/assets'
]);
for (const name of sourceFiles) {
  const destination = join(source, name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, name), destination);
}
const runtimeFiles = await collectFiles(join(root, 'extension'), ['manifest.json', 'index.html', 'screenshot.html', 'src', 'assets', 'vendor']);
for (const name of runtimeFiles) {
  const destination = join(runtime, name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, 'extension', name), destination);
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, name), join(runtime, name));
const packageCheck = validateExtensionPackage(runtime);
if (!packageCheck.passed) throw new Error('Incomplete extension package: ' + packageCheck.errors.join('; '));
const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'));
if (manifest.version !== JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version) throw new Error('Release versions differ');
const records = [];
const zipped = {};
for (const name of [...runtimeFiles, 'LICENSE', 'THIRD_PARTY_NOTICES.md'].sort()) {
  const bytes = await readFile(join(runtime, name));
  zipped[name] = [bytes, { mtime: new Date('2026-01-01T00:00:00Z') }];
  records.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const archive = `knowledge-gacha-${manifest.version}-extension.zip`;
await writeFile(join(output, archive), zipSync(zipped, { level: 6 }));
const audits = [await auditPublic(source), await auditPublic(join(output, archive))];
await writeFile(join(output, 'package-manifest.json'), JSON.stringify({ version: manifest.version, sourceFiles: sourceFiles.length, runtimeFiles: records, audits }, null, 2) + '\n');
if (audits.some(audit => !audit.passed)) {
  console.log(JSON.stringify(audits, null, 2));
  throw new Error('Public package audit failed; nothing has been uploaded');
}
console.log(JSON.stringify({ output, version: manifest.version, sourceFiles: sourceFiles.length, runtimeFiles: records.length, archive, audits }, null, 2));
