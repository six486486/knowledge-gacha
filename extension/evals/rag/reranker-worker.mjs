// Copied into an isolated MV3 evaluation package. Never loaded by the product.
import { env, XLMRobertaTokenizer, AutoModelForSequenceClassification } from './vendor/embedding/transformers.web.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./eval-models/', import.meta.url).href;
env.useBrowserCache = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/embedding/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
let loaded;
self.onmessage = async ({ data }) => {
  try {
    loaded ||= Promise.all([
      Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(async name => {
        const response = await fetch(env.localModelPath + 'reranker/' + name);
        if (!response.ok) throw new Error('Missing reranker tokenizer');
        return response.json();
      })).then(files => new XLMRobertaTokenizer(...files)),
      AutoModelForSequenceClassification.from_pretrained('reranker', { dtype: 'q8', device: 'wasm', local_files_only: true })
    ]);
    const [tokenizer, model] = await loaded;
    const scores = [];
    for (const text of data.texts) {
      const inputs = tokenizer(data.query, { text_pair: text, truncation: true, max_length: 512, padding: true });
      const output = await model(inputs);
      const score = Number(output.logits.data[0]);
      if (!Number.isFinite(score)) throw new Error('Non-finite reranker output');
      scores.push(score);
    }
    self.postMessage({ scores });
  } catch (error) { self.postMessage({ error: error.message }); }
};
