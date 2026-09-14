import { readdir, lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export const privateSegments = new Set(['.git', '.superdesign', '.tmp-browser-qa', '.tmp-public-release', '.release-staging', 'node_modules', 'test-results', 'playwright-report', 'results', 'dist', '.cache']);
export function isPrivatePath(name) {
  const parts = name.replaceAll('\\', '/').split('/');
  return parts.some(part => privateSegments.has(part.toLowerCase()) || /^\.tmp(?:[-_.]|$)/i.test(part)) || /(?:^|\/)\.env(?:\.|$)|\.local\.(?:json|ya?ml)$|\.(?:log|pem|pfx|p12|key|crx|map|sqlite|db|zip)$/i.test(name);
}
export async function collectFiles(root, entries) {
  const files = [];
  async function visit(file) {
    const name = relative(root, file).replaceAll('\\', '/');
    if (isPrivatePath(name)) return;
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links cannot be published: ' + name);
    if (stat.isDirectory()) for (const item of (await readdir(file)).sort()) await visit(join(file, item));
    else if (stat.isFile()) files.push(name);
  }
  for (const entry of entries) {
    const file = resolve(root, entry);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('Path outside source root');
    await visit(file);
  }
  return [...new Set(files)].sort();
}
