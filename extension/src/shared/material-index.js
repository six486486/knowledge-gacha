(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const query = commonJs ? require("./rag/query-analyzer.js") : root.KnowledgeGachaQueryAnalyzer;
  const chunker = commonJs ? require("./rag/structural-chunker.js") : root.KnowledgeGachaStructuralChunker;
  const retriever = commonJs ? require("./rag/lexical-retriever.js") : root.KnowledgeGachaLexicalRetriever;
  const assembler = commonJs ? require("./rag/context-assembler.js") : root.KnowledgeGachaContextAssembler;
  const api = factory(query, chunker, retriever, assembler);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaMaterialIndex = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (query, chunker, retriever, assembler) {
  "use strict";

  // Compatibility facade for generation, import and retrieval callers. Strategies are pure modules.
  function needsPlan(input) {
    if (input.forcePlan || String(input.text || "").length > 1200) return true;
    if ((input.blocks || []).filter(function (block) { return block.kind === "heading"; }).length > 1) return true;
    const text = String(input.text || "");
    return (text.match(/^#{1,6}\s+\S|^\s*\d+[.、)]\s*\S/gm) || []).length > 1;
  }


  return { MAX_CHARACTERS: chunker.MAX_CHARACTERS, splitMaterial: chunker.splitMaterial, chunkView: chunker.chunkView,
    analysisBatches: assembler.analysisBatches, terms: query.terms, score: retriever.score, retrieve: retriever.retrieve, contextFor: assembler.contextFor, needsPlan: needsPlan };
});
