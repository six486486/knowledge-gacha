(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const chunker = commonJs ? require("./structural-chunker.js") : root.KnowledgeGachaStructuralChunker;
  const api = factory(chunker);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaContextAssembler = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (chunker) {
  "use strict";

  const BATCH_CHARACTERS = 6000;
  const chunkView = chunker.chunkView;

  function analysisBatches(chunks) {
    const batches = [];
    let current = [];
    let size = 0;
    chunks.forEach(function (chunk) {
      const length = chunk.endCharacter - chunk.startCharacter + JSON.stringify(chunk).length + 30;
      if (current.length && size + length > BATCH_CHARACTERS) { batches.push(current); current = []; size = 0; }
      current.push(chunk.id);
      size += length;
    });
    if (current.length) batches.push(current);
    return batches;
  }

  function contextFor(material, chunks, evidenceIds, maxCharacters) {
    const selected = new Set(evidenceIds);
    if (!selected.size || evidenceIds.some(function (id) { return !chunks.some(function (chunk) { return chunk.id === id; }); })) throw new Error("目标缺少有效原文位置，请重新分析");
    chunks.forEach(function (chunk, index) {
      if (!evidenceIds.includes(chunk.id)) return;
      // Retain paragraph neighbours and the full table/code block. Exceptions
      // and negations often sit immediately after the defining paragraph.
      [chunks[index - 1], chunks[index + 1]].filter(Boolean).forEach(function (nearby) {
        if (JSON.stringify(nearby.headingPath) === JSON.stringify(chunk.headingPath)) selected.add(nearby.id);
      });
      if (["table", "code"].includes(chunk.kind)) chunks.forEach(function (part) { if (part.groupId === chunk.groupId) selected.add(part.id); });
    });
    const result = chunks.filter(function (chunk) { return selected.has(chunk.id); }).map(function (chunk) { return chunkView(material, chunk); });
    if (result.reduce(function (total, chunk) { return total + chunk.text.length; }, 0) > (maxCharacters || 12000)) throw new Error("该目标的完整依据超过单卡范围，请继续拆分目标或缩小材料范围");
    return result;
  }


  return { analysisBatches: analysisBatches, contextFor: contextFor };
});
