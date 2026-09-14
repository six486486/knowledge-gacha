(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const api = factory(commonJs ? require("../material-index.js") : root.KnowledgeGachaMaterialIndex,
    commonJs ? require("./embedding-config.js") : root.KnowledgeGachaEmbeddingConfig,
    commonJs ? require("../knowledge-schema.js") : root.KnowledgeGachaKnowledgeSchema);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaKnowledgeCorpus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (index, config, schema) {
  "use strict";
  // Character windows fit inside the Chinese tokenizer budget, including heading metadata.
  // Keep offsets in the original text; normalization is only for matching/embedding.
  function windows(text, start, end) {
    const spans = [];
    for (let cursor = start; cursor < end;) {
      let limit = Math.min(cursor + config.windowCharacters, end);
      if (/[\uD800-\uDBFF]/.test(text[limit - 1])) limit -= 1;
      spans.push({ startCharacter: cursor, endCharacter: limit, text: text.slice(cursor, limit) });
      if (limit === end) break;
      cursor = limit - config.overlapCharacters;
      if (/[\uDC00-\uDFFF]/.test(text[cursor])) cursor += 1;
    }
    return spans;
  }
  function buildCorpus(db) {
    const entries = [];
    (db.documents || []).forEach(function (document) {
      const source = (db.sources || []).find(function (item) { return item.documentId === document.id; });
      const material = { id: document.id, text: document.content || "", blocks: document.blocks, version: source?.version || 1 };
      const linked = (db.learningState?.cards || []).some(function (card) { return source && schema.cardSourceIds(card).includes(source.id); });
      index.splitMaterial(material).filter(function (chunk) { return chunk.kind !== "heading"; }).forEach(function (chunk) {
        windows(material.text, chunk.startCharacter, chunk.endCharacter).forEach(function (span) {
          entries.push(Object.assign({}, chunk, span, { id: "document:" + document.id + ":" + span.startCharacter, type: "document", documentId: document.id,
            title: document.title, version: material.version, linked: linked, sourceType: document.type, sourceUrl: document.sourceUrl || null,
            evidenceRole: "source_excerpt", embeddingText: chunk.headingPath.join(" / ").slice(0, 80) + "\n" + span.text }));
        });
      });
    });
    (db.learningState?.cards || []).forEach(function (card) {
      const text = [card.title, card.learningObjective, card.summary, card.mantra, card.boundaries, card.example?.text].filter(Boolean).join("\n");
      windows(text, 0, text.length).forEach(function (span) {
        entries.push(Object.assign({}, span, { id: "card:" + card.id + ":" + span.startCharacter, type: "card", cardId: card.id,
          title: card.title, evidenceRole: "learning_background", embeddingText: String(card.title || "").slice(0, 80) + "\n" + span.text }));
      });
    });
    return entries;
  }
  function inScope(entry, options) {
    const settings = options || {};
    return (!settings.type || entry.type === settings.type) &&
      (!settings.excludeDocumentId || entry.documentId !== settings.excludeDocumentId) && (!settings.onlyLinked || entry.linked);
  }
  return { buildCorpus: buildCorpus, windows: windows, inScope: inScope };
});
