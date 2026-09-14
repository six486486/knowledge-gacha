import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// A suite run can retain all screenshots under its own report directory.
export function artifactPath(relative: string) {
  const path = resolve(process.env.KG_TEST_REPORT_DIR || process.cwd(), relative);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
