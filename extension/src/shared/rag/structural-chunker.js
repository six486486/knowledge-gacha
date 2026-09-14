(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;

  const api = factory();
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaStructuralChunker = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_CHARACTERS = 1000000;
  const CHUNK_CHARACTERS = 1800;

  function splitMaterial(material, maxCharacters) {
    const text = String(material.text || "");
    if (text.length > (maxCharacters || MAX_CHARACTERS)) throw new Error("材料超过 100 万字符，请先缩小范围");
    const lines = Array.from(text.matchAll(/[^\n]*\n|[^\n]+$/g));
    const blocks = [];
    let start = null;
    let end = 0;
    let kind = "paragraph";
    let fence = "";
    let headingPath = [];
    let currentHeadings = [];
    function flush() {
      if (start !== null && text.slice(start, end).trim()) blocks.push({ start: start, end: end, kind: kind, headingPath: currentHeadings.slice() });
      start = null;
    }
    lines.forEach(function (line) {
      const value = line[0];
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(value.trimEnd());
      const marker = /^\s*(`{3,}|~{3,})/.exec(value);
      const table = /^\s*\|.*\|\s*$/.test(value.trimEnd());
      if (!fence && heading) {
        flush();
        headingPath = headingPath.slice(0, heading[1].length - 1);
        headingPath[heading[1].length - 1] = heading[2];
        blocks.push({ start: line.index, end: line.index + value.length, kind: "heading", headingPath: headingPath.filter(Boolean) });
        return;
      }
      if (!fence && !value.trim()) { flush(); return; }
      const nextKind = fence || marker ? "code" : table ? "table" : "paragraph";
      if (!fence && start !== null && nextKind !== kind) flush();
      if (start === null) { start = line.index; kind = nextKind; currentHeadings = headingPath.filter(Boolean); }
      end = line.index + value.length;
      if (marker) {
        if (fence && marker[1][0] === fence[0] && marker[1].length >= fence.length) { fence = ""; flush(); }
        else if (!fence) fence = marker[1];
      }
    });
    flush();
    if (Array.isArray(material.blocks) && material.blocks.length) {
      blocks.length = 0;
      let lastEnd = 0;
      material.blocks.forEach(function (block) {
        if (!Number.isInteger(block.startCharacter) || !Number.isInteger(block.endCharacter) || block.startCharacter < lastEnd || block.endCharacter <= block.startCharacter || block.endCharacter > text.length || text.slice(block.startCharacter, block.endCharacter) !== block.text) throw new Error("解析文字与段落位置不一致，请重新选择范围");
        blocks.push({ start: block.startCharacter, end: block.endCharacter, kind: block.kind || "paragraph", headingPath: block.headingPath || [],
          groupId: block.groupId, locator: block.locator, pageNumber: block.pageNumber || block.locator?.pageNumber || null, sourceBlockId: block.id, selectionId: block.selectionId });
        lastEnd = block.endCharacter;
      });
    }
    const packed = [];
    blocks.forEach(function (block) {
      const previous = packed.at(-1);
      if (!block.locator && !previous?.locator && previous && previous.kind === "paragraph" && block.kind === "paragraph" &&
          JSON.stringify(previous.headingPath) === JSON.stringify(block.headingPath) && block.end - previous.start <= CHUNK_CHARACTERS) previous.end = block.end;
      else packed.push(Object.assign({}, block));
    });
    const chunks = [];
    packed.forEach(function (block) {
      let cursor = block.start;
      const groupId = material.id + "_block_" + (block.groupId || block.start);
      while (cursor < block.end) {
        let limit = Math.min(cursor + CHUNK_CHARACTERS, block.end);
        if (limit < block.end) {
          const sample = text.slice(cursor, limit);
          const separators = Array.from(sample.matchAll(/[。！？；\n]|[.!?;]\s/g));
          const last = separators.at(-1);
          if (last && last.index > CHUNK_CHARACTERS / 2) limit = cursor + last.index + last[0].length;
          // Never cut a UTF-16 surrogate pair in half.
          if (/[\uD800-\uDBFF]/.test(text[limit - 1])) limit -= 1;
        }
        chunks.push({ id: material.id + "_chunk_" + cursor, materialId: material.id, version: material.version || 1,
          startCharacter: cursor, endCharacter: limit, kind: block.kind, groupId: groupId, headingPath: block.headingPath,
          locator: block.locator, sourceBlockId: block.sourceBlockId, selectionId: block.selectionId,
          pageNumber: block.pageNumber || (material.pages || []).find(function (page) { return cursor >= page.startCharacter && cursor < page.endCharacter; })?.pageNumber || null });
        cursor = limit;
      }
    });
    return chunks;
  }

  function chunkView(material, chunk) {
    return Object.assign({}, chunk, { text: material.text.slice(chunk.startCharacter, chunk.endCharacter) });
  }


  return { MAX_CHARACTERS: MAX_CHARACTERS, CHUNK_CHARACTERS: CHUNK_CHARACTERS, splitMaterial: splitMaterial, chunkView: chunkView };
});
