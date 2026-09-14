import { readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const extensionRoot = resolve(import.meta.dirname, "..");
const scanRoots = [join(extensionRoot, "src"), join(extensionRoot, "tooling"), join(extensionRoot, "e2e"), join(extensionRoot, "evals")];
const files = scanRoots.flatMap(collectJavaScriptFiles).sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `语法检查失败：${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log(`扩展源码语法检查通过：${files.length} 个 JavaScript 模块。`);

function collectJavaScriptFiles(root) {
  if (!statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(path);
    return [".js", ".mjs"].includes(extname(entry.name)) ? [path] : [];
  });
}
