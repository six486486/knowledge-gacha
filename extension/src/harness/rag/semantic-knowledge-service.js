(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const api = factory(commonJs ? require("../../shared/rag/knowledge-corpus.js") : root.KnowledgeGachaKnowledgeCorpus,
    commonJs ? require("../../shared/rag/hybrid-retriever.js") : root.KnowledgeGachaHybridRetriever,
    commonJs ? require("../../shared/rag/query-analyzer.js") : root.KnowledgeGachaQueryAnalyzer);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaSemanticKnowledge = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (corpus, hybrid, analyzer) {
  "use strict";
  function createSemanticKnowledgeService(context) {
    const embedding = context.embedding;
    const repository = context.repository;
    let serial = Promise.resolve();
    let cooldownUntil = 0;
    async function searchNow(query, options) {
      const settings = options || {};
      const started = performance.now();
      const text = String(query || "").normalize("NFKC").trim().slice(0, 1000);
      const all = corpus.buildCorpus(context.readDb());
      const entries = all.filter(function (entry) { return corpus.inScope(entry, settings); });
      const trace = { strategy: "lexical", model: embedding?.fingerprint || null, totalEntries: all.length, searchedEntries: entries.length,
        indexed: 0, cacheHits: 0, denseThreshold: hybrid.DENSE_THRESHOLD, degraded: null };
      if (!analyzer.terms(text).size || !entries.length) return { results: [], trace: trace };
      const vectors = new Map();
      let vector;
      if (embedding && repository && Date.now() >= cooldownUntil) try {
        const cached = new Map((await repository.list("vectors")).map(function (row) { return [row.id, row.value]; }));
        const missing = [];
        for (const entry of entries) {
          const value = cached.get(entry.id);
          if (value?.model === embedding.fingerprint && value.text === entry.embeddingText && value.vector?.length === embedding.dimensions && value.vector.every(Number.isFinite)) {
            vectors.set(entry.id, value.vector); trace.cacheHits += 1;
          } else missing.push(entry);
        }
        for (let i = 0; i < missing.length; i += 8) {
          const batch = missing.slice(i, i + 8);
          const output = await embedding.embed(batch.map(function (entry) { return entry.embeddingText; }));
          const rows = batch.map(function (entry, j) {
            vectors.set(entry.id, output[j]);
            return { id: entry.id, value: { model: embedding.fingerprint, text: entry.embeddingText, vector: new Float32Array(output[j]) } };
          });
          await repository.putMany("vectors", rows);
          trace.indexed += rows.length;
        }
        vector = (await embedding.embed([text.slice(0, 400)], { query: true }))[0];
        trace.strategy = "hybrid-rrf-v1";
      } catch (_) { cooldownUntil = Date.now() + 30000; trace.degraded = "local_embedding_unavailable"; }
      else trace.degraded = embedding ? "local_embedding_cooldown" : "local_embedding_disabled";
      // Re-read after async inference: deleted/updated records must never reappear as stale evidence.
      const currentDb = context.readPersisted ? await context.readPersisted() : context.readDb();
      const current = new Map(corpus.buildCorpus(currentDb).filter(function (entry) { return corpus.inScope(entry, settings); }).map(function (entry) { return [entry.id, entry]; }));
      const eligible = entries.filter(function (entry) { const live = current.get(entry.id); return live && live.version === entry.version && live.embeddingText === entry.embeddingText; });
      // A concurrent delete may have pruned before our inference finished writing.
      // Remove these obsolete derived rows again; absence from the current corpus is authoritative.
      if (repository) {
        const obsolete = entries.filter(function (entry) { return !current.has(entry.id) || current.get(entry.id).embeddingText !== entry.embeddingText; }).map(function (entry) { return entry.id; });
        if (obsolete.length) try { await repository.removeMany("vectors", obsolete); } catch (_) { /* Never use obsolete rows; cleanup retries on the next mutation. */ }
      }
      const counts = new Map();
      const results = hybrid.rank(eligible, text, vector, vectors, settings).filter(function (hit) {
        const key = hit.entry.cardId || hit.entry.documentId;
        const count = counts.get(key) || 0;
        if (count >= (hit.entry.type === "card" ? 1 : 2)) return false;
        counts.set(key, count + 1); return true;
      }).slice(0, settings.limit || 5).map(function (hit) { return Object.assign({}, current.get(hit.entry.id), { score: hit.score, lexicalScore: hit.lexicalScore, denseScore: hit.denseScore }); });
      trace.elapsedMs = performance.now() - started;
      trace.selected = results.map(function (hit) { return { id: hit.id, score: hit.score, lexical: hit.lexicalScore, dense: hit.denseScore }; });
      return { results: results, trace: trace };
    }
    async function prune() {
      if (!repository) return;
      const live = new Map(corpus.buildCorpus(context.readDb()).map(function (entry) { return [entry.id, entry.embeddingText]; }));
      const stale = (await repository.list("vectors")).filter(function (row) { return !live.has(row.id) || live.get(row.id) !== row.value.text || row.value.model !== embedding?.fingerprint; });
      await repository.removeMany("vectors", stale.map(function (row) { return row.id; }));
    }
    return { search: function (query, options) { const result = serial.catch(function () {}).then(function () { return searchNow(query, options); }); serial = result; return result; },
      prune: prune, dispose: function () { embedding?.dispose?.(); } };
  }
  return { createSemanticKnowledgeService: createSemanticKnowledgeService };
});
