import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const requiredDocuments = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/public/architecture.md",
  "docs/public/development.md",
  "docs/public/privacy.md"
];
const errors = [];
const skills = createRequire(import.meta.url)("../extension/src/harness/skills/skill-registry.js");
// Current architecture documents describe live versions. Historical evaluation
// reports deliberately keep the version that produced their recorded results.
for (const document of ["docs/architecture.md", "docs/agent-architecture.md"]) {
  if (!existsSync(join(root, document))) continue;
  const content = readFileSync(join(root, document), "utf8");
  for (const task of ["concept-card", "knowledge-plan"]) {
    const version = skills.loadTask(task).version;
    for (const match of content.matchAll(new RegExp(task + "-v[0-9.]+\\+skill\\.[0-9.]+", "g"))) {
      if (match[0] !== version) errors.push(`任务版本已过期：${document} 的 ${match[0]}，运行时为 ${version}`);
    }
  }
}

for (const document of requiredDocuments) {
  if (!existsSync(join(root, document))) errors.push(`缺少必需文档：${document}`);
}

const markdownFiles = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"].map(file => join(root, file)).concat(walkMarkdown(join(root, "docs")));
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
for (const file of markdownFiles) {
  const content = readFileSync(file, "utf8");
  const targets = [...content.matchAll(linkPattern)].map(match => match[1]).concat([...content.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]));
  for (const raw of targets) {
    const target = raw.trim().replace(/^<|>$/g, "");
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const pathOnly = decodeURIComponent(target.split("#", 1)[0]);
    if (!pathOnly) continue;
    const absolute = resolve(dirname(file), pathOnly);
    if (!existsSync(absolute)) errors.push(`失效链接：${relative(root, file)} -> ${target}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`文档校验通过：${markdownFiles.length} 份文档。`);
}

function walkMarkdown(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walkMarkdown(path));
    else if (extname(path).toLowerCase() === ".md") files.push(path);
  }
  return files;
}
