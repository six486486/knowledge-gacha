import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProviderCompatibilityReport,
  loadProviderConfigs,
  runProviderCompatibility
} from "../provider-compatibility.mjs";

test("两个 OpenAI-compatible Provider 形态都通过文本、图片和原生工具调用", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url: String(url), body, authorization: init.headers.authorization });
    const tool = Array.isArray(body.tools);
    const image = body.messages.some((message) => Array.isArray(message.content));
    const modernUsage = String(url).includes("provider-b");
    return new Response(JSON.stringify({
      choices: [{ message: tool ? {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_release_probe", type: "function", function: { name: "release_probe", arguments: JSON.stringify({ token: "provider-tool-ok" }) } }]
      } : { role: "assistant", content: image ? "PROVIDER_IMAGE_OK" : "PROVIDER_TEXT_OK" } }],
      usage: modernUsage
        ? { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
        : { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runProviderCompatibility([
    { name: "provider-a", baseUrl: "https://provider-a.example/v1", apiKey: "secret-a", model: "deepseek-v4-flash-vision-exp" },
    { name: "provider-b", baseUrl: "https://provider-b.example/v1", apiKey: "secret-b", model: "qwen3.5" }
  ], { fetchImpl });
  assert.equal(result.passed, true);
  assert.equal(result.providers.length, 2);
  assert.ok(result.providers.every(provider => provider.checks.every(check => check.usageReported === true)));
  assert.equal(requests.length, 6);
  assert.ok(requests.filter(request => request.body.model.startsWith("deepseek")).every(request => request.body.thinking.type === "disabled"));
  assert.ok(requests.filter(request => request.body.model === "qwen3.5").every(request => request.body.enable_thinking === false && request.body.chat_template_kwargs.enable_thinking === false));
  assert.equal(requests.every((request) => request.body.parallel_tool_calls === false || request.body.parallel_tool_calls === undefined), true);
  assert.equal(requests.some((request) => JSON.stringify(request.body).includes("image_url")), true);
  assert.equal(JSON.stringify(result).includes("secret-a"), false);
  assert.equal(JSON.stringify(result).includes("secret-b"), false);
});

test("缺少第二个 Provider 或原生工具调用时发布门槛失败", async () => {
  const result = await runProviderCompatibility([
    { name: "text-only", baseUrl: "https://text-only.example/v1", apiKey: "secret", model: "gpt-4o-mini" }
  ], { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "直接回答" } }] }), { status: 200 }) });
  assert.equal(result.passed, false);
  assert.equal(result.providers[0].checks.find((item) => item.kind === "tool_calling").passed, false);
  assert.match(formatProviderCompatibilityReport(result), /需要至少 2 个真实 Provider/);
});

test("Provider 配置只从显式环境 JSON 读取并要求完整字段", () => {
  assert.deepEqual(loadProviderConfigs({}), []);
  assert.throws(() => loadProviderConfigs({ KG_RELEASE_PROVIDERS_JSON: "{}" }), /必须是数组/);
  assert.throws(() => loadProviderConfigs({ KG_RELEASE_PROVIDERS_JSON: '[{"name":"x"}]' }), /必须包含/);
  const loaded = loadProviderConfigs({ KG_RELEASE_PROVIDERS_JSON: '[{"name":"A","baseUrl":"https://a.example/v1","apiKey":"k","model":"m"}]' });
  assert.equal(loaded[0].name, "A");
});

