(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaDocumentStructure = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const PARSER_VERSION = "document-v1/pdfjs-6.3.289/mammoth-1.12.2";
  const LIMITS = { fileBytes: 20 * 1024 * 1024, pagesPerBatch: 100, selectedCharacters: 1_000_000, extractedCharacters: 2_000_000,
    zipBytes: 64 * 1024 * 1024, zipEntryBytes: 16 * 1024 * 1024, zipEntries: 2048, blocks: 30000, renderPixels: 3_000_000 };

  function parsePageRange(value, count) {
    const pages = new Set();
    const parts = String(value || "").replace(/，/g, ",").split(",");
    if (!parts.length || !parts[0].trim()) throw new Error("请填写页码，例如 1-5,8");
    for (const part of parts) {
      const match = part.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
      if (!match) throw new Error("页码格式应为 1-5,8");
      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      if (start < 1 || end < start || end > count) throw new Error("页码超出文件范围");
      if (end - start + 1 > LIMITS.pagesPerBatch) throw new Error("每批最多选择 100 页，其余页可稍后继续");
      for (let page = start; page <= end; page += 1) pages.add(page);
      if (pages.size > LIMITS.pagesPerBatch) throw new Error("每批最多选择 100 页，其余页可稍后继续");
    }
    return Array.from(pages).sort(function (a, b) { return a - b; });
  }
  function assemble(blocks) {
    let text = "";
    const rows = [];
    for (const block of blocks) {
      const content = String(block.text || "").trim();
      if (!content) continue;
      if (text) text += "\n\n";
      rows.push(Object.assign({}, block, { text: content, startCharacter: text.length, endCharacter: text.length + content.length }));
      text += content;
    }
    return { text: text, blocks: rows, parserVersion: PARSER_VERSION };
  }
  function regionFor(box, width, height) {
    return { x: Math.max(0, Math.min(1, box.x / width)), y: Math.max(0, Math.min(1, box.y / height)),
      width: Math.max(0, Math.min(1, box.w / width)), height: Math.max(0, Math.min(1, box.h / height)) };
  }
  function textJoin(left, right, gap, font) {
    if (!left) return right;
    const adjacentCjk = /[\p{Script=Han}\p{P}]$/u.test(left) || /^[\p{Script=Han}\p{P}]/u.test(right);
    return left + (gap > font * 0.12 && !adjacentCjk && !/\s$/.test(left) ? " " : "") + right;
  }
  function pdfPageBlocks(items, pageNumber, width, height, transformPoint) {
    const words = items.filter(function (item) { return item.str && item.str.trim(); }).map(function (item) {
      const point = transformPoint(item.transform[4], item.transform[5]);
      const font = Math.max(1, Math.hypot(item.transform[2], item.transform[3]) || item.height || 12);
      return { text: item.str, x: point[0], y: point[1] - font, w: Math.max(item.width, font / 2), h: font };
    }).sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    const lines = [];
    for (const word of words) {
      const line = lines.slice(-12).find(function (row) { return Math.abs(row.y - word.y) < Math.min(row.h, word.h) * 0.45 && word.x >= row.x && word.x - (row.x + row.w) < Math.max(row.h * 2, width * 0.025); });
      if (line) { line.text = textJoin(line.text, word.text, word.x - (line.x + line.w), word.h); line.w = Math.max(line.w, word.x + word.w - line.x); line.h = Math.max(line.h, word.h); }
      else lines.push(Object.assign({}, word));
    }
    const body = lines.map(function (row) { return row.h; }).sort(function (a, b) { return a - b; });
    const font = body[Math.floor(body.length / 2)] || 12;
    const left = lines.filter(function (line) { return line.x < width * 0.45 && line.x + line.w < width * 0.54 && line.y > height * 0.07 && line.y < height * 0.93; });
    const right = lines.filter(function (line) { return line.x >= width * 0.48 && line.y > height * 0.07 && line.y < height * 0.93; });
    const columns = left.length >= 2 && right.length >= 2 && Math.min(...right.map(function (r) { return r.y; })) < Math.max(...left.map(function (r) { return r.y + r.h; })) ? 2 : 1;
    let ordered = lines.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    if (columns === 2) {
      const span = function (line) { return line.y <= height * 0.07 || line.y >= height * 0.93 || line.x < width * 0.48 && line.x + line.w > width * 0.54; };
      const result = [];
      let group = [];
      function flush() { result.push(...group.filter(function (line) { return line.x < width * 0.48; }), ...group.filter(function (line) { return line.x >= width * 0.48; })); group = []; }
      for (const line of ordered) { if (span(line)) { flush(); result.push(line); } else group.push(line); }
      flush(); ordered = result;
    }
    const blocks = [];
    for (const line of ordered) {
      const heading = line.h > font * 1.18 && line.text.length < 150;
      const previous = blocks[blocks.length - 1];
      const sameColumn = previous && Math.abs(previous.box.x - line.x) < font * 1.5;
      const margin = line.y < height * 0.07 || line.y > height * 0.93;
      if (previous && previous.kind === "paragraph" && !heading && !margin && !previous.margin && sameColumn && line.y > previous.lastY && line.y - previous.lastY < font * 1.7) {
        previous.text = textJoin(previous.text, line.text, font, font);
        previous.box.w = Math.max(previous.box.w, line.w); previous.box.h = line.y + line.h - previous.box.y; previous.lastY = line.y;
      } else blocks.push({ text: line.text, kind: heading ? "heading" : "paragraph", box: { x: line.x, y: line.y, w: line.w, h: line.h }, lastY: line.y, margin: margin });
    }
    return { columns: columns, blocks: blocks.map(function (block, i) {
      const region = regionFor(block.box, width, height);
      return { id: "pdf_p" + pageNumber + "_b" + i, text: block.text, kind: block.kind, headingPath: [], pageNumber: pageNumber,
        locator: { format: "pdf", pageNumber: pageNumber, region: region, extractionMethod: "text", parserVersion: PARSER_VERSION, revision: 1 }, margin: block.margin };
    }) };
  }
  function cleanRepeatedMargins(pages) {
    const counts = new Map();
    const signature = function (text) { return text.replace(/\d+/g, "#").replace(/\s+/g, "").slice(0, 160); };
    for (const page of pages) {
      const seen = new Set((page.rawBlocks || page.blocks || []).filter(function (block) { return block.margin; }).map(function (block) { return signature(block.text); }));
      seen.forEach(function (key) { counts.set(key, (counts.get(key) || 0) + 1); });
    }
    return pages.map(function (page) {
      if (["ocr", "ocr_corrected", "manual"].includes(page.extractionMethod)) return page;
      const removed = [];
      const blocks = (page.rawBlocks || page.blocks || []).filter(function (block) {
        const repeated = block.margin && (counts.get(signature(block.text)) || 0) >= Math.max(2, Math.ceil(pages.length * 0.6));
        if (repeated) removed.push(block.text);
        return !repeated;
      });
      return Object.assign({}, page, { blocks: blocks, removedMargins: removed });
    });
  }
  function docxBlocks(document) {
    const blocks = [];
    const warnings = new Set();
    const headings = [];
    let paragraph = 0;
    let table = 0;
    function plain(node, depth) {
      if (depth > 80) throw new Error("DOCX 结构嵌套过深，请简化文件后导入");
      if (node.type === "text") return node.value || "";
      if (node.type === "tab") return "\t";
      if (node.type === "break") return "\n";
      if (["image", "noteReference", "commentReference"].includes(node.type)) warnings.add("图片、公式、批注及脚注可能未进入正文，请对照原文件");
      return (node.children || []).map(function (child) { return plain(child, depth + 1); }).join("");
    }
    function walk(nodes, cell, depth) {
      if (depth > 40) throw new Error("DOCX 表格嵌套过深，请简化文件后导入");
      for (const node of nodes || []) {
        if (blocks.length >= LIMITS.blocks) throw new Error("文档结构过多，请按章节拆成较小文件");
        if (node.type === "paragraph") {
          paragraph += 1;
          const text = plain(node, 0).trim();
          const match = String(node.styleId || node.styleName || "").match(/(?:heading|标题)\s*([1-9])/i) || String(node.styleName || "").match(/(?:heading|标题)\s*([1-9])/i);
          const level = match ? Number(match[1]) : 0;
          if (level && !cell) { headings.length = level - 1; headings[level - 1] = text; }
          if (!text) continue;
          const locator = Object.assign({ format: "docx", paragraphNumber: paragraph, extractionMethod: "text", parserVersion: PARSER_VERSION, revision: 1 }, cell || {});
          blocks.push({ id: "docx_p" + paragraph, text: text, kind: cell ? "table" : level ? "heading" : node.numbering ? "list" : "paragraph",
            headingPath: headings.filter(Boolean), level: level || null, listLevel: node.numbering ? Number(node.numbering.level) || 0 : null,
            groupId: cell ? "docx_table" + cell.tableNumber : null, locator: locator });
        } else if (node.type === "table") {
          table += 1;
          const currentTable = table;
          if (cell) warnings.add("嵌套或合并表格已按单元格读取，请核对行列关系");
          (node.children || []).forEach(function (row, rowIndex) {
            let column = 1;
            (row.children || []).forEach(function (item) {
              walk(item.children, { tableNumber: currentTable, rowNumber: rowIndex + 1, columnNumber: column, rowSpan: item.rowSpan || 1, columnSpan: item.colSpan || 1 }, depth + 1);
              column += item.colSpan || 1;
            });
          });
        } else if (node.children) walk(node.children, cell, depth + 1);
      }
    }
    walk(document.children, null, 0);
    const result = assemble(blocks);
    if (result.text.length > LIMITS.extractedCharacters) throw new Error("解析文字超过 200 万字，请拆分文件后导入");
    return Object.assign(result, { warnings: Array.from(warnings), paragraphCount: paragraph, tableCount: table });
  }
  function selectionFromBlocks(blocks, ids) {
    const chosen = new Set(ids);
    const selected = blocks.filter(function (block) { return chosen.has(block.id); });
    if (selected.length !== chosen.size) throw new Error("选择的段落已变化，请刷新预览");
    const result = assemble(selected);
    if (!result.text.trim()) throw new Error("所选范围没有可用文字，请先识别扫描页或选择其他范围");
    if (result.text.length > LIMITS.selectedCharacters) throw new Error("选中范围超过 100 万字，请分批制卡");
    return result;
  }
  return { PARSER_VERSION: PARSER_VERSION, LIMITS: LIMITS, parsePageRange: parsePageRange, assemble: assemble,
    pdfPageBlocks: pdfPageBlocks, cleanRepeatedMargins: cleanRepeatedMargins, docxBlocks: docxBlocks, selectionFromBlocks: selectionFromBlocks };
});
