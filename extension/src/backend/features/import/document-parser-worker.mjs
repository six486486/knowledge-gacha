import '../../../shared/document-structure.js';
import '../../../shared/runtime-utils.js';
import '../../../shared/rag/query-analyzer.js';
import '../../../shared/rag/structural-chunker.js';
import '../../../shared/rag/lexical-retriever.js';
import '../../../shared/rag/context-assembler.js';
import '../../../shared/material-index.js';

const structure = globalThis.KnowledgeGachaDocumentStructure;
const { LIMITS, PARSER_VERSION } = structure;
const acknowledgements = new Map();
let serial = 0;
async function progress(value) {
  const id = ++serial;
  const receipt = new Promise(resolve => acknowledgements.set(id, resolve));
  postMessage({ type: 'progress', id, value });
  await receipt;
}

class WorkerCanvasFactory {
  create(width, height) { const canvas = new OffscreenCanvas(Math.ceil(width), Math.ceil(height)); return { canvas, context: canvas.getContext('2d') }; }
  reset(target, width, height) { target.canvas.width = Math.ceil(width); target.canvas.height = Math.ceil(height); }
  destroy(target) { target.canvas.width = target.canvas.height = 1; target.canvas = target.context = null; }
}
async function loadPdf(bytes) {
  const pdf = await import('../../../../vendor/pdfjs/pdf.mjs');
  // The outer, cancellable worker already isolates parsing and rendering from the UI.
  globalThis.pdfjsWorker = await import('../../../../vendor/pdfjs/pdf.worker.mjs');
  const base = new URL('../../../../vendor/pdfjs/', import.meta.url).href;
  pdf.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.mjs';
  const loading = pdf.getDocument({ data: bytes, cMapUrl: base + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/', useWorkerFetch: true,
    isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: true,
    CanvasFactory: WorkerCanvasFactory, maxImageSize: 16_000_000, canvasMaxAreaInBytes: LIMITS.renderPixels * 4 });
  try { return { document: await loading.promise, pdf }; }
  catch (error) {
    await loading.destroy();
    if (error.name === 'PasswordException') throw new Error('PDF 已加密，请先在本地解密后重新导入');
    throw new Error('PDF 损坏或无法读取：' + error.message);
  }
}
async function inspectPdf(document) {
  const outline = [];
  async function visit(nodes, depth) {
    if (depth > 8) return;
    for (const node of nodes || []) {
      if (outline.length >= 500) return;
      let pageNumber = null;
      try {
        const dest = typeof node.dest === 'string' ? await document.getDestination(node.dest) : node.dest;
        if (dest?.[0] != null) pageNumber = typeof dest[0] === 'number' ? dest[0] + 1 : await document.getPageIndex(dest[0]) + 1;
      } catch (_) { /* A broken bookmark does not make the body unreadable. */ }
      outline.push({ title: String(node.title || '').slice(0, 200), pageNumber, level: depth });
      await visit(node.items, depth + 1);
    }
  }
  await visit(await document.getOutline(), 0);
  return { kind: 'pdf', pageCount: document.numPages, outline, parserVersion: PARSER_VERSION };
}
async function parsePdf(document, pdf, pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > LIMITS.pagesPerBatch || new Set(pages).size !== pages.length || pages.some(page => !Number.isInteger(page) || page < 1 || page > document.numPages)) throw new Error('请选择文件内最多 100 个不同页码');
  let characters = 0;
  for (const pageNumber of pages) {
    const started = performance.now();
    let page;
    try {
      page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      if (content.items.length > 100000) throw new Error('单页对象过多，请将这一页单独导出后重试');
      const result = structure.pdfPageBlocks(content.items, pageNumber, viewport.width, viewport.height, (x, y) => viewport.convertToViewportPoint(x, y));
      const operators = await page.getOperatorList();
      const imageOps = new Set([pdf.OPS.paintImageXObject, pdf.OPS.paintInlineImageXObject, pdf.OPS.paintImageMaskXObject]);
      const hasImages = operators.fnArray.some(op => imageOps.has(op));
      const text = result.blocks.map(block => block.text).join('\n');
      characters += text.length;
      if (characters > LIMITS.extractedCharacters) throw new Error('本批文字超过 200 万字，请缩小页码范围');
      const sparse = text.replace(/[\s\p{P}\p{N}]/gu, '').length < 12;
      await progress({ type: 'page', page: { pageNumber, status: sparse ? 'needs_ocr' : 'ready', hasImages,
        rawBlocks: result.blocks, blocks: result.blocks, columns: result.columns, extractionMethod: 'text', revision: 1,
        warnings: hasImages ? ['本页含图片；图片中的内容尚未识别，可按需补充识别'] : [],
        metrics: { elapsedMs: Math.round(performance.now() - started), characters: text.length, textItems: content.items.length } } });
    } catch (error) {
      await progress({ type: 'page', page: { pageNumber, status: 'failed', blocks: [], error: error.message, metrics: { elapsedMs: Math.round(performance.now() - started) } } });
      if (characters > LIMITS.extractedCharacters) break;
    } finally { page?.cleanup(); }
  }
  return { parsed: true };
}
async function renderPdf(document, pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error('页码超出文件范围');
  const page = await document.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(2, Math.sqrt(LIMITS.renderPixels / (original.width * original.height)));
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'white' }).promise;
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  page.cleanup();
  return { pageNumber, dataUrl: 'data:image/jpeg;base64,' + btoa(binary), width: canvas.width, height: canvas.height, region: { x: 0, y: 0, width: 1, height: 1 } };
}

