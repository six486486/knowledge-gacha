(function () {
  "use strict";
  const runner = window.KnowledgeGachaPairedEvaluation;
  const task = window.KnowledgeGachaHarnessSkills.loadTask("concept-card");
  const baseline = window.KnowledgeGachaQualityBaseline;
  const provider = window.KnowledgeGachaProviderTransport;
  const storage = window.KnowledgeGachaStorage.createStorageAdapter(window.localStorage, window.sessionStorage);
  const checkpointKey = window.KnowledgeGachaStorage.KEYS.qualityEvaluation;
  const el = id => document.getElementById(id);
  let allCases = [], cases = [], report = null, running = false, stopRequested = false, configured = false;

  function render() {
    const progress = runner.progress(report, cases.length);
    const completed = progress.processed;
    el("progress").max = cases.length || 1;
    el("progress").value = completed;
    el("mode").disabled = running || Boolean(report);
    el("sample-field").hidden = el("mode").value !== "single";
    el("sample").disabled = running || Boolean(report) || el("mode").value !== "single";
    el("max-requests").disabled = running;
    el("max-tokens").disabled = running;
    el("mode-note").textContent = el("mode").value === "single" ? "仅运行所选 1 份素材，默认最多 4 次请求、8,000 token；不会自动开始下一份。导出并评审后再决定是否继续，不替代完整验收。" : el("mode").value === "targeted" ? "先运行曾截断的 short-05，再检查缓存、排序、事务和图片；默认 16 次请求、24,000 token，仅作问题验证。" : el("mode").value === "paired" ? "完整对比用于正式评分；旧版提示保持冻结，新旧请求均强制关闭思考。" : "仅检查新版质量，不计算新旧胜率；快速检查不能替代第二步完整验收。";
    const budget = report?.budget;
    el("usage").textContent = budget ? "已尝试 " + budget.requestsUsed + " 次请求；已知用量 " + budget.knownTokens.toLocaleString() + " token。" +
      (budget.missingUsage ? "其中 " + budget.missingUsage + " 次未获得用量，实际总量可能更高。" : "") : "尚未发送请求。";
    el("start").disabled = running || !configured || !cases.length || completed === cases.length;
    el("start").textContent = report && report.cases.length ? "继续评测" : "开始评测";
    el("stop").disabled = !running || stopRequested;
    el("export").disabled = !report || !report.cases.length;
    el("reset").disabled = running || !report;
    const statusNames = { ready: "可收下，待评分", needs_split: "待拆分", insufficient_material: "材料不足", needs_revision: "问题草稿" };
    el("cases").replaceChildren(...cases.map(sample => {
      const record = report && report.cases.find(item => item.id === sample.id);
      const li = document.createElement("li");
      li.textContent = sample.id + " · " + sample.title + "：" + (runner.outputLimitCall(record?.current) ? "输出达到上限，失败（不会重复请求）" : record?.current ? statusNames[record.current.status] || record.current.status : record?.old ? "旧版完成，新版待完成" : "等待运行");
      return li;
    }));
    if (running) return;
    const labels = { blocked: "可点击“继续评测”重试，已完成的版本和其他素材会保留。", budget_reached: "已达到预算，可导出已有结果或调高累计预算后继续。", paused: "已暂停", awaiting_ai_review: "输出完成，请导出结果交给 Codex 评分", running: "上次运行中断，可继续" };
    const next = report?.failure?.code === "MODEL_OUTPUT_LIMIT" ? "可继续处理剩余素材，此份按失败保留，不会原样重试。" : labels[report?.status] || "准备就绪";
    el("status").textContent = "已处理 " + completed + "/" + cases.length + " 份。" + (progress.outputLimited ? "其中 " + progress.outputLimited + " 份输出达到上限，未通过。" : "") +
      (completed === cases.length && cases.length ? "请导出全部结果交给 Codex 评分，失败样本仍计入结果。" : next) +
      runner.failureMessage(report);
  }

  function checkpoint(value) {
    report = value;
    try { window.localStorage.setItem(checkpointKey, JSON.stringify(report)); }
    catch { el("storage-warning").textContent = "本地保存失败。请导出已有结果，关闭此页会丢失未保存的记录。"; }
    render();
  }

  async function loadImage(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("图片加载失败");
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: reader.result });
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  el("start").addEventListener("click", async function () {
    if (running) return;
    if (!el("max-requests").reportValidity() || !el("max-tokens").reportValidity()) return;
    const mode = el("mode").value;
    const limits = { maxRequests: Number(el("max-requests").value), maxTokens: Number(el("max-tokens").value) };
    const config = Object.assign({}, storage.loadSettings(), { apiKey: storage.loadApiKey(), model: runner.MODEL, temperature: 0.3 });
    try { provider.normalizeModelConfig(config); }
    catch { el("status").textContent = "当前页面没有可用的模型连接。请返回“我的模型”保存配置后，从同一页面进入评测。"; return; }
    if (report && !runner.canResume(report, cases, task, baseline, config.model, mode)) {
      el("status").textContent = "素材或提示版本已变化，请先导出已有结果，再清除本次评测记录。";
      return;
    }
    running = true;
    stopRequested = false;
    render();
    const baseTransport = provider.createProviderTransport({ timeoutMs: 60000 });
    let phase = "旧版";
    const transport = { complete: async function (modelConfig, request) {
      phase = request.messages[0].content === baseline.prompt ? "旧版" : "新版生成或核验";
      el("status").textContent = "正在运行" + phase + "，已完成 " + (report?.cases.filter(item => item.current).length || 0) + "/" + cases.length + " 份…";
      return baseTransport.complete(modelConfig, request);
    } };
    const service = window.KnowledgeGachaCardQuality.createQualityService({ task, transport, getModelConfig: () => config });
    try {
      // Request permission from the click gesture, before waiting for images or model responses.
      await baseTransport.ensurePermission(config.baseUrl);
      report = report || runner.createReport(cases, task, baseline, config.model, mode);
      await runner.run({ cases, task, baseline, config, transport, service, report, mode, limits, loadImage, checkpoint, shouldStop: () => stopRequested });
    } catch {
      if (report) { report.status = "blocked"; checkpoint(report); }
      running = false;
      render();
      el("status").textContent = "评测未能继续。请确认模型服务域名权限及连接配置；已有结果可导出。";
      return;
    } finally {
      config.apiKey = "";
      running = false;
    }
    render();
  });

  function changeMode() {
    const mode = el("mode").value;
    cases = runner.selectCases(allCases, mode, mode === "single" ? el("sample").value : undefined);
    el("max-requests").value = runner.MODES[mode].maxRequests;
    el("max-tokens").value = runner.MODES[mode].maxTokens;
    render();
  }
  el("mode").addEventListener("change", changeMode);
  el("sample").addEventListener("change", function () {
    // Keep the user's budget when selecting a different sample before starting.
    cases = runner.selectCases(allCases, "single", el("sample").value);
    render();
  });

  el("stop").addEventListener("click", function () {
    stopRequested = true;
    render();
    el("status").textContent = "完成当前素材后暂停，已有结果会保留。";
  });

  el("export").addEventListener("click", function () {
    if (!report) return;
    const bundle = runner.exportBundle(report, cases, () => crypto.getRandomValues(new Uint8Array(1))[0] & 1);
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "card-quality-results.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  el("reset").addEventListener("click", function () {
    if (running || !window.confirm("仅清除本次评测记录。请先导出需要保留的结果。继续吗？")) return;
    try { window.localStorage.removeItem(checkpointKey); }
    catch { el("storage-warning").textContent = "无法清除本地记录，请检查浏览器存储。"; return; }
    report = null;
    changeMode();
  });

  (async function init() {
    const settings = storage.loadSettings();
    configured = Boolean(storage.loadApiKey());
    el("connection").textContent = "评测模型：" + runner.MODEL + "。" + (configured ? "已找到保存的连接配置。" : "未找到密钥，请从已配置模型的扩展页面进入。") +
      (settings.model !== runner.MODEL ? "本次仅使用指定评测模型，不更改日常设置。" : "");
    try {
      const response = await fetch("cases.json");
      if (!response.ok) throw new Error("素材加载失败");
      allCases = await response.json();
      el("sample").replaceChildren(...allCases.map(sample => {
        const option = document.createElement("option");
        option.value = sample.id;
        option.textContent = sample.id + " · " + sample.title;
        return option;
      }));
      el("sample").value = "short-05";
      report = JSON.parse(window.localStorage.getItem(checkpointKey) || "null");
      if (report) el("mode").value = report.evaluationMode || "paired";
      if (report?.evaluationMode === "single") el("sample").value = JSON.parse(report.corpus)[0]?.id || "";
      changeMode();
      if (report?.budget?.maxRequests) el("max-requests").value = report.budget.maxRequests;
      if (report?.budget?.maxTokens) el("max-tokens").value = report.budget.maxTokens;
      render();
    } catch { el("status").textContent = "无法加载评测素材或检查点。请确认已加载本项目的完整 extension 目录。"; }
  })();
})();
