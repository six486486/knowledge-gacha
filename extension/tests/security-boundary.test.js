const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webRoot = path.resolve(__dirname, "..");

function readProductRuntimeSources() {
  const sourceRoots = [
    path.join(webRoot, "src", "harness"),
    path.join(webRoot, "src", "backend", "application"),
    path.join(webRoot, "src", "backend", "features"),
    path.join(webRoot, "src", "backend", "infrastructure")
  ];
  return sourceRoots.flatMap((sourceRoot) => fs.readdirSync(sourceRoot, { recursive: true })
    .filter((file) => String(file).endsWith(".js"))
    .map((file) => fs.readFileSync(path.join(sourceRoot, file), "utf8")))
    .join("\n");
}

test("manifest 不声明 localhost Harness，网页与 Provider 域名只按需授权", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(webRoot, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage", "activeTab", "scripting", "tabs"]);
  assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://*/*"]);
  assert.equal(JSON.stringify(manifest).includes(":8787"), false);
});

test("生产源码按前端、后端业务与基础设施、Harness 子系统分层", () => {
  const required = [
    "src/frontend/app.js",
    "src/frontend/settings/browser-storage.js",
    "src/backend/background.js",
    "src/backend/provider/provider-transport.js",
    "src/backend/application/extension-service.js",
    "src/backend/features/review/review-service.js",
    "src/backend/features/discovery/discovery-service.js",
    "src/backend/infrastructure/observability/trace-service.js",
    "src/backend/infrastructure/storage/extension-store.js",
    "src/harness/core/agent-harness.js",
    "src/harness/rag/rag-service.js",
    "src/harness/memory/memory-service.js",
    "src/harness/skills/skill-registry.js",
    "src/harness/mcp/mcp-audit-service.js",
    "src/harness/tools/tool-calling.js"
  ];
  for (const file of required) assert.equal(fs.existsSync(path.join(webRoot, file)), true, `缺少分层模块：${file}`);
  for (const directory of ["review", "discovery", "observability", "storage"]) {
    assert.equal(fs.existsSync(path.join(webRoot, "src", "harness", directory)), false, `业务或基础设施不应留在 Harness：${directory}`);
  }
  const featureRoot = path.join(webRoot, "src", "backend", "features");
  const featureSources = fs.readdirSync(featureRoot, { recursive: true })
    .filter((file) => String(file).endsWith(".js"))
    .map((file) => fs.readFileSync(path.join(featureRoot, file), "utf8"))
    .join("\n");
  const harnessCore = fs.readFileSync(path.join(webRoot, "src", "harness", "core", "agent-harness.js"), "utf8");
  const application = fs.readFileSync(path.join(webRoot, "src", "backend", "application", "extension-service.js"), "utf8");
  assert.doesNotMatch(featureSources, /require\([^)]*harness/i);
  assert.doesNotMatch(harnessCore, /backend[\\/]/i);
  assert.match(application, /harness\/core\/agent-harness/);
  assert.match(application, /features\/review\/review-service/);
  assert.match(application, /features\/discovery\/discovery-service/);
  assert.equal(fs.existsSync(path.join(webRoot, "app.js")), false);
  assert.equal(fs.existsSync(path.join(webRoot, "background.js")), false);
  const repoRoot = path.resolve(webRoot, "..");
  assert.equal(fs.existsSync(path.join(repoRoot, "apps")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "miniapp")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "legacy")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "tsconfig.base.json")), false);
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(rootPackage.workspaces, ["extension"]);
  assert.equal(Object.keys(rootPackage.scripts).some((name) => name.startsWith("legacy:")), false);
});

test("扩展包中的每个图标资源都有运行时引用", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
  const manifest = fs.readFileSync(path.join(webRoot, "manifest.json"), "utf8");
  const references = [app, html, manifest].join("\n");
  const assetsRoot = path.join(webRoot, "assets");
  const assets = fs.readdirSync(assetsRoot, { recursive: true })
    .filter((file) => /\.(svg|png)$/i.test(String(file)));
  for (const asset of assets) {
    const normalized = String(asset).replaceAll("\\", "/");
    const name = path.basename(normalized);
    const base = path.basename(name, path.extname(name));
    const referenced = references.includes(normalized)
      || references.includes(name)
      || references.includes(`icon("${base}")`);
    assert.equal(referenced, true, `存在未引用的扩展资源：assets/${normalized}`);
  }
});

test("网页捕获必须由用户操作触发且只申请当前网页 Origin", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const capture = fs.readFileSync(path.join(webRoot, "src", "frontend", "browser", "browser-capture.js"), "utf8");
  assert.match(app, /id="capture-selection"/);
  assert.match(app, /id="capture-page"/);
  assert.match(app, /id="capture-screenshot"/);
  assert.match(app, /captureSelection/);
  assert.match(app, /capturePage/);
  assert.match(app, /captureScreenshot/);
  assert.doesNotMatch(capture, /<all_urls>|host_permissions/);
  assert.match(capture, /permissions\.request\(\{ origins: \[pattern\] \}\)/);
  assert.match(capture, /parsed\.protocol \+ "\/\/" \+ parsed\.host \+ "\/\*"/);
  assert.doesNotMatch(capture, /permissions\.request\([^)]*https:\/\/\*\/\*/s);
});