// Check both declared ZIP sizes and actual streamed inflation before Mammoth sees it.
// No XML or converted HTML is ever inserted into a DOM.
async function inspectZip(bytes) {
  const data = new DataView(bytes);
  let end = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i -= 1) if (data.getUint32(i, true) === 0x06054b50 && i + 22 + data.getUint16(i + 20, true) === bytes.byteLength) { end = i; break; }
  if (end < 0 || data.getUint16(end + 4, true) || data.getUint16(end + 6, true)) throw new Error('DOCX 压缩结构损坏或不受支持');
  const count = data.getUint16(end + 10, true);
  if (!count || count > LIMITS.zipEntries) throw new Error('DOCX 内部文件过多，请拆分文件');
  let cursor = data.getUint32(end + 16, true);
  const directoryEnd = cursor + data.getUint32(end + 12, true);
  if (directoryEnd > end) throw new Error('DOCX 压缩目录损坏');
  let total = 0;
  const names = new Set();
  const warnings = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end || data.getUint32(cursor, true) !== 0x02014b50) throw new Error('DOCX 内部文件目录损坏');
    const flags = data.getUint16(cursor + 8, true);
    const method = data.getUint16(cursor + 10, true);
    const compressed = data.getUint32(cursor + 20, true);
    const size = data.getUint32(cursor + 24, true);
    const nameSize = data.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameSize));
    const local = data.getUint32(cursor + 42, true);
    cursor += 46 + nameSize + data.getUint16(cursor + 30, true) + data.getUint16(cursor + 32, true);
    total += size;
    if (flags & 1) throw new Error('DOCX 已加密，请在本地解密后导入');
    if (![0, 8].includes(method) || size > LIMITS.zipEntryBytes || total > LIMITS.zipBytes || cursor > directoryEnd) throw new Error('DOCX 解压规模超过本次预算，请拆分文件');
    if (names.has(name) || name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error('DOCX 内部路径重复或无效');
    names.add(name);
    if (local + 30 > end || data.getUint32(local, true) !== 0x04034b50 || data.getUint16(local + 8, true) !== method) throw new Error('DOCX 内部文件头损坏');
    const localNameSize = data.getUint16(local + 26, true);
    const localName = new TextDecoder().decode(bytes.slice(local + 30, local + 30 + localNameSize));
    if (localName !== name) throw new Error('DOCX 内部文件名不一致');
    const offset = local + 30 + localNameSize + data.getUint16(local + 28, true);
    if (offset + compressed > end) throw new Error('DOCX 文件内容不完整');
    const blob = new Blob([bytes.slice(offset, offset + compressed)]);
    const stream = method === 8 ? blob.stream().pipeThrough(new DecompressionStream('deflate-raw')) : blob.stream();
    const reader = stream.getReader();
    let actual = 0;
    let xml = '';
    const decoder = name === 'word/document.xml' ? new TextDecoder() : null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      actual += value.byteLength;
      if (actual > size || actual > LIMITS.zipEntryBytes) { await reader.cancel(); throw new Error('DOCX 解压大小与目录不符，已停止解析'); }
      if (decoder) xml += decoder.decode(value, { stream: true });
    }
    if (actual !== size) throw new Error('DOCX 解压内容不完整');
    if (decoder) {
      xml += decoder.decode();
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 包含不受支持的实体定义');
      if (/<(?:m:)?oMath|<w:altChunk|<w:txbxContent/.test(xml)) warnings.push('公式、嵌入文档或文本框未完整提取，请对照原文件');
      if (/<w:gridSpan|<w:vMerge/.test(xml)) warnings.push('表格包含合并单元格，请核对行列关系');
    }
  }
  if (!names.has('word/document.xml') || !names.has('[Content_Types].xml')) throw new Error('这不是有效的 DOCX 文件');
  return { zipBytes: total, zipEntries: count, warnings };
}
async function parseDocx(bytes) {
  const checked = await inspectZip(bytes);
  await import('../../../../vendor/mammoth/mammoth.browser.min.js');
  let parsed;
  const converted = await globalThis.mammoth.convertToHtml({ arrayBuffer: bytes }, {
    includeEmbeddedStyleMap: false, externalFileAccess: false,
    transformDocument(document) { parsed = structure.docxBlocks(document); return document; },
    convertImage: globalThis.mammoth.images.imgElement(async () => ({ src: '' }))
  });
  if (!parsed?.text.trim()) throw new Error('DOCX 没有可用正文，图片型文档请导出 PDF 后识别');
  return Object.assign(parsed, { kind: 'docx', pageCount: null, metrics: { zipBytes: checked.zipBytes, zipEntries: checked.zipEntries },
    warnings: Array.from(new Set(parsed.warnings.concat(checked.warnings, converted.messages.map(item => String(item.message).slice(0, 300))))) });
}
function parseText(bytes, kind) {
  const prefix = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength));
  const encoding = prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf-16le' : prefix[0] === 0xfe && prefix[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
  if (!text.trim() || text.includes('\0')) throw new Error('文件没有可用文字，请使用 UTF-8 或 UTF-16 的文本文件');
  if (text.length > LIMITS.extractedCharacters) throw new Error('文本超过 200 万字，请先按章节拆分');
  const material = { id: 'text', text };
  const chunks = globalThis.KnowledgeGachaMaterialIndex.splitMaterial(material, LIMITS.extractedCharacters);
  const blocks = chunks.map((chunk, i) => ({ id: 'text_b' + i, text: text.slice(chunk.startCharacter, chunk.endCharacter), kind: chunk.kind,
    headingPath: chunk.headingPath, groupId: chunk.groupId, locator: { format: kind, startCharacter: chunk.startCharacter, endCharacter: chunk.endCharacter, extractionMethod: 'text', parserVersion: PARSER_VERSION, revision: 1 } }));
  return Object.assign(structure.assemble(blocks), { kind, pageCount: null, warnings: [] });
}
async function run(input) {
  if (!input.bytes || input.bytes.byteLength > LIMITS.fileBytes) throw new Error('本次最多导入 20 MB 的文件');
  const started = performance.now();
  const inputBytes = input.bytes.byteLength;
  let result;
  if (input.kind === 'pdf') {
    const { document, pdf } = await loadPdf(input.bytes);
    try {
      result = input.operation === 'inspect' ? await inspectPdf(document) : input.operation === 'render' ? await renderPdf(document, input.pageNumber) : await parsePdf(document, pdf, input.pages);
    } finally { await document.loadingTask.destroy(); }
  } else if (input.kind === 'docx') {
    try { result = await parseDocx(input.bytes); }
    catch (error) { throw new Error('DOCX 解析失败：' + (/[\u4e00-\u9fff]/.test(error.message) ? error.message : '文件已损坏或内容不受支持，请在本地重新另存为 DOCX')); }
  } else result = parseText(input.bytes, input.kind);
  return Object.assign(result, { metrics: Object.assign({}, result.metrics, { elapsedMs: Math.round(performance.now() - started), inputBytes }) });
}
globalThis.onmessage = async function (event) {
  if (event.data.type === 'ack') { acknowledgements.get(event.data.id)?.(); acknowledgements.delete(event.data.id); return; }
  if (event.data.type !== 'run') return;
  try { postMessage({ type: 'result', value: await run(event.data.input) }); }
  catch (error) { postMessage({ type: 'error', message: error.message || '文件解析失败', code: error.name }); }
};
