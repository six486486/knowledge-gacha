(function (root) {
  "use strict";

  const DOMAINS = [
    { id: "computing", label: "计算机与 AI", icon: "bolt", detail: "理解技术，动手创造", tags: ["编程基础", "前端开发", "后端开发", "机器学习", "AI 应用", "网络与安全"] },
    { id: "business", label: "商业与经济", icon: "book", detail: "看懂商业与决策", tags: ["产品思维", "行为经济学", "市场营销", "商业模式", "管理与协作", "经济学基础"] },
    { id: "psychology", label: "心理与行为", icon: "heart", detail: "认识自己与他人", tags: ["认知偏差", "习惯养成", "学习方法", "情绪管理", "人际沟通", "决策心理"] },
    { id: "science", label: "自然科学", icon: "eye", detail: "探索世界如何运转", tags: ["数学", "物理", "化学", "生命科学", "天文", "地球科学"] },
    { id: "design", label: "设计与表达", icon: "image", detail: "把想法表达清楚", tags: ["视觉设计", "交互设计", "摄影", "写作", "演讲表达", "信息可视化"] },
    { id: "humanities", label: "人文与社会", icon: "book", detail: "理解人与文明", tags: ["历史", "哲学", "社会学", "文学", "文化与艺术", "语言学习"] }
  ];

  function createDiscoveryInterestsUI(options) {
    const page = options.page, escape = options.escapeHtml, attr = options.escapeAttr;
    let entry = {}, step = 1, domains = new Set(), topics = new Set(), revision = "", busy = "", error = "", custom = "", session = 0;
    function key(value) { return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase(); }
    function hasTopic(value) { return Array.from(topics).some(function (topic) { return key(topic) === key(value); }); }
    function removeTopic(value) { topics.forEach(function (topic) { if (key(topic) === key(value)) topics.delete(topic); }); }
    function knownDomain(value) { return DOMAINS.find(function (domain) { return key(domain.label) === key(value) || domain.tags.some(function (tag) { return key(tag) === key(value); }); }); }
    function selectedTopics() {
      const values = Array.from(topics);
      domains.forEach(function (id) {
        const domain = DOMAINS.find(function (item) { return item.id === id; });
        if (!domain.tags.some(hasTopic)) values.push(domain.label);
      });
      return Array.from(new Map(values.map(function (value) { return [key(value), value]; })).values());
    }
    function accept(result) {
      revision = result.revision;
      topics = new Set(); domains = new Set();
      result.interests.forEach(function (interest) {
        const label = interest.topicLabel || interest.value, domain = knownDomain(label);
        if (domain) domains.add(domain.id);
        topics.add(label);
      });
    }
    async function open(settings) {
      const token = ++session;
      entry = settings || {}; step = 1; error = ""; custom = ""; busy = "loading";
      domains = new Set(); topics = new Set();
      options.showPage();
      try {
        const result = entry.initial || await options.api.getDiscoveryInterests();
        if (token !== session) return;
        accept(result);
      } catch (failure) { if (token === session) error = failure.message || "读取兴趣失败，请重试"; }
      finally { if (token === session) { busy = ""; if (options.isVisible()) render(); } }
    }
    function cancel() { if (busy === "saving") return; session++; options.onCancel(entry.returnView || "discovery", Boolean(entry.onboarding)); }
    async function save(skip) {
      if (busy) return;
      if (!skip && custom.trim() && !addCustom(false)) { render(); return; }
      if (!skip && entry.onboarding && !selectedTopics().length) { error = "先选择一个兴趣，或点“先随便看看”"; render(); return; }
      const token = session;
      busy = "saving"; error = ""; render();
      try {
        const result = await options.api.saveDiscoveryInterests({ skip: skip, revision: revision, topics: selectedTopics(), mutationId: options.mutationId() });
        if (token !== session) return;
        busy = "";
        options.onSaved(result, entry.returnView || "discovery", options.isVisible());
      } catch (failure) {
        if (token !== session) return;
        error = failure.message || "兴趣没有保存，请重试"; busy = "";
        if (options.isVisible()) render();
      }
    }
    function addCustom(shouldRender) {
      const value = custom.normalize("NFKC").replace(/\s+/g, " ").trim();
      if (!value) return true;
      if (value.length > 120) { error = "兴趣主题最多 120 个字符"; if (shouldRender) render(); return false; }
      const domain = knownDomain(value);
      if (domain) domains.add(domain.id);
      if (!hasTopic(value) && (!domain || key(domain.label) !== key(value))) topics.add(value);
      custom = ""; error = "";
      if (shouldRender) { render(); page.querySelector("#interest-custom").focus(); }
      return true;
    }
    function tagButton(label, selected, extra) {
      return '<button class="interest-tag' + (selected ? ' is-selected' : '') + '" type="button" aria-pressed="' + selected + '" ' + extra + '><span>' + escape(label) + '</span><b aria-hidden="true">' + (selected ? '✓' : '+') + '</b></button>';
    }
    function render() {
      if (busy === "loading") {
        page.innerHTML = '<section class="interest-loading" role="status"><h2>正在读取你的兴趣</h2><p>稍等一下，已有选择会一起带过来。</p></section>';
        return;
      }
      const selected = selectedTopics();
      const customTopics = Array.from(topics).filter(function (value) { return !knownDomain(value); });
      page.innerHTML = '<section class="interest-setup" aria-label="选择学习兴趣">' +
        '<div class="interest-progress" aria-label="第 ' + step + ' 步，共 2 步"><span class="' + (step === 1 ? 'is-current' : 'is-done') + '">1 选择领域</span><i></i><span class="' + (step === 2 ? 'is-current' : '') + '">2 细分兴趣</span></div>' +
        '<div class="interest-intro"><span class="pending-pill">' + (entry.onboarding ? '让第一批推荐更懂你' : '你的兴趣，随时可改') + '</span><h2>' + (step === 1 ? '想发现哪些新知识？' : '想先了解哪些主题？') + '</h2><p>' + (step === 1 ? '建议选 1–3 个领域，也可以下一步自定义主题。' : '点选感兴趣的标签。不选细分标签时，会推荐该领域的不同主题。') + '</p></div>' +
        '<fieldset class="interest-fields" ' + (busy ? 'disabled' : '') + '><legend class="sr-only">' + (step === 1 ? '兴趣领域' : '兴趣标签') + '</legend>' +
        (step === 1 ? '<div class="interest-domain-grid">' + DOMAINS.map(function (domain) {
          const checked = domains.has(domain.id);
          return '<button class="interest-domain domain-' + domain.id + (checked ? ' is-selected' : '') + '" type="button" data-interest-domain="' + domain.id + '" aria-pressed="' + checked + '"><span class="interest-domain-top">' + options.icon(domain.icon) + '<i aria-hidden="true">' + (checked ? '✓' : '+') + '</i></span><strong>' + escape(domain.label) + '</strong><small>' + escape(domain.detail) + '</small></button>';
        }).join('') + '</div>' + (customTopics.length ? '<p class="interest-existing">还有 ' + customTopics.length + ' 个已保存的自定义兴趣，下一步可调整。</p>' : '')
          : '<div class="interest-tag-groups">' + DOMAINS.filter(function (domain) { return domains.has(domain.id); }).map(function (domain) {
            return '<section class="interest-tag-group" aria-label="' + attr(domain.label) + '"><h3>' + escape(domain.label) + '</h3><div class="interest-tag-list">' + domain.tags.map(function (tag) { return tagButton(tag, hasTopic(tag), 'data-interest-tag="' + attr(tag) + '"'); }).join('') + '</div></section>';
          }).join('') + '</div><section class="interest-custom-group"><label for="interest-custom">也可以自己添加兴趣</label><div class="interest-custom-input"><input class="form-input" id="interest-custom" maxlength="120" placeholder="例如：咖啡萃取、游戏设计" value="' + attr(custom) + '"><button class="secondary-btn" id="interest-add" type="button">添加</button></div><div class="interest-tag-list">' + customTopics.map(function (tag) { return tagButton(tag, true, 'data-interest-tag="' + attr(tag) + '"'); }).join('') + '</div></section>') +
        '</fieldset>' +
        (error ? '<p class="interest-error" role="alert">' + escape(error) + '</p>' : '') +
        '<div class="interest-selection-summary"><strong>' + (step === 1 ? '已选 ' + domains.size + ' 个领域' : '已选 ' + selected.length + ' 个兴趣') + '</strong><p>' + (step === 1 ? '兴趣只决定推荐方向，内容难度可以以后再调。' : selected.length ? escape(selected.join(' · ')) : '未选择兴趣，将使用通用探索。') + '</p></div>' +
        '<div class="interest-actions">' + (step === 2 ? '<button class="secondary-btn" id="interest-back" type="button" ' + (busy ? 'disabled' : '') + '>上一步</button>' : '') +
          '<button class="primary-btn" id="interest-next" type="button" ' + (busy ? 'disabled' : '') + '>' + (busy ? '正在保存…' : step === 1 ? '下一步' : entry.onboarding ? '开始推荐' : '保存兴趣') + '</button></div>' +
        '<button class="ghost-btn interest-skip" id="interest-cancel" type="button" ' + (busy ? 'disabled' : '') + '>' + (entry.onboarding ? '先随便看看' : '取消修改') + '</button>' +
        (error ? '<button class="ghost-btn interest-reload" id="interest-reload" type="button">重新载入已保存兴趣</button>' : '') +
        '</section>';
      page.querySelectorAll('[data-interest-domain]').forEach(function (button) { button.addEventListener('click', function () {
        const id = button.dataset.interestDomain, domain = DOMAINS.find(function (item) { return item.id === id; });
        if (domains.has(id)) { domains.delete(id); removeTopic(domain.label); domain.tags.forEach(removeTopic); }
        else if (domains.size < 3) { domains.add(id); }
        else { error = '建议先选最多 3 个领域，之后随时可以调整'; render(); return; }
        error = ''; render(); page.querySelector('[data-interest-domain="' + id + '"]').focus();
      }); });
      page.querySelectorAll('[data-interest-tag]').forEach(function (button) { button.addEventListener('click', function () {
        const value = button.dataset.interestTag;
        const domain = knownDomain(value);
        if (domain) removeTopic(domain.label);
        if (hasTopic(value)) removeTopic(value); else topics.add(value);
        error = ''; render();
        const next = Array.from(page.querySelectorAll('[data-interest-tag]')).find(function (item) { return item.dataset.interestTag === value; });
        (next || page.querySelector('#interest-custom')).focus();
      }); });
      const input = page.querySelector('#interest-custom');
      if (input) {
        input.addEventListener('input', function () { custom = input.value; });
        input.addEventListener('keydown', function (event) { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addCustom(true); } });
        page.querySelector('#interest-add').addEventListener('click', function () { addCustom(true); });
      }
      page.querySelector('#interest-next').addEventListener('click', function () { if (step === 1) { step = 2; error = ''; render(); options.focusPage(); } else void save(false); });
      const back = page.querySelector('#interest-back');
      if (back) back.addEventListener('click', function () { step = 1; error = ''; render(); options.focusPage(); });
      page.querySelector('#interest-cancel').addEventListener('click', function () { if (entry.onboarding) void save(true); else cancel(); });
      const reload = page.querySelector('#interest-reload');
      if (reload) reload.addEventListener('click', function () { void open({ onboarding: entry.onboarding, returnView: entry.returnView }); });
    }
    return { open: open, render: render, cancel: cancel };
  }
  root.KnowledgeGachaDiscoveryInterestsUI = { createDiscoveryInterestsUI: createDiscoveryInterestsUI };
})(typeof window !== "undefined" ? window : globalThis);
