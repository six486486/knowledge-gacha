import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import rag from "../../src/harness/rag/rag-service.js";
import index from "../../src/shared/material-index.js";

export const corpus = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));

export function fixtureDb() {
  return {
    documents: corpus.documents.map(doc => ({ ...doc, type: "text/plain" })),
    sources: corpus.documents.map(doc => ({ id: "source_" + doc.id, documentId: doc.id, version: 1 })),
    learningState: { cards: corpus.documents.filter(doc => doc.linked).map(doc => ({ id: "card_" + doc.id, sourceIds: ["source_" + doc.id] })) }
  };
}

// A controlled ablation of the evidence eligibility rule, not a vector baseline.
function withHeadingEvidence(material, chunks, query, options) {
  return chunks.map(chunk => ({ ...index.chunkView(material, chunk), score: index.score(query, chunk.headingPath.join(" ") + " " + index.chunkView(material, chunk).text) }))
    .filter(chunk => chunk.score >= options.minScore).sort((a, b) => b.score - a.score || a.startCharacter - b.startCharacter).slice(0, options.limit);
}

export function evaluate({ headings = false } = {}) {
  const db = fixtureDb();
  const service = rag.createRagService({ readDb: () => db, retrieve: headings ? withHeadingEvidence : undefined, retrievalStrategy: "heading-evidence-ablation" });
  const cases = corpus.cases.map(item => {
    const started = performance.now();
    const result = service.inspectRetrieval(item.query, { limit: 3, ...item.options });
    const latencyMs = performance.now() - started;
    const relevant = span => item.expected.some(label => label.documentId === span.documentId && span.text.includes(label.contains));
    const first = result.evidence.findIndex(relevant);
    const recalled = item.expected.filter(label => result.evidence.some(span => label.documentId === span.documentId && span.text.includes(label.contains))).length;
    const noHitCorrect = !item.expected.length && !result.evidence.length;
    return { id: item.id, query: item.query, probe: Boolean(item.probe), expected: item.expected, hitAt1: first === 0,
      recallAt3: item.expected.length ? recalled / item.expected.length : null, reciprocalRankAt3: first < 0 ? 0 : 1 / (first + 1), noHitCorrect,
      passed: item.expected.length ? recalled === item.expected.length : noHitCorrect, latencyMs, trace: result.trace };
  });
  const scored = cases.filter(item => !item.probe), positive = scored.filter(item => item.expected.length), negative = scored.filter(item => !item.expected.length);
  const mean = (items, field) => items.reduce((sum, item) => sum + Number(item[field]), 0) / items.length;
  return { corpusVersion: corpus.version, description: corpus.description, documentCount: db.documents.length,
    metrics: { scoredCases: scored.length, positiveCases: positive.length, negativeCases: negative.length, passed: scored.filter(item => item.passed).length,
      hitRateAt1: mean(positive, "hitAt1"), recallAt3: mean(positive, "recallAt3"), mrrAt3: mean(positive, "reciprocalRankAt3"), noHitAccuracy: mean(negative, "noHitCorrect") }, cases };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = { generatedAt: new Date().toISOString(), current: evaluate(), withHeadings: evaluate({ headings: true }) };
  const outputIndex = process.argv.indexOf("--out");
  if (outputIndex >= 0) { const target = resolve(process.argv[outputIndex + 1]); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(report, null, 2) + "\n"); }
  console.log(JSON.stringify({ current: report.current.metrics, withHeadings: report.withHeadings.metrics,
    probes: report.current.cases.filter(item => item.probe).map(item => ({ id: item.id, passed: item.passed })) }, null, 2));
  if (report.current.metrics.passed !== report.current.metrics.scoredCases) process.exitCode = 1;
}
