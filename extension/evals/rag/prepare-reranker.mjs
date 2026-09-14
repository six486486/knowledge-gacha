import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const model = JSON.parse(readFileSync(new URL('./reranker-model.json', import.meta.url)));
const output = resolve('.tmp-browser-qa/rag-ablation/reranker');
for (const file of model.files) {
  const path = resolve(output, file.path);
  if (!existsSync(path)) {
    const response = await fetch(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file.source}`, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`Reranker download failed: ${response.status} ${file.source}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (file.sha256 && createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Model checksum mismatch: ${file.path}`);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
  }
  if (file.sha256 && createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error(`Cached model checksum mismatch: ${file.path}`);
  console.log(`Ready ${file.path}`);
}
