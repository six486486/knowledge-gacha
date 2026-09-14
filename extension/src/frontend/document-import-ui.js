(function (root) {
  "use strict";
  function createDocumentImportUI(options) {
    const api = options.api;
    const escape = options.escapeHtml;
    const attr = options.escapeAttr;
    const structure = root.KnowledgeGachaDocumentStructure;
    let job = null;
    let busy = "";
    let operationVersion = 0;
    let pageRange = "";
    let selectedPages = new Set();
    let selectedBlocks = new Set();
    let ocrPages = new Set();
    let chapterIndex = 0;
    let blockOffset = 0;
    const pageSize = 30;
    function accept(value, reset) {
      job = value;
      if (reset) {
        selectedPages = new Set(job.selectedPages || []); selectedBlocks = new Set(job.selectedBlockIds || []);
        pageRange = compactPages(Array.from(selectedPages)); chapterIndex = 0; blockOffset = 0;
        ocrPages = new Set(job.pages.filter(function (page) { return selectedPages.has(page.pageNumber) && (page.status === "needs_ocr" || page.ocrError); }).map(function (page) { return page.pageNumber; }));
      }
      if (options.isVisible()) render();
    }
    function compactPages(pages) {
      const sorted = Array.from(new Set(pages)).sort(function (a, b) { return a - b; });
      const ranges = [];
      for (const number of sorted) { const last = ranges[ranges.length - 1]; if (last && number === last[1] + 1) last[1] = number; else ranges.push([number, number]); }
      return ranges.map(function (pair) { return pair[0] === pair[1] ? String(pair[0]) : pair[0] + "-" + pair[1]; }).join(",");
    }
    async function work(label, operation, reset, interrupt) {
      if (busy && !interrupt) return;
      const version = ++operationVersion;
      busy = label; render();
      try {
        const result = await operation(function (value, resetProgress) { if (version === operationVersion) accept(value, resetProgress); });
        if (version !== operationVersion) return;
        if (result?.job) accept(result.job, reset !== false);
        return result;
      } catch (error) { if (version === operationVersion) options.toast(error.message || "处理尚未完成，请重试"); }
      finally { if (version === operationVersion) { busy = ""; if (options.isVisible()) render(); } }
    }
    async function openFile(file) {
      if (busy) { options.toast("请先暂停当前导入"); return; }
      await work("正在读取文件", async function (progress) {
        if (job) {
          if (job.keepDraft) await api.releaseDocumentImport(job.id);
          else await api.discardDocumentImport(job.id);
        }
        job = null; options.showPage();
        return api.importDocumentFile(file, { onProgress: function (value) { progress(value, true); } });
      });
    }
    async function open(id) {
      if (busy) { if (job?.id === id) options.showPage(); else options.toast("当前材料仍在处理，请先暂停后再打开另一份"); return; }
      const result = await work("正在打开导入", async function () {
        if (job && job.id !== id) { await api.releaseDocumentImport(job.id); await options.onChange(); }
        return api.getDocumentImport(id);
      });
      if (result?.job) options.showPage();
    }
    function locator(block) {
      const value = block.locator || {};
      if (value.tableNumber) return "表 " + value.tableNumber + " · 行 " + value.rowNumber + " 列 " + value.columnNumber + " · 段 " + value.paragraphNumber;
      return value.paragraphNumber ? "段 " + value.paragraphNumber : block.kind === "heading" ? "标题" : "正文";
    }
    function chapters() {
      const groups = [];
      for (const block of job.blocks) {
        const title = block.headingPath?.join(" / ") || "正文";
        const last = groups[groups.length - 1];
        if (last?.title === title) last.blocks.push(block);
        else groups.push({ title: title, blocks: [block] });
      }
      return groups;
    }
    function pdfMarkup() {
      const processed = new Set(job.pages.map(function (page) { return page.pageNumber; }));
      const unprocessed = Array.from(selectedPages).filter(function (number) { return !processed.has(number); }).length;
      const status = { ready: "可用文字", needs_ocr: "待识别或补充文字", failed: "解析失败" };
      return '<p class="import-count">共 ' + job.pageCount + ' 页 · 已解析 ' + job.pages.filter(function (page) { return page.status !== "failed"; }).length + ' 页 · 本次选 ' + selectedPages.size + ' 页' + (unprocessed ? '，其中 ' + unprocessed + ' 页尚未解析' : '') + '</p>' +
        (job.outline.length ? '<details class="import-outline"><summary>文件目录（' + job.outline.length + ' 项）</summary>' + job.outline.map(function (item, i) {
          return '<button type="button" class="source-inline-action" data-outline="' + i + '" ' + (!item.pageNumber ? 'disabled' : '') + '>' + escape(item.title) + (item.pageNumber ? ' · 第 ' + item.pageNumber + ' 页' : '') + '</button>';
        }).join('') + '</details>' : '<p class="meta">文件没有目录书签，可直接选择页码。</p>') +
        '<label class="field-label" for="import-page-range">本次页码（每批最多 100 页）</label><input class="form-input" id="import-page-range" value="' + attr(pageRange) + '" placeholder="例如 1-5,8" ' + (busy ? 'disabled' : '') + '>' +
        '<button class="secondary-btn" type="button" id="import-parse" ' + (busy ? 'disabled' : '') + '>解析所选范围 / 继续未完成页</button>' +
        '<p class="meta">已有结果会保留，重试只处理失败或尚未解析的页。图片内容需另行识别；复杂公式、跨页表格请对照原页。</p>' +
        '<div class="import-pages" aria-label="页面解析结果">' + job.pages.map(function (page) {
          const number = page.pageNumber;
          const text = page.blocks.map(function (block) { return block.text; }).join(' ');
          return '<article class="import-page"><div class="import-page-head"><label><input type="checkbox" data-import-page="' + number + '" ' + (selectedPages.has(number) ? 'checked ' : '') + (busy ? 'disabled' : '') + '> 第 ' + number + ' 页</label><span class="import-status ' + (page.status !== 'ready' ? 'is-warning' : '') + '">' + status[page.status] + '</span></div>' +
            (page.error ? '<p class="citation-error">' + escape(page.error) + '</p>' : '<p class="import-snippet">' + escape(text.slice(0, 120) || '本页没有可用的文字层') + (text.length > 120 ? '…' : '') + '</p>') +
            (page.removedMargins?.length ? '<p class="meta">已略去重复页眉或页脚 ' + page.removedMargins.length + ' 处</p>' : '') +
            (page.columns === 2 ? '<p class="meta">按左右两栏读取，请核对顺序</p>' : '') +
            (page.hasImages && !page.ocr?.reviewed ? '<p class="meta">含图片，当前只包含文字层</p>' : '') +
            (page.ocr ? '<p class="meta">' + (page.ocr.reviewed ? '识别文字已确认 · 版本 ' + page.revision : '已识别，等待确认文字') + '</p>' : '') +
            (page.ocrError ? '<p class="citation-error">' + escape(page.ocrError) + '</p>' : '') +
            '<div class="import-page-actions"><button type="button" class="source-inline-action" data-preview-page="' + number + '" ' + (busy ? 'disabled' : '') + '>预览 / 校对本页</button>' +
            (page.status !== 'failed' ? '<label><input type="checkbox" data-ocr-page="' + number + '" ' + (ocrPages.has(number) ? 'checked ' : '') + (busy ? 'disabled' : '') + '> 用模型识别此页</label>' : '') + '</div></article>';
        }).join('') + '</div>' +
        (job.pages.length ? '<button class="secondary-btn" id="import-ocr" type="button" ' + (busy || !ocrPages.size ? 'disabled' : '') + '>识别选定页面 / 重试未成功页</button><p class="meta">每次最多识别 3 页；只发送确认过的页面图片。</p>' : '');
    }
    function docxMarkup() {
      const groups = chapters();
      const current = groups[chapterIndex] || groups[0];
      if (!current) return '';
      return '<p class="import-count">' + (job.kind === 'docx' ? job.paragraphCount + ' 段 · ' + job.tableCount + ' 个表格 · ' : '') + '已选择 ' + selectedBlocks.size + ' / ' + job.blocks.length + ' 个段落块</p>' +
        '<p class="meta">按标题、段落与单元格定位，不使用固定页码。可按章节选择，再取消不需要的段落。</p>' +
        '<div class="import-chapters" aria-label="章节选择">' + groups.map(function (group, i) {
          const checked = group.blocks.every(function (block) { return selectedBlocks.has(block.id); });
          return '<label><input type="checkbox" data-import-chapter="' + i + '" ' + (checked ? 'checked ' : '') + (busy ? 'disabled' : '') + '><span>' + escape(group.title) + '（' + group.blocks.length + '）</span></label>';
        }).join('') + '</div><div class="import-page-actions"><button type="button" class="source-inline-action" id="import-select-all">全选</button><button type="button" class="source-inline-action" id="import-select-none">清空选择</button></div>' +
        '<label class="field-label" for="import-chapter-preview">查看章节内容</label><select class="form-input" id="import-chapter-preview">' + groups.map(function (group, i) { return '<option value="' + i + '" ' + (i === chapterIndex ? 'selected' : '') + '>' + escape(group.title) + '</option>'; }).join('') + '</select>' +
        '<div class="import-blocks" aria-label="段落预览">' + current.blocks.slice(blockOffset, blockOffset + pageSize).map(function (block) {
          return '<label class="import-block"><input type="checkbox" data-import-block="' + attr(block.id) + '" ' + (selectedBlocks.has(block.id) ? 'checked' : '') + '><span><strong>' + escape(locator(block)) + '</strong><span class="import-block-text">' + escape(block.text) + '</span></span></label>';
        }).join('') + '</div>' + (current.blocks.length > pageSize ? '<div class="import-page-actions"><button class="secondary-btn" id="import-block-prev" type="button" ' + (!blockOffset ? 'disabled' : '') + '>上一组</button><span>' + (blockOffset + 1) + '–' + Math.min(current.blocks.length, blockOffset + pageSize) + ' / ' + current.blocks.length + '</span><button class="secondary-btn" id="import-block-next" type="button" ' + (blockOffset + pageSize >= current.blocks.length ? 'disabled' : '') + '>下一组</button></div>' : '');
    }
    function render() {
      if (!options.isVisible()) return;
      const page = options.page;
      if (!job) { page.innerHTML = '<section class="capture-panel"><h2 class="section-title">' + (busy ? '正在打开文件…' : '选择文件开始导入') + '</h2><button class="secondary-btn" id="import-back" type="button">返回制卡</button></section>'; page.querySelector('#import-back').onclick = options.goFeed; return; }
      page.innerHTML = '<section class="capture-panel import-panel"><p class="capture-kicker">导入 · 选择范围 · 制卡</p><h2 class="section-title">' + escape(job.title) + '</h2><p class="meta">' + (job.fileBytes / 1024 / 1024).toFixed(2) + ' MB · 文件在本地解析</p>' +
        (busy ? '<div class="capture-feedback" role="status">' + escape(busy) + '… 已完成结果会逐页保留。</div>' : '') +
        (job.error ? '<p class="citation-error" role="alert">' + escape(job.error) + '</p>' : '') +
        ((job.kind === 'pdf' && job.pageCount) ? pdfMarkup() : job.blocks.length ? docxMarkup() : '<button class="secondary-btn" id="import-inspect-retry" type="button" ' + (busy ? 'disabled' : '') + '>重试读取文件</button>') +
        (job.warnings?.length ? '<details class="import-warnings"><summary>需要核对的内容（' + job.warnings.length + '）</summary>' + job.warnings.map(function (warning) { return '<p>' + escape(warning) + '</p>'; }).join('') + '</details>' : '') +
        '<div class="import-finish"><button class="primary-btn" id="import-use" type="button" ' + (busy || !(selectedPages.size || selectedBlocks.size) ? 'disabled' : '') + '>使用选定范围制卡</button>' +
        (busy ? '<button class="secondary-btn" id="import-pause" type="button">暂停处理</button>' : '<button class="secondary-btn" id="import-later" type="button">保存导入草稿，稍后继续</button>') +
        '<button class="source-inline-action" id="import-discard" type="button" ' + (["正在打开导入", "正在保存导入草稿", "正在放弃导入"].includes(busy) ? 'disabled' : '') + '>放弃这次导入</button></div><p class="meta">尚未收下卡片时，文件仅用于当前任务；保存草稿会保留文件和解析进度。收下时可选择保留哪些来源材料。</p></section>';
      const bind = function (selector, action) { const node = page.querySelector(selector); if (node) node.onclick = action; };
      bind('#import-inspect-retry', function () { void work('正在重新读取文件', function (progress) { return api.retryDocumentImport(job.id, { onProgress: function (value) { progress(value, false); } }); }); });
      const range = page.querySelector('#import-page-range'); if (range) range.oninput = function () { pageRange = range.value; };
      bind('#import-parse', function () { try { selectedPages = new Set(structure.parsePageRange(pageRange, job.pageCount)); void work('正在解析所选页面', function (progress) { return api.parseImportedPages(job.id, { pages: Array.from(selectedPages) }, { onProgress: function (value) { progress(value, false); } }); }); } catch (error) { options.toast(error.message); } });
      page.querySelectorAll('[data-outline]').forEach(function (button) { button.onclick = function () { const i = Number(button.dataset.outline); const start = job.outline[i].pageNumber; const next = job.outline.slice(i + 1).find(function (item) { return item.pageNumber > start; }); pageRange = start + '-' + Math.min(start + 99, (next?.pageNumber || job.pageCount + 1) - 1); render(); }; });
      page.querySelectorAll('[data-import-page]').forEach(function (box) { box.onchange = function () { const number = Number(box.dataset.importPage); if (box.checked) selectedPages.add(number); else selectedPages.delete(number); render(); }; });
      page.querySelectorAll('[data-ocr-page]').forEach(function (box) { box.onchange = function () { const number = Number(box.dataset.ocrPage); if (box.checked) ocrPages.add(number); else ocrPages.delete(number); render(); }; });
      page.querySelectorAll('[data-preview-page]').forEach(function (button) { button.onclick = function () { void previewPage(Number(button.dataset.previewPage)); }; });
      bind('#import-ocr', confirmOcr);
      page.querySelectorAll('[data-import-chapter]').forEach(function (box) { box.onchange = function () { chapters()[Number(box.dataset.importChapter)].blocks.forEach(function (block) { if (box.checked) selectedBlocks.add(block.id); else selectedBlocks.delete(block.id); }); render(); }; });
      page.querySelectorAll('[data-import-block]').forEach(function (box) { box.onchange = function () { if (box.checked) selectedBlocks.add(box.dataset.importBlock); else selectedBlocks.delete(box.dataset.importBlock); render(); }; });
      bind('#import-select-all', function () { selectedBlocks = new Set(job.blocks.map(function (block) { return block.id; })); render(); });
      bind('#import-select-none', function () { selectedBlocks.clear(); render(); });
      const preview = page.querySelector('#import-chapter-preview'); if (preview) preview.onchange = function () { chapterIndex = Number(preview.value); blockOffset = 0; render(); };
      bind('#import-block-prev', function () { blockOffset = Math.max(0, blockOffset - pageSize); render(); });
      bind('#import-block-next', function () { blockOffset += pageSize; render(); });
      bind('#import-pause', async function () {
        const version = operationVersion, id = job.id;
        try { const result = await api.cancelDocumentImport(id); if (version === operationVersion && job?.id === id) accept(result.job, false); }
        catch (error) { if (version === operationVersion) options.toast(error.message); }
      });
      bind('#import-later', function () { void work('正在保存导入草稿', async function () { const result = await api.retainDocumentImport(job.id); await options.onChange(); options.goFeed(); options.toast('导入草稿和解析进度已保存'); return result; }); });
      bind('#import-discard', function () { void work('正在放弃导入', async function () { await api.discardDocumentImport(job.id); job = null; await options.onChange(); options.goFeed(); }, false, true); });
      bind('#import-use', async function () {
        const result = await work('正在准备选定范围', function () { return api.selectDocumentImport(job.id, job.kind === 'pdf' ? { pages: Array.from(selectedPages) } : { blockIds: Array.from(selectedBlocks) }); }, false);
        try { if (result?.material) await options.onMaterial(result.material); }
        catch (error) { options.toast(error.message || '选定范围尚未准备完成，请重试'); }
      });
    }
    function confirmOcr() {
      const pending = Array.from(ocrPages).filter(function (number) { return !job.pages.find(function (page) { return page.pageNumber === number; })?.ocr?.text; });
      if (!pending.length) { options.toast('所选页面已有识别结果，请预览并确认文字'); return; }
      options.openModal();
      options.modalContent.innerHTML = '<h2 class="modal-title">识别这些页面？</h2><p>将向当前模型发送「' + escape(job.title) + '」第 <strong>' + escape(compactPages(pending.slice(0, 3))) + '</strong> 页的图片。</p>' +
        (pending.length > 3 ? '<p class="meta">其余 ' + (pending.length - 3) + ' 页可在本次完成后继续。</p>' : '') + '<p class="meta">识别完成后可对照原页修改文字；只有确认的文字会用于制卡。</p><div class="modal-actions"><button class="secondary-btn" id="ocr-cancel" type="button">返回</button><button class="primary-btn" id="ocr-confirm" type="button">发送这些页并识别</button></div>';
      options.modalContent.querySelector('#ocr-cancel').onclick = options.closeModal;
      options.modalContent.querySelector('#ocr-confirm').onclick = function () { options.closeModal(); void work('正在识别页面', function (progress) { return api.recognizeImportedPages(job.id, { pages: Array.from(ocrPages), confirmTransmission: true }, { onProgress: function (value) { progress(value, false); } }); }, false); };
    }
    async function previewPage(number) {
      const page = job.pages.find(function (item) { return item.pageNumber === number; });
      options.openModal();
      const text = page.ocr ? page.ocr.correctedText || page.ocr.text : page.blocks.map(function (block) { return block.text; }).join('\n\n');
      options.modalContent.innerHTML = '<h2 class="modal-title">第 ' + number + ' 页 · 预览与校对</h2><div id="import-page-image"><button class="secondary-btn" id="import-show-page" type="button">显示原始页面</button></div>' +
        (page.ocr?.uncertain?.length ? '<p class="citation-error">待核对：' + escape(page.ocr.uncertain.join('；')) + '</p>' : '') +
        '<label class="field-label" for="import-correction">本页文字（可修改或补充）</label><textarea class="feed-input import-correction" id="import-correction" maxlength="30000">' + escape(text) + '</textarea>' +
        '<p class="meta">校对后保存一个新解析版本，引用仍指向这一原始页面。</p><div class="modal-actions"><button class="secondary-btn" id="import-preview-close" type="button">返回</button><button class="primary-btn" id="import-correct" type="button" ' + (page.status === 'failed' ? 'disabled' : '') + '>确认本页文字</button></div>';
      options.modalContent.querySelector('#import-preview-close').onclick = options.closeModal;
      options.modalContent.querySelector('#import-show-page').onclick = async function () {
        const target = options.modalContent.querySelector('#import-page-image'); target.textContent = '正在读取原页…';
        try { const image = await api.renderImportedPage(job.id, number); if (target.isConnected) target.innerHTML = '<img class="import-original-image" src="' + attr(image.dataUrl) + '" alt="第 ' + number + ' 页原始页面">'; }
        catch (error) { target.textContent = error.message; }
      };
      const confirm = options.modalContent.querySelector('#import-correct');
      confirm.onclick = function () {
        const id = job.id;
        const input = { pageNumber: number, text: options.modalContent.querySelector('#import-correction').value, expectedRevision: page.ocr?.revision || page.revision };
        void work('正在保存校对', async function () {
          const result = await api.correctImportedPage(id, input);
          if (confirm.isConnected) { options.closeModal(); options.toast('本页文字已确认'); }
          return result;
        }, false);
      };
    }
    async function showOriginal(id, pageNumber, sourceLocator, returnTo) {
      options.openModal(); options.modalContent.innerHTML = '<h2 class="modal-title">正在读取原始文件…</h2>';
      try {
        const original = await api.getDocumentOriginal(id);
        const isPdf = original.mimeType === 'application/pdf';
        let current = pageNumber || 1;
        options.modalContent.innerHTML = '<h2 class="modal-title">' + escape(original.name) + '</h2><p class="meta">已保留原始文件' + (isPdf ? ' · 共 ' + original.pageCount + ' 页' : ' · 按段落或单元格定位') + '</p><div class="import-page-actions"><button class="secondary-btn" id="original-download" type="button">下载原始文件</button><button class="secondary-btn" id="original-reuse" type="button">从原文件继续制卡</button></div>' +
          (isPdf ? '<label class="field-label" for="original-page-number">页码</label><div class="import-page-actions"><input class="form-input" id="original-page-number" type="number" min="1" max="' + original.pageCount + '" value="' + current + '"><button class="secondary-btn" id="original-go" type="button">查看</button></div><div id="original-image"></div>' : '') +
          '<div class="modal-actions"><button class="secondary-btn" id="original-back" type="button">返回</button></div>';
        options.modalContent.querySelector('#original-download').onclick = function () { const url = URL.createObjectURL(original.blob); const link = document.createElement('a'); link.href = url; link.download = original.name; link.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
        options.modalContent.querySelector('#original-back').onclick = returnTo || options.closeModal;
        options.modalContent.querySelector('#original-reuse').onclick = function () { options.closeModal(); void openFile(new File([original.blob], original.name, { type: original.mimeType })); };
        const draw = async function () {
          const target = options.modalContent.querySelector('#original-image'); target.textContent = '正在渲染原页…';
          try { const image = await api.renderDocumentOriginal(id, current); const box = current === pageNumber && sourceLocator?.region;
            if (target.isConnected) target.innerHTML = '<div class="original-page"><img class="import-original-image" src="' + attr(image.dataUrl) + '" alt="原始 PDF 第 ' + current + ' 页">' + (box ? '<span class="original-region" style="left:' + box.x * 100 + '%;top:' + box.y * 100 + '%;width:' + box.width * 100 + '%;height:' + box.height * 100 + '%"></span>' : '') + '</div>';
          } catch (error) { target.textContent = error.message; }
        };
        if (isPdf) { options.modalContent.querySelector('#original-go').onclick = function () { current = Number(options.modalContent.querySelector('#original-page-number').value); void draw(); }; await draw(); }
      } catch (error) { options.modalContent.innerHTML = '<h2 class="modal-title">原始文件不可用</h2><p>' + escape(error.message) + '</p>'; }
    }
    return { openFile: openFile, open: open, render: render, showOriginal: showOriginal, currentId: function () { return job?.id || null; }, compactPages: compactPages };
  }
  root.KnowledgeGachaDocumentImportUI = { createDocumentImportUI: createDocumentImportUI };
})(typeof globalThis !== "undefined" ? globalThis : this);
