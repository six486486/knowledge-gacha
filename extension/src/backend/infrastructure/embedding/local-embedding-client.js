(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const config = commonJs ? require("../../../shared/rag/embedding-config.js") : root.KnowledgeGachaEmbeddingConfig;
  const scriptUrl = typeof document !== "undefined" ? document.currentScript?.src : null;
  const api = factory(config, scriptUrl);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaLocalEmbedding = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (config, scriptUrl) {
  "use strict";
  function createLocalEmbeddingClient(options) {
    const settings = options || {};
    let worker, sequence = 0, queue = Promise.resolve();
    const pending = new Map();
    function dispose() {
      if (worker) worker.terminate();
      worker = null;
      pending.forEach(function (item) { clearTimeout(item.timer); item.reject(new Error("本地语义检索已停止")); });
      pending.clear();
    }
    function request(texts, query) {
      if (!worker) {
        worker = settings.workerFactory ? settings.workerFactory() : new Worker(new URL("local-embedding-worker.mjs", scriptUrl), { type: "module" });
        worker.onmessage = function ({ data }) {
          const item = pending.get(data.id);
          if (!item) return;
          pending.delete(data.id); clearTimeout(item.timer);
          if (data.error) item.reject(new Error(data.error));
          else if (!Array.isArray(data.vectors) || data.vectors.length !== item.count || data.vectors.some(function (vector) { return vector.length !== config.dimensions || vector.some(function (v) { return !Number.isFinite(v); }); })) item.reject(new Error("本地向量格式无效"));
          else item.resolve(data.vectors);
        };
        worker.onerror = function () { dispose(); };
      }
      return new Promise(function (resolve, reject) {
        const id = ++sequence;
        const timer = setTimeout(dispose, settings.timeoutMs || 90000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer, count: texts.length });
        worker.postMessage({ id: id, texts: texts, query: Boolean(query) });
      });
    }
    return { fingerprint: config.fingerprint, dimensions: config.dimensions, dispose: dispose,
      embed: function (texts, options) {
        const result = queue.catch(function () {}).then(function () { return request(texts, options?.query); });
        queue = result;
        return result;
      } };
  }
  return { createLocalEmbeddingClient: createLocalEmbeddingClient };
});
