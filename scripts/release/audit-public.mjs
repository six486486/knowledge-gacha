import { readFile, readdir, lstat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { unzipSync } from 'fflate';
import { isPrivatePath } from './public-files.mjs';

// Findings contain paths and categories, never matched credentials or contents.
export async function auditPublic(target, { privateConfig } = {}) {
  const files = new Map();
  const resolved = resolve(target);
  if (resolved.endsWith('.zip')) {
    const bytes = await readFile(resolved);
    const unpacked = unzipSync(bytes, { filter: entry => {
      if (entry.originalSize > 100 * 1024 * 1024) throw new Error('Archive entry exceeds release file limit');
      return true;
    } });
    for (const [name, data] of Object.entries(unpacked)) if (!name.endsWith('/')) files.set(name, Buffer.from(data));
  } else {
    async function walk(file) {
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Symlink in release');
      if (stat.isDirectory()) for (const name of await readdir(file)) {
        if (name === '.git') throw new Error('Git history must not be part of the audited export');
        await walk(join(file, name));
      }
      else files.set(relative(resolved, file).replaceAll('\\', '/'), await readFile(file));
    }
    await walk(resolved);
  }
  const secrets = [];
  if (privateConfig) {
    const config = JSON.parse(await readFile(privateConfig, 'utf8'));
    if (typeof config.apiKey !== 'string' || config.apiKey.length < 8) throw new Error('Private comparison configuration has no usable credential');
    secrets.push(Buffer.from(config.apiKey), Buffer.from(JSON.stringify(config.apiKey).slice(1, -1)), Buffer.from(Buffer.from(config.apiKey).toString('base64')));
  }
  const findings = [];
  const fixture = /^(?:e2e(?:-|$)|test(?:-|$)|fixture(?:-|$)|demo(?:-|$)|sk-test(?:-|$)|your[-_ ]|redacted|replace[-_ ])/i;
  const rules = [
    ['provider-token', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{64,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['personal-path', /\b[A-Za-z]:[\\/]+(?:Users|Work)[\\/]+[^\s"'<>]+/g]
  ];
  for (const [name, bytes] of files) {
    if (isPrivatePath(name)) findings.push({ file: name, kind: 'excluded-file' });
    if (bytes.length > 100 * 1024 * 1024) findings.push({ file: name, kind: 'oversized-file' });
    if (secrets.some(secret => bytes.includes(secret))) findings.push({ file: name, kind: 'known-private-credential' });
    if (bytes.includes(0) || bytes.length > 8 * 1024 * 1024) continue;
    const text = bytes.toString('utf8');
    if (text.includes(homedir()) || text.includes(homedir().replaceAll('\\', '/'))) findings.push({ file: name, kind: 'local-home-path' });
    for (const [kind, pattern] of rules) for (const match of text.matchAll(pattern)) {
      if (fixture.test(match[0])) continue;
      findings.push({ file: name, kind, line: text.slice(0, match.index).split('\n').length });
    }
    if (/\.json$/i.test(name)) {
      try {
        const check = value => {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (/^(apiKey|api_key|access_token|refresh_token|authorization|password)$/i.test(key) && typeof item === 'string' && item.length >= 8 && !fixture.test(item)) findings.push({ file: name, kind: 'credential-field' });
            check(item);
          }
        };
        check(JSON.parse(text));
      } catch { findings.push({ file: name, kind: 'invalid-json' }); }
    }
  }
  return { target: basename(resolved), files: files.size, knownCredentialChecked: Boolean(privateConfig), findings, passed: findings.length === 0 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: audit-public.mjs <directory-or-zip> [--private-config <local-file>]');
  const index = process.argv.indexOf('--private-config');
  const result = await auditPublic(target, { privateConfig: index < 0 ? undefined : process.argv[index + 1] });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
