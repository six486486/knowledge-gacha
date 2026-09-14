const test = require("node:test");
const assert = require("node:assert/strict");

const provider = require("../src/backend/provider/provider-transport.js");

test("超时覆盖已返回响应头但一直未完成的正文", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const pending = provider.executeProviderRequest({ config: { baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "gpt-4o-mini" }, request: {} },
    async (_url, init) => {
      signal = init.signal;
      return { ok: true, text: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }) };
    }, 5000);
  await Promise.resolve();
  const assertion = assert.rejects(pending, error => error.code === "MODEL_TIMEOUT");
  t.mock.timers.tick(5000);
  await assertion;
  assert.equal(signal.aborted, true);
});

test("非思考响应保留缓存和零思考用量，空 usage 仍标为未知", async function () {
  for (const usage of [{ prompt_tokens: 100, completion_tokens: 70, total_tokens: 170, completion_tokens_details: { reasoning_tokens: 0 }, prompt_cache_hit_tokens: 80 }, {}]) {
    const result = await provider.executeProviderRequest({ config: { baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "gpt-4o-mini" }, request: {} },
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok", reasoning_content: "" }, finish_reason: "stop" }], usage })), 5000);
    if (usage.total_tokens) assert.deepEqual(result.provider.usage, { inputTokens: 100, outputTokens: 70, totalTokens: 170, reasoningTokens: 0, cachedInputTokens: 80 });
    else assert.equal(result.provider.usage, undefined);
    assert.ok(!JSON.stringify(result).includes("private-reasoning"));
  }
});

test("全部请求按模型协议强制关闭思考，覆盖开启参数及嵌套覆盖项，保留任务正文和工具", async function () {
  const cases = [
    ["deepseek-v4-flash-vision-exp", "https://fixture.invalid/v1", { thinking: { type: "disabled" } }],
    ["qwen3.5", "https://uni-api.cstcloud.cn/v1", { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } }],
    ["Qwen/Qwen3.5-9B", "http://127.0.0.1:8000/v1", { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } }],
    ["qwen3.5-plus", "https://dashscope.aliyuncs.com/compatible-mode/v1", { enable_thinking: false }],
    ["glm-4.7", "https://open.bigmodel.cn/api/paas/v4", { thinking: { type: "disabled" } }],
    ["kimi-k2.5", "https://api.moonshot.ai/v1", { thinking: { type: "disabled" } }],
    ["kimi-k2.5", "http://127.0.0.1:8000/v1", { thinking: { type: "disabled" }, chat_template_kwargs: { thinking: false } }],
    ["gpt-5.1", "https://api.openai.com/v1", { reasoning_effort: "none" }],
    ["gpt-5.2-2025-12-11", "https://fixture.invalid/v1", { reasoning_effort: "none" }],
    ["gpt-4o-mini", "https://fixture.invalid/v1", {}]
  ];
  const original = { messages: [{ role: "user", content: [{ type: "text", text: "test" }, { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] }],
    tools: [{ type: "function", function: { name: "fixture" } }], temperature: 0.3, max_tokens: 120,
    thinking: { type: "enabled", budget_tokens: 9000 }, enable_thinking: true, reasoning_effort: "high", reasoning: { enabled: true },
    think: true, thinking_budget: 9000, chat_template_kwargs: { enable_thinking: true }, extra_body: { thinking: { type: "enabled" } } };
  for (const [model, baseUrl, flags] of cases) {
    let sent;
    await provider.executeProviderRequest({ config: { model, baseUrl, apiKey: "fixture" }, request: original }, async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    assert.deepEqual(sent, { messages: original.messages, tools: original.tools, temperature: 0.3, max_tokens: 120, ...flags, model });
    assert.deepEqual(provider.enforceNonThinking({ model, baseUrl }, sent), sent);
  }
  assert.equal(original.thinking.type, "enabled");
  assert.equal(original.extra_body.thinking.type, "enabled");
});

test("无法关闭思考的型号和未知别名在授权或网络之前被阻止，不能用 minimal 冒充关闭", async function () {
  let permissions = 0, requests = 0;
  const transport = provider.createProviderTransport({ chromeApi: { permissions: { contains() { permissions += 1; } } },
    fetchImpl: async () => { requests += 1; throw Error("must not send"); } });
  for (const model of ["deepseek-reasoner", "deepseek-ai/DeepSeek-R1", "Qwen/QwQ-32B", "qwen3-235b-a22b-thinking-2507", "glm-5.3", "gpt-5", "gpt-5-mini", "gpt-5.2-pro", "o3", "custom-deployment"]) {
    const config = { baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model };
    const request = { reasoning_effort: "minimal", thinking: { type: "disabled" } };
    const rejected = error => error.code === "MODEL_NON_THINKING_UNSUPPORTED" && error.sent === false;
    await assert.rejects(transport.complete(config, request), rejected);
    await assert.rejects(provider.executeProviderRequest({ config, request }, async () => { requests += 1; }), rejected);
  }
  assert.equal(permissions, 0);
  assert.equal(requests, 0);
});

test("后台再次强制关闭思考；服务仍返回思考时拒绝成功，错误只携带用量", async function () {
  for (const variant of ["content", "usage", "tags", "empty-tags"]) {
    let sent;
    const handler = provider.createBackgroundMessageHandler({ extensionId: "fixture", fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      const message = { content: "ok" };
      if (variant === "content") message.reasoning_content = "private-reasoning";
      if (variant === "tags") message.content = "<think>private-reasoning</think>ok";
      if (variant === "empty-tags") message.content = "<think>\n</think>ok";
      return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
        output_tokens_details: { reasoning_tokens: variant === "usage" ? 15 : 0 } } }));
    } });
    const result = await handler({ type: provider.MESSAGE_TYPE, config: { baseUrl: "https://fixture.invalid/v1", apiKey: "secret", model: "deepseek-v4-flash" },
      request: { thinking: { type: "enabled" }, messages: [] } }, { id: "fixture" });
    assert.deepEqual(sent.thinking, { type: "disabled" });
    if (variant === "empty-tags") assert.equal(result.ok, true);
    else {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "MODEL_THINKING_NOT_DISABLED");
      assert.equal(result.error.provider.usage.totalTokens, 30);
      assert.equal(result.error.provider.thinkingMode, "rejected");
      assert.ok(!JSON.stringify(result).includes("private-reasoning"));
      assert.ok(!JSON.stringify(result).includes("secret"));
    }
  }
});

