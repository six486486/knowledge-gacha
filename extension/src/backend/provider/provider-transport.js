(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaProviderTransport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MESSAGE_TYPE = "knowledge-gacha:provider-request";
  const THINKING_POLICY = "non-thinking-v1";

  function nonThinkingOptions(config) {
    const model = String(config.model || "").trim().toLowerCase().split("/").at(-1);
    const host = new URL(config.baseUrl).hostname;
    // Only documented non-thinking modes are admitted. Unknown deployment aliases
    // and reasoning-only variants must be adapted explicitly, never guessed.
    if (!/(?:thinking|reasoner|\br1\b|qwq|qvq)/.test(model)) {
      if (/^deepseek-v4-(?:flash(?:-vision-exp)?|pro)$/.test(model) || model === "deepseek-chat") return { thinking: { type: "disabled" } };
      if (/^qwen3(?:\.5)?(?:$|[-:])/.test(model) || /^qwen-(?:plus|flash|turbo)(?:$|-)/.test(model)) {
        const flags = { enable_thinking: false };
        // Alibaba consumes the top-level flag; self-hosted Qwen templates use kwargs.
        if (!/(^|\.)(?:aliyuncs\.com|qwen\.ai)$/.test(host)) flags.chat_template_kwargs = { enable_thinking: false };
        return flags;
      }
      if (/^glm-(?:4\.[567](?:-flash|-air|-airx)?|5(?:\.[12])?)$/.test(model)) return { thinking: { type: "disabled" } };
      if (model === "kimi-k2.5") {
        const flags = { thinking: { type: "disabled" } };
        if (!/(^|\.)moonshot\.(?:cn|ai)$/.test(host)) flags.chat_template_kwargs = { thinking: false };
        return flags;
      }
      if (/^gpt-5\.[12](?:-\d{4}-\d{2}-\d{2})?$/.test(model) || model === "gpt-5.6-sol") return { reasoning_effort: "none" };
      // These families have no separate thinking mode or reasoning-effort option.
      if (/^gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?|3\.5-turbo)(?:-\d{4}(?:-\d{2}-\d{2})?)?$/.test(model) || /^qwen2\.5(?:$|[-:])/.test(model)) return {};
    }
    const error = codedError("MODEL_NON_THINKING_UNSUPPORTED", "该型号不支持关闭思考或尚未适配非思考模式，已阻止调用；请使用已适配的非思考型号");
    error.sent = false;
    throw error;
  }

  function enforceNonThinking(config, request) {
    const flags = nonThinkingOptions(config);
    const body = Object.assign({}, request || {});
    // Raw HTTP is used here, not an SDK. Remove nested SDK/provider overrides too;
    // no caller, task, retry or saved setting may turn thinking back on.
    ["thinking", "think", "enable_thinking", "reasoning", "reasoning_effort", "reasoning_budget", "thinking_budget",
      "thinking_config", "include_reasoning", "chat_template_kwargs", "extra_body", "generation_config"].forEach(function (key) { delete body[key]; });
    return Object.assign(body, flags, { model: config.model });
  }

  function assertNonThinkingResult(result, assistant) {
    const value = assistant || result || {};
    const hasContent = function (item) { return typeof item === "string" ? Boolean(item.trim()) : Array.isArray(item) ? item.length > 0 : Boolean(item); };
    const prefix = String(result.content || "").match(/^\s*<think>([\s\S]*?)(?:<\/think>|$)/i);
    const thinking = [value.reasoning_content, value.reasoning, value.reasoning_details].some(hasContent) ||
      (Array.isArray(value.content) && value.content.some(function (part) { return ["thinking", "reasoning"].includes(part && part.type); })) ||
      (prefix && prefix[1].trim()) || Number(result.provider && result.provider.usage && result.provider.usage.reasoningTokens) > 0;
    if (thinking) {
      const error = codedError("MODEL_THINKING_NOT_DISABLED", "模型服务仍返回思考内容或思考用量，已停止处理；请确认服务支持关闭思考");
      error.provider = Object.assign({}, result.provider, { thinkingMode: "rejected" });
      throw error;
    }
    return result;
  }

  function normalizeModelBaseUrl(value) {
    const text = String(value || "").trim().replace(/\/+$/, "");
    let url;
    try { url = new URL(text); } catch (error) { throw new Error("Base URL 格式无效"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("Base URL 必须使用 HTTPS，本机模型调试除外");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("Base URL 不能包含账号、参数或片段");
    return url.href.replace(/\/+$/, "");
  }

  function normalizeModelConfig(value) {
    const input = value || {};
    const baseUrl = normalizeModelBaseUrl(input.baseUrl || "https://api.openai.com/v1");
    const apiKey = String(input.apiKey || "").trim();
    const model = String(input.model || "").trim();
    if (!apiKey) throw new Error("API Key 不能为空");
    if (!model) throw new Error("Model 名称不能为空");
    return { baseUrl: baseUrl, apiKey: apiKey, model: model };
  }

  function providerPermissionPattern(baseUrl) {
    const url = new URL(normalizeModelBaseUrl(baseUrl));
    return url.protocol + "//" + url.host + "/*";
  }

  function chatCompletionsUrl(baseUrl) {
    const normalized = normalizeModelBaseUrl(baseUrl);
    return /\/chat\/completions$/i.test(normalized) ? normalized : normalized + "/chat/completions";
  }

  function createProviderTransport(options) {
    const settings = options || {};
    const chromeApi = settings.chromeApi || (typeof chrome !== "undefined" ? chrome : null);
    const fetchImpl = settings.fetchImpl || (typeof fetch === "function" ? fetch : null);
    const timeoutMs = Math.max(5_000, Math.min(Number(settings.timeoutMs) || 50_000, 60_000));

    async function ensurePermission(baseUrl) {
      const pattern = providerPermissionPattern(baseUrl);
      if (!chromeApi || !chromeApi.permissions) return pattern;
      const permissions = { origins: [pattern] };
      let granted;
      try { granted = await callChrome(chromeApi, chromeApi.permissions.request.bind(chromeApi.permissions), permissions); }
      catch (error) { throw codedError("MODEL_PERMISSION_REQUIRED", "请点击操作按钮，重新确认模型服务域名访问权限"); }
      if (!granted) throw codedError("MODEL_PERMISSION_DENIED", "未获得模型服务域名访问权限");
      return pattern;
    }

    async function hasPermission(baseUrl) {
      if (!chromeApi || !chromeApi.permissions) return true;
      try {
        return await callChrome(chromeApi, chromeApi.permissions.contains.bind(chromeApi.permissions), {
          origins: [providerPermissionPattern(baseUrl)]
        });
      } catch (error) { throw codedError("MODEL_PERMISSION_REQUIRED", "无法检查模型服务域名访问权限，请重新打开扩展后重试"); }
    }

    async function complete(config, request) {
      const normalized = normalizeModelConfig(config);
      const enforced = enforceNonThinking(normalized, request);
      // A repair/review can run long after the user's click. Checking an existing
      // grant needs no user gesture; requesting it again would fail at that point.
      if (!await hasPermission(normalized.baseUrl)) await ensurePermission(normalized.baseUrl);
      if (chromeApi && chromeApi.runtime && typeof chromeApi.runtime.sendMessage === "function") {
        const response = await callChrome(chromeApi, chromeApi.runtime.sendMessage.bind(chromeApi.runtime), {
          type: MESSAGE_TYPE,
          config: normalized,
          request: enforced
        });
        if (!response || response.ok !== true) throw providerResponseError(response && response.error);
        return assertNonThinkingResult(response.data);
      }
      if (!fetchImpl) throw new Error("当前环境无法发送模型请求");
      return executeProviderRequest({ config: normalized, request: enforced }, fetchImpl, timeoutMs);
    }

    return { complete: complete, ensurePermission: ensurePermission };
  }

  async function executeProviderRequest(message, fetchImpl, timeoutMs) {
    const config = normalizeModelConfig(message && message.config);
    // Enforce again at the final network boundary, including direct CLI/probe calls.
    const request = enforceNonThinking(config, message && message.request);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, Math.max(5_000, Math.min(Number(timeoutMs) || 50_000, 60_000)));
    let response, text;
    const startedAt = Date.now();
    try {
      response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + config.apiKey },
        body: JSON.stringify(Object.assign({}, request, { model: config.model })),
        signal: controller.signal
      });
      // Keep the timeout active through the response body, not just the headers.
      text = await response.text();
    } catch (error) {
      if (error && error.name === "AbortError") throw codedError("MODEL_TIMEOUT", "模型服务响应超时");
      throw codedError("MODEL_UNAVAILABLE", "无法连接模型服务");
    } finally {
      clearTimeout(timer);
    }
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (error) { throw codedError("MODEL_INVALID_RESPONSE", "模型服务返回了无效 JSON"); }
    if (!response.ok) {
      const upstream = payload && payload.error;
      const messageText = upstream && (upstream.message || upstream.code) ? String(upstream.message || upstream.code) : "模型请求失败";
      throw codedError("MODEL_HTTP_ERROR", "HTTP " + response.status + " " + messageText, response.status);
    }
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const assistant = choice && choice.message ? choice.message : {};
    const result = {
      content: typeof assistant.content === "string" ? assistant.content : contentText(assistant.content),
      toolCalls: Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [],
      finishReason: choice && choice.finish_reason ? String(choice.finish_reason) : null,
      provider: {
        model: String(payload.model || config.model),
        thinkingPolicy: THINKING_POLICY,
        thinkingMode: "disabled",
        latencyMs: Math.max(0, Date.now() - startedAt),
        usage: normalizeUsage(payload.usage)
      }
    };
    return assertNonThinkingResult(result, assistant);
  }

  function createBackgroundMessageHandler(options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || fetch;
    const timeoutMs = settings.timeoutMs || 50_000;
    return async function (message, sender) {
      if (!message || message.type !== MESSAGE_TYPE) return undefined;
      if (sender && sender.id && settings.extensionId && sender.id !== settings.extensionId) {
        return { ok: false, error: { code: "INVALID_SENDER", message: "拒绝非本扩展的模型请求" } };
      }
      try {
        return { ok: true, data: await executeProviderRequest(message, fetchImpl, timeoutMs) };
      } catch (error) {
        return { ok: false, error: serializeError(error) };
      }
    };
  }

  function callChrome(chromeApi, method) {
    const args = Array.prototype.slice.call(arguments, 2);
    return new Promise(function (resolve, reject) {
      let settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        const runtimeError = chromeApi.runtime && chromeApi.runtime.lastError;
        if (runtimeError) reject(new Error(runtimeError.message));
        else resolve(value);
      }
      try {
        const result = method.apply(null, args.concat(done));
        if (result && typeof result.then === "function") result.then(done, reject);
      } catch (error) { reject(error); }
    });
  }

  function normalizeUsage(value) {
    if (!value || typeof value !== "object") return undefined;
    if (!["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens", "total_tokens"].some(function (key) {
      return value[key] !== undefined && value[key] !== null && Number.isFinite(Number(value[key])) && Number(value[key]) >= 0;
    })) return undefined;
    const inputTokens = Math.max(0, Number(value.prompt_tokens || value.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(value.completion_tokens || value.output_tokens) || 0);
    const usage = { inputTokens: inputTokens, outputTokens: outputTokens, totalTokens: Math.max(inputTokens + outputTokens, Number(value.total_tokens) || 0) };
    const reasoning = (value.completion_tokens_details && value.completion_tokens_details.reasoning_tokens) ??
      (value.output_tokens_details && value.output_tokens_details.reasoning_tokens);
    if (Number.isFinite(reasoning) && reasoning >= 0) usage.reasoningTokens = reasoning;
    const cached = value.prompt_cache_hit_tokens ?? (value.prompt_tokens_details && value.prompt_tokens_details.cached_tokens);
    if (Number.isFinite(cached) && cached >= 0) usage.cachedInputTokens = cached;
    return usage;
  }

  function contentText(content) {
    if (!Array.isArray(content)) return "";
    return content.map(function (part) { return part && typeof part.text === "string" ? part.text : ""; }).join("");
  }

  function codedError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    if (status) error.status = status;
    return error;
  }

  function serializeError(error) {
    const result = { code: String(error && error.code || "MODEL_REQUEST_FAILED"), message: String(error && error.message || "模型请求失败"), status: Number(error && error.status) || 0 };
    if (error && error.sent === false) result.sent = false;
    if (error && error.code === "MODEL_THINKING_NOT_DISABLED") result.provider = error.provider;
    return result;
  }

  function providerResponseError(value) {
    const error = new Error(String(value && value.message || "模型请求失败"));
    error.code = String(value && value.code || "MODEL_REQUEST_FAILED");
    if (value && value.status) error.status = Number(value.status);
    if (value && value.sent === false) error.sent = false;
    if (value && value.code === "MODEL_THINKING_NOT_DISABLED") error.provider = value.provider;
    return error;
  }

  return {
    MESSAGE_TYPE: MESSAGE_TYPE,
    THINKING_POLICY: THINKING_POLICY,
    enforceNonThinking: enforceNonThinking,
    chatCompletionsUrl: chatCompletionsUrl,
    createBackgroundMessageHandler: createBackgroundMessageHandler,
    createProviderTransport: createProviderTransport,
    executeProviderRequest: executeProviderRequest,
    normalizeModelBaseUrl: normalizeModelBaseUrl,
    normalizeModelConfig: normalizeModelConfig,
    providerPermissionPattern: providerPermissionPattern
  };
});
