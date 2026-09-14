import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const skillRoot = resolve(import.meta.dirname, "../src/harness/skills");

// Repository-authored YAML subset: scalar fields and an inline JSON metadata map.
// This is a build-time packager, not an installer/parser for arbitrary third-party skills.
export function parseSkill(source, directory) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`${directory}: SKILL.md needs YAML frontmatter and instructions`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-z-]+): (.*)$/.exec(line);
    if (!field || !["name", "description", "compatibility", "license", "metadata", "allowed-tools"].includes(field[1]) || Object.hasOwn(fields, field[1])) {
      throw new Error(`${directory}: unsupported or duplicate frontmatter field`);
    }
    fields[field[1]] = field[1] === "metadata" ? JSON.parse(field[2]) : field[2].trim();
  }
  if (fields.name !== directory || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name) || fields.name.length > 64) throw new Error(`${directory}: invalid skill name`);
  if (!fields.description || fields.description.length > 1024) throw new Error(`${directory}: invalid description`);
  if ((fields.compatibility || "").length > 500) throw new Error(`${directory}: invalid compatibility`);
  if (!fields.metadata || Array.isArray(fields.metadata) || typeof fields.metadata !== "object" || Object.values(fields.metadata).some(value => typeof value !== "string")) throw new Error(`${directory}: metadata must map strings to strings`);
  if (!fields.metadata.version || !["task", "workflow", "assistant-prototype"].includes(fields.metadata.mode)) throw new Error(`${directory}: missing host version or mode`);
  const instructions = match[2].trim();
  if (!instructions || instructions.split("\n").length > 500) throw new Error(`${directory}: invalid instruction body`);
  return { ...fields, instructions };
}

export function buildCatalog() {
  return readdirSync(resolve(skillRoot, "definitions"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const directory = resolve(skillRoot, "definitions", entry.name);
    const skill = parseSkill(readFileSync(resolve(directory, "SKILL.md"), "utf8"), entry.name);
    for (const link of skill.instructions.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(link[1])) continue;
      const target = resolve(directory, link[1].split("#")[0]);
      const local = relative(directory, target);
      if (local.startsWith("..") || isAbsolute(local) || !existsSync(target)) throw new Error(`${entry.name}: missing or nonlocal resource ${link[1]}`);
    }
    return skill;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function renderCatalog(catalog) {
  return `// Generated from definitions/*/SKILL.md by tooling/build-skills.mjs. Do not edit.\n(function (root) {\n  const catalog = ${JSON.stringify(catalog, null, 2)};\n  catalog.forEach(function (entry) { Object.freeze(entry.metadata); Object.freeze(entry); });\n  Object.freeze(catalog);\n  if (typeof module === "object" && module.exports) module.exports = catalog;\n  else root.KnowledgeGachaSkillCatalog = catalog;\n})(typeof globalThis !== "undefined" ? globalThis : this);\n`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const catalog = buildCatalog();
  const output = resolve(skillRoot, "skill-catalog.generated.js");
  const rendered = renderCatalog(catalog);
  if (process.argv.includes("--check")) {
    if (!existsSync(output) || readFileSync(output, "utf8") !== rendered) throw new Error("Skill bundle is stale. Run npm run build:skills.");
  } else writeFileSync(output, rendered);
  console.log(`Skills: ${catalog.length} entrypoints validated; browser bundle ${process.argv.includes("--check") ? "current" : "generated"}.`);
}