test("模型地址生成精确可选权限，不依赖 localhost Harness", function () {
  assert.equal(provider.providerPermissionPattern("https://api.example.com/v1"), "https://api.example.com/*");
  assert.equal(provider.chatCompletionsUrl("https://api.example.com/v1/"), "https://api.example.com/v1/chat/completions");
  assert.equal(provider.chatCompletionsUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1/chat/completions");
});

test("扩展侧先申请当前 Provider 域名权限，再通过后台发送请求", async function () {
  const calls = [];
  const chromeApi = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        calls.push(["message", message]);
        callback({ ok: true, data: { content: "OK", toolCalls: [], provider: { model: "gpt-4o-mini", latencyMs: 1 } } });
      }
    },
    permissions: {
      contains(value, callback) { calls.push(["contains", value]); callback(false); },
      request(value, callback) { calls.push(["request", value]); callback(true); }
    }
  };
  const transport = provider.createProviderTransport({ chromeApi });
  const result = await transport.complete({ baseUrl: "https://model.example/v1", apiKey: "secret", model: "gpt-4o-mini" }, { messages: [] });
  assert.equal(result.content, "OK");
  assert.deepEqual(calls[0], ["contains", { origins: ["https://model.example/*"] }]);
  assert.deepEqual(calls[1], ["request", { origins: ["https://model.example/*"] }]);
  assert.equal(calls[2][1].type, provider.MESSAGE_TYPE);
});

test("后台直接请求 OpenAI-compatible 接口并保留真实用量", async function () {
  const calls = [];
  const result = await provider.executeProviderRequest({
    config: { baseUrl: "https://model.example/v1", apiKey: "secret", model: "gpt-4o-mini" },
    request: { messages: [{ role: "user", content: "hello" }] }
  }, async function (url, init) {
    calls.push({ url, init });
    return new Response(JSON.stringify({ model: "demo-v2", choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }), { status: 200 });
  }, 5000);
  assert.equal(calls[0].url, "https://model.example/v1/chat/completions");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer secret");
  assert.deepEqual(result.provider.usage, { inputTokens: 4, outputTokens: 1, totalTokens: 5 });
});

test("Provider 网络失败不会伪装成本地 Harness 错误", async function () {
  await assert.rejects(provider.executeProviderRequest({
    config: { baseUrl: "https://model.example/v1", apiKey: "secret", model: "gpt-4o-mini" }, request: {}
  }, async function () { throw new TypeError("offline"); }, 5000), /无法连接模型服务/);
});

test("每次请求检查实际授权，撤回权限后拒绝发送，错误使用可诊断的权限码", async function () {
  let granted = true, sent = 0, requests = 0;
  const chromeApi = {
    permissions: {
      contains(value, callback) { assert.deepEqual(value, { origins: ["https://model.example/*"] }); callback(granted); },
      request(_value, callback) { requests += 1; callback(false); }
    },
    runtime: { sendMessage(_message, callback) { sent += 1; callback({ ok: true, data: { content: "OK" } }); } }
  };
  const transport = provider.createProviderTransport({ chromeApi });
  const config = { baseUrl: "https://model.example/v1", apiKey: "secret", model: "gpt-4o-mini" };
  await transport.complete(config, {});
  assert.equal(requests, 0);
  granted = false;
  await assert.rejects(transport.complete(config, {}), error => error.code === "MODEL_PERMISSION_DENIED");
  assert.equal(sent, 1);
  chromeApi.permissions.request = () => { throw new Error("user gesture required"); };
  await assert.rejects(transport.complete(config, {}), error => error.code === "MODEL_PERMISSION_REQUIRED");
  assert.equal(sent, 1);
});

