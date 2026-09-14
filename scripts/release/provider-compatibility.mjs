import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { executeProviderRequest } = require("../../extension/src/backend/provider/provider-transport.js");

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TOOL_TOKEN = "provider-tool-ok";

export async function checkProvider(config, options = {}) {
  const normalized = normalizeProviderConfig(config);
  const complete = (request) => executeProviderRequest({ config: normalized, request }, options.fetchImpl || fetch, normalized.timeoutMs);
  const startedAt = Date.now();
  const checks = [];
  checks.push(await executeCheck("text", async () => {
    const result = await complete({
      messages: [{ role: "user", content: "只回复 PROVIDER_TEXT_OK" }],
      max_tokens: 32,
      temperature: 0.2
    });
    if (!result.content) throw new Error("文本响应为空");
    return result;
  }));
  checks.push(await executeCheck("image", async () => {
    const result = await complete({
      messages: [{ role: "user", content: [
        { type: "text", text: "这是一张 1x1 PNG。只回复 PROVIDER_IMAGE_OK" },
        { type: "image_url", image_url: { url: IMAGE_DATA_URL } }
      ] }],
      max_tokens: 32,
      temperature: 0.2
    });
    if (!result.content) throw new Error("图片响应为空");
    return result;
  }));
  checks.push(await executeCheck("tool_calling", async () => {
    const result = await complete({
      messages: [{ role: "user", content: `必须调用 release_probe，并把 token 设为 ${TOOL_TOKEN}。不要直接回答。` }],
      max_tokens: 64,
      temperature: 0.2,
      tools: [{ type: "function", function: {
        name: "release_probe", description: "发布兼容性探针", parameters: {
          type: "object",
          additionalProperties: false,
          properties: { token: { type: "string", const: TOOL_TOKEN } },
          required: ["token"]
        }
      } }]
    });
    const call = result.toolCalls?.find((item) => item.function?.name === "release_probe");
    const args = call ? JSON.parse(call.function.arguments || "{}") : {};
    if (!call || args.token !== TOOL_TOKEN) throw new Error("模型没有返回要求的原生工具调用");
    return result;
  }));
  return {
    name: normalized.name,
    baseUrlHost: new URL(normalized.baseUrl).host,
    model: normalized.model,
    checks,
    durationMs: Date.now() - startedAt,
    passed: checks.every((item) => item.passed)
  };
}

export async function runProviderCompatibility(configs, options = {}) {
  const providers = [];
  for (const config of configs) providers.push(await checkProvider(config, options));
  return {
    executedAt: new Date().toISOString(),
    requiredProviders: 2,
    providers,
    passed: providers.length >= 2 && providers.every((item) => item.passed)
  };
}

export function loadProviderConfigs(env = process.env) {
  const raw = String(env.KG_RELEASE_PROVIDERS_JSON || "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("KG_RELEASE_PROVIDERS_JSON 不是有效 JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("KG_RELEASE_PROVIDERS_JSON 必须是数组");
  return parsed.map(normalizeProviderConfig);
}

export function formatProviderCompatibilityReport(result) {
  return [
    "# Provider 兼容性验收",
    "",
    `> 执行时间：${result.executedAt}  `,
    `> 结论：**${result.passed ? "通过" : "未通过"}真实 Provider 门槛**`,
    "",
    "| Provider | Host | Model | 文本 | 图片 | 原生工具调用 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.providers.map((provider) => {
      const status = (kind) => provider.checks.find((item) => item.kind === kind)?.passed ? "通过" : "失败";
      return `| ${provider.name} | ${provider.baseUrlHost} | ${provider.model} | ${status("text")} | ${status("image")} | ${status("tool_calling")} |`;
    }),
    "",
    ...(result.providers.length < result.requiredProviders
      ? [`- 需要至少 ${result.requiredProviders} 个真实 Provider；当前只执行 ${result.providers.length} 个。`]
      : result.providers.flatMap((provider) => provider.checks.filter((item) => !item.passed).map((item) => `- ${provider.name}/${item.kind}: ${item.error}`))),
    "",
    "报告不包含 Base URL 完整路径、API Key、请求正文或模型响应正文。",
    ""
  ].join("\n");
}

function normalizeProviderConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider 配置必须是对象");
  const name = String(value.name || "").trim();
  const baseUrl = String(value.baseUrl || "").trim();
  const apiKey = String(value.apiKey || "").trim();
  const model = String(value.model || "").trim();
  const timeoutMs = Number(value.timeoutMs || 45_000);
  if (!name || !baseUrl || !apiKey || !model) throw new Error("Provider 必须包含 name、baseUrl、apiKey 和 model");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) throw new Error(`${name} 的 timeoutMs 必须在 5000–60000 之间`);
  return { name, baseUrl, apiKey, model, timeoutMs };
}

async function executeCheck(kind, run) {
  const startedAt = Date.now();
  try {
    const result = await run();
    return {
      kind,
      passed: true,
      latencyMs: result.provider?.latencyMs,
      durationMs: Date.now() - startedAt,
      usageReported: Boolean(result.provider?.usage)
    };
  } catch (error) {
    return {
      kind,
      passed: false,
      latencyMs: null,
      durationMs: Date.now() - startedAt,
      usageReported: false,
      error: safeError(error)
    };
  }
}

function safeError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "PROVIDER_CHECK_FAILED";
  return `${code}: ${error instanceof Error ? error.message.slice(0, 240) : "未知错误"}`;
}

async function main() {
  const allowMissing = process.argv.includes("--allow-missing");
  const json = process.argv.includes("--json");
  const configs = loadProviderConfigs();
  if (!configs.length) {
    const message = allowMissing
      ? "未执行：缺少 KG_RELEASE_PROVIDERS_JSON；不代表任何具体 Provider 已认证，Edge-only Harness 工程门禁继续。"
      : "未执行：缺少 KG_RELEASE_PROVIDERS_JSON。真实 Provider 认证不能由模拟结果替代。";
    process.stdout.write(`${json ? JSON.stringify({ passed: false, skipped: true, reason: message }) : `${message}\n`}`);
    if (!allowMissing) process.exitCode = 2;
    return;
  }
  const result = await runProviderCompatibility(configs);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatProviderCompatibilityReport(result));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
