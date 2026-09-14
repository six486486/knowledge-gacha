(function (root, factory) {
  const script = typeof document !== "undefined" ? document.currentScript?.src : null;
  const api = factory(script);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaDocumentParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (script) {
  "use strict";
  function createDocumentParser(options) {
    const settings = options || {};
    const workerUrl = settings.workerUrl || new URL("./document-parser-worker.mjs", script || location.href).href;
    function run(input, options) {
      const config = options || {};
      return new Promise(function (resolve, reject) {
        const worker = new Worker(workerUrl, { type: "module", name: "knowledge-document-parser" });
        let finished = false;
        let timer;
        let checkpoints = Promise.resolve();
        function finish(error, result) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          config.signal?.removeEventListener("abort", abort);
          worker.terminate();
          checkpoints.then(function () { if (error) reject(error); else resolve(result); }, reject);
        }
        function abort() { const error = new Error("已暂停解析，已完成的范围已保留"); error.name = "AbortError"; finish(error); }
        function timeout() { clearTimeout(timer); timer = setTimeout(function () { finish(new Error("这一部分解析超时，已完成范围已保留；可缩小范围重试")); }, settings.timeoutMs || 60000); }
        worker.onmessage = function (event) {
          if (finished) return;
          const message = event.data;
          if (message.type === "progress") {
            timeout();
            checkpoints = checkpoints.then(function () { return config.onProgress?.(message.value); });
            checkpoints.then(function () { if (!finished) worker.postMessage({ type: "ack", id: message.id }); }, function (error) { finish(error); });
          } else if (message.type === "result") finish(null, message.value);
          else if (message.type === "error") { const error = new Error(message.message); error.code = message.code; finish(error); }
        };
        worker.onerror = function (event) { event.preventDefault(); finish(new Error("解析器未能运行：" + (event.message || "请重新加载扩展"))); };
        if (config.signal?.aborted) { abort(); return; }
        config.signal?.addEventListener("abort", abort, { once: true });
        timeout();
        worker.postMessage({ type: "run", input: input }, input.bytes ? [input.bytes] : []);
      });
    }
    return { run: run };
  }
  return { createDocumentParser: createDocumentParser };
});
