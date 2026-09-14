import { env, BertTokenizer, AutoModel, FeatureExtractionPipeline } from "../../../../vendor/embedding/transformers.web.js";
import "../../../shared/rag/embedding-config.js";

const config = globalThis.KnowledgeGachaEmbeddingConfig;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL("../../../../vendor/embedding/models/", import.meta.url).href;
env.useBrowserCache = false;
env.useWasmCache = false; // MV3 forbids importing a blob URL as executable code.
env.backends.onnx.wasm.wasmPaths = new URL("../../../../vendor/embedding/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
let extractor;
let queue = Promise.resolve();
async function loadTokenizer() {
  const files = await Promise.all(["tokenizer.json", "tokenizer_config.json"].map(async name => {
    const response = await fetch(env.localModelPath + config.model + "/" + name);
    if (!response.ok) throw new Error("本地分词文件缺失");
    return response.json();
  }));
  return new BertTokenizer(...files);
}
self.onmessage = ({ data }) => {
  queue = queue.catch(() => {}).then(async () => {
    try {
      extractor ||= Promise.all([
        loadTokenizer(),
        AutoModel.from_pretrained(config.model, { device: "wasm", dtype: "q8", local_files_only: true })
      ]).then(([tokenizer, model]) => new FeatureExtractionPipeline({ task: "feature-extraction", tokenizer, model }));
      const model = await extractor;
      const vectors = [];
      for (const text of data.texts) {
        const output = await model((data.query ? config.queryPrefix : "") + text, { pooling: "cls", normalize: true, truncation: true, max_length: 512 });
        vectors.push(Array.from(output.data));
      }
      self.postMessage({ id: data.id, vectors });
    } catch (error) {
      console.warn("Local embedding runtime:", error.message);
      extractor = null;
      self.postMessage({ id: data.id, error: "本地语义模型暂不可用，已使用关键词检索" });
    }
  });
};
