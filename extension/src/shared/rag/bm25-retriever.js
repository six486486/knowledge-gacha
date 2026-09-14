(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const api = factory(commonJs ? require("./query-analyzer.js") : root.KnowledgeGachaQueryAnalyzer);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaBM25Retriever = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (analyzer) {
  "use strict";

  // Okapi BM25, positive Robertson IDF. Statistics belong to the eligible chunk
  // corpus, never to another profile or to documents excluded by the caller.
  function createIndex(entries, options) {
    const settings = options || {};
    const k1 = settings.k1 ?? 1.2, b = settings.b ?? 0.75;
    if (!Number.isFinite(k1) || k1 < 0 || !Number.isFinite(b) || b < 0 || b > 1) throw new Error("Invalid BM25 parameters");
    const frequencies = new Map();
    const rows = entries.map(function (entry) {
      const tokens = analyzer.tokens(entry.embeddingText), tf = new Map();
      tokens.forEach(function (token) { tf.set(token, (tf.get(token) || 0) + 1); });
      tf.forEach(function (_, token) { frequencies.set(token, (frequencies.get(token) || 0) + 1); });
      return { entry: entry, tf: tf, length: tokens.length };
    });
    const averageLength = rows.length ? rows.reduce(function (sum, row) { return sum + row.length; }, 0) / rows.length : 0;
    function rank(query) {
      const wanted = new Set(analyzer.tokens(query));
      return rows.map(function (row) {
        let score = 0;
        wanted.forEach(function (term) {
          const tf = row.tf.get(term) || 0;
          if (!tf) return;
          const df = frequencies.get(term);
          const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
          score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * row.length / averageLength));
        });
        return { entry: row.entry, score: score };
      }).filter(function (hit) { return hit.score > 0; }).sort(function (a, b) { return b.score - a.score || a.entry.id.localeCompare(b.entry.id); });
    }
    return { rank: rank, documentCount: rows.length, averageLength: averageLength, k1: k1, b: b };
  }
  return { createIndex: createIndex };
});