test("浏览器收集用户模型配置并只经扩展后台直连 Provider", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const transport = fs.readFileSync(path.join(webRoot, "src", "backend", "provider", "provider-transport.js"), "utf8");
  const background = fs.readFileSync(path.join(webRoot, "src", "backend", "background.js"), "utf8");
  assert.match(app, /type=["']password["']/i);
  assert.match(app, /Base URL/);
  assert.match(app, /Model/);
  assert.doesNotMatch(app, /authorization/i);
  assert.doesNotMatch(app, /chat\/completions/i);
  assert.match(transport, /chat\/completions/i);
  assert.match(transport, /permissions\.request/);
  assert.match(transport, /authorization/);
  assert.match(background, /createBackgroundMessageHandler/);
  assert.doesNotMatch(transport, /127\.0\.0\.1:8787|本地 Agent Harness/);
});

test("本地预览服务只负责静态文件", () => {
  const source = fs.readFileSync(path.join(webRoot, "tooling", "dev-server.js"), "utf8");
  assert.doesNotMatch(source, /chat\/completions/i);
  assert.doesNotMatch(source, /authorization/i);
  assert.doesNotMatch(source, /LLM_API_KEY|CSTCLOUD_API_KEY/);
});

test("资料核验必须经固定产品端点，并同时呈现有来源与无来源状态", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const harness = readProductRuntimeSources();
  assert.match(harness, /checkGachaCardSources/);
  assert.match(harness, /resolveCitation/);
  assert.match(app, /agentApi\.checkGachaCardSources/);
  assert.match(app, /agentApi\.resolveCitation\(citation\)/);
  assert.match(app, /没有找到相关来源/);
  assert.match(app, /本次材料和相关来源的可定位片段/);
  assert.match(app, /合并补充/);
  assert.match(app, /仍然新建/);
  assert.match(app, /放弃这次/);
  assert.match(app, /excerpt\.highlight/);
  assert.match(app, /rel="noopener noreferrer"/);
  const productMarkup = app.match(/function sourceProductMarkup\(\)[\s\S]*?\n  function similarCardMarkup/)?.[0] || "";
  assert.ok(productMarkup);
  assert.doesNotMatch(productMarkup, /RAG|MCP|Embedding|Schema/);
});

test("学习记忆界面区分明确偏好、候选建议与学习证据", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const harness = readProductRuntimeSources();
  assert.match(app, /确认后的偏好只保存在当前本地学习档案中/);
  assert.match(app, /data-memory-tab/);
  assert.match(app, /confirmMemoryCandidate/);
  assert.match(app, /ignoreMemoryCandidate/);
  assert.match(app, /updatePreferenceMemory/);
  assert.match(app, /deletePreferenceMemory/);
  assert.match(app, /练习证据来自不可变复习事件/);
  assert.match(app, /createPreferenceMemory/);
  assert.match(app, /clearRecentLearningContext/);
  assert.doesNotMatch(harness, /createMemoryCandidate:/);
  assert.match(harness, /confirmMemoryCandidate/);
  assert.match(harness, /updatePreferenceMemory/);
  assert.match(harness, /planWeakPointReview/);
  assert.match(harness, /openGachaReview/);
  assert.match(app, /agentApi\.openGachaReview/);
  assert.match(app, /agentApi\.answerGachaReview/);
  assert.doesNotMatch(app, /reviewQueue|reviewResult/);
  assert.doesNotMatch(app, /chosenIndex === card\.correctIndex/);
});

test("MCP 审计界面只展示脱敏连接元数据", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const harness = readProductRuntimeSources();
  assert.match(harness, /listMcpAudit/);
  assert.match(app, /历史连接记录/);
  assert.match(app, /item\.connectionId/);
  assert.match(app, /item\.permissions/);
  assert.match(app, /不会保存参数正文、文档正文、API Key 或隐藏思考内容/);
  assert.doesNotMatch(app, /item\.input\b|item\.output\b/);
});

test("伴学进入主导航，设置保留配置而不承载学习对话", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const homeMarkup = app.match(/function renderHome\(\)[\s\S]*?\n  function reviewHomeEntry/)?.[0] || "";
  const moreMarkup = app.match(/function renderSettings\(\)[\s\S]*?\n  function moreEntry/)?.[0] || "";
  const assistantMarkup = fs.readFileSync(path.join(webRoot, "src", "frontend", "companion-ui.js"), "utf8");
  assert.ok(homeMarkup);
  assert.ok(moreMarkup);
  assert.ok(assistantMarkup);
  assert.match(homeMarkup, /投入知识/);
  assert.match(homeMarkup, /今日复习/);
  assert.match(moreMarkup, /我的模型/);
  assert.match(moreMarkup, /我的学习偏好/);
  assert.doesNotMatch(moreMarkup, /我的资料/);
  assert.doesNotMatch(moreMarkup, /open-agent|问助手/);
  assert.match(fs.readFileSync(path.join(webRoot, "index.html"), "utf8"), /data-view="agent">伴学/);
  assert.match(assistantMarkup, /学习对话/);
  assert.doesNotMatch(homeMarkup, /问 Agent|Skill|RAG|MCP/);
  assert.doesNotMatch(moreMarkup, /问 Agent|Skill|RAG|MCP/);
  assert.doesNotMatch(assistantMarkup, /agent-skill|已完成核对/);
});

test("运行观测只读取聚合与脱敏 trace，不渲染 run 原文或元数据", () => {
  const app = fs.readFileSync(path.join(webRoot, "src", "frontend", "app.js"), "utf8");
  const harness = readProductRuntimeSources();
  assert.match(harness, /getObservabilityDashboard/);
  assert.match(harness, /getAgentTrace/);
  assert.match(app, /Prompt、用户原文、参数、工具输出、文档正文/);
  assert.match(app, /state\.observabilityTraceItems/);
  assert.doesNotMatch(app, /observabilityRun\.(goal|userInput|metadata|input|output)/);
});
