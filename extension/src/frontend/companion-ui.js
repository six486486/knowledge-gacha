(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./companion-markdown.js") : root.KnowledgeGachaCompanionMarkdown);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaCompanionUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (markdown) {
  "use strict";
  function createCompanionUI(context) {
    const api = context.api, page = context.page, escape = context.escapeHtml;
    let current = null, items = [], error = "", loading = false, sequence = 0, renaming = false, deleting = false;
    let materialText = "", materialTitle = "", materialUrl = "", materialNotice = "";
    const inputs = new Map(), preferenceDrafts = new Map(), pending = new Set();
    function accept(response, id) { if (!id || current?.id === id) current = response.session; }
    function redraw() { if (context.isVisible()) render(); }
    async function enter() {
      if (loading) return;
      const request = ++sequence; loading = true; redraw();
      try {
        const listed = await api.listCompanionSessions();
        if (request !== sequence) return;
        items = listed.sessions;
        const selected = current?.id || context.getLastSession?.();
        const id = items.find(function (item) { return item.id === selected; })?.id || items[0]?.id;
        const response = id ? await api.getCompanionSession(id) : await api.createCompanionSession({});
        if (request !== sequence) return;
        accept(response);
        context.setLastSession?.(current.id); error = "";
      } catch (failure) { error = failure.message; }
      finally { if (request === sequence) { loading = false; redraw(); } }
    }
    async function open(input) {
      sequence += 1; loading = false;
      const response = await api.createCompanionSession(input || {});
      current = response.session; error = ""; renaming = false; deleting = false;
      materialText = ""; materialTitle = ""; materialNotice = ""; materialUrl = "";
      context.setLastSession?.(current.id); items = (await api.listCompanionSessions()).sessions;
      context.show(); redraw();
    }
    function referenceHtml(ref) {
      const label = ref.kind === "card" ? "卡片总结" : ref.kind === "context" ? "本次材料" : "原文片段";
      return '<details class="companion-reference"><summary>[' + escape(ref.id) + '] ' + escape(ref.title) + ' <span>' + label + '</span></summary>' +
        '<blockquote>' + escape(ref.quote) + '</blockquote><p class="companion-meta">' + (ref.pageNumber ? '第 ' + Number(ref.pageNumber) + ' 页 · ' : '') +
        (ref.version ? '版本 ' + Number(ref.version) + ' · ' : '') + (Number.isFinite(ref.start) ? '位置 ' + ref.start : '学习背景') + '</p>' +
        (ref.cardId ? '<button class="pill-btn" type="button" data-companion-card="' + escape(ref.cardId) + '">打开卡片</button>' : '') +
        (/^https?:\/\//i.test(ref.sourceUrl || '') ? '<a class="companion-source-link" href="' + escape(ref.sourceUrl) + '" target="_blank" rel="noopener noreferrer">打开来源网页</a>' : '') + '</details>';
    }
    function actionHtml(action, busy) {
      const completed = action.status === "completed", preference = action.kind === "preference";
      const scopeLabel = action.scope === 'discussion' ? '仅本次讨论' : action.scope === 'topic' ? '主题「' + action.topicLabel + '」' : '所有讨论';
      return '<div class="companion-action">' + (preference ? '<p>' + escape(scopeLabel) + ' · 讲解偏好：' + escape(action.value) + '</p>' : '') +
        '<button class="pill-btn" type="button" data-companion-action="' + escape(action.id) + '" ' + (busy || completed && preference ? 'disabled' : '') + '>' +
        escape(completed ? preference ? '已记住' : action.kind === 'card' ? '查看卡片草稿' : '进入练习' : action.title) + '</button></div>';
    }
    function messageHtml(message, busy) {
      if (message.role === "user") return '<article class="companion-message is-user" aria-label="我的消息"><div class="companion-prose">' + escape(message.content) + '</div></article>';
      return '<article class="companion-message is-assistant"><div class="companion-message-head"><span class="companion-answer-dot" aria-hidden="true"></span><strong>伴学</strong>' + (message.citations?.length ? '<span>参考 ' + message.citations.length + ' 处资料</span>' : '') + '</div>' +
        '<div class="companion-prose companion-markdown">' + markdown.render(message.content) + '</div>' + (message.citations || []).map(referenceHtml).join('') +
        ((message.steps || []).length ? '<details class="companion-steps"><summary>查看整理过程</summary><ol>' + message.steps.map(function (step) { return '<li>' + escape(step.label) + (step.status === 'unavailable' ? ' · 未取得结果' : ' · 完成') + '</li>'; }).join('') + '</ol></details>' : '') +
        '<div class="companion-actions">' + (message.actions || []).filter(function (action) { return action.placement !== 'menu'; }).map(function (action) { return actionHtml(action, busy); }).join('') + '</div>' +
        ((message.actions || []).some(function (action) { return action.placement === 'menu'; }) ? '<details class="companion-message-menu"><summary>更多操作</summary>' + message.actions.filter(function (action) { return action.placement === 'menu'; }).map(function (action) { return actionHtml(action, busy); }).join('') + '</details>' : '') +
        (message.id === current.messages[current.messages.length - 1]?.id && (message.followUps || []).length ? '<div class="companion-followups" aria-label="继续聊聊">' + message.followUps.map(function (prompt) { return '<button type="button" data-companion-prompt="' + escape(prompt) + '">' + escape(prompt) + '<span aria-hidden="true"> ↗</span></button>'; }).join('') + '</div>' : '') + '</article>';
    }
    function render() {
      const focused = page.contains(document.activeElement) ? document.activeElement : null;
      const focusId = focused?.id, caret = focused?.selectionStart;
      const oldMessages = page.querySelector('.companion-messages');
      const sameSession = Boolean(oldMessages && current && oldMessages.dataset.session === current.id);
      const oldScroll = sameSession ? oldMessages.scrollTop : 0;
      const oldCount = sameSession ? oldMessages.querySelectorAll('.companion-message').length : 0;
      const nearBottom = !sameSession || oldMessages.scrollHeight - oldMessages.clientHeight - oldScroll < 48;
      const settingsOpen = sameSession && Boolean(page.querySelector('.companion-settings[open]'));
      const contextOpen = sameSession && Boolean(page.querySelector('.companion-context[open]'));
      const busy = current && pending.has(current.id);
      const turn = current?.turn;
      page.innerHTML = '<section class="companion-shell">' +
        '<div class="companion-toolbar"><h2 title="' + escape(current?.title || '新的讨论') + '">' + escape(current?.title || '新的讨论') + '</h2><div class="companion-toolbar-actions">' +
        '<details class="companion-history"><summary>历史讨论</summary><div class="companion-history-panel"><label>选择讨论<select id="companion-history-select" class="form-input">' +
        (current && !items.some(function (item) { return item.id === current.id; }) ? '<option value="' + escape(current.id) + '">' + escape(current.title) + '</option>' : '') +
        items.map(function (item) { return '<option value="' + escape(item.id) + '" ' + (item.id === current?.id ? 'selected' : '') + '>' + escape(item.title) + '</option>'; }).join('') +
        '</select></label><div class="companion-history-actions"><button class="pill-btn" id="companion-rename" type="button">改名</button><button class="pill-btn" id="companion-delete" type="button" ' + (busy ? 'disabled' : '') + '>删除讨论</button></div></div></details>' +
        '<button class="pill-btn" id="companion-new" type="button" aria-label="新讨论"><span aria-hidden="true">＋</span> 新讨论</button></div></div>' +
        (renaming ? '<form id="companion-rename-form" class="companion-inline-form"><input id="companion-title" aria-label="讨论标题" class="form-input" maxlength="60" value="' + escape(current.title) + '"><button class="pill-btn" type="submit">保存名称</button></form>' : '') +
        (deleting ? '<div class="companion-error"><p>删除这段对话和关联的讨论材料？卡片和复习记录会保留。</p><button class="pill-btn" id="companion-delete-confirm" type="button">确认删除这段讨论</button><button class="pill-btn" id="companion-delete-cancel" type="button">保留</button></div>' : '') +
        (error ? '<div class="companion-error" role="alert">' + escape(error) + '</div>' : '') +
        (loading && !current ? '<p role="status">正在打开讨论…</p>' : '') +
        (current ? bodyHtml(busy, turn) : '') + '</section>';
      bind();
      if (settingsOpen) page.querySelector('.companion-settings')?.setAttribute('open', '');
      if (contextOpen) page.querySelector('.companion-context')?.setAttribute('open', '');
      const messageList = page.querySelector('.companion-messages');
      resizeInput();
      if (messageList) messageList.scrollTop = nearBottom && oldCount < current.messages.length ? messageList.scrollHeight : oldScroll;
      if (focusId) { const target = document.getElementById(focusId); if (target && !target.disabled) { target.focus({ preventScroll: true }); if (typeof caret === 'number' && target.setSelectionRange) target.setSelectionRange(caret, caret); } }
    }
    function bodyHtml(busy, turn) {
      const bound = current.context;
      const task = current.learningTask;
      return (task && ['awaiting_answer', 'feedback'].includes(task.phase) ? '<div class="companion-task-status" role="status"><span>' + (task.phase === 'awaiting_answer' ? '陪练 · 等待你回答' : '本题反馈已完成') + '</span>' +
          (task.phase === 'awaiting_answer' ? '<details><summary>当前题目' + (task.hintLevel ? ' · 提示 ' + task.hintLevel + ' 次' : '') + '</summary><p>' + escape(task.pendingQuestion) + '</p></details>' : '') + '</div>' : '') +
        '<div class="companion-messages" data-session="' + escape(current.id) + '" role="region" aria-label="学习对话" tabindex="0">' +
        (bound ? '<details class="companion-context"><summary>正在讨论 · ' + escape(bound.title) + '</summary><div class="companion-prose">' + escape(bound.text) + '</div><p class="companion-meta">本次讨论保留这份材料，切换网页不会替换。</p>' +
        (!current.messages.length ? '<button class="pill-btn" id="companion-context-remove" type="button">移除材料</button>' : '') + '</details>' : !current.messages.length ?
        '<details class="companion-context"><summary>带入一段材料（可选）</summary><div class="companion-capture"><button class="pill-btn" id="companion-selection" type="button">读取网页选区</button><button class="pill-btn" id="companion-page" type="button">读取网页正文</button></div>' +
        (materialNotice ? '<p class="companion-meta">' + escape(materialNotice) + '</p>' : '') + '<input class="form-input" id="companion-material-title" aria-label="材料标题" placeholder="材料标题" maxlength="120" value="' + escape(materialTitle) + '">' +
        '<textarea class="feed-input" id="companion-material" aria-label="讨论材料" placeholder="也可以粘贴一段想讨论的文字，最多 12000 字" maxlength="12000">' + escape(materialText) + '</textarea><button class="pill-btn" id="companion-context-save" type="button">使用这段材料</button></details>' : '') +
        (!current.messages.length ? '<section class="companion-welcome"><span class="companion-badge">一起学明白</span><h3>从一个好奇开始。</h3><p>有不懂的地方，就在这里问。<br>我们可以讲清楚、做比较，也可以练一练。</p><div class="companion-starters">' +
          [['讲清一个概念', '用具体例子理解它', '帮我解释这段材料，先讲最关键的一点'], ['比较两个知识点', '找出区别与联系', '我想比较两个容易混淆的概念'], ['陪我练一练', '一步一步，先不给答案', '先别给答案，一步步引导我理解']].map(function (item, index) { return '<button type="button" data-companion-prompt="' + escape(item[2]) + '"><span class="companion-starter-number" aria-hidden="true">0' + (index + 1) + '</span><span><strong>' + item[0] + '</strong><small>' + item[1] + '</small></span><span class="companion-starter-arrow" aria-hidden="true">↗</span></button>'; }).join('') + '</div></section>' : '') +
        '<div class="companion-thread">' + current.messages.map(function (message) { return messageHtml(message, busy); }).join('') + '</div>' +
        (turn && turn.status !== 'completed' ? '<section class="companion-run" aria-live="polite"><strong>' + (busy ? '正在整理回答…' : turn.status === 'failed' ? '这次回答尚未完成' : '讨论已暂停') + '</strong>' +
          '<p id="companion-progress">' + escape(turn.compaction?.status === 'running' ? '正在整理前文…' : turn.steps?.map(function (step) { return step.label; }).join(' → ') || '准备学习上下文') + '</p>' + (turn.error ? '<p>' + escape(turn.error) + '</p>' : '') +
          (!busy ? '<button class="pill-btn" id="companion-resume" type="button">继续这条回答</button>' : '') + '</section>' : '') +
        (turn?.contextStats?.summaryTurns ? '<p class="companion-meta companion-context-note">较早讨论已整理为摘要，原文仍保留在历史中。</p>' : '') +
        (turn?.omittedTurns ? '<p class="companion-meta companion-context-note">部分较早消息未带入本轮回答，必要时请重新说明关键要求。</p>' : '') + '</div>' +
        '<form id="companion-form" class="companion-composer"><label class="sr-only" for="companion-input">向伴学提问</label><textarea id="companion-input" placeholder="说说你的问题，或接着追问…" maxlength="4000" rows="2">' + escape(inputs.get(current.id) || '') + '</textarea>' +
        '<div class="companion-send-row"><div class="companion-options"><label><select id="companion-mode" aria-label="教学方式" title="自动跟随问题选择教学方式，也可以手动固定" ' + (busy ? 'disabled' : '') + '>' +
          Object.entries({ auto: '自动', explain: '讲解', compare: '比较', practice: '陪练' }).map(function (entry) { return '<option value="' + entry[0] + '" ' + (current.mode === entry[0] ? 'selected' : '') + '>' + entry[1] + '</option>'; }).join('') +
          '</select></label><details class="companion-settings"><summary aria-label="本次讨论设置">讨论设置</summary><div class="companion-settings-panel"><strong>本次讨论设置</strong><div class="companion-scope-options">' +
          [['knowledge', '知识库', current.useKnowledge], ['preferences', '使用我的偏好', current.usePreferences], ['records', '参考学习记录', current.useLearningRecords]].map(function (entry) { return '<label><input id="companion-' + entry[0] + '" type="checkbox" ' + (entry[2] ? 'checked ' : '') + (busy ? 'disabled' : '') + '>' + entry[1] + '</label>'; }).join('') +
          '</div><p class="companion-meta">关闭后不再读取对应资料；本次对话的历史和摘要仍会保留。</p>' +
          '<label class="companion-discussion-label" for="companion-discussion-preference">仅本次讨论的讲解偏好</label><input class="form-input" id="companion-discussion-preference" maxlength="160" value="' + escape(preferenceDrafts.get(current.id) ?? current.discussionPreference ?? '') + '" placeholder="例如：这次先举例，再讲定义" ' + (busy ? 'disabled' : '') + '>' +
          '<div class="companion-setting-actions"><button class="pill-btn" id="companion-preference-save" type="button" ' + (busy ? 'disabled' : '') + '>保存本次偏好</button>' + (current.discussionPreference ? '<button class="pill-btn" id="companion-preference-clear" type="button" ' + (busy ? 'disabled' : '') + '>清除</button>' : '') + '</div>' +
          '<p class="companion-meta">仅在本讨论启用“使用我的偏好”时生效。</p></div></details></div>' +
          (busy ? '<button id="companion-stop" class="secondary-btn" type="button">停止</button>' : '<button class="primary-btn" id="companion-send" type="submit">发送 <span aria-hidden="true">↑</span></button>') + '</div>' +
          '<div class="companion-composer-footer"><button id="companion-model" class="companion-model-button" type="button" title="打开模型设置">' + escape(context.isConfigured() ? context.modelName() : '先配置模型') + '</button><span>Ctrl / ⌘ + Enter 发送</span></div></form>';
    }
    function resizeInput() {
      const input = document.getElementById('companion-input');
      if (input) { input.style.height = 'auto'; input.style.height = Math.min(132, Math.max(54, input.scrollHeight)) + 'px'; }
    }
    function on(id, event, fn) { document.getElementById(id)?.addEventListener(event, fn); }
    async function run(fn) { try { error = ""; await fn(); } catch (failure) { error = failure.message; } redraw(); }
    async function update(input) { const id = current.id; accept(await api.updateCompanionSession(id, input), id); }
    async function send(resume) {
      const id = current?.id;
      if (!id || pending.has(id)) return;
      if (!context.isConfigured()) { context.openModel(); return; }
      const content = (inputs.get(id) || '').trim();
      if (!resume && !content) return;
      pending.add(id); error = "";
      let poll;
      try {
        const operation = resume ? api.resumeCompanionTurn(id) : api.sendCompanionMessage(id, { requestId: context.mutationId(), content: content });
        operation.catch(function () {});
        if (!resume) inputs.set(id, '');
        const refresh = async function () {
          if (!pending.has(id)) return;
          try {
            const response = await api.getCompanionSession(id);
            accept(response, id);
            if (current?.id === id) {
              const progress = document.getElementById('companion-progress');
              if (progress) progress.textContent = response.session.turn?.compaction?.status === 'running' ? '正在整理前文…' : response.session.turn?.steps?.map(function (step) { return step.label; }).join(' → ') || '正在准备回答';
            }
          } catch (_) { /* The final operation reports its own failure. */ }
          if (pending.has(id)) poll = setTimeout(refresh, 900);
        };
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
        accept(await api.getCompanionSession(id), id); redraw(); poll = setTimeout(refresh, 900);
        accept(await operation, id); items = (await api.listCompanionSessions()).sessions;
      } catch (failure) { error = failure.message; if (!resume && !inputs.get(id)) inputs.set(id, content); }
      finally { pending.delete(id); clearTimeout(poll); redraw(); }
    }
    async function capture(type) {
      const material = await context.capture(type);
      materialText = material.text.slice(0, 12000); materialTitle = material.title; materialUrl = material.url;
      materialNotice = material.text.length > 12000 ? '已带入前 12000 字，请检查并选取需要讨论的部分后确认。' : '检查材料后，点击“使用这段材料”。';
      redraw(); page.querySelector('.companion-context')?.setAttribute('open', '');
    }
    function bind() {
      on('companion-new', 'click', function () { void run(function () { return open({}); }); });
      on('companion-history-select', 'change', function (event) { void run(async function () { const request = ++sequence; const response = await api.getCompanionSession(event.target.value); if (request === sequence) { current = response.session; context.setLastSession?.(current.id); renaming = false; deleting = false; } }); });
      on('companion-rename', 'click', function () { renaming = !renaming; redraw(); });
      on('companion-rename-form', 'submit', function (event) { event.preventDefault(); const title = document.getElementById('companion-title').value; void run(async function () { await update({ title: title }); renaming = false; items = (await api.listCompanionSessions()).sessions; }); });
      on('companion-delete', 'click', function () { deleting = true; redraw(); });
      on('companion-delete-cancel', 'click', function () { deleting = false; redraw(); });
      on('companion-delete-confirm', 'click', function () { void run(async function () { await api.deleteCompanionSession(current.id); current = null; deleting = false; context.setLastSession?.(''); await enter(); }); });
      on('companion-input', 'input', function (event) { inputs.set(current.id, event.target.value); resizeInput(); });
      on('companion-input', 'keydown', function (event) { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void send(false); } });
      on('companion-form', 'submit', function (event) { event.preventDefault(); void send(false); });
      on('companion-resume', 'click', function () { void send(true); });
      on('companion-stop', 'click', function () { const id = current.id; void run(async function () { accept(await api.cancelCompanionTurn(id), id); }); });
      on('companion-mode', 'change', function (event) { const value = event.target.value; void run(function () { return update({ mode: value }); }); });
      on('companion-knowledge', 'change', function (event) { const value = event.target.checked; void run(function () { return update({ useKnowledge: value }); }); });
      on('companion-preferences', 'change', function (event) { const value = event.target.checked; void run(function () { return update({ usePreferences: value }); }); });
      on('companion-records', 'change', function (event) { const value = event.target.checked; void run(function () { return update({ useLearningRecords: value }); }); });
      on('companion-discussion-preference', 'input', function (event) { preferenceDrafts.set(current.id, event.target.value); });
      on('companion-preference-save', 'click', function () { const id = current.id, value = document.getElementById('companion-discussion-preference').value.trim(); void run(async function () { await update({ discussionPreference: value || null }); preferenceDrafts.delete(id); }); });
      on('companion-discussion-preference', 'keydown', function (event) { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); document.getElementById('companion-preference-save').click(); } });
      on('companion-preference-clear', 'click', function () { const id = current.id; void run(async function () { await update({ discussionPreference: null }); preferenceDrafts.delete(id); }); });
      page.querySelectorAll('.companion-settings, .companion-history').forEach(function (details) { details.addEventListener('keydown', function (event) { if (event.key === 'Escape' && details.open) { event.preventDefault(); details.open = false; details.querySelector('summary').focus(); } }); });
      on('companion-model', 'click', context.openModel);
      on('companion-selection', 'click', function () { void run(function () { return capture('selection'); }); });
      on('companion-page', 'click', function () { void run(function () { return capture('page'); }); });
      on('companion-material', 'input', function (event) { materialText = event.target.value; });
      on('companion-material-title', 'input', function (event) { materialTitle = event.target.value; });
      on('companion-context-save', 'click', function () { void run(function () { return update({ context: { kind: 'text', text: materialText, title: materialTitle, sourceUrl: materialUrl } }); }); });
      on('companion-context-remove', 'click', function () { void run(function () { return update({ context: { kind: 'none' } }); }); });
      page.querySelectorAll('[data-companion-prompt]').forEach(function (button) { button.addEventListener('click', function () { inputs.set(current.id, button.dataset.companionPrompt); redraw(); document.getElementById('companion-input')?.focus(); }); });
      page.querySelectorAll('[data-companion-card]').forEach(function (button) { button.addEventListener('click', function () { context.openCard(button.dataset.companionCard); }); });
      page.querySelectorAll('[data-companion-action]').forEach(function (button) { button.addEventListener('click', function () {
        const id = current.id; button.disabled = true;
        void run(async function () {
          const response = await api.executeCompanionAction(id, button.dataset.companionAction); accept(response, id);
          if (current?.id !== id || !context.isVisible()) return;
          if (response.result.kind === 'card') await context.openDraft(response.result.draftId);
          else if (response.result.kind === 'review') await context.openReview(response.result.cardId);
          else if (response.result.scope !== 'discussion') context.onPreferenceSaved();
        });
      }); });
    }
    return { render: render, enter: enter, open: open };
  }
  return { createCompanionUI: createCompanionUI };
});
