(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const query = commonJs ? require("./query-analyzer.js") : root.KnowledgeGachaQueryAnalyzer;
  const chunker = commonJs ? require("./structural-chunker.js") : root.KnowledgeGachaStructuralChunker;
  const api = factory(query, chunker);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaLexicalRetriever = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (query, chunker) {
  "use strict";

  const terms = query.terms;
  const normalizeText = query.normalizeText;
  const chunkView = chunker.chunkView;

  function score(query, content) {
    return explainScore(query, content).score;
  }

  function explainScore(query, content) {
    const wanted = terms(query);
    const found = terms(content);
    let hits = 0;
    const matchedTerms = [];
    wanted.forEach(function (word) { if (found.has(word)) { hits += word.startsWith("synonym_") ? 2 : 1; matchedTerms.push(word); } });
    const normalized = normalizeText(query).trim();
    const exact = normalized.length >= 2 && normalizeText(content).includes(normalized);
    return { score: !wanted.size || !found.size ? 0 : Math.min(1, Math.max(exact ? 0.9 : 0, hits / Math.sqrt(wanted.size * Math.min(found.size, wanted.size * 4)))),
      exactPhrase: exact, matchedTerms: matchedTerms, queryTermCount: wanted.size, contentTermCount: found.size };
  }

  function retrieve(material, chunks, query, options) {
    const settings = options || {};
    // Headings remain searchable metadata on body chunks, not standalone evidence.
    return chunks.filter(function (chunk) { return chunk.kind !== "heading"; }).map(function (chunk) {
      return { chunk: chunk, score: score(query, chunk.headingPath.join(" ") + " " + material.text.slice(chunk.startCharacter, chunk.endCharacter)) };
    }).filter(function (hit) { return hit.score >= (settings.minScore || 0.18); })
      .sort(function (a, b) { return b.score - a.score || a.chunk.startCharacter - b.chunk.startCharacter; })
      .slice(0, settings.limit || 5).map(function (hit) { return Object.assign(chunkView(material, hit.chunk), { score: hit.score }); });
  }


  return { score: score, explainScore: explainScore, retrieve: retrieve };
});
