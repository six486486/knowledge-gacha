(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const api = factory(commonJs ? require("./lexical-retriever.js") : root.KnowledgeGachaLexicalRetriever);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaHybridRetriever = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (lexical) {
  "use strict";
  const DENSE_THRESHOLD = 0.44;
  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  }
  function rank(entries, query, vector, vectors, options) {
    const settings = options || {};
    const scored = entries.map(function (entry) {
      return { entry: entry, lexicalScore: lexical.score(query, entry.embeddingText), denseScore: vector ? cosine(vector, vectors.get(entry.id)) : 0 };
    });
    const word = scored.filter(function (item) { return item.lexicalScore >= 0.18; }).sort(function (a, b) { return b.lexicalScore - a.lexicalScore; });
    const dense = scored.filter(function (item) { return vector && item.denseScore >= (settings.denseThreshold ?? DENSE_THRESHOLD); }).sort(function (a, b) { return b.denseScore - a.denseScore; });
    return fuse(word, dense);
  }
  function fuse(word, dense) {
    const merged = new Map();
    // Weighted reciprocal rank fusion: lexical 1.25 protects precise identifiers.
    [word, dense].forEach(function (list, branch) { list.forEach(function (item, i) {
      const found = merged.get(item.entry.id) || Object.assign({}, item, { score: 0 });
      found.score += (branch ? 1 : 1.25) * 61 / (60 + i + 1) / 2.25;
      merged.set(item.entry.id, found);
    }); });
    return Array.from(merged.values()).sort(function (a, b) { return b.score - a.score || b.lexicalScore - a.lexicalScore; });
  }
  return { rank: rank, fuse: fuse, cosine: cosine, DENSE_THRESHOLD: DENSE_THRESHOLD };
});
