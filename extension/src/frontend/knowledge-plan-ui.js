(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaPlanUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createKnowledgePlanUI(options) {
    const api = options.api;
    const html = options.escapeHtml;
    const attr = options.escapeAttr;
    const page = options.page;
    let current = null;
    let screen = "plan";
    let busy = false;
    let starting = false;
    let error = "";
    let selectedForSave = new Set();
    let seenReady = new Set();
    const labels = { pending: "待生成", generating: "生成中", needs_review: "待检查", ready: "可收下", confirmed: "已收下",
      needs_revision: "待检查", needs_split: "需要继续拆分", insufficient_material: "依据不足", failed: "失败" };

    function visible() { return options.isVisible(); }
    function selectedUnits() { return current.plan.units.filter(function (unit) { return unit.selected && unit.disposition === "active"; }); }
    function activeUnits() { return current.plan.units.filter(function (unit) { return unit.disposition === "active"; }).sort(function (a, b) { return a.order - b.order; }); }
    function draftFor(unitId) { return current.sessions.find(function (draft) { return draft.unitId === unitId; }); }
    function button(id, text, disabled, primary) { return '<button class="' + (primary ? 'primary-btn' : 'secondary-btn') + '" id="' + id + '" type="button" ' + (disabled ? 'disabled' : '') + '>' + text + '</button>'; }
    function listen(id, action) { const element = document.getElementById(id); if (element) element.addEventListener("click", action); }

    async function run(action) {
      if (busy) return;
      busy = true; error = ""; render();
      try {
        const result = await action(function (view) { current = view; if (visible()) render(); });
        if (result?.plan) current = result;
        await options.onChange();
      } catch (failure) { error = failure.message || "本次未完成，已有进度已保留"; }
      finally { busy = false; if (visible()) render(); }
    }

    async function open(id, destination) {
      if (busy && current?.plan.id !== id) { options.toast('当前清单仍在处理，请先暂停后再打开另一份'); return; }
      const changed = current?.plan.id !== id;
      current = await api.getKnowledgePlan(id);
      if (changed) { selectedForSave = new Set(); seenReady = new Set(); }
      screen = destination || (current.batch ? "batch" : "plan");
      error = "";
      options.showPage();
    }

    async function start(input) {
      if (busy || starting) return;
      starting = true;
      try { const created = await api.createKnowledgePlan(input); await open(created.plan.id, "plan"); await analyze(); }
      finally { starting = false; }
    }

    async function analyze() {
      await run(function (progress) { return api.analyzeKnowledgePlan(current.plan.id, { maxRequests: 3, onProgress: progress }); });
    }

    async function generate(unitIds, retry) {
      screen = "batch";
      await run(function (progress) { return api.generateCardBatch(current.plan.id, { unitIds: unitIds, retry: Boolean(retry), maxUnits: 3, onProgress: progress }); });
    }

    function metricsMarkup() {
      const calls = (current.plan.generation.calls || []).concat(current.sessions.flatMap(function (draft) { return (draft.history || []).flatMap(function (generation) { return generation.calls || []; }); }));
      if (!calls.length) return "";
      const tokens = calls.reduce(function (total, call) { return total + Number(call.usage?.totalTokens || call.usage?.total_tokens || 0); }, 0);
      const latency = calls.reduce(function (total, call) { return total + Number(call.latencyMs || 0); }, 0);
      const unknown = calls.some(function (call) { return !call.usage; });
      return '<p class="plan-metrics">已请求 ' + calls.length + ' 次 · ' + (latency / 1000).toFixed(1) + ' 秒' + (tokens ? ' · ' + tokens.toLocaleString() + ' token' : '') + (unknown ? '（部分用量未返回）' : '') + '</p>';
    }

    function render() {
      if (!visible()) return;
      if (!current) { page.innerHTML = '<p class="meta">正在读取学习清单…</p>'; return; }
      const plan = current.plan;
      const completed = plan.analyses.filter(function (part) { return part.status === "completed"; }).length;
      const done = current.sessions.filter(function (draft) { return draft.status === "confirmed"; }).length;
      const chosen = selectedUnits();
      page.innerHTML = '<section class="plan-intro"><p class="capture-kicker">LEARN IN SMALL STEPS</p><h2>' + html(plan.title) + '</h2>' +
        '<p>' + (screen === "plan" ? '挑选你想学会的内容，按目标生成知识卡。' : '每张卡独立完成。你可以先收下已检查的部分。') + '</p>' +
        '<div class="plan-counts"><span>已分析 ' + completed + ' / ' + plan.analyses.length + ' 段范围</span><span>已选 ' + chosen.length + ' 个目标</span><span>已收下 ' + done + ' 张</span></div>' +
        (plan.overviews.length ? '<p class="plan-overview">' + html(plan.overviews.map(function (part) { return part.text; }).join('；')) + '</p>' : '') +
        (current.material?.transcription ? '<details><summary>图片识别情况</summary><p class="meta">已将可见文字纳入清单，制卡时同时对照图片。</p>' +
          current.material.transcription.unreadable.map(function (part) { return '<p class="plan-warning">未识别：' + html(part) + '</p>'; }).join('') + '</details>' : '') + '</section>' +
        '<div class="filter-row plan-tabs">' + button('plan-tab', '学习清单', false, screen === 'plan') + button('batch-tab', '卡组预览', !current.batch, screen === 'batch') + '</div>' +
        (error || plan.error ? '<div class="quality-issues" role="alert">' + html(error || plan.error) + '</div>' : '') +
        (busy ? '<div class="plan-running" role="status"><strong>' + (plan.pauseRequested ? '正在完成当前项，随后暂停…' : screen === 'plan' ? '正在整理学习目标…' : '正在逐卡生成与核验…') + '</strong>' + button('pause-plan', '完成当前项后暂停', plan.pauseRequested, false) + '</div>' : '') +
        (screen === 'plan' ? planMarkup() : batchMarkup()) + metricsMarkup() +
        '<div class="plan-bottom-actions">' + (plan.discardedAt ? '' : button('plan-later', '保留所选目标，稍后继续', false, false)) + button('plan-back', '返回制卡', busy, false) +
        (current.material?.source?.importRef && !current.material.completedAt ? button('discard-plan', '放弃未完成目标', busy, false) + '<p class="meta">放弃会清理本次未收下的草稿；已收下卡片及其附件继续保留。</p>' : '') + '</div>';
      listen('plan-tab', function () { screen = 'plan'; render(); });
      listen('batch-tab', function () { screen = 'batch'; render(); });
      listen('pause-plan', async function () { try { current = await api.pauseKnowledgeWork(plan.id); render(); } catch (failure) { options.toast(failure.message); } });
      listen('plan-later', async function () {
        try { if (busy) await api.pauseKnowledgeWork(plan.id); await api.retainKnowledgePlan(plan.id); await options.onChange(); options.goFeed(); options.toast('所选目标和已有卡片已保留'); }
        catch (failure) { options.toast(failure.message); }
      });
      listen('plan-back', options.goFeed);
      listen('discard-plan', function () { void run(async function () { const result = await api.discardKnowledgePlan(plan.id); options.goFeed(); options.toast('未完成目标已放弃，已收下卡片继续保留'); return result; }); });
      listen('analyze-plan', analyze);
      listen('generate-plan', function () { void generate(); });
      listen('continue-batch', function () { void generate(); });
      listen('merge-plan-units', function () { showReshape('merge', selectedUnits().map(function (unit) { return unit.id; })); });
      listen('save-selected-batch', function () { void confirmUnits(Array.from(selectedForSave)); });
      bindUnitActions();
    }

    function planMarkup() {
      const plan = current.plan;
      if (plan.discardedAt) return '<p class="meta">未完成目标已放弃；已收下卡片可从卡组或卡册回查。</p>';
      const chosen = selectedUnits();
      const undecided = chosen.some(function (unit) { return unit.duplicateAction === 'undecided'; });
      const rows = activeUnits().map(unitMarkup).join('');
      const skippedRanges = plan.coverage.filter(function (row) { return !row.unitIds.length; });
      return (plan.status !== 'ready' ? '<p class="meta">每次分析最多 3 个请求，已完成的范围会保留。完成全部分析后生成卡组。</p>' + button('analyze-plan', plan.status === 'pending' ? '整理学习清单' : '继续分析未完成范围', busy, true) : '') +
        (rows ? '<div class="knowledge-unit-list">' + rows + '</div>' : '<p class="plan-empty">完成分析后，这里会显示具体目标及原文位置。</p>') +
        (skippedRanges.length ? '<details class="plan-coverage"><summary>' + skippedRanges.length + ' 段未制卡的原因</summary>' + skippedRanges.map(function (row) {
          const chunk = current.chunks.find(function (part) { return part.id === row.chunkId; });
          return '<p>所选材料第 ' + (chunk.startCharacter + 1) + '–' + chunk.endCharacter + ' 字：' + html(row.reason) + '</p>';
        }).join('') + '</details>' : '') +
        (plan.relations.length ? '<details class="plan-coverage"><summary>建议学习关系</summary>' + plan.relations.map(function (relation) {
          const from = plan.units.find(function (unit) { return unit.id === relation.from; });
          const to = plan.units.find(function (unit) { return unit.id === relation.to; });
          return '<p>' + html(from?.title || '') + ' → ' + html(to?.title || '') + ' · ' + html({ prerequisite: '前置', comparison: '对比', application: '应用' }[relation.type]) + '</p>';
        }).join('') + '</details>' : '') +
        (rows ? '<div class="plan-actions">' + button('merge-plan-units', '合并勾选目标', busy || chosen.length < 2, false) +
          button('generate-plan', '生成所选 ' + chosen.length + ' 个目标', busy || plan.status !== 'ready' || !chosen.length || undecided, true) + '</div>' +
          '<p class="meta">每次最多完成 3 个目标；每张卡通常需生成和核验 2 次请求，修复时最多 4 次。</p>' +
          (undecided ? '<p class="plan-warning">先选择相似目标的处理方式，再生成。</p>' : '') : '');
    }

    function unitMarkup(unit) {
      const draft = draftFor(unit.id);
      const locked = busy || draft?.status === 'confirmed' || draft?.status === 'generating';
      const editable = !locked && (!draft?.card || draft.status === 'needs_split');
      const evidence = current.chunks.filter(function (chunk) { return unit.evidenceIds.includes(chunk.id); });
      return '<article class="knowledge-unit ' + (unit.selected ? '' : 'is-skipped') + '" data-unit="' + attr(unit.id) + '">' +
        '<div class="plan-unit-heading"><label><input type="checkbox" data-unit-select="' + attr(unit.id) + '" ' + (unit.selected ? 'checked ' : '') + (locked ? 'disabled ' : '') + '><strong>' + html(unit.title) + '</strong></label>' +
        '<span class="plan-state">' + html(draft ? labels[draft.status] || '待检查' : unit.selected ? '待生成' : '已跳过') + '</span></div>' +
        '<p class="plan-objective">' + html(unit.learningObjective) + '</p>' +
        (unit.selected ? '' : '<p class="meta">' + html(unit.skipReason || unit.reason) + '</p>') +
        (unit.relatedCardId ? '<div class="plan-related"><p>' + html(unit.relationToCard === 'same_goal' ? '已有相同学习目标' : '与已有卡片相关') + (unit.newInformation ? '：' + html(unit.newInformation) : '') + '</p>' +
          '<label>处理方式<select data-unit-duplicate="' + attr(unit.id) + '" ' + (locked ? 'disabled' : '') + '>' +
          [['undecided', '请选择处理方式'], ['merge', '合并到已有卡（收下前查看差异）'], ['create_new', '仍然新建一张']].map(function (option) { return '<option value="' + option[0] + '" ' + (unit.duplicateAction === option[0] ? 'selected' : '') + '>' + option[1] + '</option>'; }).join('') + '</select></label></div>' : '') +
        (unit.supplementalEvidence?.length ? '<p class="plan-warning">使用了你允许的补充原文：' + html(unit.supplementalEvidence.map(function (span) { return span.title; }).join('、')) + '</p>' : '') +
        '<details class="plan-unit-detail"><summary>修改目标、顺序与原文范围</summary><label>目标标题<input class="form-input" data-unit-title maxlength="80" value="' + attr(unit.title) + '" ' + (!editable ? 'disabled' : '') + '></label>' +
        '<label>学会什么<textarea class="feed-input" data-unit-objective maxlength="300" ' + (!editable ? 'disabled' : '') + '>' + html(unit.learningObjective) + '</textarea></label>' +
        '<label>建议顺序<input class="form-input plan-order" type="number" data-unit-order min="1" max="999" value="' + Math.ceil(unit.order) + '" ' + (locked ? 'disabled' : '') + '></label>' +
        '<fieldset class="plan-evidence"><legend>目标依据（位置相对于所选材料）</legend>' + evidence.map(function (chunk) {
          const text = current.material?.text?.slice(chunk.startCharacter, chunk.endCharacter);
          return '<label><input type="checkbox" data-unit-evidence value="' + attr(chunk.id) + '" checked ' + (!editable ? 'disabled' : '') + '>第 ' + (chunk.startCharacter + 1) + '–' + chunk.endCharacter + ' 字 ' + html(chunk.headingPath.join(' / ')) + '</label>' +
            (text ? '<blockquote>' + html(text) + '</blockquote>' : '<p class="meta">已完成卡片可从卡册回查依据。</p>');
        }).join('') + '</fieldset><div class="plan-actions"><button class="secondary-btn" data-unit-update="' + attr(unit.id) + '" type="button" ' + (locked ? 'disabled' : '') + '>保存目标修改</button>' +
        '<button class="secondary-btn" data-unit-split="' + attr(unit.id) + '" type="button" ' + (!editable ? 'disabled' : '') + '>继续拆分</button></div></details></article>';
    }

    function batchMarkup() {
      const units = selectedUnits().sort(function (a, b) { return a.order - b.order; });
      let readyCount = 0;
      const rows = units.map(function (unit) {
        const draft = draftFor(unit.id);
        const status = draft?.status || 'pending';
        if (status === 'ready') {
          readyCount += 1;
          if (!seenReady.has(unit.id)) { seenReady.add(unit.id); selectedForSave.add(unit.id); }
        } else selectedForSave.delete(unit.id);
        const issue = draft?.failureMessage || draft?.quality?.issues?.map(function (item) { return item.message; }).join('；') || '';
        return '<article class="batch-card" data-batch-unit="' + attr(unit.id) + '"><div class="plan-unit-heading"><label>' +
          (status === 'ready' ? '<input type="checkbox" data-batch-save="' + attr(unit.id) + '" ' + (selectedForSave.has(unit.id) ? 'checked' : '') + (busy ? ' disabled' : '') + '>' : '') +
          '<strong>' + html(draft?.card?.title || unit.title) + '</strong></label><span class="plan-state state-' + attr(status) + '">' + html(labels[status] || '待检查') + '</span></div>' +
          '<p class="plan-objective">' + html(unit.learningObjective) + '</p>' + (draft?.card ? '<p class="batch-summary">' + html(draft.card.summary) + '</p>' : '') +
          (draft?.exercise ? '<p class="meta">自测：' + html(draft.exercise.question) + '</p>' : '') +
          (issue && !['ready', 'confirmed'].includes(status) ? '<p class="plan-warning">' + html(issue) + '</p>' : '') +
          (draft?.candidates?.length ? '<p class="meta">保留了 ' + draft.candidates.length + ' 个候选，请回到学习清单继续拆分。</p>' : '') +
          '<div class="plan-actions">' + (draft && !['generating', 'confirmed'].includes(status) ? '<button class="secondary-btn" data-open-batch-draft="' + attr(draft.id) + '" type="button" ' + (busy ? 'disabled' : '') + '>逐卡检查或修改</button>' : '') +
          (!['generating', 'confirmed'].includes(status) ? '<button class="secondary-btn" data-retry-unit="' + attr(unit.id) + '" type="button" ' + (busy ? 'disabled' : '') + '>' + (status === 'pending' ? '生成这张' : '只重做这张') + '</button>' : '') + '</div></article>';
      }).join('');
      const pending = units.filter(function (unit) { const draft = draftFor(unit.id); return !draft || draft.status === 'generating'; }).length;
      return '<div class="batch-card-list">' + (rows || '<p class="plan-empty">先从学习清单选择要学的内容。</p>') + '</div>' +
        '<div class="plan-actions">' + (pending ? button('continue-batch', '继续生成剩余 ' + pending + ' 张', busy, false) : '') +
        button('save-selected-batch', '收下选中 ' + selectedForSave.size + ' 张', busy || !readyCount || !selectedForSave.size, true) + '</div>';
    }

    function bindUnitActions() {
      page.querySelectorAll('[data-unit-select]').forEach(function (element) { element.addEventListener('change', function () {
        void run(function () { return api.updateKnowledgePlan(current.plan.id, { units: [{ id: element.dataset.unitSelect, selected: element.checked }] }); });
      }); });
      page.querySelectorAll('[data-unit-duplicate]').forEach(function (element) { element.addEventListener('change', function () {
        void run(function () { return api.updateKnowledgePlan(current.plan.id, { units: [{ id: element.dataset.unitDuplicate, duplicateAction: element.value }] }); });
      }); });
      page.querySelectorAll('[data-unit-update]').forEach(function (element) { element.addEventListener('click', function () {
        const parent = element.closest('[data-unit]');
        const patch = { id: element.dataset.unitUpdate, order: Number(parent.querySelector('[data-unit-order]').value) };
        if (!parent.querySelector('[data-unit-title]').disabled) {
          patch.title = parent.querySelector('[data-unit-title]').value;
          patch.learningObjective = parent.querySelector('[data-unit-objective]').value;
          patch.evidenceIds = Array.from(parent.querySelectorAll('[data-unit-evidence]:checked')).map(function (input) { return input.value; });
        }
        void run(function () { return api.updateKnowledgePlan(current.plan.id, { units: [patch] }); });
      }); });
      page.querySelectorAll('[data-unit-split]').forEach(function (element) { element.addEventListener('click', function () { showReshape('split', [element.dataset.unitSplit]); }); });
      page.querySelectorAll('[data-retry-unit]').forEach(function (element) { element.addEventListener('click', function () { void generate([element.dataset.retryUnit], true); }); });
      page.querySelectorAll('[data-open-batch-draft]').forEach(function (element) { element.addEventListener('click', function () { void options.openDraft(element.dataset.openBatchDraft); }); });
      page.querySelectorAll('[data-batch-save]').forEach(function (element) { element.addEventListener('change', function () {
        if (element.checked) selectedForSave.add(element.dataset.batchSave); else selectedForSave.delete(element.dataset.batchSave);
        render();
      }); });
    }

    function showReshape(action, ids) {
      if (busy) return;
      const units = current.plan.units.filter(function (unit) { return ids.includes(unit.id); });
      const title = units.map(function (unit) { return unit.title; }).join('与');
      options.modalContent.innerHTML = '<h2 class="modal-title">' + (action === 'merge' ? '合并学习目标' : '继续拆分学习目标') + '</h2>' +
        '<p class="meta">每行填写一个“标题 | 学习目标”。目标以“能解释、能区分、能判断、能完成、能识别”开头。保存后可调整各目标的原文范围。</p>' +
        '<textarea class="feed-input" id="plan-reshape-targets" aria-label="新的学习目标" rows="5" placeholder="适用条件 | 能判断这个方法何时适用">' +
        (action === 'merge' ? html(title.slice(0, 70) + ' | 能区分' + title + '的作用') : '') + '</textarea><p class="plan-warning" id="plan-reshape-error" role="alert"></p>' +
        '<div class="modal-actions">' + button('cancel-reshape', '取消', false, false) + button('apply-reshape', '确认调整', false, true) + '</div>';
      options.openModal();
      listen('cancel-reshape', options.closeModal);
      listen('apply-reshape', async function () {
        try {
          const targets = document.getElementById('plan-reshape-targets').value.split('\n').filter(function (line) { return line.trim(); }).map(function (line) {
            const split = line.indexOf('|');
            if (split < 0) throw new Error('请用 | 分隔标题和学习目标');
            return { title: line.slice(0, split).trim(), learningObjective: line.slice(split + 1).trim() };
          });
          current = await api.reshapeKnowledgeUnits(current.plan.id, { action: action, unitIds: ids, targets: targets });
          options.closeModal(); await options.onChange(); render();
        } catch (failure) { document.getElementById('plan-reshape-error').textContent = failure.message; }
      });
    }

    async function confirmUnits(ids) {
      try {
        const prepared = await api.prepareCardBatchConfirmation(current.batch.id, ids);
        options.modalContent.innerHTML = '<h2 class="modal-title">确认收下 ' + prepared.selection.length + ' 张卡片</h2><div class="batch-confirm-list">' + prepared.selection.map(function (choice) {
          return '<article><strong>' + html(choice.title) + '</strong>' + (choice.before ? '<p class="meta">合并到「' + html(choice.before.title) + '」，保留收藏与复习记录。</p><details open><summary>查看合并差异</summary><p class="detail-label">原有解释</p><p>' + html(choice.before.summary) + '</p><p class="detail-label">本次解释</p><p>' + html(choice.after.summary) + '</p></details>' : '<p class="meta">新卡将加入卡册，并安排首次复习。</p>') + '</article>';
        }).join('') + '</div><p class="plan-warning" id="batch-confirm-error" role="alert"></p><div class="modal-actions">' +
          button('cancel-batch-confirm', '返回检查', false, false) + button('apply-batch-confirm', '确认收下', false, true) + '</div>';
        options.openModal();
        listen('cancel-batch-confirm', options.closeModal);
        listen('apply-batch-confirm', async function () {
          const button = document.getElementById('apply-batch-confirm');
          button.disabled = true;
          try {
            const result = await api.confirmCardBatch(current.batch.id, prepared.selection);
            current = await api.getKnowledgePlan(current.plan.id);
            await options.afterSave(); await options.onChange();
            options.closeModal();
            const failed = result.results.filter(function (entry) { return entry.status === 'failed'; });
            error = failed.map(function (entry) { return entry.message; }).join('；');
            options.toast('已收下 ' + (result.results.length - failed.length) + ' 张' + (failed.length ? '，其余卡片可继续处理' : ''));
            render();
          } catch (failure) { document.getElementById('batch-confirm-error').textContent = failure.message; button.disabled = false; }
        });
      } catch (failure) { error = failure.message; render(); }
    }

    return { open: open, start: start, render: render, confirmUnits: confirmUnits, isBusy: function () { return busy || starting; } };
  }
  return { createKnowledgePlanUI: createKnowledgePlanUI };
});
