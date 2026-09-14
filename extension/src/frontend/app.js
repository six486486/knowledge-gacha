(function () {
  const DAILY_REVIEW_LIMIT = 3;
  const cardDomain = window.KnowledgeGachaCardDomain;
  const storageModule = window.KnowledgeGachaStorage;
  const agentApiModule = window.KnowledgeGachaExtensionService;
  const browserCaptureModule = window.KnowledgeGachaBrowserCapture;
  const materialIndex = window.KnowledgeGachaMaterialIndex;
  if (!cardDomain || !storageModule || !agentApiModule || !browserCaptureModule) throw new Error("知识扭蛋机核心模块加载失败");
  const COLORS = cardDomain.COLORS;
  const normalizeText = cardDomain.normalizeText;
  const sanitizeCard = cardDomain.sanitizeCard;
  const shuffled = cardDomain.shuffled;
  const storage = storageModule.createStorageAdapter(window.localStorage, window.sessionStorage, {
    sanitizeCard: sanitizeCard,
    normalizeText: normalizeText,
    dailyReviewLimit: DAILY_REVIEW_LIMIT
  });
  const profileId = storage.getOrCreateProfileId();
  const initialLearningState = storage.loadLearningStateSnapshot();
  const savedModelSettings = storage.loadSettings();
  const agentApi = agentApiModule.createExtensionService({
    profileId: profileId,
    storage: window.localStorage,
    cardDomain: cardDomain,
    providerModule: window.KnowledgeGachaProviderTransport,
    chromeApi: window.chrome,
    getModelConfig: function () { return state.aiConfig; }
  });
  const browserCapture = browserCaptureModule.createBrowserCapture(window.chrome);
  const state = {
    view: "home",
    filter: "all",
    keyword: "",
    discoveryPools: [],
    currentDiscoveryPoolId: "",
    discoveryLoading: false,
    discoverySetupLoading: false,
    discoveryError: "",
    discoveryScrollTop: 0,
    discoveryOpeningId: "",
    drawReturnView: "",
    feedText: "",
    feedBlocks: null,
    documentImports: [],
    feedGoal: "",
    feedAllowSupplemental: false,
    knowledgePlans: [],
    batchFilter: "",
    materialDraftId: "",
    feedImage: null,
    captureSource: null,
    manualInputCollapsed: false,
    captureBusy: false,
    captureError: "",
    sourceDocuments: [],
    sourceConnection: "loading",
    sourceLoading: false,
    sourceError: "",
    sourceCheck: null,
    sourceCheckKey: "",
    sourceCheckLoading: false,
    sourceCheckError: "",
    sourceDuplicateAction: "",
    sourceDuplicateTargetId: "",
    saveFullSource: false,
    saveOriginalFile: false,
    cards: initialLearningState.cards,
    pending: initialLearningState.pending,
    gachaDrafts: [],
    currentDraftId: "",
    draftBusy: false,
    clearingData: false,
    totalDraws: initialLearningState.totalDraws,
    currentDrawnId: "",
    plainMode: false,
    manageMode: false,
    selectedIds: new Set(),
    reviewDay: initialLearningState.reviewDay,
    reviewOverview: null,
    reviewQuestion: null,
    reviewFeedback: null,
    reviewHint: "",
    reviewAnswer: null,
    reviewRecallResponse: "",
    reviewLoading: false,
    reviewSubmitting: false,
    reviewVariantLoading: false,
    reviewError: "",
    reviewCardId: "",
    reviewOrder: [],
    reviewStartedAt: 0,
    connectionStatus: "unknown",
    connectionMessage: "",
    agentConnectionMessage: "",
    agentInput: "",
    agentBusy: false,
    agentResponse: null,
    agentError: "",
    aiConfig: {
      baseUrl: savedModelSettings.baseUrl,
      model: savedModelSettings.model,
      temperature: savedModelSettings.temperature,
      apiKey: storage.loadApiKey(),
      rememberApiKey: storage.hasPersistentApiKey()
    },
    reducedMotion: savedModelSettings.reducedMotion,
    memoryTab: "interests",
    memoryRecordTab: "concepts",
    memoryLoading: false,
    memoryLoaded: false,
    memoryError: "",
    memoryConcepts: [],
    memoryPreferences: [],
    memoryCandidates: [],
    memoryContext: null,
    mcpAuditLoading: false,
    mcpAuditLoaded: false,
    mcpAuditError: "",
    mcpAuditItems: [],
    observabilityFilters: { window: "24h", status: "all", skill: "all", source: "all", limit: 20 },
    observabilityLoading: false,
    observabilityLoaded: false,
    observabilityError: "",
    observabilityDashboard: null,
    observabilityRun: null,
    observabilityTraceLoading: false,
    observabilityTraceError: "",
    observabilityTraceItems: [],
    observabilityTraceHasMore: false
  };
  let persistenceReady = false;
  let stateRevision = 0;
  let mutationSequence = 0;
  let sourceCheckSequence = 0;
  let syncQueue = Promise.resolve();
  let lastModalTrigger = null;

  const page = document.getElementById("page");
  const pageViewport = document.getElementById("page-viewport");
  const pageTitle = document.getElementById("page-title");
  const pageKicker = document.getElementById("page-kicker");
  const topAction = document.getElementById("top-action");
  const topActionIcon = document.getElementById("top-action-icon");
  const loader = document.getElementById("loader");
  const loaderText = document.getElementById("loader-text");
  const modal = document.getElementById("modal");
  const modalPanel = modal.querySelector(".modal-panel");
  const modalContent = document.getElementById("modal-content");
  const toastNode = document.getElementById("toast");
  const knowledgePlanUI = window.KnowledgeGachaPlanUI.createKnowledgePlanUI({
    api: agentApi, page: page, modalContent: modalContent, escapeHtml: escapeHtml, escapeAttr: escapeAttr,
    openModal: openModal, closeModal: closeModal, toast: toast,
    isVisible: function () { return state.view === "plan"; }, showPage: function () { setView("plan"); }, goFeed: function () { setView("feed"); },
    onChange: loadKnowledgePlans,
    openDraft: async function (draftId) {
      const result = await agentApi.getGachaCardDraft(draftId);
      state.gachaDrafts = [result.session].concat(state.gachaDrafts.filter(function (item) { return item.id !== draftId; }));
      setView("draw"); state.currentDraftId = draftId; renderDraw();
    },
    afterSave: async function () {
      await syncQueue;
      applyLearningState((await agentApi.loadLearningState()).state);
      storage.saveLearningStateSnapshot(currentLearningState());
      await bootstrapGachaDrafts(); await loadKnowledgeSources();
    }
  });

  const documentImportUI = window.KnowledgeGachaDocumentImportUI.createDocumentImportUI({
    api: agentApi, page: page, modalContent: modalContent, escapeHtml: escapeHtml, escapeAttr: escapeAttr,
    openModal: openModal, closeModal: closeModal, toast: toast,
    isVisible: function () { return state.view === "import"; }, showPage: function () { setView("import"); }, goFeed: function () { setView("feed"); },
    onChange: loadDocumentImports,
    onMaterial: async function (material) {
      resetSourceProductState(); state.feedText = material.text; state.feedBlocks = material.blocks; state.feedImage = null;
      state.captureSource = material.source; setView("feed"); void loadGachaSourceCheck();
    }
  });
  let discoverySetupSequence = 0;
  const discoveryInterestsUI = window.KnowledgeGachaDiscoveryInterestsUI.createDiscoveryInterestsUI({
    api: agentApi, page: page, escapeHtml: escapeHtml, escapeAttr: escapeAttr, icon: icon, mutationId: nextMutationId,
    isVisible: function () { return state.view === "interests"; }, showPage: function () { setView("interests"); },
    focusPage: function () { pageViewport.scrollTo({ top: 0, behavior: "instant" }); page.focus({ preventScroll: true }); },
    onCancel: function (returnView, onboarding) { setView(onboarding ? "home" : returnView); },
    onSaved: function (result, returnView, visible) {
      if (result.changed) { invalidateLocalDiscoveryPools(); state.memoryLoaded = false; }
      if (returnView === "memory") state.memoryTab = "interests";
      if (visible) setView(returnView);
    }
  });
  window.addEventListener("pagehide", function () { agentApi.dispose(); });
  const companionUI = window.KnowledgeGachaCompanionUI.createCompanionUI({
    api: agentApi, page: page, escapeHtml: escapeHtml, mutationId: nextMutationId,
    isVisible: function () { return state.view === "agent"; }, show: function () { setView("agent"); },
    isConfigured: isModelConfigured, modelName: function () { return state.aiConfig.model; }, openModel: function () { setView("model"); },
    getLastSession: function () { return localStorage.getItem("kg_companion_active:" + profileId) || ""; },
    setLastSession: function (id) { localStorage.setItem("kg_companion_active:" + profileId, id); },
    capture: function (type) { return type === "selection" ? browserCapture.captureSelection() : browserCapture.capturePage(); },
    openCard: openCard,
    openDraft: async function (id) {
      const response = await agentApi.getGachaCardDraft(id);
      state.gachaDrafts = [response.session].concat(state.gachaDrafts.filter(function (draft) { return draft.id !== id; }));
      setView("draw"); state.currentDraftId = id; renderDraw();
    },
    openReview: async function (id) {
      state.view = "review"; state.reviewQuestion = null; state.reviewFeedback = null; state.reviewLoading = false;
      render(); await openReviewGacha(id);
    },
    onPreferenceSaved: function () { state.memoryLoaded = false; invalidateLocalDiscoveryPools(); toast("已保存讲解偏好，可在我的学习偏好中修改或删除"); }
  });

  document.querySelectorAll(".nav-item[data-view]").forEach(function (button) {
    button.addEventListener("click", function () {
      setView(button.dataset.view);
    });
  });
  topAction.addEventListener("click", function () {
    if (state.view === "interests") { discoveryInterestsUI.cancel(); return; }
    const target = topAction.dataset.target;
    if (target) setView(target);
  });
  document.getElementById("modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", function (event) {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", handleGlobalKeydown);
  enableMouseDragScroll();
  applyMotionPreference();

  render();
  void bootstrapLearningState().then(bootstrapGachaReview);
  void bootstrapGachaDrafts();
  void bootstrapDiscoveryPools();
  void loadKnowledgeSources();
  void loadKnowledgePlans();
  void loadDocumentImports();

  function setView(view) {
    const previous = state.view;
    const restoreDiscoveryScroll = view === "discovery" && previous === "draw" && state.drawReturnView === "discovery";
    state.view = view;
    if (view === "review" && previous !== "review") {
      state.reviewQuestion = null;
      state.reviewFeedback = null;
      state.reviewCardId = "";
      state.reviewOrder = [];
      state.reviewLoading = true;
      state.reviewError = "";
    }
    if (view === "draw" && previous !== "draw") {
      if (previous !== "discovery") state.drawReturnView = "";
      state.currentDrawnId = "";
      state.currentDraftId = "";
      state.plainMode = false;
    }
    render();
    if (view === "review" && previous !== "review") void loadGachaReview();
    if (view === "memory" && previous !== "memory") void loadMemoryData();
    if (view === "agent" && previous !== "agent") void companionUI.enter();
    if (view === "observability" && previous !== "observability") {
      state.observabilityRun = null;
      state.observabilityTraceItems = [];
      void loadObservabilityDashboard();
      void loadMcpAudit();
    }
    if (view === "discovery" && previous !== "discovery") void ensureDiscoveryPool();
    pageViewport.scrollTo({ top: restoreDiscoveryScroll ? state.discoveryScrollTop : 0, behavior: "instant" });
    window.requestAnimationFrame(function () { page.focus({ preventScroll: true }); });
  }

  function render() {
    document.body.dataset.view = state.view;
    const navView = state.view === "draw" ? (state.drawReturnView === "discovery" ? "home" : "feed")
      : ({ plan: "feed", import: "feed", discovery: "home", interests: "home", settings: "home", model: "home", memory: "home", observability: "home" }[state.view] || state.view);
    document.querySelectorAll(".nav-item").forEach(function (button) {
      const active = button.dataset.view === navView;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const titles = {
      home: ["Knowledge Gacha", "知识扭蛋机"],
      feed: ["Capture · Distill · Remember", "凝练成卡"],
      plan: ["Learning Plan", "学习清单与卡组"],
      import: ["Document Import", "解析预览与范围选择"],
      draw: ["Open Capsule", "抽蛋"],
      album: ["Card Album", "卡册"],
      review: ["Tiny Review", "复习"],
      settings: ["Your Gacha", "更多"],
      model: ["Your Model", "我的模型"],
      agent: ["Learn Together", "伴学"],
      memory: ["My Learning", "偏好与学习记录"],
      discovery: ["Discover Gacha", "发现扭蛋"],
      interests: ["Your Interests", "选择兴趣"],
      observability: ["Run History", "运行记录"]
    };
    const title = titles[state.view] || titles.home;
    pageKicker.textContent = title[0];
    pageTitle.textContent = title[1];
    configureTopAction();
    if (state.view === "home") renderHome();
    if (state.view === "feed") renderFeed();
    if (state.view === "plan") knowledgePlanUI.render();
    if (state.view === "import") documentImportUI.render();
    if (state.view === "draw") renderDraw();
    if (state.view === "album") renderAlbum();
    if (state.view === "review") renderReview();
    if (state.view === "settings") renderSettings();
    if (state.view === "model") renderModelSettings();
    if (state.view === "agent") companionUI.render();
    if (state.view === "memory") renderMemory();
    if (state.view === "discovery") renderDiscovery();
    if (state.view === "interests") discoveryInterestsUI.render();
    if (state.view === "observability") renderObservability();
  }

  function configureTopAction() {
    const actions = {
      home: ["menu.svg", "settings", "更多与设置"],
      draw: state.drawReturnView === "discovery" ? ["arrow-left.svg", "discovery", "返回发现"] : ["home.svg", "home", "回到首页"],
      plan: ["arrow-left.svg", "feed", "返回制卡"],
      import: ["arrow-left.svg", "feed", "返回制卡"],
      interests: ["arrow-left.svg", "discovery", "返回上一页"],
      album: ["plus.svg", "feed", "凝练成卡"],
      review: ["home.svg", "home", "回到首页"],
      settings: ["arrow-left.svg", "home", "返回首页"],
      model: ["arrow-left.svg", "settings", "返回更多"],
      agent: ["menu.svg", "settings", "更多与设置"],
      discovery: ["arrow-left.svg", "home", "返回首页"],
      memory: ["arrow-left.svg", "settings", "返回更多"],
      observability: ["arrow-left.svg", "settings", "返回更多"]
    };
    const action = actions[state.view];
    topAction.hidden = !action;
    if (!action) {
      topAction.dataset.target = "";
      return;
    }
    topActionIcon.src = "./assets/icons/" + action[0];
    topAction.dataset.target = action[1];
    topAction.setAttribute("aria-label", action[2]);
  }

  function renderHome() {
    const dueCount = state.reviewOverview ? state.reviewOverview.dueCount : dueCards().length;
    const recent = state.cards.slice(0, 6);
    const pendingCount = readyDrafts().length + state.pending.length;
    page.innerHTML =
      '<section class="hero-band home-primary-hero">' +
        '<div class="hero-copy">' +
          '<span class="pending-pill">待打开 ' + pendingCount + '</span>' +
          '<h2>' + (pendingCount ? "把今天的新知识扭出来" : "捕获一段，做成第一颗知识扭蛋") + '</h2>' +
          '<p>' + (pendingCount ? "材料已经凝练好，打开后再决定要不要收进卡册。" : "框选网页、截下画面或手动输入，把值得记住的内容变成小卡片。") + '</p>' +
        '</div>' +
        '<div class="machine-wrap">' + machineHtml() + '</div>' +
        '<button class="draw-button" id="home-draw" type="button"><span class="draw-dot"></span><span>' + (pendingCount ? "打开 " + pendingCount + " 颗待开扭蛋" : "投入第一段知识") + '</span></button>' +
      '</section>' +
      '<section class="home-task-grid" aria-label="今天的学习任务">' +
        '<button class="home-task-card is-feed" id="home-feed" type="button"><span class="home-task-icon">' + icon("plus") + '</span><span><strong>投入知识</strong><small>框选、截图或输入</small></span></button>' +
        '<button class="home-task-card is-review" id="home-review" type="button"><span class="home-task-icon">' + icon("heart") + '</span><span><strong>' + (dueCount ? "今日复习 · " + dueCount : "查看复习") + '</strong><small>' + (dueCount ? "一次一题，随答随调" : "看看下一颗何时到期") + '</small></span></button>' +
      '</section>' +
      '<div class="stats-strip">' +
        statTile(state.cards.length, "已收集") +
        statTile(pendingCount, "待打开") +
        statTile(dueCount, "待复习") +
      '</div>' +
      '<button class="discovery-home-entry" id="home-discovery" type="button"><span class="discovery-home-capsules"><i></i><i></i><i></i></span><span><small>为你推荐</small><strong>发现新知识</strong><em>主题、目标与推荐理由先看清楚</em></span><b>去看看</b></button>' +
      '<div class="section-head"><h2 class="section-title">最近收集</h2><button class="pill-btn" id="home-album" type="button">' + icon("book") + '<span>卡册</span></button></div>' +
      (recent.length ? '<div class="recent-card-list">' + recent.map(function (card) { return cardTile(card); }).join("") + '</div>' : emptyPanel("捕获一段值得记住的内容，第一张知识卡就会出现。", "开始制卡", "home-empty-feed"));

    document.getElementById("home-feed").addEventListener("click", function () { setView("feed"); });
    document.getElementById("home-draw").addEventListener("click", function () { setView(pendingCount ? "draw" : "feed"); });
    document.getElementById("home-review").addEventListener("click", function () { setView("review"); });
    document.getElementById("home-discovery").addEventListener("click", function () { setView("discovery"); });
    document.getElementById("home-album").addEventListener("click", function () { setView("album"); });
    const emptyFeed = document.getElementById("home-empty-feed");
    if (emptyFeed) emptyFeed.addEventListener("click", function () { setView("feed"); });
    bindCardTiles();
  }

  function reviewHomeEntry() {
    const review = state.reviewOverview;
    const status = review ? review.status : "loading";
    const dueCount = review ? review.dueCount : dueCards().length;
    const title = status === "goal_reached"
      ? "今天的 " + (review.dailyGoal || DAILY_REVIEW_LIMIT) + " 颗目标已完成"
      : status === "no_due_reviews"
        ? "现在没有到期的复习扭蛋"
        : dueCount
          ? "有 " + dueCount + " 颗知识等待加固"
          : "正在查看今天的薄弱点";
    const detail = status === "ready"
      ? "一次一题 · 作答后立即重排"
      : status === "goal_reached"
        ? "可以收工，也可以继续学习"
        : "复习计划由到期时间和掌握度决定";
    const action = status === "ready" ? "去扭一颗" : "查看";
    return '<button class="review-home-entry" id="home-review" type="button"><span class="review-home-capsule" aria-hidden="true"><i></i></span><span><small>WEAK POINT GACHA</small><strong>' + escapeHtml(title) + '</strong><em>' + escapeHtml(detail) + '</em></span><b>' + action + '</b></button>';
  }

  function renderDiscovery() {
    const pool = currentDiscoveryPool();
    if (state.discoverySetupLoading && !pool) {
      page.innerHTML = '<section class="interest-loading" role="status"><h2>正在读取你的兴趣</h2><p>准备适合你的学习方向。</p></section>';
      return;
    }
    if (state.discoveryLoading && !pool) {
      page.innerHTML = '<section class="discovery-loading"><span class="discovery-loader-capsule"></span><h2>正在准备具体学习方向</h2><p>模型只生成候选提纲；排除、去重、排序和真实理由由扩展核对。</p></section>';
      return;
    }
    if (!pool) {
      const configured = isModelConfigured();
      page.innerHTML = '<section class="discovery-intro discovery-start"><div><span class="pending-pill">为你推荐</span><h2>下一颗，学点真正新的</h2><p>候选会先展示主题、目标和新增内容；完整卡片只在你打开时生成。</p></div><span class="discovery-orbit" aria-hidden="true"><i></i><i></i><i></i></span></section>' +
        (state.discoveryError ? '<p class="discovery-error">' + escapeHtml(state.discoveryError) + '</p>' : '') +
        '<section class="discovery-empty-state"><h3>' + (configured ? '准备你的第一批具体方向' : '先连接你的模型') + '</h3><p>' +
          (configured ? '没有卡片或偏好也可以直接探索；添加兴趣后，候选会更贴近你的选择。' : '发现页不会用固定模板冒充个性化推荐。模型配置完成后再生成具体候选。') +
        '</p><div><button class="secondary-btn" id="discovery-interests" type="button">调整兴趣</button><button class="primary-btn" id="discovery-retry" type="button">' + (configured ? '生成推荐' : '去配置模型') + '</button></div></section>';
      document.getElementById("discovery-interests").addEventListener("click", function () { void discoveryInterestsUI.open({ returnView: "discovery" }); });
      document.getElementById("discovery-retry").addEventListener("click", function () { if (configured) void createDiscoveryPool(""); else setView("model"); });
      return;
    }
    const candidates = (pool.candidates || []).filter(function (item) { return !["dismissed", "feedback_applied"].includes(item.status); });
    const dueCount = state.reviewOverview?.dueCount || 0;
    page.innerHTML =
      '<section class="discovery-intro"><div><span class="pending-pill">第 ' + pool.batch + ' 批 · ' + candidates.length + ' 个方向</span><h2>下一颗，学点真正新的</h2><p>主题先看清楚；打开后才生成完整学习卡。</p><div class="discovery-intro-actions"><button class="secondary-btn" id="discovery-refresh" type="button" ' + (state.discoveryLoading ? 'disabled' : '') + '>' + icon("refresh") + '<span>换个方向</span></button><button class="secondary-btn" id="discovery-interests" type="button">调整兴趣</button></div></div><span class="discovery-orbit" aria-hidden="true"><i></i><i></i><i></i></span></section>' +
      (state.discoveryError ? '<p class="discovery-error">' + escapeHtml(state.discoveryError) + '</p>' : '') +
      (!isModelConfigured() ? '<p class="discovery-error">现有候选仍保留；再次生成或打开新候选前，请先恢复模型配置。</p>' : '') +
      (pool.status === "stale" ? '<p class="discovery-update-note">学习偏好已经变化；当前方向仍可查看，换个方向后会按新设置生成。</p>' : '') +
      (candidates.length ? '<div class="discovery-candidate-list" aria-label="发现候选">' + candidates.map(discoveryCandidateHtml).join("") + '</div>'
        : '<section class="discovery-empty-state"><h3>这一批没有合适的新方向</h3><p>已展示、排除和同义目标不会改名重复凑数。你可以换个方向或结束本次发现。</p></section>') +
      (dueCount ? '<button class="discovery-review-reminder" id="discovery-review-reminder" type="button"><strong>还有 ' + dueCount + ' 颗知识待复习</strong><span>发现与复习分开安排，随时回去加固</span></button>' : '') +
      '<p class="discovery-boundary">推荐理由与卡片知识依据分开保存。喜欢、降权、排除和难度设置会影响后续候选，并可在“我的学习偏好”中撤销。</p>' +
      '<button class="ghost-btn discovery-end" id="discovery-dismiss" type="button" ' + (state.discoveryLoading ? 'disabled' : '') + '>结束本次发现</button>';
    document.querySelectorAll("[data-discovery-reason]").forEach(function (button) {
      button.addEventListener("click", function () { openDiscoveryReason(pool, button.dataset.discoveryReason); });
    });
    document.querySelectorAll("[data-discovery-more]").forEach(function (button) {
      button.addEventListener("click", function () { openDiscoveryFeedback(pool, button.dataset.discoveryMore); });
    });
    document.querySelectorAll("[data-discovery-like]").forEach(function (button) {
      button.addEventListener("click", function () { void applyDiscoveryFeedback(pool.id, button.dataset.discoveryLike, "like_topic"); });
    });
    document.querySelectorAll("[data-discovery-open]").forEach(function (button) {
      button.addEventListener("click", function () { void openDiscoveryCandidate(pool, button.dataset.discoveryOpen); });
    });
    document.getElementById("discovery-refresh").addEventListener("click", function () { void createDiscoveryPool(pool.id); });
    document.getElementById("discovery-interests").disabled = state.discoveryLoading;
    document.getElementById("discovery-interests").addEventListener("click", function () { void discoveryInterestsUI.open({ returnView: "discovery" }); });
    document.getElementById("discovery-dismiss").addEventListener("click", function () { void dismissDiscoveryPool(pool.id); });
    const reviewReminder = document.getElementById("discovery-review-reminder");
    if (reviewReminder) reviewReminder.addEventListener("click", function () { setView("review"); });
  }

  function discoveryCandidateHtml(candidate) {
    const difficulty = candidate.difficulty === "foundation" ? "入门" : candidate.difficulty === "challenge" ? "进阶" : "标准";
    const liked = (candidate.feedback || []).some(function (item) { return item.action === "like_topic"; });
    const opened = candidate.status === "opened";
    const saved = candidate.status === "saved";
    return '<article class="discovery-candidate mode-' + escapeAttr(candidate.mode) + ' status-' + escapeAttr(candidate.status) + '">' +
      '<div class="discovery-candidate-main"><span class="discovery-capsule" aria-hidden="true"><i></i></span><div class="discovery-candidate-copy">' +
        '<span class="discovery-candidate-top"><b>' + escapeHtml(difficulty) + '</b><em>' + escapeHtml(candidate.evidenceLabel || candidate.badge) + '</em></span>' +
        '<h3>' + escapeHtml(candidate.topic) + '</h3><p>' + escapeHtml(candidate.learningObjective) + '</p></div></div>' +
      '<div class="discovery-novelty"><span>这次新增</span><p>' + escapeHtml(candidate.newKnowledge) + '</p></div>' +
      '<button class="discovery-relationship" type="button" data-discovery-reason="' + escapeAttr(candidate.id) + '"><span>' + escapeHtml(candidate.relationship) + '</span><b>查看依据</b></button>' +
      '<div class="discovery-card-actions"><button class="primary-btn" type="button" data-discovery-open="' + escapeAttr(candidate.id) + '" ' + (saved || state.discoveryLoading ? 'disabled' : '') + '>' +
        (state.discoveryOpeningId === candidate.id ? '正在打开…' : saved ? '已收下' : opened ? '继续编辑' : '打开学习') +
        '</button><button class="secondary-btn ' + (liked ? 'is-liked' : '') + '" type="button" data-discovery-like="' + escapeAttr(candidate.id) + '" aria-pressed="' + liked + '" ' + (liked || state.discoveryLoading ? 'disabled' : '') + '>' + (liked ? '已喜欢' : '喜欢这个方向') + '</button>' +
        '<button class="secondary-btn" type="button" data-discovery-more="' + escapeAttr(candidate.id) + '" ' + (state.discoveryLoading ? 'disabled' : '') + '>更多</button></div></article>';
  }

  function openDiscoveryReason(pool, candidateId) {
    const candidate = pool.candidates.find(function (item) { return item.id === candidateId; });
    if (!candidate) return;
    const sourceLabels = { review_event: "复习证据", recent_card: "最近卡片", card: "已有卡片", preference: "明确偏好", exploration_rule: "通用探索规则" };
    const related = (candidate.relatedCardIds || []).map(getCard).filter(Boolean);
    modalContent.innerHTML = '<p class="eyebrow">推荐依据 · ' + escapeHtml(candidate.evidenceLabel || candidate.badge) + '</p><h2 class="modal-title">' + escapeHtml(candidate.topic) + '</h2>' +
      '<p class="discovery-reason-summary">' + escapeHtml(candidate.relationship) + '</p><div class="discovery-reasons">' + candidate.reasons.map(function (reason) { return '<article><span>' + escapeHtml(sourceLabels[reason.sourceType] || "可追溯依据") + '</span><p>' + escapeHtml(reason.summary) + '</p></article>'; }).join("") + '</div>' +
      (related.length ? '<div class="discovery-related-cards">' + related.map(function (card) { return '<button type="button" data-discovery-related-card="' + escapeAttr(card.id) + '">查看《' + escapeHtml(card.title) + '》</button>'; }).join("") + '</div>' : '') +
      '<p class="privacy-note">推荐理由说明为什么选中方向；完整卡片中的知识引用会另行核验。候选规划不读取待确认或已忽略记忆，也不使用其他档案的数据。</p><div class="modal-actions"><button class="primary-btn" id="discovery-reason-close" type="button">知道了</button></div>';
    document.getElementById("discovery-reason-close").addEventListener("click", closeModal);
    document.querySelectorAll("[data-discovery-related-card]").forEach(function (button) {
      button.addEventListener("click", function () { closeModal(); openCard(button.dataset.discoveryRelatedCard); });
    });
    openModal();
  }

  async function ensureDiscoveryPool() {
    const sequence = ++discoverySetupSequence;
    state.discoverySetupLoading = true;
    renderDiscovery();
    try {
      const interests = await agentApi.getDiscoveryInterests();
      if (sequence !== discoverySetupSequence || state.view !== "discovery") return;
      state.discoverySetupLoading = false;
      if (!interests.completed) {
        void discoveryInterestsUI.open({ onboarding: true, initial: interests, returnView: "discovery" });
        return;
      }
      const current = currentDiscoveryPool();
      if (current && ["active", "empty"].includes(current.status) && current.contextMemoryVersion === interests.memoryVersion) { renderDiscovery(); return; }
      const active = state.discoveryPools.find(function (pool) { return ["active", "empty"].includes(pool.status) && pool.contextMemoryVersion === interests.memoryVersion && pool.poolVersion === window.KnowledgeGachaBackendDiscovery.POOL_VERSION && pool.rankingVersion === window.KnowledgeGachaBackendDiscovery.RANKING_VERSION; });
      if (active) { state.currentDiscoveryPoolId = active.id; renderDiscovery(); return; }
      if (!isModelConfigured()) { state.discoveryError = "请先配置模型，再生成具体发现候选"; renderDiscovery(); return; }
      await createDiscoveryPool("");
    } catch (error) {
      if (sequence === discoverySetupSequence) state.discoveryError = error.message || "读取兴趣失败，请重试";
    } finally {
      if (sequence === discoverySetupSequence) { state.discoverySetupLoading = false; if (state.view === "discovery") renderDiscovery(); }
    }
  }

  async function createDiscoveryPool(refreshFromPoolId) {
    if (state.discoveryLoading) return;
    if (!isModelConfigured()) { state.discoveryError = "请先配置模型，再生成具体发现候选"; renderDiscovery(); return; }
    state.discoveryLoading = true;
    state.discoveryError = "";
    if (state.view === "discovery") renderDiscovery();
    try {
      const response = await agentApi.createGachaDiscoveryPool(refreshFromPoolId);
      if (refreshFromPoolId) {
        const previous = state.discoveryPools.find(function (pool) { return pool.id === refreshFromPoolId; });
        if (previous) previous.status = "refreshed";
      }
      replaceDiscoveryPool(response.pool);
      state.currentDiscoveryPoolId = response.pool.id;
      toast(response.pool.candidates.length ? (refreshFromPoolId ? "已换成新的学习方向" : "具体学习方向已就位") : "没有用重复方向凑数，可以稍后再来");
    } catch (error) {
      state.discoveryError = error.message || "发现扭蛋准备失败";
    } finally {
      state.discoveryLoading = false;
      if (state.view === "discovery") renderDiscovery();
    }
  }

  async function dismissDiscoveryPool(poolId) {
    if (state.discoveryLoading) return;
    state.discoveryLoading = true;
    try {
      const response = await agentApi.sendGachaDiscoveryFeedback(poolId, { action: "end_session", mutationId: nextMutationId() });
      replaceDiscoveryPool(response.pool);
      toast("这批先收起来，不会改写长期偏好");
      setView("home");
    } catch (error) {
      state.discoveryError = error.message || "暂时无法收起这批扭蛋";
      renderDiscovery();
    } finally {
      state.discoveryLoading = false;
    }
  }

  function openDiscoveryFeedback(pool, candidateId) {
    const candidate = pool.candidates.find(function (item) { return item.id === candidateId; });
    if (!candidate) return;
    const actions = [
      ["dismiss_candidate", "暂时不看", "只移出当前这批，不改长期偏好"],
      ["less_topic", "少推荐这个主题", "降低主题排序"],
      ["exclude_unit", "不再推荐这个知识点", "持续排除同一学习单元"],
      ["too_simple", "太简单", "提高这个主题的难度"],
      ["too_hard", "太难", "降低这个主题的难度"]
    ];
    modalContent.innerHTML = '<p class="eyebrow">调整推荐 · 立即生效</p><h2 class="modal-title">' + escapeHtml(candidate.topic) + '</h2>' +
      '<div class="discovery-feedback-grid">' + actions.map(function (action) {
        return '<button type="button" data-apply-discovery-feedback="' + action[0] + '"><strong>' + action[1] + '</strong><span>' + action[2] + '</span></button>';
      }).join("") + '</div><p class="privacy-note">除“暂时不看”外，这些都是你的明确设置，可在“我的学习偏好”中停用或删除。答错、打开和收藏不会自动变成不喜欢。</p>' +
      '<div class="modal-actions"><button class="secondary-btn" id="discovery-feedback-cancel" type="button">取消</button></div>';
    document.getElementById("discovery-feedback-cancel").addEventListener("click", closeModal);
    document.querySelectorAll("[data-apply-discovery-feedback]").forEach(function (button) {
      button.addEventListener("click", function () { void applyDiscoveryFeedback(pool.id, candidate.id, button.dataset.applyDiscoveryFeedback); });
    });
    openModal();
  }

  async function applyDiscoveryFeedback(poolId, candidateId, action) {
    if (state.discoveryLoading) return;
    state.discoveryLoading = true;
    try {
      const response = await agentApi.sendGachaDiscoveryFeedback(poolId, { action: action, candidateId: candidateId, mutationId: nextMutationId() });
      replaceDiscoveryPool(response.pool);
      closeModal();
      state.memoryLoaded = false;
      toast(action === "dismiss_candidate" ? "这一条已从本批移开" : action === "like_topic" ? "已记住你喜欢这个方向" : "推荐设置已生效，可在学习偏好中撤销");
    } catch (error) {
      toast(error.message || "反馈暂未保存");
    } finally {
      state.discoveryLoading = false;
      if (state.view === "discovery") renderDiscovery();
    }
  }

  async function openDiscoveryCandidate(pool, candidateId) {
    if (state.discoveryLoading || !candidateId) return;
    const candidate = pool.candidates.find(function (item) { return item.id === candidateId; });
    if (!candidate) return;
    if (!isModelConfigured() && !candidate.openedDraftId) {
      toast("先在 AI 设置中填写 Base URL、API Key 和模型名称");
      setView("model");
      return;
    }
    state.discoveryLoading = true;
    state.discoveryOpeningId = candidateId;
    state.discoveryScrollTop = pageViewport.scrollTop;
    renderDiscovery();
    showLoader("正在打开发现扭蛋并凝练知识卡");
    try {
      const response = await agentApi.openGachaDiscoveryCandidate(pool.id, candidateId);
      replaceDiscoveryPool(response.pool);
      state.gachaDrafts = state.gachaDrafts.filter(function (item) { return item.id !== response.session.id; });
      state.gachaDrafts.unshift(response.session);
      state.currentDraftId = response.session.id;
      state.currentDrawnId = "";
      state.drawReturnView = "discovery";
      setView("draw");
      state.currentDraftId = response.session.id;
      renderDraw();
      toast(response.alreadyOpened ? "已恢复这颗发现草稿" : "扭蛋已打开，请检查新增内容后再收下");
    } catch (error) {
      state.discoveryError = error.message || "扭蛋没有打开，请重试";
      toast(state.discoveryError);
    } finally {
      state.discoveryLoading = false;
      state.discoveryOpeningId = "";
      hideLoader();
      if (state.view === "discovery") renderDiscovery();
    }
  }

  function currentDiscoveryPool() {
    return state.discoveryPools.find(function (pool) { return pool.id === state.currentDiscoveryPoolId; }) || null;
  }

  function replaceDiscoveryPool(pool) {
    state.discoveryPools = state.discoveryPools.filter(function (item) { return item.id !== pool.id; });
    state.discoveryPools.unshift(pool);
  }

  function invalidateLocalDiscoveryPools() {
    state.discoveryPools.forEach(function (pool) { if (["active", "empty"].includes(pool.status)) pool.status = "stale"; });
    state.currentDiscoveryPoolId = "";
  }

  function renderFeed() {
    const sourceVisible = state.captureSource && !state.manualInputCollapsed;
    const connected = state.connectionStatus === "ready";
    const configured = isModelConfigured();
    const engineLabel = connected
      ? "AI 已连接"
      : state.connectionStatus === "error" ? "AI 连接异常" : configured ? "AI 已配置 · 待测试" : "AI 尚未配置";
    page.innerHTML =
      '<div class="feed-action-row">' +
        '<button class="feed-action" id="feed-home" type="button">' + icon("home") + '<span>回首页</span></button>' +
        '<button class="feed-action primary" id="feed-settings" type="button">' + icon("gear") + '<span>我的模型</span></button>' +
      '</div>' +
      '<button class="engine-strip ' + (connected ? "ready" : "") + '" id="feed-engine" type="button">' +
        '<span class="engine-left"><span class="engine-dot"></span><span>' + engineLabel + '</span></span>' +
        '<span class="engine-model">' + escapeHtml(state.aiConfig.model || "未配置") + '</span>' +
      '</button>' +
      '<section class="capture-panel">' +
        '<div class="capture-step-head"><span class="capture-step">1</span><div><p class="capture-kicker">CAPTURE</p><h2 class="section-title">捕获值得记住的内容</h2></div></div>' +
        '<p class="capture-intro">选择文字、网页、图片或文件，预览后凝练成卡。</p>' +
        '<div class="capture-method-grid" aria-label="捕获方式">' +
          '<button class="capture-method selection" id="capture-selection" type="button" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("bolt") + '<strong>选中文字</strong><span>读取网页选区</span></button>' +
          '<button class="capture-method page" id="capture-page" type="button" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("book") + '<strong>读取正文</strong><span>提取当前网页文章</span></button>' +
          '<button class="capture-method screenshot" id="capture-screenshot" type="button" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("image") + '<strong>截取屏幕</strong><span>自由框选所需区域</span></button>' +
          '<button class="capture-method manual" id="capture-manual" type="button" aria-expanded="' + Boolean(sourceVisible && state.captureSource.type === "manual") + '" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("plus") + '<strong>手动输入</strong><span>粘贴文字内容</span></button>' +
          '<button class="capture-method" id="capture-image" type="button" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("image") + '<strong>上传图片</strong><span>PNG / JPG / WebP / GIF</span></button>' +
          '<button class="capture-method" id="capture-file" type="button" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("book") + '<strong>导入文件</strong><span>PDF / DOCX / MD / TXT</span></button>' +
        '</div>' +
        '<input class="file-input" id="source-file-input" type="file" accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown">' +
        '<input class="file-input" id="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" ' + (state.captureBusy ? "disabled" : "") + '>' +
        '<p class="capture-hint">选区适合一小段，正文适合整篇文章；读取后都可以编辑。</p>' +
        (state.captureBusy ? '<div class="capture-feedback" role="status">' + ({ selection: "正在读取网页选区…", page: "正在提取当前网页正文…", file: "正在读取文件…", screenshot: "先在浏览器弹窗中选择画面并点击“共享”，随后拖拽框选截图区域。", region: "请在截图窗口中拖拽框选区域，按 Enter 确认或 Esc 取消。共享已停止。" }[state.captureBusy]) + '</div>' : '') +
        (state.captureError ? '<div class="capture-feedback is-error" role="alert">' + escapeHtml(state.captureError) + '</div>' : '') +
      '</section>' +
      documentImportsMarkup() + (state.manualInputCollapsed ? "" : captureSourceHtml()) +
      (sourceVisible ? '<div class="form-section capture-goal"><label class="field-label" for="feed-goal">这次想学会什么？（可选）</label><input class="form-input" id="feed-goal" maxlength="600" placeholder="例如：能判断缓存有效期的取舍" value="' + escapeAttr(state.feedGoal || "") + '"></div>' : "") +
      (sourceVisible ? sourceProductMarkup() : "") +
      (sourceVisible && state.feedText && !state.feedImage ? '<button class="secondary-btn companion-material-entry" id="feed-companion" type="button">先和伴学聊聊这段材料</button>' : '') +
      knowledgePlansMarkup() +
      (sourceVisible ? '<div class="plan-input-options"><button class="secondary-btn" id="plan-material" type="button" ' + (state.captureBusy ? 'disabled' : '') + '>查看可编辑学习清单</button><label><input id="plan-supplemental" type="checkbox" ' + (state.feedAllowSupplemental ? 'checked' : '') + '>允许使用' + (state.captureSource.importRef ? '其他文件的' : '') + '已保留原文补充解释</label></div>' : '') +
      '<div class="action-row capture-actions"><button class="secondary-btn" id="clear-feed" type="button" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("refresh") + '<span>重新选择</span></button><button class="primary-btn" id="generate-card" type="button" ' + (state.captureBusy || state.manualInputCollapsed || !materialIndex.needsPlan({ text: state.feedText, blocks: state.feedBlocks }) && (sourceDecisionPending() || state.sourceCheckLoading) ? "disabled" : "") + '>' + icon("bolt") + '<span>' + (materialIndex.needsPlan({ text: state.feedText, blocks: state.feedBlocks }) ? '整理学习清单' : '凝练成卡') + '</span></button></div>' +
      (readyDrafts().length + state.pending.length ? '<div class="pending-strip"><div><strong>' + (readyDrafts().length + state.pending.length) + ' 张卡待打开</strong><p class="meta">可以直接去抽</p></div><button class="pill-btn" id="feed-draw" type="button">打开</button></div>' : "");

    document.getElementById("feed-home").addEventListener("click", function () { setView("home"); });
    document.getElementById("feed-companion")?.addEventListener("click", function () {
      void companionUI.open({ context: { kind: "text", text: state.feedText, title: state.captureSource?.title || "制卡材料", sourceUrl: state.captureSource?.url } }).catch(function (error) { toast(error.message); });
    });
    document.getElementById("feed-settings").addEventListener("click", function () { setView("model"); });
    document.getElementById("feed-engine").addEventListener("click", function () { setView("model"); });
    document.getElementById("capture-selection").addEventListener("click", function () { void captureFromBrowser("selection"); });
    document.getElementById("capture-screenshot").addEventListener("click", function () { void captureFromBrowser("screenshot"); });
    document.getElementById("capture-page").addEventListener("click", function () { void captureFromBrowser("page"); });
    document.getElementById("capture-manual").addEventListener("click", startManualCapture);
    document.getElementById("capture-image").addEventListener("click", function () { openCapturePicker("image-input"); });
    document.getElementById("capture-file").addEventListener("click", function () { openCapturePicker("source-file-input"); });
    document.getElementById("source-file-input").addEventListener("change", importSelectedSourceFile);
    const rangeButton = document.getElementById("select-material-range");
    if (rangeButton) rangeButton.addEventListener("click", function () {
      const preview = document.getElementById("material-full-text");
      selectMaterialRange(preview, state.captureSource);
    });
    const goal = document.getElementById("feed-goal");
    if (goal) goal.addEventListener("input", function () { state.feedGoal = goal.value; });
    const feedText = document.getElementById("feed-text");
    if (feedText) feedText.addEventListener("input", function (event) {
      if (feedText.readOnly) return;
      state.feedText = event.target.value;
      if (state.captureSource && !state.feedImage) state.captureSource.scope = "selected_text";
      if (state.captureSource) state.captureSource.excerpt = state.feedText;
      if (state.captureSource) { state.captureSource.range = null; state.captureSource.documentId = null; }
      invalidateSourceCheck();
      document.getElementById("feed-count").textContent = state.feedText.length + " / " + materialIndex.MAX_CHARACTERS;
      document.querySelector('#generate-card span').textContent = materialIndex.needsPlan({ text: state.feedText, blocks: state.feedBlocks }) ? '整理学习清单' : '凝练成卡';
      document.getElementById('generate-card').disabled = Boolean(state.captureBusy);
      document.getElementById("feed-ready").textContent = state.feedImage ? "图注可选" : state.feedText.length >= 20 ? "可以凝练" : "再多一点点";
      if (!state.feedText.trim()) state.saveFullSource = false;
      const retention = document.querySelector(".source-retention");
      if (retention) retention.outerHTML = sourceRetentionMarkup();
      bindSourceRetentionToggle();
    });
    document.getElementById("image-input").addEventListener("change", readImage);
    const clearImage = document.getElementById("clear-image");
    if (clearImage) clearImage.addEventListener("click", clearCapture);
    document.getElementById("clear-feed").addEventListener("click", clearCapture);
    page.querySelectorAll('[data-resume-import]').forEach(function (button) { button.addEventListener('click', function () { void documentImportUI.open(button.dataset.resumeImport); }); });
    page.querySelectorAll('[data-discard-import]').forEach(function (button) { button.addEventListener('click', async function () { try { await agentApi.discardDocumentImport(button.dataset.discardImport); await loadDocumentImports(); } catch (error) { toast(error.message); } }); });
    const backToImport = document.getElementById('back-to-import');
    if (backToImport) backToImport.addEventListener('click', function () { void documentImportUI.open(state.captureSource.importRef.importId); });
    document.getElementById("generate-card").addEventListener("click", generateFromFeed);
    const planButton = document.getElementById('plan-material');
    if (planButton) planButton.addEventListener('click', function () { void startKnowledgePlanFromFeed(); });
    const supplemental = document.getElementById('plan-supplemental');
    if (supplemental) supplemental.addEventListener('change', function () { state.feedAllowSupplemental = supplemental.checked; });
    page.querySelectorAll('[data-open-knowledge-plan]').forEach(function (button) { button.addEventListener('click', function () {
      void knowledgePlanUI.open(button.dataset.openKnowledgePlan).catch(function (error) { toast(error.message); });
    }); });
    bindSourceProductActions();
    const feedDraw = document.getElementById("feed-draw");
    if (feedDraw) feedDraw.addEventListener("click", function () { setView("draw"); });
  }

  function bindMaterialDraftActions() {
    modalContent.querySelectorAll("[data-resume-material]").forEach(function (button) {
      button.addEventListener("click", function () {
        const draft = state.gachaDrafts.find(function (item) { return item.id === button.dataset.resumeMaterial; });
        if (!draft) return;
        resetSourceProductState();
        state.materialDraftId = draft.id;
        state.feedText = draft.material.text || "";
        state.feedBlocks = draft.material.blocks || null;
        state.feedGoal = draft.material.userGoal || "";
        state.feedImage = draft.material.image || null;
        state.captureSource = draft.material.source;
        state.saveFullSource = draft.material.sourcePlan?.saveFullSource === true;
        state.saveOriginalFile = draft.material.sourcePlan?.saveOriginal === true;
        closeModal();
        setView("feed");
      });
    });
    modalContent.querySelectorAll("[data-discard-material]").forEach(function (button) {
      button.addEventListener("click", async function () {
        try {
          await agentApi.discardGachaCardDraft(button.dataset.discardMaterial);
          state.gachaDrafts = state.gachaDrafts.filter(function (item) { return item.id !== button.dataset.discardMaterial; });
          if (state.materialDraftId === button.dataset.discardMaterial) state.materialDraftId = "";
          if (state.view === "settings") renderSettings();
          renderSourceManager();
        } catch (error) { toast(error.message); }
      });
    });
  }

  function captureSourceHtml() {
    if (!state.captureSource) {
      return '<section class="capture-source-empty"><strong>还没有捕获内容</strong><span>选择上方一种方式，素材只会在你主动点击后读取。</span></section>';
    }
    const source = state.captureSource;
    const label = captureTypeLabel(source.type);
    const meta = source.url
      ? '<span class="capture-source-url" title="' + escapeAttr(source.url) + '">' + escapeHtml(source.url) + '</span>'
      : '<span class="capture-source-url">' + escapeHtml(source.type === "manual" ? "由你输入，不读取网页" : source.type === "screenshot" ? "来自你选择的画面" : ["file", "pdf", "docx"].includes(source.type) ? "文件已读取 · " + (source.mimeType || "text/plain") : "本地图片") + '</span>';
    const editor = state.feedImage
      ? '<div class="image-preview capture-preview"><img src="' + escapeAttr(state.feedImage.dataUrl) + '" alt="已捕获的知识素材"><button class="icon-btn image-remove" id="clear-image" type="button" aria-label="移除图片" ' + (state.captureBusy ? "disabled" : "") + '>' + icon("x") + '</button></div>' +
        '<div class="form-section"><label class="field-label" for="feed-text">图注或补充说明（可选）</label><textarea class="feed-input capture-editor" id="feed-text" aria-label="图注或补充说明" maxlength="1000000" ' + (state.captureBusy ? "disabled" : "") + ' placeholder="粘贴图片原有图例或相邻段落，补充颜色、符号和状态的含义。">' + escapeHtml(state.feedText) + '</textarea><div class="input-meta"><span id="feed-count">' + state.feedText.length + ' / ' + materialIndex.MAX_CHARACTERS + '</span><span id="feed-ready">图注可选</span></div></div>'
      : '<textarea class="feed-input capture-editor" id="feed-text" aria-label="制卡素材" maxlength="1000000" ' + (source.importRef ? 'readonly ' : '') + (state.captureBusy ? "disabled" : "") + ' placeholder="粘贴一段文章、课堂笔记、视频摘录，或者今天没看懂的概念。">' + escapeHtml(state.feedText) + '</textarea><div class="input-meta"><span id="feed-count">' + state.feedText.length + ' / ' + materialIndex.MAX_CHARACTERS + '</span><span id="feed-ready">' + (state.feedText.length >= 20 ? "可以凝练" : "再多一点点") + '</span></div>';
    const readingNote = source.importRef ? '<p class="capture-reading-note">本次范围：' + escapeHtml(importRangeLabel(source.importRef.ranges)) + '。未选择的范围不会发送给模型。</p>' + (!state.materialDraftId ? '<button class="source-inline-action" id="back-to-import" type="button">返回解析预览选择或校对</button>' : '<p class="meta">已保存选定范围和解析版本；需要其他范围时可重新导入同一文件。</p>') : source.type === "page"
      ? '<p class="capture-reading-note">' + (source.extractionMethod === "article" ? "已提取文章正文，请检查并删去不需要的内容。" : "未识别到独立文章，已读取页面可见文字，请检查后制卡。") + (source.truncated ? '<strong>正文较长，仅读取前 256K 字符；可选择更小的章节范围。</strong>' : '') + '</p>'
      : source.fullText ? '<p class="capture-reading-note">已读取 ' + source.fullText.length + ' 字；当前范围：' + (source.range ? (source.range.start + 1) + '–' + source.range.end : '下方预览文字') + '。长材料将分批整理学习清单，可编辑或选择范围。</p><details class="material-range"><summary>查看全部文字并选择范围</summary><textarea class="feed-input" id="material-full-text" readonly aria-label="完整材料">' + escapeHtml(source.fullText) + '</textarea><button class="secondary-btn" id="select-material-range" type="button">使用选中内容</button></details>' : '';
    return '<section class="capture-source-card"><div class="capture-source-head"><span class="source-type-pill">' + escapeHtml(label) + '</span><div><strong>' + escapeHtml(source.title || label) + '</strong>' + meta + '</div></div>' + readingNote + editor + '</section>';
  }

  function materialDraftsMarkup() {
    const drafts = state.gachaDrafts.filter(function (draft) { return draft.status === "material"; });
    if (!drafts.length) return "";
    return '<section class="source-document-list" aria-label="材料草稿"><h2 class="section-title">材料草稿</h2>' + drafts.map(function (draft) {
      return '<article class="source-document"><strong>' + escapeHtml(draft.source.title) + '</strong><button data-resume-material="' + escapeAttr(draft.id) + '" type="button">继续</button><button data-discard-material="' + escapeAttr(draft.id) + '" type="button">放弃</button></article>';
    }).join("") + '</section>';
  }

  function knowledgePlansMarkup() {
    if (!state.knowledgePlans.length) return '';
    return '<section class="source-document-list knowledge-plan-resume" aria-label="学习清单与卡组"><h2 class="section-title">继续学习清单与卡组</h2>' + state.knowledgePlans.map(function (plan) {
      return '<article class="source-document"><div><strong>' + escapeHtml(plan.title) + '</strong><p class="meta">已选 ' + plan.selected + ' 个目标 · 已收下 ' + plan.confirmed + ' 张</p></div><button class="secondary-btn" type="button" data-open-knowledge-plan="' + escapeAttr(plan.id) + '">继续</button></article>';
    }).join('') + '</section>';
  }

  function importRangeLabel(ranges) {
    const pages = (ranges || []).filter(function (range) { return range.pageNumber; }).map(function (range) { return range.pageNumber; });
    if (pages.length) return 'PDF 第 ' + documentImportUI.compactPages(pages) + ' 页';
    const labels = (ranges || []).map(function (range) { return (range.headingPath?.join(' / ') || '正文') + (range.startParagraph ? ' · 段 ' + range.startParagraph + (range.endParagraph !== range.startParagraph ? '–' + range.endParagraph : '') : ''); });
    return Array.from(new Set(labels)).join('；') || '选定文字';
  }

  function documentImportsMarkup() {
    if (!state.documentImports.length) return '';
    return '<section class="source-document-list" aria-label="导入草稿"><h2 class="section-title">继续导入材料</h2>' + state.documentImports.map(function (item) {
      return '<article class="source-document"><div><strong>' + escapeHtml(item.title) + '</strong>' + (item.pageCount ? '<p class="meta">已解析 ' + item.parsedPages + ' / ' + item.pageCount + ' 页</p>' : '') + '</div><button class="secondary-btn" type="button" data-resume-import="' + escapeAttr(item.id) + '">继续</button><button class="source-inline-action" type="button" data-discard-import="' + escapeAttr(item.id) + '">放弃</button></article>';
    }).join('') + '</section>';
  }

  async function loadDocumentImports() {
    try { state.documentImports = (await agentApi.listDocumentImports()).imports; if (state.view === 'feed') renderFeed(); }
    catch (error) { state.captureError = '导入草稿读取失败：' + error.message; }
  }

  async function loadKnowledgePlans() {
    try { state.knowledgePlans = (await agentApi.listKnowledgePlans()).plans; if (['feed', 'album'].includes(state.view)) render(); }
    catch (error) { state.agentConnectionMessage = '学习清单读取失败：' + error.message; }
  }

  async function startKnowledgePlanFromFeed(options) {
    if (knowledgePlanUI.isBusy()) { toast('正在处理上一份清单，可从列表查看进度'); return; }
    const material = gachaSourceMaterial();
    if (!material.text && !material.image) { toast('先选择文字或图片材料'); return; }
    if (!isModelConfigured()) { toast('请先配置模型再整理清单'); setView('model'); return; }
    try {
      await knowledgePlanUI.start(Object.assign({}, material, { materialDraftId: state.materialDraftId, requestId: window.KnowledgeGachaRuntimeUtils.id('plan_request'),
        allowSupplemental: state.feedAllowSupplemental, sourcePlan: { saveFullSource: Boolean(state.saveFullSource && (material.text || material.image)), saveOriginal: state.saveOriginalFile } }, options || {}));
      if (state.view === 'plan') { state.feedText = ''; state.feedImage = null; state.captureSource = null; state.feedGoal = ''; resetSourceProductState(); }
    } catch (error) { toast(error.message || '清单尚未完成，材料已保留'); }
  }

  function sourceProductMarkup() {
    if (!state.captureSource) return "";
    let checkMarkup = "";
    if (state.sourceCheckLoading) {
      checkMarkup = '<div class="source-check-state"><strong>正在查找相关来源和相似卡…</strong><span>只读取当前档案</span></div>';
    } else if (state.sourceCheckError) {
      checkMarkup = '<div class="source-check-state is-error"><strong>资料核对暂时不可用</strong><span>' + escapeHtml(state.sourceCheckError) + '</span><button class="source-inline-action" id="retry-source-check" type="button">重新核对</button></div>';
    } else if (state.sourceCheck) {
      const related = state.sourceCheck.relatedSources || [];
      checkMarkup = '<div class="related-source-panel ' + (related.length ? "" : "is-empty") + '">' +
        '<div class="related-source-head"><span class="source-spark">' + icon("bolt") + '</span><div><strong>' + (related.length ? "找到 " + related.length + " 条相关来源" : "没有找到相关来源") + '</strong><span>' + (state.captureSource.importRef ? '当前文件只使用选定范围；勾选补充解释后才会使用其他原文。' : '本次材料和相关来源的可定位片段将参与生成与核验。') + '</span></div></div>' +
        (related.length ? '<div class="related-source-list">' + related.map(function (item, index) {
          return '<button class="related-source-item" type="button" data-related-source="' + index + '"><strong>' + escapeHtml(item.citation.source.title) + '</strong><span>“' + escapeHtml(shortCopy(item.citation.quote, 62)) + '”</span></button>';
        }).join("") + '</div>' : "") +
      '</div>' + similarCardMarkup(state.sourceCheck.similarCards || []);
    } else {
      checkMarkup = '<div class="source-check-state"><strong>制卡前查找相似卡</strong><span>发现相似内容时，由你选择是否合并。</span></div>';
    }
    return '<section class="source-product-panel">' +
      checkMarkup +
    '</section>' + sourceRetentionMarkup();
  }

  function sourceRetentionMarkup() {
    if (state.captureSource?.importRef) {
      const value = state.saveOriginalFile ? 'original' : state.saveFullSource ? 'text' : 'excerpt';
      return '<section class="source-retention"><div><label class="field-label" for="import-retention">收下卡片时保留什么？</label><select class="form-input" id="import-retention"><option value="excerpt" ' + (value === 'excerpt' ? 'selected' : '') + '>仅保留引用片段</option><option value="text" ' + (value === 'text' ? 'selected' : '') + '>保留选定范围的解析文字</option><option value="original" ' + (value === 'original' ? 'selected' : '') + '>保留原始文件和选定文字</option></select><p>' + (value === 'original' ? '保留整个原始文件，可从引用打开原页或下载；解析文字只保留本次选择的范围。' : value === 'text' ? '保留本次选定的解析文字，可回查与复用；原始文件会在任务完成后释放。' : '任务完成后只保留卡片必要的引用文字和位置。') + '</p></div></section>';
    }
    const canArchive = Boolean(state.feedText.trim());
    const enabled = state.saveFullSource && canArchive;
    const disabled = !canArchive || state.captureBusy;
    return '<section class="source-retention ' + (enabled ? "is-on" : "") + '"><div><strong id="source-retention-label">随卡片保留原文</strong><p id="source-retention-description">' + (enabled ? "收下时保留当前预览的全部文字（选定范围），可从卡片打开；不保存原始文件。" : "收下时只新增必要片段、标题和网址；已有原文附件继续保留。") + '</p>' + (!canArchive ? '<span>' + (state.feedImage ? "图片暂不保留原图或文字依据" : "输入文字后可开启") + '</span>' : '') + '</div><button class="source-toggle ' + (enabled ? "is-on" : "") + '" id="toggle-full-source" type="button" role="switch" aria-labelledby="source-retention-label" aria-describedby="source-retention-description" aria-checked="' + (enabled ? "true" : "false") + '" ' + (disabled ? "disabled" : "") + '><span class="source-toggle-label">' + (!canArchive ? "不可用" : enabled ? "已开启" : "已关闭") + '</span></button></section>';
  }

  function bindSourceRetentionToggle() {
    const retentionSelect = document.getElementById('import-retention');
    if (retentionSelect) retentionSelect.addEventListener('change', function () { state.saveFullSource = retentionSelect.value !== 'excerpt'; state.saveOriginalFile = retentionSelect.value === 'original'; document.querySelector('.source-retention').outerHTML = sourceRetentionMarkup(); bindSourceRetentionToggle(); });
    const toggle = document.getElementById("toggle-full-source");
    if (toggle) toggle.addEventListener("click", function () {
      state.saveFullSource = !state.saveFullSource;
      document.querySelector(".source-retention").outerHTML = sourceRetentionMarkup();
      bindSourceRetentionToggle();
      document.getElementById("toggle-full-source").focus({ preventScroll: true });
    });
  }

  function similarCardMarkup(cards) {
    if (!cards.length) return "";
    const card = cards[0];
    return '<section class="similar-card-panel"><div class="similar-card-head"><span class="similar-card-icon">✓</span><div><span>相似卡提醒 · ' + card.similarityPercent + '%</span><strong>卡册里已有「' + escapeHtml(card.title) + '」</strong></div></div><p>这次内容可以补充原卡，也可以保留成一张新卡。由你决定，系统不会自动覆盖。</p><div class="similar-card-actions"><button class="source-choice primary ' + (state.sourceDuplicateAction === "merge" ? "is-selected" : "") + '" data-source-choice="merge" data-card-id="' + escapeAttr(card.cardId) + '" type="button">合并补充到原卡</button><button class="source-choice ' + (state.sourceDuplicateAction === "create_new" ? "is-selected" : "") + '" data-source-choice="create_new" type="button">仍然新建</button><button class="source-choice" data-source-choice="abandon" type="button">放弃这次</button></div></section>';
  }

  function bindSourceProductActions() {
    const manage = document.getElementById("manage-sources");
    if (manage) manage.addEventListener("click", function () { void openSourceManager(); });
    const retry = document.getElementById("retry-source-check");
    if (retry) retry.addEventListener("click", function () { void loadGachaSourceCheck(); });
    bindSourceRetentionToggle();
    document.querySelectorAll("[data-related-source]").forEach(function (button) {
      button.addEventListener("click", function () {
        const related = state.sourceCheck && state.sourceCheck.relatedSources
          ? state.sourceCheck.relatedSources[Number(button.dataset.relatedSource)]
          : null;
        if (related) void openCitation(related.citation, function () { closeModal(); renderFeed(); });
      });
    });
    document.querySelectorAll("[data-source-choice]").forEach(function (button) {
      button.addEventListener("click", function () {
        const action = button.dataset.sourceChoice;
        if (action === "abandon") {
          clearCapture();
          toast("已放弃这次制卡");
          return;
        }
        state.sourceDuplicateAction = action;
        state.sourceDuplicateTargetId = action === "merge" ? button.dataset.cardId || "" : "";
        renderFeed();
      });
    });
  }

  function sourceDecisionPending() {
    return Boolean(state.sourceCheck && state.sourceCheck.requiresDuplicateDecision && !state.sourceDuplicateAction);
  }

  function shortCopy(value, limit) {
    const text = normalizeText(value || "");
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  }

  function captureTypeLabel(type) {
    return { selection: "网页选区", page: "网页正文", screenshot: "屏幕截图", manual: "手动输入", image: "本地图片", file: "导入文件", pdf: "PDF 文件", docx: "DOCX 文件" }[type] || "知识素材";
  }

  function startManualCapture() {
    if (state.captureBusy) return;
    state.captureError = "";
    if (state.captureSource?.type !== "manual") {
      state.feedText = "";
      state.feedImage = null;
      state.captureSource = { type: "manual", title: "手动输入", url: "", excerpt: "", capturedAt: Date.now() };
      resetSourceProductState();
    }
    state.manualInputCollapsed = false;
    renderFeed();
    const input = document.getElementById("feed-text");
    if (input) input.focus();
  }

  function openCapturePicker(inputId) {
    if (state.captureBusy) return;
    state.manualInputCollapsed = state.captureSource?.type === "manual";
    state.captureError = "";
    renderFeed();
    document.getElementById(inputId).click();
  }

  async function captureFromBrowser(type) {
    if (state.captureBusy) return;
    state.captureBusy = type;
    state.manualInputCollapsed = state.captureSource?.type === "manual";
    state.captureError = "";
    renderFeed();
    try {
      const result = type === "selection"
        ? await browserCapture.captureSelection()
        : type === "page"
          ? await browserCapture.capturePage()
          : await browserCapture.captureScreenshot();
      if (type === "screenshot") {
        state.captureBusy = "region";
        if (state.view === "feed") renderFeed();
        result.image = await window.KnowledgeGachaScreenshotRegion.selectScreenshotRegion(result.image, window.chrome);
        result.title = "区域截图";
      }
      resetSourceProductState();
      state.feedText = result.text || "";
      state.feedImage = result.image || null;
      state.captureSource = {
        type: result.type,
        title: result.title,
        url: result.url,
        excerpt: result.text || "",
        truncated: result.truncated,
        extractionMethod: result.extractionMethod,
        capturedAt: result.capturedAt
      };
      toast(captureTypeLabel(result.type) + "已捕获");
    } catch (error) {
      state.captureError = error && error.message ? error.message : "捕获失败，请重试";
    } finally {
      state.captureBusy = false;
      if (state.view === "feed") {
        renderFeed();
        if (!state.captureError) void loadGachaSourceCheck();
      }
    }
  }

  function clearCapture() {
    if (state.captureBusy) return;
    const importId = state.captureSource?.importRef?.importId;
    if (importId && !state.materialDraftId) void agentApi.discardDocumentImport(importId).catch(function (error) { toast(error.message); });
    state.captureError = "";
    state.feedText = "";
    state.feedImage = null;
    state.captureSource = null;
    resetSourceProductState();
    renderFeed();
  }

  function resetSourceProductState() {
    state.manualInputCollapsed = false;
    state.feedAllowSupplemental = false;
    state.materialDraftId = "";
    state.sourceCheck = null;
    state.sourceCheckKey = "";
    state.sourceCheckLoading = false;
    state.sourceCheckError = "";
    state.sourceDuplicateAction = "";
    state.sourceDuplicateTargetId = "";
    state.saveFullSource = false;
    state.saveOriginalFile = false;
    state.feedBlocks = null;
  }

  function invalidateSourceCheck() {
    state.sourceCheck = null;
    state.sourceCheckKey = "";
    state.sourceCheckError = "";
    state.sourceDuplicateAction = "";
    state.sourceDuplicateTargetId = "";
  }

  function gachaSourceMaterial() {
    const source = state.captureSource || {
      type: state.feedImage ? "image" : "manual",
      title: state.feedImage ? state.feedImage.name : "手动输入",
      url: "",
      capturedAt: Date.now()
    };
    return {
      text: state.feedText.trim(),
      blocks: state.feedBlocks,
      allowSupplemental: state.feedAllowSupplemental,
      sourcePlan: { saveFullSource: state.saveFullSource, saveOriginal: state.saveOriginalFile },
      userGoal: state.feedGoal || "",
      image: state.feedImage ? { name: state.feedImage.name, mime: state.feedImage.mime, dataUrl: state.feedImage.dataUrl } : undefined,
      source: {
        type: source.type,
        title: source.title || captureTypeLabel(source.type),
        url: source.url || null,
        documentId: source.documentId || null,
        mimeType: source.mimeType || "text/plain",
        scope: source.scope || "selected_text",
        range: source.range || null,
        importRef: source.importRef || null,
        capturedAt: Number(source.capturedAt) || Date.now()
      }
    };
  }

  function gachaSourceMaterialKey(material) {
    const imageData = material.image ? material.image.dataUrl : "";
    return JSON.stringify({
      text: material.text,
      image: material.image ? [
        material.image.name,
        material.image.mime,
        imageData.length,
        imageData.slice(0, 64),
        imageData.slice(-64)
      ] : null,
      source: material.source
    });
  }

  async function loadGachaSourceCheck() {
    const material = gachaSourceMaterial();
    if (!material.text && !material.image) return null;
    const key = gachaSourceMaterialKey(material);
    const sequence = ++sourceCheckSequence;
    state.sourceCheckLoading = true;
    state.sourceCheckError = "";
    if (state.view === "feed") renderFeed();
    try {
      const response = await agentApi.checkGachaCardSources(material);
      if (sequence !== sourceCheckSequence || key !== gachaSourceMaterialKey(gachaSourceMaterial())) return null;
      state.sourceCheck = response.check;
      state.sourceCheckKey = key;
      state.sourceDuplicateAction = response.check.requiresDuplicateDecision ? "" : "create_new";
      state.sourceDuplicateTargetId = "";
      return response.check;
    } catch (error) {
      if (sequence === sourceCheckSequence) {
        state.sourceCheck = null;
        state.sourceCheckKey = "";
        state.sourceCheckError = error.message || "资料核对失败";
      }
      return null;
    } finally {
      if (sequence === sourceCheckSequence) {
        state.sourceCheckLoading = false;
        if (state.view === "feed") renderFeed();
      }
    }
  }

  async function loadKnowledgeSources() {
    state.sourceLoading = true;
    state.sourceError = "";
    try {
      const result = await agentApi.listDocuments();
      state.sourceDocuments = result.documents;
    } catch (error) { state.sourceError = error.message; }
    finally { state.sourceLoading = false; if (state.view === "settings") renderSettings(); }
  }

  async function openSourceManager() {
    openModal();
    modalContent.innerHTML = '<h2 class="modal-title">正在读取历史材料…</h2>';
    await loadKnowledgeSources();
    renderSourceManager();
  }

  function renderSourceManager() {
    const materials = state.sourceDocuments.filter(function (document) { return !document.linkedCardCount; });
    const drafts = materialDraftsMarkup();
    modalContent.innerHTML = '<h2 class="modal-title">历史材料</h2><p class="meta">继续整理以前保存但尚未制卡的材料。卡片的原文附件可从卡片中打开。</p>' +
      (state.sourceError ? '<p class="citation-error">' + escapeHtml(state.sourceError) + '</p>' : '') +
      drafts +
      (materials.length ? '<div class="source-document-list">' + materials.map(function (document) {
        return '<article class="source-document"><div><strong>' + escapeHtml(document.title) + '</strong><span>' + sourceDocumentTypeLabel(document.type) + ' · ' + Math.max(1, Math.round(document.byteSize / 1024)) + 'KB</span></div><button type="button" data-resume-source="' + escapeAttr(document.id) + '">继续制卡</button></article>';
      }).join("") + '</div>' : drafts ? '' : '<p class="evidence-empty-note">没有待处理的历史材料</p>');
    bindMaterialDraftActions();
    modalContent.querySelectorAll('[data-resume-source]').forEach(function (button) {
      button.addEventListener('click', function () { void openSourceText(button.dataset.resumeSource, renderSourceManager); });
    });
  }

  async function importSelectedSourceFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file || state.captureBusy) return;
    if (!/\.(pdf|docx|md|markdown|txt)$/i.test(file.name) || file.size > 20 * 1024 * 1024) {
      toast("支持不超过 20 MB 的 PDF、DOCX、Markdown 或 TXT 文件");
      return;
    }
    if (/\.(pdf|docx)$/i.test(file.name) || file.size > materialIndex.MAX_CHARACTERS) { await documentImportUI.openFile(file); return; }
    state.captureBusy = "file";
    state.captureError = "";
    renderFeed();
    try {
      const content = await file.text();
      if (!content.trim()) throw new Error("文件没有可制卡的文字");
      resetSourceProductState();
      state.feedText = content;
      state.feedImage = null;
      state.captureSource = { type: "file", title: file.name, fullText: content, url: null, capturedAt: Date.now(),
        mimeType: /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : "text/plain", range: { start: 0, end: state.feedText.length },
        scope: "full_file_text" };
      toast("文件已读取，请检查制卡范围");
    } catch (error) { state.captureError = error.message || "读取失败，请重试"; }
    finally { state.captureBusy = false; if (state.view === "feed") renderFeed(); }
  }

  function selectMaterialRange(preview, metadata) {
    let start = preview.selectionStart;
    let end = preview.selectionEnd;
    if (end <= start) { toast("请先在完整文字中选中一段内容"); return false; }
    if (end - start > materialIndex.MAX_CHARACTERS) { toast("每次请选择不超过 100 万字符"); return false; }
    if (metadata.blocks?.length) {
      const selected = preview.value.slice(start, end);
      start += selected.length - selected.trimStart().length;
      end -= selected.length - selected.trimEnd().length;
    }
    resetSourceProductState();
    state.feedText = preview.value.slice(start, end);
    state.feedBlocks = metadata.blocks?.filter(function (block) { return block.startCharacter < end && block.endCharacter > start; }).map(function (block) {
      const from = Math.max(start, block.startCharacter); const to = Math.min(end, block.endCharacter);
      return Object.assign({}, block, { text: preview.value.slice(from, to), startCharacter: from - start, endCharacter: to - start });
    }) || null;
    state.feedImage = null;
    state.captureSource = Object.assign({}, metadata, { fullText: preview.value, range: { start: start, end: end }, scope: start === 0 && end === preview.value.length ? "full_file_text" : "selected_text" });
    delete state.captureSource.blocks;
    closeModal();
    setView("feed");
    return true;
  }

  async function openSourceText(documentId, returnTo) {
    openModal();
    modalContent.innerHTML = '<h2 class="modal-title">正在读取原文…</h2>';
    try {
      const result = await agentApi.getDocument(documentId);
      const source = result.document;
      modalContent.innerHTML = '<h2 class="modal-title">' + escapeHtml(source.title) + '</h2><p class="meta">' + (source.parserVersion ? '已保留解析文字' : '已保留的原文') + ' · ' + source.content.length + ' 字。选中需要学习的范围后可继续制卡。</p>' +
        (source.selections ? '<p class="meta">保留范围：' + escapeHtml(importRangeLabel(source.selections.flatMap(function (item) { return item.ranges; }))) + '</p><p class="meta">' + (source.originalAssetId ? '同时保留了整个原始文件。' : '未保留原始文件，无法查看原始页面或下载。') + '</p>' : '') +
        (source.originalAssetId ? '<button class="secondary-btn" id="source-original" type="button">查看 / 下载原始文件</button>' : '') +
        '<textarea class="feed-input retained-source-text" id="retained-source-text" readonly aria-label="已保留原文">' + escapeHtml(source.content) + '</textarea>' +
        '<div class="modal-actions"><button class="secondary-btn" id="source-back" type="button">返回</button><button class="primary-btn" id="source-reuse" type="button">用选中内容制卡</button></div>';
      const preview = document.getElementById('retained-source-text');
      preview.setSelectionRange(0, Math.min(source.content.length, materialIndex.MAX_CHARACTERS));
      document.getElementById('source-back').addEventListener('click', returnTo || closeModal);
      const original = document.getElementById('source-original');
      if (original) original.addEventListener('click', function () { void documentImportUI.showOriginal(source.id, 1, null, function () { void openSourceText(source.id, returnTo); }); });
      document.getElementById('source-reuse').addEventListener('click', function () {
        selectMaterialRange(preview, { type: ['pdf', 'docx'].includes(source.type) ? source.type : 'file', title: source.title, url: source.sourceUrl, capturedAt: source.createdAt, documentId: source.id, mimeType: source.mimeType, blocks: source.blocks });
      });
    } catch (error) {
      modalContent.innerHTML = '<h2 class="modal-title">原文不可用</h2><p>' + escapeHtml(error.message) + '</p>';
    }
  }

  function sourceDocumentTypeLabel(type) {
    return { webpage: "网页", pdf: "PDF", docx: "DOCX", text: "文字资料" }[type] || "资料";
  }

  function renderDraw() {
    const draft = state.gachaDrafts.find(function (item) { return item.id === state.currentDraftId; });
    if (draft) {
      renderGachaDraft(draft);
      return;
    }
    const current = getCard(state.currentDrawnId);
    if (current) {
      const summary = state.plainMode && current.plainSummary ? current.plainSummary : current.summary;
      const discoveryBasis = current.discoveryBasis;
      page.innerHTML =
        '<section class="result-card" style="--card-color:' + escapeAttr(current.color || COLORS[0]) + '">' +
          '<div class="detail-top"><span class="card-pill">知识卡</span><span class="card-pill">' + (current.mastery ? "复习 " + current.mastery + " 次" : "未复习") + '</span></div>' +
          '<h2 class="result-title">' + escapeHtml(current.title) + '</h2>' +
          teachingMarkup(current, summary) + exerciseMarkup(cardExercise(current)) +
          cardSourcesMarkup(current) +
        '</section>' +
        (discoveryBasis ? '<section class="discovery-after-save"><span>已从发现候选收下</span><strong>' + escapeHtml(discoveryBasis.topic || current.title) + '</strong><p>候选列表和剩余方向仍为你保留。</p><div><button class="primary-btn" id="discovery-continue" type="button">继续这个方向</button><button class="secondary-btn" id="discovery-return-list" type="button">返回候选列表</button></div></section>' : '') +
        '<div class="quick-actions">' +
          '<button class="secondary-btn" id="draw-plain" type="button">' + icon("refresh") + '<span>' + (state.plainMode ? "原内容" : "说人话") + '</span></button>' +
          '<button class="secondary-btn" id="draw-favorite" type="button">' + icon("heart") + '<span>' + (current.favorite ? "已收藏" : "收藏") + '</span></button>' +
          '<button class="primary-btn" id="draw-finish" type="button">' + icon("check") + '<span>' + (discoveryBasis ? "返回候选" : "收下返回") + '</span></button>' +
        '</div>';
      document.getElementById("draw-plain").addEventListener("click", function () { state.plainMode = !state.plainMode; renderDraw(); });
      document.getElementById("draw-favorite").addEventListener("click", function (event) { void toggleCardFavorite(current, event.currentTarget, renderDraw); });
      document.getElementById("draw-finish").addEventListener("click", function () { state.currentDrawnId = ""; setView(discoveryBasis ? "discovery" : "home"); });
      const discoveryReturn = document.getElementById("discovery-return-list");
      if (discoveryReturn) discoveryReturn.addEventListener("click", function () { state.currentDrawnId = ""; setView("discovery"); });
      const discoveryContinue = document.getElementById("discovery-continue");
      if (discoveryContinue) discoveryContinue.addEventListener("click", async function () {
        const pool = state.discoveryPools.find(function (item) { return item.id === discoveryBasis.poolId; });
        const candidate = pool && pool.candidates.find(function (item) { return item.id === discoveryBasis.candidateId; });
        if (candidate && !(candidate.feedback || []).some(function (item) { return item.action === "like_topic"; })) {
          await applyDiscoveryFeedback(pool.id, candidate.id, "like_topic");
        }
        state.currentDrawnId = "";
        setView("discovery");
      });
      bindCitationButtons(page, current);
      return;
    }

    const unopenedCount = readyDrafts().length + state.pending.length;
    if (unopenedCount) {
      page.innerHTML =
        '<section class="draw-stage">' +
          '<button class="capsule-shell" id="open-capsule" type="button" aria-label="打开知识扭蛋"><span class="shell-half shell-top"></span><span class="shell-line"></span><span class="shell-half shell-bottom"></span></button>' +
          '<h2 class="stage-title">知识扭蛋已出仓</h2><p class="stage-subtitle">剩余 ' + unopenedCount + ' 颗 · 打开后可编辑</p>' +
          '<button class="primary-btn" id="open-capsule-action" type="button">' + icon("arrow-right") + '<span>打开</span></button>' +
        '</section>';
      document.getElementById("open-capsule").addEventListener("click", drawPendingCard);
      document.getElementById("open-capsule-action").addEventListener("click", drawPendingCard);
      return;
    }

    page.innerHTML = emptyPanel("机器现在是空的。", "去投喂", "draw-feed");
    document.getElementById("draw-feed").addEventListener("click", function () { setView("feed"); });
  }

  function exerciseMarkup(exercise) {
    if (!exercise || !exercise.question) return "";
    const options = Array.isArray(exercise.options) ? exercise.options : [];
    return '<section class="draft-exercise" aria-label="自测预览"><span class="detail-label">' + (exercise.type === "recall" ? "尝试回答" : "自测") + '</span><p class="detail-copy">' + escapeHtml(exercise.question) + '</p>' +
      (exercise.type === "recall" ? '<textarea class="form-input" aria-label="尝试回答" placeholder="先尝试回忆，再展开要点"></textarea>' : '<ol class="exercise-options" type="A">' + options.map(function (option) { return '<li>' + escapeHtml(option) + '</li>'; }).join("") + '</ol>') +
      '<details class="exercise-answer"><summary>展开答案与要点</summary><p><strong>' + escapeHtml(exercise.answer || "") + '</strong></p><p>' + escapeHtml(exercise.answerExplanation || "") + '</p><ul>' + (Array.isArray(exercise.rubric) ? exercise.rubric : []).map(function (point) { return '<li>' + escapeHtml(point) + '</li>'; }).join("") + '</ul></details></section>';
  }

  function teachingMarkup(card, summary) {
    const example = card.example;
    return discoveryProvenanceMarkup(card.discoveryBasis || (card.sourceSnapshot?.sourceType === "discovery" ? {} : null)) +
      (card.learningObjective ? detailBlock("学习目标", card.learningObjective, "") : "") + detailBlock("核心解释", summary || card.summary, "") +
      (example && example.text ? detailBlock(example.origin === "source" ? "原文示例" : "教学示例", example.text, "analogy") : "") +
      (card.boundaries ? detailBlock("适用边界", card.boundaries, "") : "") +
      (card.analogy ? detailBlock("类比（辅助理解）", card.analogy, "analogy") : "") +
      (card.mantra ? detailBlock("记忆提示", card.mantra, "") : "");
  }

  function cardExercise(card) {
    return (state.exercises || []).find(function (item) { return (card.exerciseIds || []).includes(item.id); }) ||
      (card.question ? { type: "choice", question: card.question, options: card.options, answer: card.options[card.correctIndex], rubric: [] } : null);
  }

  function generationMetrics(session) {
    const item = session.generation;
    if (!item) return "";
    const calls = item.calls || [];
    const known = calls.length && calls.every(function (call) { return call.usage; });
    const tokens = known ? calls.reduce(function (sum, call) { return sum + call.usage.totalTokens; }, 0) + " tokens" : "服务未报告完整用量";
    return '<details class="generation-metrics"><summary>本次生成 · ' + (item.elapsedMs / 1000).toFixed(1) + ' 秒 · ' + tokens + '</summary><p>' + escapeHtml(item.model) + ' · ' + escapeHtml(item.promptVersion) + '</p><p>' + calls.length + ' 次请求 · ' + item.materialLength + ' 字材料</p></details>';
  }

  function draftEvidenceMarkup(session) {
    const inputs = session.context && session.context.evidence || [];
    const locations = new Map();
    (session.quality && session.quality.evidence || []).forEach(function (span) {
      const origin = inputs.find(function (item) { return item.id === span.evidenceId; });
      if (span.evidenceId === "discovery_outline" || origin?.origin === "discovery_outline" || (!origin && (session.discoveryContext || session.source?.type === "discovery"))) return;
      const key = JSON.stringify([span.evidenceId, span.kind, span.startCharacter, span.quote || span.observation]);
      if (!locations.has(key)) locations.set(key, Object.assign({}, span, { claims: [], sourceTitle: origin?.title || session.source.title }));
      locations.get(key).claims.push({ summary: "解释", exercise: "答案", boundaries: "边界", example: "示例" }[span.claim] || "依据");
    });
    const spans = Array.from(locations.values());
    if (!spans.length) return "";
    const visuals = spans.filter(function (span) { return span.kind === "image"; });
    const label = visuals.length === spans.length ? "查看图片依据" : visuals.length ? "查看材料依据" : "查看原文";
    return '<details class="draft-evidence"><summary>' + label + '（' + spans.length + ' 处）</summary>' + spans.map(function (span) {
      return '<p class="meta">' + escapeHtml(span.sourceTitle) + ' · ' + escapeHtml(Array.from(new Set(span.claims)).join("、")) + '</p><blockquote>' + escapeHtml(span.quote || span.observation) + '</blockquote>';
    }).join("") + (visuals.length ? '<p class="meta">图片依据来自模型视觉核验，不是逐字引文。</p>' : '') + '</details>';
  }

  function discoveryProvenanceMarkup(basis) {
    if (!basis) return "";
    const titles = (basis.relatedCardIds || []).map(getCard).filter(Boolean).map(function (card) { return "《" + card.title + "》"; });
    return '<p class="card-provenance">AI 生成' + (titles.length ? ' · 延伸自' + escapeHtml(titles.join("、")) : '') + '</p>';
  }

  function draftIssueMessage(issue) {
    if (["example_type", "example_origin_missing"].includes(issue.code) || issue.message === "请区分教学自拟示例与原文示例") {
      return "示例暂未整理完成，可以重试生成。";
    }
    return issue.message;
  }

  function readDraftEdits(session) {
    if (!session.card) return null;
    const edited = {};
    [["title", "draft-title"], ["learningObjective", "draft-objective"], ["summary", "draft-summary"], ["boundaries", "draft-boundaries"], ["analogy", "draft-analogy"]].forEach(function (entry) {
      const field = document.getElementById(entry[1]);
      if (field && field.value.trim() !== String(session.card[entry[0]] || "").trim()) edited[entry[0]] = field.value.trim();
    });
    const example = document.getElementById("draft-example");
    if (example && example.value.trim() !== String(session.card.example && session.card.example.text || "").trim()) edited.example = Object.assign({}, session.card.example || { type: "example", origin: "authored" }, { text: example.value.trim() });
    return edited;
  }

  async function saveDraftEdits(session) {
    const edits = readDraftEdits(session);
    if (edits) Object.assign(session, (await agentApi.updateGachaCardDraft(session.id, edits)).session);
  }

  async function runDraftRevision(session, action) {
    if (state.draftBusy) return;
    state.draftBusy = true;
    try {
      await saveDraftEdits(session);
      renderDraw();
      Object.assign(session, (await agentApi.reviseGachaCardDraft(session.id, action)).session);
      toast(session.status === "ready" ? "已更新并核验草稿" : "仍有问题，草稿已保留");
    } catch (error) { toast(error.message); }
    finally { state.draftBusy = false; if (state.view === "draw") renderDraw(); }
  }

  function renderGachaDraft(session) {
    const card = session.card;
    const ready = session.status === "ready" && session.quality && session.quality.passed;
    const issues = session.quality && session.quality.issues || [{ message: "旧版草稿需要按新标准重新生成" }];
    const merging = Boolean(session.sourcePlan && session.sourcePlan.duplicateAction === "merge");
    const isDiscovery = Boolean(session.discoveryContext || session.source?.type === "discovery");
    const discoveryUnavailable = isDiscovery && !ready;
    const labels = { needs_split: isDiscovery ? "这个方向需要细化" : "材料待拆分", insufficient_material: isDiscovery ? "这个方向暂时未能成卡" : "需要更多材料", needs_revision: isDiscovery ? "这张卡暂未生成完成" : "草稿待完善", needs_review: "修改后待核验" };
    function field(id, label, value, limit) { return '<div><label class="field-label" for="' + id + '">' + label + '</label><textarea class="feed-input draft-field" id="' + id + '" maxlength="' + limit + '">' + escapeHtml(value || "") + '</textarea></div>'; }
    page.innerHTML = '<section class="draft-reveal-head"><span class="capture-step">2</span><h2 class="section-title">查看解释和自测</h2></section>' +
      '<section class="gacha-draft-card"><div class="draft-card-top"><span class="card-pill">' + (ready || isDiscovery ? "知识卡草稿" : labels[session.status] || "待核验草稿") + '</span>' + (!isDiscovery ? '<span class="card-pill">' + escapeHtml(session.model || "用户模型") + '</span>' : '') + '</div>' +
      discoveryProvenanceMarkup(isDiscovery ? session.discoveryContext || {} : null) +
      (!ready ? '<div class="quality-issues" role="status"><strong>' + escapeHtml(labels[session.status] || "需要核验") + '</strong><ul>' + Array.from(new Set(issues.map(draftIssueMessage))).map(function (message) { return '<li>' + escapeHtml(message) + '</li>'; }).join("") + '</ul></div>' : '') +
      (card ? '<h2 class="result-title">' + escapeHtml(card.title || "未完成草稿") + '</h2>' + teachingMarkup(card) + exerciseMarkup(session.exercise) +
        '<div class="draft-revision-actions"><button class="secondary-btn" data-revise="summary" type="button">讲清楚一点</button><button class="secondary-btn" data-revise="example" type="button">换个例子</button><button class="secondary-btn" data-revise="exercise" type="button">题目太简单</button></div>' +
        '<details class="draft-editor"><summary>手动修改内容</summary><div class="form-section form-grid"><div><label class="field-label" for="draft-title">标题</label><input class="form-input" id="draft-title" maxlength="80" value="' + escapeAttr(card.title || "") + '"></div>' +
        field("draft-objective", "学习目标", card.learningObjective, 300) + field("draft-summary", "核心解释", card.summary, 2000) + field("draft-example", "示例或过程", card.example && card.example.text, 2000) + field("draft-boundaries", "适用边界（可选）", card.boundaries, 1000) + field("draft-analogy", "类比（可选）", card.analogy, 1000) +
        '</div><p class="meta">修改后重新核验依据与答案；如果答案失效，可重做题目。</p><button class="secondary-btn" data-revise="review" type="button">核验修改</button></details>' : '') +
      draftEvidenceMarkup(session) + (!isDiscovery ? generationMetrics(session) : '') + '</section>' +
      (merging ? '<p class="draft-merge-note">收下后补充到所选原卡，保留收藏和复习记录。</p>' : '') +
      '<p class="meta">' + (ready ? isDiscovery ? "看完解释和自测，可以收下这张卡。" : "草稿已生成，等待你确认。模型检查已完成，仍可对照原文判断。" : discoveryUnavailable ? "可以重试生成，或返回发现换个方向。" : "尚未写入卡册，可调整材料或重试。") + '</p>' +
      '<div class="draft-revision-actions">' + (!isDiscovery ? '<button class="source-inline-action" id="draft-material" type="button">调整材料或目标</button>' : '') + '<button class="source-inline-action" data-revise="retry" type="button">' + (isDiscovery ? '重试生成' : '重新生成整张草稿') + '</button><button class="source-inline-action" id="discard-draft" type="button">放弃草稿</button></div>' +
      '<div class="action-row draft-actions"><button class="secondary-btn" id="draft-later" type="button">' + (isDiscovery ? "返回发现" : "稍后打开") + '</button><button class="primary-btn" id="draft-confirm" type="button" ' + (!ready || state.draftBusy ? 'disabled' : '') + '>' + (state.draftBusy ? "正在处理…" : merging ? "确认合并并复习" : "收下并安排复习") + '</button></div>';
    page.querySelectorAll('[data-revise]').forEach(function (button) { button.disabled = state.draftBusy; button.addEventListener("click", function () { void runDraftRevision(session, button.dataset.revise); }); });
    page.querySelectorAll('.draft-editor input, .draft-editor textarea').forEach(function (field) { field.disabled = state.draftBusy; field.addEventListener("input", function () { document.getElementById("draft-confirm").disabled = true; }); });
    document.getElementById("draft-material")?.addEventListener("click", async function () {
      if (state.draftBusy) return;
      try {
        await saveDraftEdits(session);
        if (session.batchId) { await knowledgePlanUI.open(session.planId, 'plan'); return; }
        resetSourceProductState();
        state.materialDraftId = session.id;
        state.feedText = session.material && session.material.text || "";
        state.feedImage = session.material && session.material.image || null;
        state.feedGoal = session.material && session.material.userGoal || "";
        state.captureSource = session.source;
        setView("feed");
      } catch (error) { toast(error.message); }
    });
    document.getElementById("discard-draft").addEventListener("click", async function () {
      if (state.draftBusy) return;
      try { await agentApi.discardGachaCardDraft(session.id); state.gachaDrafts = state.gachaDrafts.filter(function (item) { return item.id !== session.id; }); state.currentDraftId = ""; setView(isDiscovery ? "discovery" : "feed"); toast("草稿已放弃"); } catch (error) { toast(error.message); }
    });
    document.getElementById("draft-later").addEventListener("click", async function () {
      if (state.draftBusy) return;
      try { await saveDraftEdits(session); state.currentDraftId = ""; if (session.batchId) await knowledgePlanUI.open(session.planId, 'batch'); else if (isDiscovery) { state.currentDiscoveryPoolId = session.discoveryContext?.poolId || state.currentDiscoveryPoolId; setView("discovery"); } else setView("home"); } catch (error) { toast(error.message); }
    });
    if (session.batchId) { document.getElementById('draft-later').textContent = '返回卡组'; document.getElementById('draft-material').textContent = '查看学习清单'; }
    document.getElementById("draft-confirm").addEventListener("click", function () { void confirmCurrentDraft(session); });
  }

  let albumSearchTimer;
  let albumSearchSequence = 0;
  let albumSearchResult = null;
  let albumSearchStatus = "";
  function searchAlbum() {
    clearTimeout(albumSearchTimer);
    const sequence = ++albumSearchSequence;
    const query = state.keyword.trim();
    albumSearchResult = null;
    albumSearchStatus = query ? "正在本地查找相关卡片…" : "";
    renderAlbumResults();
    albumSearchTimer = setTimeout(async function () {
      if (!query) return;
      try {
        const result = await agentApi.searchCards({ query: query });
        if (sequence !== albumSearchSequence || state.keyword.trim() !== query) return;
        albumSearchResult = { query: query, ids: result.results.map(function (card) { return card.cardId; }) };
        albumSearchStatus = result.trace.strategy === "hybrid-rrf-v1" ? "已按关键词和语义查找" : "已按关键词查找，语义检索暂不可用";
      } catch (_) {
        if (sequence !== albumSearchSequence) return;
        albumSearchStatus = "暂时无法完成语义检索，显示文字匹配结果";
      }
      if (state.view === "album") renderAlbumResults();
    }, 300);
  }

  function renderAlbum() {
    const cards = filteredCards();
    page.innerHTML =
      '<div class="search-row"><input class="search-input" id="album-search" value="' + escapeAttr(state.keyword) + '" placeholder="搜索卡片，也可以描述想找的知识"></div>' +
      (state.knowledgePlans.some(function (plan) { return plan.confirmed; }) ? '<label class="album-group-filter">卡组<select class="form-input" id="album-batch-filter"><option value="">全部卡片</option>' + state.knowledgePlans.filter(function (plan) { return plan.confirmed; }).map(function (plan) { return '<option value="' + escapeAttr(plan.batchId) + '" ' + (state.batchFilter === plan.batchId ? 'selected' : '') + '>' + escapeHtml(plan.title) + ' · ' + plan.confirmed + ' 张</option>'; }).join('') + '</select></label>' : '') +
      '<div class="filter-row">' +
        filterButton("all", "全部") + filterButton("favorite", "收藏") + filterButton("new", "新卡") + filterButton("due", "待复习") +
      '</div>' +
      '<div class="manage-row"><button class="manage-btn ' + (state.manageMode ? "is-active" : "") + '" id="manage-cards" type="button">' + (state.manageMode ? "完成管理" : "管理卡片") + '</button></div>' +
      (state.manageMode ? '<section class="batch-bar"><div class="batch-head"><strong>已选 ' + state.selectedIds.size + ' 张</strong></div><div class="batch-actions"><button class="secondary-btn" id="select-visible" type="button">' + icon("check") + '<span>全选当前</span></button><button class="primary-btn is-danger" id="delete-selected" type="button" ' + (state.selectedIds.size ? "" : "disabled") + '>' + icon("trash") + '<span>删除</span></button></div></section>' : "") +
      '<div class="subtle" id="album-search-status" role="status">' + escapeHtml(albumSearchStatus) + '</div><div id="album-results">' + albumResultsMarkup(cards) + '</div>';

    document.getElementById("album-search").addEventListener("input", function (event) {
      state.keyword = event.target.value;
      searchAlbum();
    });
    const batchFilter = document.getElementById('album-batch-filter');
    if (batchFilter) batchFilter.addEventListener('change', function () { state.batchFilter = batchFilter.value; state.selectedIds.clear(); renderAlbumResults(); });
    document.querySelectorAll("[data-filter]").forEach(function (button) {
      button.addEventListener("click", function () { state.filter = button.dataset.filter; state.selectedIds.clear(); renderAlbum(); });
    });
    document.getElementById("manage-cards").addEventListener("click", function () { state.manageMode = !state.manageMode; state.selectedIds.clear(); renderAlbum(); });
    const selectVisible = document.getElementById("select-visible");
    if (selectVisible) selectVisible.addEventListener("click", function () {
      const visibleCards = filteredCards();
      const allSelected = visibleCards.length && visibleCards.every(function (card) { return state.selectedIds.has(card.id); });
      visibleCards.forEach(function (card) { if (allSelected) state.selectedIds.delete(card.id); else state.selectedIds.add(card.id); });
      renderAlbum();
    });
    const deleteSelected = document.getElementById("delete-selected");
    if (deleteSelected) deleteSelected.addEventListener("click", deleteSelectedCards);
    bindCardTiles();
    if (state.keyword.trim()) searchAlbum();
  }

  function albumResultsMarkup(cards) {
    return cards.length
      ? '<div class="card-grid">' + cards.map(function (card) { return cardTile(card, { managing: state.manageMode, selected: state.selectedIds.has(card.id) }); }).join("") + '</div>'
      : emptyPanel("这个筛选里还没有卡片。");
  }

  function renderAlbumResults() {
    const searchStatus = document.getElementById("album-search-status");
    if (searchStatus) searchStatus.textContent = albumSearchStatus;
    const results = document.getElementById("album-results");
    if (!results) return;
    results.innerHTML = albumResultsMarkup(filteredCards());
    bindCardTiles();
  }

  function renderReview() {
    if (state.reviewLoading && !state.reviewOverview) {
      page.innerHTML = '<section class="review-loading"><span class="review-capsule large" aria-hidden="true"><i></i></span><h2>正在挑选最该复习的一颗</h2><p>读取当前档案的到期卡片和掌握度。</p></section>';
      return;
    }
    if (state.reviewError && !state.reviewOverview) {
      page.innerHTML = emptyPanel(state.reviewError, "重新读取", "review-retry");
      document.getElementById("review-retry").addEventListener("click", function () { void loadGachaReview(); });
      return;
    }
    const review = state.reviewOverview;
    if (!review) {
      page.innerHTML = emptyPanel("暂时无法读取今天的复习扭蛋。", "重新读取", "review-retry");
      document.getElementById("review-retry").addEventListener("click", function () { void loadGachaReview(); });
      return;
    }
    if (state.reviewQuestion) {
      renderOpenedReview(review, state.reviewQuestion, state.reviewFeedback);
      return;
    }
    if (review.status !== "ready" || !review.capsule) {
      const goal = review.dailyGoal || DAILY_REVIEW_LIMIT;
      const message = review.status === "goal_reached"
        ? "今天的建议目标已完成。你可以在这里结束，也可以继续复习。"
        : review.newCardCount
          ? "当前没有到期复习，还有 " + review.newCardCount + " 张新卡已分批排入后续学习。"
          : "现在没有到期的复习扭蛋。";
      page.innerHTML = '<section class="review-empty-state"><span class="review-capsule muted" aria-hidden="true"><i></i></span><span class="pending-pill review-count">' + review.dailyAnswered + ' / ' + goal + '</span><h2>' + escapeHtml(message) + '</h2>' +
        (review.canContinue ? '<button class="primary-btn" id="review-continue" type="button">' + (review.status === "goal_reached" ? '继续今天的复习' : '提前学下一张新卡') + '</button>' : '') +
        '<button class="secondary-btn" id="review-album" type="button">看卡册</button>' + reviewGoalMarkup(review) + '</section>';
      document.getElementById("review-album").addEventListener("click", function () { setView("album"); });
      const continueButton = document.getElementById("review-continue");
      if (continueButton) continueButton.addEventListener("click", continueReviewToday);
      bindReviewGoal();
      return;
    }
    const reason = reviewReasonSummary(review.capsule.reasons);
    const goal = review.dailyGoal || DAILY_REVIEW_LIMIT;
    const progress = Math.min(100, Math.round(review.dailyAnswered / goal * 100));
    page.innerHTML =
      '<section class="review-gacha-stage">' +
        '<div class="review-progress-head"><span>今天已完成 ' + review.dailyAnswered + ' / ' + goal + '</span><strong>待复习 ' + review.dueCount + '</strong></div>' +
        '<div class="review-progress-track"><i style="width:' + progress + '%"></i></div>' +
        '<span class="review-capsule large" aria-hidden="true"><i></i></span>' +
        '<span class="review-gacha-kicker">' + (review.capsule.learningStage === "new" ? '今日新卡学习' : '今天最该加固') + '</span><h2>打开一颗复习扭蛋</h2>' +
        '<div class="review-why"><strong>为什么是这颗？</strong><p>' + escapeHtml(reason) + '</p></div>' +
        '<button class="primary-btn review-open-btn" id="review-open" type="button" ' + (state.reviewLoading ? 'disabled' : '') + '>' + icon("bolt") + '<span>' + (state.reviewLoading ? '正在打开…' : '打开这颗复习扭蛋') + '</span></button>' +
        '<div class="review-queue-actions"><button class="secondary-btn" id="review-later" type="button">稍后 1 小时</button><button class="secondary-btn" id="review-tomorrow" type="button">明天再看</button>' +
          (isModelConfigured() && review.capsule.canGenerateVariant ? '<button class="secondary-btn" id="review-variant" type="button" ' + (state.reviewVariantLoading ? 'disabled' : '') + '>' + (state.reviewVariantLoading ? '正在生成新题…' : '生成一道新情景题') + '</button>' : '') + '</div>' +
        '<div class="review-facts"><span><b>1</b>一次一题</span><span><b>' + goal + '</b>今日目标</span><span><b>↻</b>按事件重排</span></div>' + reviewGoalMarkup(review) +
      '</section>';
    document.getElementById("review-open").addEventListener("click", function () { void openReviewGacha(review.capsule.cardId); });
    document.getElementById("review-later").addEventListener("click", function () { void deferReview(review.capsule.cardId, "later"); });
    document.getElementById("review-tomorrow").addEventListener("click", function () { void deferReview(review.capsule.cardId, "tomorrow"); });
    const variant = document.getElementById("review-variant");
    if (variant) variant.addEventListener("click", function () { void generateReviewVariant(review.capsule.cardId); });
    bindReviewGoal();
  }

  function reviewGoalMarkup(review) {
    return '<div class="review-goal-control"><label for="review-daily-goal">每日目标</label><input id="review-daily-goal" type="number" min="1" max="20" value="' + (review.dailyGoal || DAILY_REVIEW_LIMIT) + '"><button class="secondary-btn" id="review-goal-save" type="button">保存目标</button></div>';
  }

  function bindReviewGoal() {
    const button = document.getElementById("review-goal-save");
    if (button) button.addEventListener("click", function () { void setReviewGoal(Number(document.getElementById("review-daily-goal").value)); });
  }

  function renderOpenedReview(review, question, feedback) {
    ensureReviewOrder(question.cardId, (question.options || []).length);
    const goal = review.dailyGoal || DAILY_REVIEW_LIMIT;
    const number = review.dailyAnswered + (feedback ? 0 : 1);
    const recallMarkup = question.type === "recall"
      ? '<textarea class="feed-input" id="review-recall-response" aria-label="回忆作答" placeholder="先尝试用自己的话回答" ' + (feedback ? 'disabled' : '') + '>' + escapeHtml(state.reviewRecallResponse || question.savedResponse || '') + '</textarea>' +
        (state.reviewAnswer ? '<section class="review-answer-panel"><strong>参考答案与要点</strong><p>' + escapeHtml(state.reviewAnswer.answer) + '</p><p>' + escapeHtml(state.reviewAnswer.answerExplanation) + '</p><ul>' + (state.reviewAnswer.rubric || []).map(function (point) { return '<li>' + escapeHtml(point) + '</li>'; }).join("") + '</ul><p class="meta">请按要点自行判断；自评与选择题判分会分开记录。</p>' +
          (!feedback ? '<div class="review-self-actions"><button class="secondary-btn" data-self-assess="false" type="button">还没答出要点</button><button class="primary-btn" data-self-assess="true" type="button">已答出要点</button></div>' : '') + '</section>'
          : '<button class="primary-btn review-reveal-btn" id="review-reveal" type="button" ' + (state.reviewSubmitting ? 'disabled' : '') + '>对照答案与要点</button>')
      : '<div class="option-list">' + state.reviewOrder.map(function (original, display) {
          let className = "";
          if (feedback && original === feedback.chosenIndex) className = feedback.correct ? " is-correct" : " is-wrong";
          if (feedback && original === feedback.correctIndex) className += " is-reveal";
          return '<button class="option-btn' + className + '" data-answer="' + original + '" type="button" ' + (feedback || state.reviewSubmitting ? "disabled" : "") + '><span class="option-letter">' + ["A","B","C","D","E"][display] + '</span><span>' + escapeHtml(question.options[original] || "") + '</span></button>';
        }).join("") + '</div>';
    page.innerHTML =
      '<section class="review-hero"><span class="pending-pill review-count">第 ' + number + ' 题 · 今日目标 ' + goal + ' 题</span><h2 class="review-title">扭蛋已打开</h2><p class="review-copy">先凭记忆作答；需要时再看提示，答案会在提交后或主动对照时展开。</p></section>' +
      '<section class="quiz-card review-quiz-card" style="--card-color:' + escapeAttr(COLORS[1]) + '">' +
        '<div class="quiz-top"><span class="card-pill">薄弱点复习</span><span class="card-pill">' + escapeHtml(reviewDifficultyLabel(question.difficulty)) + '</span></div>' +
        '<h2 class="quiz-title">' + escapeHtml(question.title) + '</h2><p class="quiz-question">' + escapeHtml(question.question) + '</p>' +
        recallMarkup +
        (!feedback ? '<div class="review-help-actions"><button class="secondary-btn" id="review-hint" type="button" ' + (state.reviewSubmitting || state.reviewHint ? 'disabled' : '') + '>看一个提示</button><button class="secondary-btn" id="review-defer-open" type="button">稍后再做</button></div>' : '') +
        (state.reviewHint ? '<p class="review-hint"><strong>提示：</strong>' + escapeHtml(state.reviewHint) + '</p>' : '') +
        (state.reviewSubmitting ? '<p class="review-submitting">正在记录结果并重排下一颗…</p>' : '') +
        (feedback ? reviewFeedbackMarkup(feedback, review) : '') +
      '</section>';
    document.querySelectorAll("[data-answer]").forEach(function (button) {
      button.addEventListener("click", function () { void answerReview(question.cardId, Number(button.dataset.answer)); });
    });
    const response = document.getElementById("review-recall-response");
    if (response) response.addEventListener("input", function () { state.reviewRecallResponse = response.value; });
    const reveal = document.getElementById("review-reveal");
    if (reveal) reveal.addEventListener("click", function () { void revealReviewAnswer(question.cardId); });
    const hint = document.getElementById("review-hint");
    if (hint) hint.addEventListener("click", function () { void loadReviewHint(question.cardId); });
    const defer = document.getElementById("review-defer-open");
    if (defer) defer.addEventListener("click", function () { void deferReview(question.cardId, "later"); });
    page.querySelectorAll('[data-self-assess]').forEach(function (button) { button.disabled = Boolean(feedback || state.reviewSubmitting); button.addEventListener("click", function () { void answerReview(question.cardId, button.dataset.selfAssess === "true"); }); });
    const nextReview = document.getElementById("next-review");
    const correctCause = document.getElementById("review-correct-cause");
    if (correctCause) correctCause.addEventListener("click", function () { openReviewCauseCorrection(feedback.reviewEventId); });
    if (nextReview) nextReview.addEventListener("click", function () {
      state.reviewQuestion = null;
      state.reviewFeedback = null;
      state.reviewHint = "";
      state.reviewAnswer = null;
      state.reviewRecallResponse = "";
      state.reviewCardId = "";
      state.reviewOrder = [];
      renderReview();
    });
  }

  function reviewFeedbackMarkup(feedback, review) {
    const hasNext = review.status === "ready" && review.capsule;
    const error = !feedback.correct ? '<p class="review-error-cause"><strong>本次错因：</strong>' + escapeHtml(feedback.errorCause?.label || "暂未确定") + (feedback.errorCause?.detail ? ' · ' + escapeHtml(feedback.errorCause.detail) : '') + '</p><button class="secondary-btn" id="review-correct-cause" type="button">纠正错因记录</button>' : '';
    return '<div class="feedback review-feedback"><strong>' + (feedback.assessment === "self" ? "已记录你的自评。" : feedback.correct ? "答对了，已形成一条作答证据。" : "这次没答对，已按证据安排后续练习。") + '</strong><span class="answer-line">正确答案：' + escapeHtml(feedback.correctAnswer) + '</span><p>' + escapeHtml(feedback.explanation) + '</p>' + error + '<small>掌握状态：' + escapeHtml(feedback.masteryLabel || "正在学习") + ' · 下次排期 ' + escapeHtml(formatReviewDueAt(feedback.dueAt)) + ' · 事件 ' + escapeHtml(feedback.reviewEventId) + '</small><button class="primary-btn" id="next-review" type="button">' + icon("arrow-right") + '<span>' + (hasNext ? "再扭一颗" : review.status === "goal_reached" ? "查看今日完成状态" : "完成今天") + '</span></button></div>';
  }

  function renderAgent() {
    const configured = isModelConfigured();
    const response = state.agentResponse;
    const waiting = response && response.status === "waiting_approval" && response.approval;
    page.innerHTML =
      '<section class="agent-intro"><div><span class="card-pill">由你的模型回答</span><h2>问问这台知识扭蛋机</h2><p>可以解释资料、查找卡片或帮你整理。需要使用哪种能力会自动判断，任何保存或修改仍会先问你。</p></div><span class="agent-orbit" aria-hidden="true"><i></i><i></i><i></i></span></section>' +
      '<button class="engine-strip ' + (configured ? "ready" : "") + '" id="agent-engine" type="button"><span class="engine-left"><span class="engine-dot"></span><span>' + (configured ? "当前用户模型" : "尚未配置模型") + '</span></span><span class="engine-model">' + escapeHtml(state.aiConfig.model || "去设置") + '</span></button>' +
      '<section class="agent-compose"><label class="field-label" for="agent-input">你想了解什么？</label><textarea class="feed-input agent-input" id="agent-input" maxlength="12000" placeholder="例如：用大白话解释我资料里的间隔复习，并告诉我依据来自哪里。">' + escapeHtml(state.agentInput) + '</textarea>' +
        '<div class="assistant-compose-actions"><span>会自动选择合适能力</span><button class="primary-btn agent-run-btn" id="agent-run" type="button" ' + (state.agentBusy ? "disabled" : "") + '>' + icon("bolt") + '<span>' + (state.agentBusy ? "正在查找和整理…" : "开始询问") + '</span></button></div>' +
      '</section>' +
      (state.agentError ? '<section class="agent-error"><strong>这次没有完成</strong><p>' + escapeHtml(state.agentError) + '</p><button class="primary-btn agent-retry" id="agent-retry" type="button">重试</button></section>' : "") +
      (waiting ? agentApprovalMarkup(response) : "") +
      (response && response.answer ? agentAnswerMarkup(response) : "") +
      '<p class="memory-privacy">助手只会读取当前档案中完成这次问题所需的内容。保存卡片、调整复习或改动资料前，一定会停下来等你确认。</p>';

    document.getElementById("agent-engine").addEventListener("click", function () { setView("model"); });
    document.getElementById("agent-input").addEventListener("input", function (event) { state.agentInput = event.target.value; });
    document.getElementById("agent-run").addEventListener("click", runAgentHarness);
    const retry = document.getElementById("agent-retry");
    if (retry) retry.addEventListener("click", runAgentHarness);
    const approve = document.getElementById("agent-approve");
    const reject = document.getElementById("agent-reject");
    if (approve) approve.addEventListener("click", function () { void decideAgentApproval("approve"); });
    if (reject) reject.addEventListener("click", function () { void decideAgentApproval("reject"); });
  }

  function agentApprovalMarkup(response) {
    const approval = response.approval;
    return '<section class="agent-approval"><div class="agent-result-head"><span class="card-pill">等待你的确认</span><span>' + escapeHtml(response.model) + '</span></div><h2>' + escapeHtml(agentToolLabel(approval.toolName)) + '</h2><p>' + escapeHtml(approval.reason) + '</p><small>确认前不会修改你的卡片、复习计划或资料。</small><div class="action-row"><button class="secondary-btn" id="agent-reject" type="button" ' + (state.agentBusy ? "disabled" : "") + '>不允许</button><button class="primary-btn" id="agent-approve" type="button" ' + (state.agentBusy ? "disabled" : "") + '>允许这一次</button></div></section>';
  }

  function agentAnswerMarkup(response) {
    const skill = response.run && response.run.skill ? response.run.skill.name : "plain-explanation";
    return '<section class="agent-answer"><div class="agent-result-head"><span class="card-pill">' + escapeHtml(agentSkillName(skill)) + '</span><span>已完成核对</span></div><h2>助手回答</h2><p>' + escapeHtml(response.answer) + '</p><small>由 ' + escapeHtml(response.model) + ' 回答</small></section>';
  }

  async function runAgentHarness() {
    const input = state.agentInput.trim();
    if (!input) return toast("先告诉助手你想了解什么");
    if (!isModelConfigured()) {
      toast("请先配置 Base URL、API Key 和 Model");
      setView("model");
      return;
    }
    state.agentBusy = true;
    state.agentError = "";
    state.agentResponse = null;
    renderAgent();
    try {
      const request = {
        goal: "使用扩展内 Agent Harness 完成用户任务",
        userInput: input
      };
      state.agentResponse = await agentApi.runAgent(request);
      state.connectionStatus = "ready";
      state.connectionMessage = "助手已使用你的模型：" + state.agentResponse.model;
    } catch (error) {
      state.agentError = error.message || "助手暂时无法完成这次问题";
    } finally {
      state.agentBusy = false;
      if (state.view === "agent") renderAgent();
    }
  }

  async function decideAgentApproval(decision) {
    const response = state.agentResponse;
    if (!response || !response.approval) return;
    state.agentBusy = true;
    state.agentError = "";
    renderAgent();
    try {
      state.agentResponse = await agentApi.continueAgent(response.run.id, {
        approvalId: response.approval.id,
        decision: decision
      });
      toast(decision === "approve" ? "已允许，助手继续处理" : "已拒绝，助手会调整回答");
    } catch (error) {
      state.agentError = error.message || "助手暂时无法继续处理";
    } finally {
      state.agentBusy = false;
      if (state.view === "agent") renderAgent();
    }
  }

  function agentSkillName(value) {
    return ({
      "concept-card": "知识卡",
      "plain-explanation": "大白话解释",
      "weak-point-review": "薄弱点复习",
      "gacha-discovery": "发现扭蛋",
      "citation-check": "引用核验"
    })[value] || "助手";
  }

  function agentToolLabel(value) {
    return ({
      create_card: "保存知识卡",
      schedule_review: "调整复习计划",
      record_review_result: "记录复习结果"
    })[value] || value;
  }

  function renderSettings() {
    const configured = isModelConfigured();
    const modelStatus = state.connectionStatus === "ready" ? "已连接 " + state.aiConfig.model : configured ? "已填写 · 待测试" : "尚未配置";
    const pendingPreferences = state.memoryCandidates.filter(function (candidate) { return candidate.status === "pending"; }).length;
    const preferenceSummary = state.memoryLoaded
      ? state.memoryPreferences.filter(function (memory) { return memory.enabled; }).length + " 项偏好 · " + pendingPreferences + " 个待确认建议"
      : "调整兴趣、讲解方式与内容难度";
    const reduced = prefersReducedMotion();
    const hasHistoricalMaterials = state.sourceDocuments.some(function (document) { return !document.linkedCardCount; }) || state.gachaDrafts.some(function (draft) { return draft.status === "material"; });
    page.innerHTML =
      '<section class="more-intro"><span class="more-intro-icon">' + icon("bolt") + '</span><div><strong>扭蛋机已经准备好</strong><p>在这里设置模型和学习偏好，文件从制卡页导入。</p></div></section>' +
      '<div class="section-head more-section-head"><h2 class="section-title">我的扭蛋机</h2><span class="card-pill">常用设置</span></div>' +
      '<div class="more-entry-list">' +
        moreEntry("open-model", "gear", "我的模型", modelStatus, "mint") +
        moreEntry("open-memory", "heart", "我的学习偏好", preferenceSummary, "pink") +
      '</div>' +
      (hasHistoricalMaterials ? '<div class="section-head more-section-head"><h2 class="section-title">继续整理</h2></div>' + moreEntry("historical-materials", "book", "历史材料", "继续整理以前保存但尚未制卡的材料", "yellow") : '') +
      '<div class="section-head more-section-head"><h2 class="section-title">使用体验</h2></div>' +
      '<section class="motion-setting"><div><strong>减弱扭蛋动画</strong><small>默认跟随系统设置，也可以在这里单独调整</small></div><button class="motion-toggle ' + (reduced ? "is-on" : "") + '" id="toggle-reduced-motion" type="button" aria-label="减弱扭蛋动画，当前' + (reduced ? "开启" : "关闭") + '" aria-pressed="' + (reduced ? "true" : "false") + '"><i></i></button></section>' +
      '<button class="local-data-entry" id="wipe-all" type="button">本地数据与隐私</button>' +
      '<details class="more-help"><summary>帮助与诊断</summary><p>回答失败或处理较慢时，可以在这里查看运行记录。</p>' +
      moreEntry("open-observability", "book", "运行记录", "查看运行状态、处理耗时和失败原因", "mint") + '</details>';

    document.getElementById("open-model").addEventListener("click", function () { setView("model"); });
    document.getElementById("open-memory").addEventListener("click", function () { setView("memory"); });
    const historicalMaterials = document.getElementById("historical-materials");
    if (historicalMaterials) historicalMaterials.addEventListener("click", openSourceManager);
    document.getElementById("open-observability").addEventListener("click", function () { setView("observability"); });
    document.getElementById("toggle-reduced-motion").addEventListener("click", toggleReducedMotion);
    document.getElementById("wipe-all").addEventListener("click", wipeAllData);
  }

  function moreEntry(id, iconName, title, detail, tone) {
    return '<button class="more-entry tone-' + tone + '" id="' + id + '" type="button"><span class="more-entry-icon">' + icon(iconName) + '</span><span><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(detail) + '</small></span>' + icon("arrow-right") + '</button>';
  }

  function renderModelSettings() {
    const ready = state.connectionStatus === "ready";
    const configured = isModelConfigured();
    const statusLabel = ready
      ? "已连接"
      : state.connectionStatus === "error" ? "连接异常" : configured ? "已配置 · 待测试" : "尚未配置";
    page.innerHTML =
      '<section class="status-board ' + (ready ? "ready" : "") + '"><span class="status-main"><span class="engine-dot"></span><span>' + statusLabel + '</span></span><span class="engine-model">' + escapeHtml(state.aiConfig.model || "OpenAI-compatible") + '</span></section>' +
      '<section class="setting-panel"><div class="form-grid">' +
        '<div><label class="field-label" for="model-base-url">Base URL</label><input class="form-input" id="model-base-url" type="url" inputmode="url" autocomplete="url" placeholder="https://api.openai.com/v1" value="' + escapeAttr(state.aiConfig.baseUrl) + '"></div>' +
        '<div><label class="field-label" for="model-api-key">API Key</label><div class="input-with-action"><input class="form-input" id="model-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="' + (state.aiConfig.apiKey ? "已填写；留空则继续使用当前密钥" : "sk-…") + '"><button class="icon-btn field-action" id="toggle-api-key" type="button" aria-label="显示 API Key">' + icon("eye") + '</button></div></div>' +
        '<div><label class="field-label" for="model-name">Model</label><input class="form-input" id="model-name" autocomplete="off" spellcheck="false" placeholder="gpt-4o-mini" value="' + escapeAttr(state.aiConfig.model) + '"></div>' +
        '<label class="remember-key"><input id="remember-api-key" type="checkbox" ' + (state.aiConfig.rememberApiKey ? "checked" : "") + '><span>在此扩展中持久保存 API Key</span></label>' +
        '<p class="privacy-note">所有模型调用固定关闭思考。无法关闭思考或尚未适配的型号会阻止调用。扩展只在你发起操作时向所填 OpenAI-compatible 接口请求，并按需申请该域名权限；未勾选时，API Key 只保存在当前侧边栏会话。</p>' +
      '</div></section>' +
      '<div class="settings-actions split-actions"><button class="secondary-btn" id="clear-key" type="button">清除密钥</button><button class="primary-btn" id="test-key" type="button">' + icon("bolt") + '<span>保存并测试</span></button></div>' +
      '<div class="connection-message" id="settings-status">' + escapeHtml(state.connectionMessage || "填写三项配置后，点击“保存并测试”。扩展后台会直接调用当前模型，不需要本机服务。") + '</div>';

    document.getElementById("test-key").addEventListener("click", testConnection);
    document.getElementById("toggle-api-key").addEventListener("click", toggleApiKeyVisibility);
    document.getElementById("clear-key").addEventListener("click", clearModelApiKey);
  }

  function mcpAuditMarkup() {
    if (state.mcpAuditLoading || !state.mcpAuditLoaded) {
      return '<section class="memory-state-panel"><strong>正在读取 MCP 审计…</strong><span>只读取当前档案</span></section>';
    }
    if (state.mcpAuditError) {
      return '<section class="memory-state-panel is-error"><strong>MCP 审计暂时不可用</strong><span>' + escapeHtml(state.mcpAuditError) + '</span></section>';
    }
    if (!state.mcpAuditItems.length) return emptyPanel("还没有 MCP 调用记录。连接调用后会在这里显示工具、来源和权限。");
    return '<div class="mcp-audit-list">' + state.mcpAuditItems.slice().reverse().map(function (item) {
      const source = item.direction === "inbound" ? "外部客户端 → 知识扭蛋机" : "知识扭蛋机 → 外部服务";
      const status = item.status === "completed" ? "已完成" : item.status === "approval_required" ? "待确认" : item.status === "cancelled" ? "已取消" : "失败";
      return '<article class="mcp-audit-card">' +
        '<div class="memory-card-top"><span class="card-pill">' + escapeHtml(source) + '</span><span class="memory-status">' + status + '</span></div>' +
        '<strong>' + escapeHtml(item.name) + '</strong>' +
        '<span class="mcp-audit-server">' + escapeHtml(item.serverId) + ' · ' + escapeHtml(item.connectionId) + '</span>' +
        '<div class="mcp-permissions">' + item.permissions.map(function (permission) { return '<span>' + escapeHtml(permission) + '</span>'; }).join("") + '</div>' +
        '<small>' + (item.approvalRequired ? "需要用户确认 · " : "") + item.durationMs + ' ms · ' + escapeHtml(formatMemoryTime(item.occurredAt)) + (item.errorCode ? ' · ' + escapeHtml(item.errorCode) : '') + '</small>' +
      '</article>';
    }).join("") + '</div>';
  }

  async function loadMcpAudit() {
    state.mcpAuditLoading = true;
    state.mcpAuditError = "";
    try {
      const response = await agentApi.listMcpAudit(0, 20);
      state.mcpAuditItems = Array.isArray(response.items) ? response.items : [];
      state.mcpAuditLoaded = true;
    } catch (error) {
      state.mcpAuditLoaded = true;
      state.mcpAuditError = error.message || "无法读取 MCP 审计";
    } finally {
      state.mcpAuditLoading = false;
      if (state.view === "observability" && !state.observabilityRun) renderObservability();
    }
  }

  function renderObservability() {
    if (state.observabilityRun) {
      renderObservabilityTrace();
      return;
    }
    page.innerHTML =
      '<section class="observability-intro"><div><span class="card-pill">使用诊断</span><h2>查看运行情况</h2><p>遇到回答失败或处理较慢时，查看已记录的状态、耗时与错误摘要。</p></div><span class="observability-signal" aria-hidden="true"><i></i><i></i><i></i></span></section>' +
      observabilityFiltersMarkup() +
      '<div id="observability-content">' + observabilityContentMarkup() + '</div>' +
      (state.mcpAuditItems.length || state.mcpAuditError ? '<details class="legacy-connection-records"><summary>历史连接记录</summary>' + mcpAuditMarkup() + '<button class="pill-btn" id="refresh-mcp-audit" type="button">刷新连接记录</button><p class="memory-privacy">不会保存参数正文、文档正文、API Key 或隐藏思考内容。</p></details>' : '') +
      '<p class="memory-privacy">只展示安全摘要、结构化状态与耗时。Prompt、用户原文、参数、工具输出、文档正文、路径、凭据、Cookie 和堆栈不会进入此面板；未采集的 Token、成本和模型延迟不会被虚构。</p>';
    bindObservabilityOverview();
    document.getElementById("refresh-mcp-audit")?.addEventListener("click", function () { void loadMcpAudit(); });
  }

  function observabilityFiltersMarkup() {
    const filters = state.observabilityFilters;
    return '<section class="observability-filter-panel" aria-labelledby="observability-filter-title">' +
      '<div class="section-head observability-filter-head"><h2 class="section-title" id="observability-filter-title">观察范围</h2><button class="pill-btn" id="refresh-observability" type="button">刷新</button></div>' +
      '<div class="observability-window" role="group" aria-label="时间范围">' +
        observabilityWindowButton("24h", "24 小时") + observabilityWindowButton("7d", "7 天") + observabilityWindowButton("all", "全部") +
      '</div>' +
      '<div class="observability-selects">' +
        observabilitySelect("observability-status", "状态", filters.status, [
          ["all", "全部状态"], ["queued", "排队中"], ["running", "运行中"], ["waiting_approval", "待确认"],
          ["completed", "成功"], ["failed", "失败"], ["cancelled", "已取消"]
        ]) +
        observabilitySelect("observability-skill", "任务类型", filters.skill, [
          ["all", "全部任务"], ["concept-card", "知识卡"], ["knowledge-plan", "学习清单"], ["plain-explanation", "大白话解释"],
          ["learning-dialogue", "伴学讨论"], ["companion-explain", "伴学讲解"], ["companion-compare", "伴学比较"], ["companion-practice", "伴学陪练"],
          ["weak-point-review", "薄弱点复习"], ["gacha-discovery", "发现扭蛋"], ["citation-check", "引用核验"], ["unresolved", "未绑定"]
        ]) +
        observabilitySelect("observability-source", "来源", filters.source, [
          ["all", "全部来源"], ["extension_harness", "伴学助手"], ["extension_workflow", "制卡与学习"], ["agent_api", "历史助手"], ["mcp", "内部工具"], ["external_mcp", "外部连接"]
        ]) +
      '</div></section>';
  }

  function observabilityWindowButton(value, label) {
    const active = state.observabilityFilters.window === value;
    return '<button class="filter-btn observability-window-btn ' + (active ? "is-active" : "") + '" type="button" data-observability-window="' + value + '" aria-pressed="' + active + '">' + label + '</button>';
  }

  function observabilitySelect(id, label, value, options) {
    return '<label class="observability-select"><span>' + label + '</span><select class="select" id="' + id + '">' + options.map(function (option) {
      return '<option value="' + escapeAttr(option[0]) + '" ' + (value === option[0] ? "selected" : "") + '>' + escapeHtml(option[1]) + '</option>';
    }).join("") + '</select></label>';
  }

  function observabilityContentMarkup() {
    if (state.observabilityLoading || !state.observabilityLoaded) {
      return '<section class="memory-state-panel observability-state"><strong>正在读取运行记录…</strong><span>只读取当前档案的持久化数据</span></section>';
    }
    if (state.observabilityError) {
      return '<section class="memory-state-panel is-error observability-state"><strong>运行观测暂时不可用</strong><span>' + escapeHtml(state.observabilityError) + '</span><button class="primary-btn" id="retry-observability" type="button">重试</button></section>';
    }
    const dashboard = state.observabilityDashboard;
    if (!dashboard || !dashboard.metrics.totalRuns) {
      return '<section class="memory-state-panel observability-state"><strong>当前范围暂无运行数据</strong><span>尝试调整时间范围；使用伴学或生成卡片后，可以在这里查看已记录的运行情况。</span></section>';
    }
    return observabilityMetricsMarkup(dashboard) + observabilityDistributionMarkup(dashboard) + observabilityRunsMarkup(dashboard);
  }

  function observabilityMetricsMarkup(dashboard) {
    const metrics = dashboard.metrics;
    return '<section aria-labelledby="observability-metrics-title">' +
      '<div class="section-head"><h2 class="section-title" id="observability-metrics-title">运行体检</h2><span class="card-pill">' + escapeHtml(observabilityWindowLabel(dashboard.filters.window)) + '</span></div>' +
      '<div class="observability-kpis">' +
        observabilityKpi("运行数", String(metrics.totalRuns), "筛选后已持久化运行", "blue") +
        observabilityKpi("成功率", formatRate(metrics.successRate), metrics.terminalRuns ? metrics.successfulRuns + " / " + metrics.terminalRuns + " 次已结束运行" : "暂无已结束运行", "mint") +
        observabilityKpi("P95 总耗时", formatDuration(metrics.p95DurationMs), metrics.durationSampleCount ? metrics.durationSampleCount + " 个已结束样本" : "暂无最终耗时", "yellow") +
        observabilityKpi("重试率", formatRate(metrics.retryRate), metrics.retryingRuns + " 次运行发生重试 · 平均 " + formatNumber(metrics.averageSteps) + " 步", "pink") +
      '</div></section>';
  }

  function observabilityKpi(label, value, note, tone) {
    return '<article class="observability-kpi"><div><span>' + escapeHtml(label) + '</span><i class="tone-' + tone + '"></i></div><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(note) + '</small></article>';
  }

  function observabilityDistributionMarkup(dashboard) {
    const statuses = dashboard.statusDistribution.filter(function (item) { return item.count > 0; });
    return '<section aria-labelledby="observability-status-title"><div class="section-head"><h2 class="section-title" id="observability-status-title">状态分布</h2><span class="card-pill">更新 ' + escapeHtml(formatObservabilityTime(dashboard.snapshotAt)) + '</span></div>' +
      '<div class="observability-distribution">' + statuses.map(function (item) {
        const width = Math.max(4, Math.round(Number(item.rate || 0) * 100));
        return '<div class="observability-bar-row"><div><span>' + escapeHtml(observabilityStatusLabel(item.status)) + '</span><strong>' + item.count + ' 次 · ' + escapeHtml(formatRate(item.rate)) + '</strong></div><span class="observability-bar"><i class="status-' + escapeAttr(item.status) + '" style="width:' + width + '%"></i></span></div>';
      }).join("") + '</div></section>' +
      '<section aria-labelledby="observability-error-title"><div class="section-head"><h2 class="section-title" id="observability-error-title">结构化错误码</h2><span class="card-pill">' + dashboard.errorDistribution.length + ' 类</span></div>' +
      (dashboard.errorDistribution.length ? '<div class="observability-errors">' + dashboard.errorDistribution.map(function (item) {
        return '<article><div><strong>' + escapeHtml(item.code) + '</strong><span>最终运行失败码</span></div><b>' + item.count + '</b></article>';
      }).join("") + '</div>' : '<p class="observability-no-errors">当前筛选范围没有最终失败错误。</p>') + '</section>';
  }

  function observabilityRunsMarkup(dashboard) {
    return '<section aria-labelledby="observability-runs-title"><div class="section-head"><h2 class="section-title" id="observability-runs-title">最近运行</h2><span class="card-pill">点击查看轨迹</span></div><div class="observability-runs">' + dashboard.recentRuns.map(function (run) {
      const duration = run.durationMs === null ? "未结束" : formatDuration(run.durationMs);
      return '<button class="observability-run-card status-' + escapeAttr(run.status) + '" type="button" data-observability-run="' + escapeAttr(run.id) + '">' +
        '<div class="observability-run-top"><span class="observability-status status-' + escapeAttr(run.status) + '">' + escapeHtml(observabilityStatusLabel(run.status)) + '</span><time>' + escapeHtml(formatObservabilityTime(run.createdAt)) + '</time></div>' +
        '<strong>' + escapeHtml(observabilitySkillLabel(run.skill)) + ' · ' + escapeHtml(observabilitySourceLabel(run.source)) + '</strong>' +
        '<small>' + escapeHtml(duration) + ' · ' + run.stepCount + ' 步 · 重试 ' + run.retryCount + ' · 确认 ' + run.approvalCount + (run.errorCode ? ' · ' + escapeHtml(run.errorCode) : '') + '</small>' +
        '<small>Skill ' + escapeHtml(run.skill.version || "版本未知") + (run.promptVersion ? ' · ' + escapeHtml(run.promptVersion) : '') + '</small>' +
      '</button>';
    }).join("") + '</div></section>';
  }

  function bindObservabilityOverview() {
    document.querySelectorAll("[data-observability-window]").forEach(function (button) {
      button.addEventListener("click", function () { setObservabilityFilter("window", button.dataset.observabilityWindow); });
    });
    [["observability-status", "status"], ["observability-skill", "skill"], ["observability-source", "source"]].forEach(function (binding) {
      const select = document.getElementById(binding[0]);
      if (select) select.addEventListener("change", function () { setObservabilityFilter(binding[1], select.value); });
    });
    const refresh = document.getElementById("refresh-observability");
    if (refresh) refresh.addEventListener("click", function () { void loadObservabilityDashboard(); });
    const retry = document.getElementById("retry-observability");
    if (retry) retry.addEventListener("click", function () { void loadObservabilityDashboard(); });
    document.querySelectorAll("[data-observability-run]").forEach(function (button) {
      button.addEventListener("click", function () {
        const dashboard = state.observabilityDashboard;
        const run = dashboard && dashboard.recentRuns.find(function (item) { return item.id === button.dataset.observabilityRun; });
        if (run) void loadObservabilityTrace(run);
      });
    });
  }

  function setObservabilityFilter(key, value) {
    state.observabilityFilters[key] = value;
    state.observabilityRun = null;
    void loadObservabilityDashboard();
  }

  async function loadObservabilityDashboard() {
    state.observabilityLoading = true;
    state.observabilityError = "";
    if (state.view === "observability") renderObservability();
    try {
      state.observabilityDashboard = await agentApi.getObservabilityDashboard(state.observabilityFilters);
      state.observabilityLoaded = true;
    } catch (error) {
      state.observabilityLoaded = true;
      state.observabilityError = error.message || "无法读取扩展运行数据";
    } finally {
      state.observabilityLoading = false;
      if (state.view === "observability" && !state.observabilityRun) renderObservability();
    }
  }

  async function loadObservabilityTrace(run) {
    state.observabilityRun = run;
    state.observabilityTraceLoading = true;
    state.observabilityTraceError = "";
    state.observabilityTraceItems = [];
    state.observabilityTraceHasMore = false;
    renderObservability();
    pageViewport.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "instant" : "smooth" });
    try {
      const response = await agentApi.getAgentTrace(run.id, 0, 200);
      state.observabilityTraceItems = Array.isArray(response.items) ? response.items : [];
      state.observabilityTraceHasMore = Boolean(response.replay && response.replay.hasMore);
    } catch (error) {
      state.observabilityTraceError = error.message || "无法读取 trace";
    } finally {
      state.observabilityTraceLoading = false;
      if (state.view === "observability" && state.observabilityRun && state.observabilityRun.id === run.id) renderObservability();
    }
  }

  function renderObservabilityTrace() {
    const run = state.observabilityRun;
    if (!run) return renderObservability();
    page.innerHTML =
      '<button class="secondary-btn observability-back" id="observability-back" type="button">' + icon("arrow-left") + '<span>返回运行列表</span></button>' +
      '<section class="observability-trace-summary"><div class="observability-run-top"><span class="card-pill">RUN · ' + escapeHtml(shortRunId(run.id)) + '</span><span class="observability-status status-' + escapeAttr(run.status) + '">' + escapeHtml(observabilityStatusLabel(run.status)) + '</span></div><h2>' + escapeHtml(observabilitySkillLabel(run.skill)) + '</h2><p>' + escapeHtml(observabilitySourceLabel(run.source)) + ' · ' + escapeHtml(run.durationMs === null ? "未结束" : formatDuration(run.durationMs)) + ' · ' + run.stepCount + ' 步 · 重试 ' + run.retryCount + ' · 确认 ' + run.approvalCount + '</p><small>仅显示白名单摘要、结构化状态与耗时；输入正文、参数、工具输出和凭据均已隐藏。</small></section>' +
      observabilityTraceMarkup() +
      '<p class="memory-privacy">Trace 按持久化事件 sequence 排序。这里不会显示 Prompt、用户原文、工具参数/输出正文、文档正文、路径、凭据、Cookie 或堆栈。</p>';
    document.getElementById("observability-back").addEventListener("click", function () {
      state.observabilityRun = null;
      state.observabilityTraceItems = [];
      renderObservability();
      pageViewport.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "instant" : "smooth" });
    });
    const retry = document.getElementById("retry-observability-trace");
    if (retry) retry.addEventListener("click", function () { void loadObservabilityTrace(run); });
  }

  function observabilityTraceMarkup() {
    if (state.observabilityTraceLoading) return '<section class="memory-state-panel observability-state"><strong>正在读取脱敏 trace…</strong><span>按事件序号确定性回放</span></section>';
    if (state.observabilityTraceError) return '<section class="memory-state-panel is-error observability-state"><strong>Trace 暂时不可用</strong><span>' + escapeHtml(state.observabilityTraceError) + '</span><button class="primary-btn" id="retry-observability-trace" type="button">重试</button></section>';
    if (!state.observabilityTraceItems.length) return '<section class="memory-state-panel observability-state"><strong>这次运行还没有事件</strong><span>运行开始后，安全轨迹会按顺序出现在这里。</span></section>';
    return '<ol class="observability-timeline">' + state.observabilityTraceItems.map(function (item, index) {
      const previous = state.observabilityTraceItems[index - 1];
      const delta = previous ? Math.max(0, item.occurredAt - previous.occurredAt) : 0;
      return '<li class="kind-' + escapeAttr(item.kind) + '"><span class="observability-timeline-dot"></span><article><div class="observability-trace-meta"><span>' + escapeHtml(observabilityTraceKindLabel(item.kind)) + ' · #' + item.sequence + '</span><time>' + (index ? "+" + escapeHtml(formatDuration(delta)) : escapeHtml(formatObservabilityTime(item.occurredAt))) + '</time></div><strong>' + escapeHtml(item.summary) + '</strong>' +
        (item.status ? '<span class="observability-trace-status">' + escapeHtml(observabilityStatusLabel(item.status)) + '</span>' : '') +
        (item.error ? '<p class="observability-trace-error"><b>' + escapeHtml(item.error.code) + '</b><span>' + escapeHtml(item.error.message) + '</span></p>' : '') +
      '</article></li>';
    }).join("") + '</ol>' + (state.observabilityTraceHasMore ? '<p class="observability-truncated">事件超过 200 条，本页只展示首批脱敏轨迹。</p>' : '');
  }

  function observabilityStatusLabel(status) {
    const labels = {
      queued: "排队中", running: "运行中", waiting_approval: "待确认", completed: "成功", failed: "失败",
      cancelled: "已取消", pending: "待处理", retrying: "重试中", approved: "已批准", rejected: "已拒绝"
    };
    return labels[status] || String(status || "未知");
  }

  function observabilitySkillLabel(skill) {
    const name = typeof skill === "object" && skill ? skill.name : skill;
    return ({
      "concept-card": "知识卡生成",
      "knowledge-plan": "学习清单",
      "learning-dialogue": "伴学讨论",
      "companion-explain": "伴学讲解",
      "companion-compare": "伴学比较",
      "companion-practice": "伴学陪练",
      "plain-explanation": "大白话解释",
      "weak-point-review": "薄弱点复习",
      "gacha-discovery": "发现扭蛋",
      "citation-check": "引用核验"
    })[name] || "未分类任务";
  }

  function observabilitySourceLabel(source) {
    return ({ extension_workflow: "制卡与学习", extension_harness: "伴学助手", agent_api: "历史助手", mcp: "内部工具", external_mcp: "外部连接" })[source] || "本地任务";
  }

  function observabilityTraceKindLabel(kind) {
    return ({ run: "RUN", step: "STEP", tool: "TOOL", approval: "APPROVAL", checkpoint: "CHECKPOINT" })[kind] || "EVENT";
  }

  function observabilityWindowLabel(windowValue) {
    return windowValue === "7d" ? "7 天" : windowValue === "all" ? "全部" : "24 小时";
  }

  function formatRate(value) {
    return value === null || value === undefined ? "暂无数据" : Math.round(Number(value) * 100) + "%";
  }

  function formatNumber(value) {
    return value === null || value === undefined ? "暂无数据" : String(value);
  }

  function formatDuration(milliseconds) {
    if (milliseconds === null || milliseconds === undefined) return "暂无数据";
    const value = Math.max(0, Number(milliseconds) || 0);
    if (value < 1_000) return Math.round(value) + " ms";
    if (value < 60_000) return (value / 1_000).toFixed(value < 10_000 ? 1 : 0) + "s";
    return (value / 60_000).toFixed(1) + "m";
  }

  function formatObservabilityTime(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    if (Number.isNaN(date.getTime())) return "时间未知";
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return sameDay ? "今天 " + hours + ":" + minutes : (date.getMonth() + 1) + "/" + date.getDate() + " " + hours + ":" + minutes;
  }

  function shortRunId(runId) {
    const value = String(runId || "").replace(/^run_/, "");
    return value.slice(0, 8).toUpperCase();
  }

  function renderMemory() {
    const pendingCandidates = state.memoryCandidates.filter(function (candidate) { return candidate.status === "pending"; });
    const activePreferences = state.memoryPreferences.filter(function (memory) { return memory.enabled; });
    const observedConcepts = state.memoryConcepts.filter(function (concept) { return concept.evidenceKind === "observed_review"; });
    page.innerHTML =
      '<section class="memory-control-panel">' +
        '<div><strong>让学习内容更适合你</strong><span>分别管理兴趣、内容难度、讲解方式与学习记录。</span></div>' +
        '<div class="memory-setting-actions"><button class="secondary-btn memory-add-btn" id="memory-interests" type="button">调整兴趣</button><button class="secondary-btn memory-add-btn" id="memory-add" type="button">添加学习偏好</button></div>' +
        '<div class="memory-summary">' +
          memorySummary(activePreferences.filter(function (item) { return ["topic_interest", "topic_downrank", "unit_exclusion"].includes(item.category); }).length, "推荐设置") +
          memorySummary(activePreferences.filter(function (item) { return !["topic_interest", "topic_downrank", "unit_exclusion"].includes(item.category); }).length, "难度与表达") +
          memorySummary(observedConcepts.length, "有复习记录") +
          memorySummary(pendingCandidates.length, "待确认") +
        '</div>' +
      '</section>' +
      '<div class="memory-tabs" role="tablist" aria-label="学习偏好分类">' +
        memoryTabButton("interests", "想学什么") +
        memoryTabButton("preferences", "难度与表达") +
        memoryTabButton("records", "学习记录") +
        memoryTabButton("candidates", "待确认建议") +
      '</div>' +
      '<div id="memory-content">' + memoryContentMarkup(pendingCandidates) + '</div>' +
      '<p class="memory-privacy">忽略的建议不会影响后续内容。确认后的偏好只保存在当前本地学习档案中，不同档案互相隔离。</p>';

    document.querySelectorAll("[data-memory-tab]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.memoryTab = button.dataset.memoryTab;
        renderMemory();
      });
    });
    const retry = document.getElementById("retry-memory");
    if (retry) retry.addEventListener("click", function () { void loadMemoryData(); });
    const add = document.getElementById("memory-add");
    if (add) add.addEventListener("click", openPreferenceCreator);
    const interests = document.getElementById("memory-interests");
    if (interests) interests.addEventListener("click", function () { void discoveryInterestsUI.open({ returnView: "memory" }); });
    page.querySelectorAll("[data-memory-record]").forEach(function (button) { button.addEventListener("click", function () { state.memoryRecordTab = button.dataset.memoryRecord; renderMemory(); }); });
    bindMemoryActions();
  }

  function memorySummary(value, label) {
    return '<span class="memory-summary-item"><strong>' + Number(value || 0) + '</strong><small>' + escapeHtml(label) + '</small></span>';
  }

  function memoryTabButton(value, label) {
    return '<button class="memory-tab ' + (state.memoryTab === value ? "is-active" : "") + '" type="button" role="tab" aria-selected="' + (state.memoryTab === value ? "true" : "false") + '" data-memory-tab="' + value + '">' + label + '</button>';
  }

  function memoryContentMarkup(pendingCandidates) {
    if (!state.memoryLoaded || state.memoryLoading) {
      return '<section class="memory-state-panel"><strong>正在整理你的学习偏好…</strong><span>只读取当前档案</span></section>';
    }
    if (state.memoryError) {
      return '<section class="memory-state-panel is-error"><strong>学习偏好暂时无法读取</strong><span>' + escapeHtml(state.memoryError) + '</span><button class="primary-btn" id="retry-memory" type="button">重试</button></section>';
    }
    if (state.memoryTab === "preferences") return preferenceMemoryMarkup();
    if (state.memoryTab === "interests") return '<p class="memory-section-note">这些设置影响发现页推荐。答错或近期打开过的内容不会自动变成兴趣。</p>' + preferenceMemoryMarkup("interests") +
      (state.memoryPreferences.some(function (item) { return item.category === "unit_exclusion"; }) ? '<h2 class="memory-subtitle">不再推荐的知识点</h2>' + exclusionMemoryMarkup() : '');
    if (state.memoryTab === "records") return '<p class="memory-section-note">复习结果和近期活动是记录，不是长期偏好。</p><div class="memory-record-switch" aria-label="学习记录类型">' +
      [['concepts', '复习结果'], ['recent', '近期活动']].map(function (entry) { return '<button class="pill-btn" type="button" data-memory-record="' + entry[0] + '" aria-pressed="' + (state.memoryRecordTab === entry[0]) + '">' + entry[1] + '</button>'; }).join('') + '</div>' +
      (state.memoryRecordTab === "recent" ? recentMemoryMarkup() : conceptMemoryMarkup());
    return candidateMemoryMarkup(pendingCandidates);
  }

  function candidateMemoryMarkup(candidates) {
    if (!candidates.length) return emptyPanel("现在没有待确认候选。系统推断不会在你不知情时变成长期记忆。");
    return '<div class="memory-list">' + candidates.map(function (candidate) {
      const evidenceNeed = Math.max(0, 2 - candidate.evidence.length);
      const disabledReason = evidenceNeed
        ? "还需 " + evidenceNeed + " 条证据"
        : candidate.confidence < 0.7 ? "置信度待提高" : "";
      return '<article class="memory-candidate ' + (candidate.eligibleForConfirmation ? "" : "is-waiting") + '">' +
        '<div class="memory-card-top"><span class="card-pill">' + escapeHtml(preferenceCategoryLabel(candidate.category)) + '候选</span><span class="memory-confidence">置信度 ' + Math.round(candidate.confidence * 100) + '%</span></div>' +
        '<h2>' + escapeHtml(candidate.value) + '</h2>' +
        '<div class="candidate-evidence"><div class="memory-card-top"><span class="detail-label">支撑证据</span><span class="card-pill">' + candidate.evidence.length + ' 条</span></div>' +
          candidate.evidence.slice(0, 2).map(function (evidence) {
            return '<div class="candidate-evidence-row"><strong>' + escapeHtml(evidence.summary) + '</strong><span>' + escapeHtml(memoryEvidenceLabel(evidence.sourceType)) + ' · ' + escapeHtml(formatMemoryTime(evidence.observedAt)) + '</span></div>';
          }).join("") +
        '</div>' +
        '<div class="candidate-actions"><button class="ghost-btn is-danger" type="button" data-ignore-candidate="' + escapeAttr(candidate.id) + '">忽略</button><button class="primary-btn" type="button" data-confirm-candidate="' + escapeAttr(candidate.id) + '" ' + (candidate.eligibleForConfirmation ? "" : "disabled") + '>' + (disabledReason || "确认记住") + '</button></div>' +
        '<button class="memory-detail-action" type="button" data-candidate-evidence="' + escapeAttr(candidate.id) + '">查看详细证据</button>' +
      '</article>';
    }).join("") + '</div>';
  }

  function preferenceScopeLabel(memory) {
    if (memory.scope?.type === "unit") return "知识点「" + (state.cards.find(function (card) { return card.learningUnitId === memory.scope.unitId; })?.title || memory.topicLabel || memory.value) + "」";
    if (memory.scope?.type === "topic") return "主题「" + (memory.topicLabel || memory.value) + "」";
    return "所有主题";
  }

  function preferenceImpactLabel(memory) {
    if (["topic_interest", "topic_downrank", "unit_exclusion"].includes(memory.category)) return "影响发现页推荐";
    if (memory.category === "difficulty_preference") return "用于发现推荐、制卡和伴学的内容深度";
    if (memory.category === "self_familiarity") return "自述学习起点，不代表实际掌握";
    return "用于制卡和伴学的讲解表达";
  }

  function preferenceValueLabel(memory) {
    return memory.category === "difficulty_preference" ? ({ foundational: "基础一些", balanced: "难度适中", advanced: "进阶一些" }[memory.value] || memory.value) : memory.value;
  }

  function preferenceMemoryMarkup(group) {
    const preferences = state.memoryPreferences.filter(function (memory) { return memory.category !== "unit_exclusion" && (["topic_interest", "topic_downrank"].includes(memory.category) === (group === "interests")); });
    if (!preferences.length) return emptyPanel(group === "interests" ? "还没有兴趣设置，可以先选几个想学的方向。" : "还没有难度或表达偏好，可以先设置内容难度或讲解方式。");
    return '<div class="memory-list">' + preferences.map(function (memory) {
      return '<article class="preference-memory ' + (memory.enabled ? "" : "is-disabled") + '">' +
        '<div class="memory-card-top"><span class="card-pill">' + escapeHtml(preferenceCategoryLabel(memory.category)) + '</span><span class="memory-status">' + (memory.enabled ? "已启用" : "已停用") + '</span></div>' +
        '<h2>' + escapeHtml(preferenceValueLabel(memory)) + '</h2>' +
        '<p class="preference-scope">适用于：' + escapeHtml(preferenceScopeLabel(memory)) + '</p><p class="preference-impact">' + escapeHtml(preferenceImpactLabel(memory)) + '</p>' +
        '<p>' + (memory.source === "user_confirmed_candidate" ? "由你确认的候选记忆" : "由你明确添加") + '</p>' +
        '<div class="preference-actions"><button class="secondary-btn" type="button" data-edit-preference="' + escapeAttr(memory.id) + '">编辑</button><button class="secondary-btn" type="button" data-toggle-preference="' + escapeAttr(memory.id) + '">' + (memory.enabled ? "停用" : "启用") + '</button><button class="ghost-btn is-danger" type="button" data-delete-preference="' + escapeAttr(memory.id) + '">删除</button></div>' +
      '</article>';
    }).join("") + '</div>';
  }

  function exclusionMemoryMarkup() {
    const exclusions = state.memoryPreferences.filter(function (memory) { return memory.category === "unit_exclusion"; });
    if (!exclusions.length) return emptyPanel("没有持续排除的知识点。发现页中的“不再推荐这个知识点”会显示在这里。");
    return '<div class="memory-list">' + exclusions.map(function (memory) {
      return '<article class="preference-memory exclusion-memory"><div class="memory-card-top"><span class="card-pill">知识点排除</span><span class="memory-status">' + (memory.enabled ? "生效中" : "已停用") + '</span></div>' +
        '<h2>' + escapeHtml(memory.value) + '</h2><p>按学习单元识别，同义改写也不会绕过。你可以停用或撤销。</p>' +
        '<div class="preference-actions"><button class="secondary-btn" type="button" data-toggle-preference="' + escapeAttr(memory.id) + '">' + (memory.enabled ? "暂时停用" : "重新启用") + '</button><button class="ghost-btn is-danger" type="button" data-delete-preference="' + escapeAttr(memory.id) + '">撤销排除</button></div></article>';
    }).join("") + '</div>';
  }

  function recentMemoryMarkup() {
    const recent = state.memoryContext?.recentFacts || [];
    if (!recent.length) return emptyPanel("近 30 天没有推荐、打开、收藏或练习记录。这些事实不会自动变成长期兴趣。");
    return '<div class="memory-recent-head"><div><strong>近 30 天上下文</strong><span>仅用于近期推荐，可随时清除</span></div><button class="ghost-btn is-danger" id="clear-recent-memory" type="button">清除近期</button></div>' +
      '<div class="memory-list">' + recent.map(function (event) {
        return '<article class="recent-memory"><div class="memory-card-top"><span class="card-pill">' + escapeHtml(recentEventLabel(event.type)) + '</span><span>' + escapeHtml(formatMemoryTime(event.occurredAt)) + '</span></div><h2>' + escapeHtml(event.topicLabel || event.cardId || "一次学习操作") + '</h2><p>这是有时间范围的事实记录，不代表长期喜欢或已经掌握。</p></article>';
      }).join("") + '</div>';
  }

  function conceptMemoryMarkup() {
    if (!state.memoryConcepts.length) return emptyPanel("完成一次复习后，这里会出现可追溯的学习证据。旧卡分数只标作历史状态。");
    return '<div class="memory-list">' + state.memoryConcepts.map(function (concept) {
      const score = concept.accuracyRate === null ? 0 : Math.round(concept.accuracyRate * 100);
      return '<article class="concept-memory">' +
        '<div class="memory-card-top"><span class="card-pill">' + escapeHtml(learningEvidenceLabel(concept)) + '</span><strong>' + (concept.accuracyRate === null ? "状态未知" : "答对 " + score + "%") + '</strong></div>' +
        '<h2>' + escapeHtml(concept.label) + '</h2>' +
        '<div class="mastery-track"><span class="mastery-fill" style="width:' + score + '%"></span></div>' +
        '<p>' + (concept.evidenceKind === "observed_review" ? '练习 ' + concept.reviewCount + ' 次 · 答对 ' + concept.correctCount + ' · 答错 ' + concept.incorrectCount : '旧卡历史分数 ' + (concept.legacyScore === null ? "未知" : concept.legacyScore) + ' · 不视为精确能力') + '</p>' +
        '<button class="memory-detail-action" type="button" data-concept-detail="' + escapeAttr(concept.conceptId) + '">查看学习证据</button>' +
      '</article>';
    }).join("") + '</div>';
  }

  function bindMemoryActions() {
    document.querySelectorAll("[data-confirm-candidate]").forEach(function (button) {
      button.addEventListener("click", function () { void confirmCandidateMemory(button.dataset.confirmCandidate); });
    });
    document.querySelectorAll("[data-ignore-candidate]").forEach(function (button) {
      button.addEventListener("click", function () { void ignoreCandidateMemory(button.dataset.ignoreCandidate); });
    });
    document.querySelectorAll("[data-candidate-evidence]").forEach(function (button) {
      button.addEventListener("click", function () { openCandidateEvidence(button.dataset.candidateEvidence); });
    });
    document.querySelectorAll("[data-edit-preference]").forEach(function (button) {
      button.addEventListener("click", function () { openPreferenceEditor(button.dataset.editPreference); });
    });
    document.querySelectorAll("[data-toggle-preference]").forEach(function (button) {
      button.addEventListener("click", function () { void togglePreferenceMemory(button.dataset.togglePreference); });
    });
    document.querySelectorAll("[data-delete-preference]").forEach(function (button) {
      button.addEventListener("click", function () { void deletePreferenceMemory(button.dataset.deletePreference); });
    });
    document.querySelectorAll("[data-concept-detail]").forEach(function (button) {
      button.addEventListener("click", function () { openConceptCalculation(button.dataset.conceptDetail); });
    });
    const clearRecent = document.getElementById("clear-recent-memory");
    if (clearRecent) clearRecent.addEventListener("click", function () { void clearRecentMemory(); });
  }

  async function loadMemoryData(silent) {
    if (!silent) {
      state.memoryLoading = true;
      state.memoryError = "";
      if (state.view === "memory") renderMemory();
    }
    try {
      const results = await Promise.all([
        agentApi.listConceptMasteries(),
        agentApi.listPreferenceMemories(),
        agentApi.listMemoryCandidates(),
        agentApi.getLearningContext({ mode: "recommendation" })
      ]);
      state.memoryConcepts = Array.isArray(results[0].concepts) ? results[0].concepts : [];
      state.memoryPreferences = Array.isArray(results[1].memories) ? results[1].memories : [];
      state.memoryCandidates = Array.isArray(results[2].candidates) ? results[2].candidates : [];
      state.memoryContext = results[3].context || null;
      state.memoryLoaded = true;
      state.memoryError = "";
    } catch (error) {
      state.memoryLoaded = true;
      state.memoryError = error.message || "无法读取扩展学习数据";
    } finally {
      state.memoryLoading = false;
      if (state.view === "memory") renderMemory();
    }
  }

  async function confirmCandidateMemory(candidateId) {
    if (!candidateId) return;
    showLoader("正在确认候选记忆");
    try {
      await agentApi.confirmMemoryCandidate(candidateId, nextMutationId());
      invalidateLocalDiscoveryPools();
      await loadMemoryData(true);
      state.memoryTab = "preferences";
      toast("已记住，可随时编辑或停用");
      renderMemory();
    } catch (error) {
      toast(error.message || "候选确认失败");
    } finally {
      hideLoader();
    }
  }

  async function ignoreCandidateMemory(candidateId) {
    if (!candidateId || !confirm("忽略这条候选记忆？它不会成为长期记忆。")) return;
    showLoader("正在忽略候选记忆");
    try {
      await agentApi.ignoreMemoryCandidate(candidateId, nextMutationId());
      await loadMemoryData(true);
      toast("已忽略候选");
    } catch (error) {
      toast(error.message || "候选忽略失败");
    } finally {
      hideLoader();
    }
  }

  function openCandidateEvidence(candidateId) {
    const candidate = state.memoryCandidates.find(function (item) { return item.id === candidateId; });
    if (!candidate) return;
    modalContent.innerHTML =
      '<p class="eyebrow">待确认候选 · 尚未生效</p><h2 class="modal-title">' + escapeHtml(candidate.value) + '</h2>' +
      '<div class="memory-modal-meta"><span>置信度 ' + Math.round(candidate.confidence * 100) + '%</span><span>' + candidate.evidence.length + ' 条证据</span></div>' +
      '<div class="memory-modal-evidence">' + candidate.evidence.map(function (evidence) {
        return '<div class="candidate-evidence-row"><strong>' + escapeHtml(evidence.summary) + '</strong><span>' + escapeHtml(memoryEvidenceLabel(evidence.sourceType)) + ' · ' + escapeHtml(formatMemoryTime(evidence.observedAt)) + '</span></div>';
      }).join("") + '</div>' +
      '<p class="privacy-note">达到证据门槛只代表可以确认，不会自动写入长期偏好。</p>' +
      '<div class="modal-actions"><button class="primary-btn" id="memory-modal-close" type="button">完成</button></div>';
    openModal();
    document.getElementById("memory-modal-close").addEventListener("click", closeModal);
  }

  function openPreferenceEditor(memoryId) {
    const memory = state.memoryPreferences.find(function (item) { return item.id === memoryId; });
    if (!memory) return;
    modalContent.innerHTML =
      '<p class="eyebrow">' + escapeHtml(preferenceCategoryLabel(memory.category)) + '</p><h2 class="modal-title">编辑偏好</h2>' +
      '<p class="privacy-note">适用于：' + escapeHtml(preferenceScopeLabel(memory)) + ' · ' + escapeHtml(preferenceImpactLabel(memory)) + '</p>' +
      '<div class="form-section"><label class="field-label" for="preference-value">偏好内容</label>' + (memory.category === "difficulty_preference" ? '<select class="form-input" id="preference-value">' +
        [['foundational', '基础一些'], ['balanced', '难度适中'], ['advanced', '进阶一些']].map(function (entry) { return '<option value="' + entry[0] + '" ' + (memory.value === entry[0] ? 'selected' : '') + '>' + entry[1] + '</option>'; }).join('') + '</select>' :
        '<textarea class="feed-input memory-editor" id="preference-value" maxlength="240">' + escapeHtml(memory.value) + '</textarea>') + '</div>' +
      '<div class="modal-actions"><button class="secondary-btn" id="preference-cancel" type="button">取消</button><button class="primary-btn" id="preference-save" type="button">保存</button></div>';
    openModal();
    document.getElementById("preference-cancel").addEventListener("click", closeModal);
    document.getElementById("preference-save").addEventListener("click", async function () {
      const value = document.getElementById("preference-value").value.trim();
      if (!value) return toast("偏好内容不能为空");
      try {
        await agentApi.updatePreferenceMemory(memory.id, { mutationId: nextMutationId(), value: value });
        invalidateLocalDiscoveryPools();
        closeModal();
        await loadMemoryData(true);
        toast("偏好已更新");
      } catch (error) {
        toast(error.message || "偏好更新失败");
      }
    });
  }

  function openPreferenceCreator() {
    const presets = [
      ["先举例，再解释", "先给一个具体例子，再解释概念和原理。"],
      ["简短直接", "先说重点，用简短清楚的语言讲解。"],
      ["分步骤讲", "把复杂内容拆成步骤，每次讲清楚一步。"],
      ["多问我问题", "通过提问引导我思考，先别直接给出答案。"]
    ];
    modalContent.innerHTML =
      '<form id="preference-create-form" class="preference-creator"><p class="eyebrow">让学习内容更适合你</p><h2 class="modal-title">设置学习偏好</h2><p class="preference-form-intro">选择内容难度或讲解方式，再设置适用主题。</p>' +
      '<fieldset class="preference-choice-group"><legend>想调整什么</legend><div class="preference-type-options">' +
        '<label><input type="radio" name="preference-category" value="learning_format" checked><span><strong>讲解方式</strong><small>怎么讲 · 例子与步骤</small></span></label>' +
        '<label><input type="radio" name="preference-category" value="difficulty_preference"><span><strong>内容难度</strong><small>学多深 · 入门到进阶</small></span></label></div></fieldset>' +
      '<div id="preference-text-row"><div class="preference-presets" role="group" aria-label="常用讲解方式">' + presets.map(function (item, index) { return '<button type="button" data-preference-preset="' + index + '" aria-pressed="false">' + item[0] + '</button>'; }).join('') + '</div>' +
      '<label class="field-label" for="preference-new-value">你的偏好</label><textarea class="form-input" id="preference-new-value" maxlength="240" rows="3" placeholder="例如：先用生活中的例子，再讲抽象概念" required></textarea><span class="preference-character-count" id="preference-character-count">0 / 240</span></div>' +
      '<div id="preference-difficulty-row" hidden><label class="field-label" for="preference-difficulty">难度</label><select class="form-input" id="preference-difficulty"><option value="foundational">基础一些 · 建立基础概念</option><option value="balanced" selected>难度适中 · 概念与应用兼顾</option><option value="advanced">进阶一些 · 深入原理与边界</option></select><p class="preference-field-note">选择你希望的内容深度，从基础概念到原理与应用边界。</p></div>' +
      '<fieldset class="preference-choice-group"><legend>适用于哪里</legend><div class="preference-scope-options"><label><input type="radio" name="preference-scope" value="global" checked><span>所有主题</span></label><label><input type="radio" name="preference-scope" value="topic"><span>指定主题</span></label></div></fieldset>' +
      '<div id="preference-topic-row" hidden><label class="field-label" for="preference-topic">主题名称</label><input class="form-input" id="preference-topic" maxlength="120" placeholder="例如：摄影、缓存、行为经济学"></div>' +
      '<output class="preference-preview" id="preference-preview" aria-live="polite"></output><p class="preference-existing" id="preference-existing" hidden></p><p class="preference-form-error" id="preference-create-error" role="alert" hidden></p>' +
      '<div class="modal-actions"><button class="secondary-btn" id="preference-create-cancel" type="button">取消</button><button class="primary-btn" id="preference-create-save" type="submit" disabled>保存偏好</button></div></form>';
    const form = document.getElementById("preference-create-form");
    const textInput = document.getElementById("preference-new-value"), topicInput = document.getElementById("preference-topic");
    const save = document.getElementById("preference-create-save"), failure = document.getElementById("preference-create-error");
    let mutationId = "", lastPayload = "", saving = false;
    function selected(name) { return form.querySelector('input[name="' + name + '"]:checked').value; }
    function updateFields() {
      const difficulty = selected("preference-category") === "difficulty_preference", scoped = selected("preference-scope") === "topic";
      form.querySelector("#preference-difficulty-row").hidden = !difficulty;
      form.querySelector("#preference-text-row").hidden = difficulty;
      form.querySelector("#preference-topic-row").hidden = !scoped;
      textInput.required = !difficulty; topicInput.required = scoped;
      form.querySelector("#preference-character-count").textContent = textInput.value.length + " / 240";
      form.querySelectorAll('[data-preference-preset]').forEach(function (button) { button.setAttribute('aria-pressed', String(textInput.value === presets[Number(button.dataset.preferencePreset)][1])); });
      const valid = (difficulty || Boolean(textInput.value.trim())) && (!scoped || Boolean(topicInput.value.trim()));
      save.disabled = saving || !valid;
      const scopeText = scoped ? topicInput.value.trim() ? '主题「' + topicInput.value.trim() + '」' : '指定主题（请填写名称）' : '所有主题';
      form.querySelector("#preference-preview").textContent = '保存后适用于：' + scopeText + '。' + (difficulty ? '用于发现推荐、制卡和伴学的内容深度。' : '用于制卡和伴学的讲解表达。');
      const schema = window.KnowledgeGachaKnowledgeSchema;
      const topicId = scoped ? schema.topicId(schema.topicLabel(topicInput.value)) : null;
      const existing = state.memoryPreferences.find(function (item) {
        return item.category === selected("preference-category") && (scoped ? item.scope?.type === 'topic' && item.scope.topicId === topicId : !item.scope || item.scope.type === 'global');
      });
      const notice = form.querySelector('#preference-existing');
      notice.hidden = !existing;
      notice.textContent = existing ? '这个范围已有设置：' + preferenceValueLabel(existing) + '。保存会更新' + (existing.enabled === false ? '并启用' : '') + '这条设置。' : '';
      if (!saving) save.textContent = existing ? '更新偏好' : '保存偏好';
    }
    form.addEventListener("input", updateFields);
    form.addEventListener("change", updateFields);
    form.querySelectorAll('[data-preference-preset]').forEach(function (button) { button.addEventListener('click', function () { textInput.value = presets[Number(button.dataset.preferencePreset)][1]; updateFields(); textInput.focus(); }); });
    updateFields();
    document.getElementById("preference-create-cancel").addEventListener("click", closeModal);
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (saving || save.disabled || !form.reportValidity()) return;
      const type = selected("preference-category"), scoped = selected("preference-scope") === "topic";
      const topic = scoped ? topicInput.value.trim() : '';
      const value = type === "difficulty_preference" ? form.querySelector("#preference-difficulty").value : textInput.value.trim();
      const payload = JSON.stringify([type, value, scoped, topic]);
      if (payload !== lastPayload) { mutationId = nextMutationId(); lastPayload = payload; }
      saving = true; failure.hidden = true;
      form.querySelectorAll('input, textarea, select, button').forEach(function (control) { control.disabled = true; });
      save.textContent = '正在保存…';
      try {
        await agentApi.createPreferenceMemory({ category: type, value: value, topicLabel: topic || undefined,
          scope: scoped ? { type: "topic" } : { type: "global" }, mutationId: mutationId });
        invalidateLocalDiscoveryPools();
        if (modalContent.contains(form)) closeModal();
        state.memoryTab = "preferences";
        await loadMemoryData(true);
        toast("偏好已生效");
      } catch (error) {
        failure.textContent = error.message || "偏好保存失败，请重试"; failure.hidden = false;
      } finally {
        saving = false;
        form.querySelectorAll('input, textarea, select, button').forEach(function (control) { control.disabled = false; });
        save.textContent = '保存偏好'; updateFields();
      }
    });
    openModal();
  }

  async function clearRecentMemory() {
    if (!confirm("清除近 30 天的推荐上下文？长期偏好和复习记录会保留。")) return;
    showLoader("正在清除近期推荐记录");
    try {
      await agentApi.clearRecentLearningContext({ mutationId: nextMutationId() });
      invalidateLocalDiscoveryPools();
      await loadMemoryData(true);
      toast("近期推荐记录已清除");
    } catch (error) {
      toast(error.message || "近期记录清除失败");
    } finally {
      hideLoader();
    }
  }

  async function togglePreferenceMemory(memoryId) {
    const memory = state.memoryPreferences.find(function (item) { return item.id === memoryId; });
    if (!memory) return;
    showLoader(memory.enabled ? "正在停用偏好" : "正在启用偏好");
    try {
      await agentApi.updatePreferenceMemory(memory.id, { mutationId: nextMutationId(), enabled: !memory.enabled });
      invalidateLocalDiscoveryPools();
      await loadMemoryData(true);
      toast(memory.enabled ? "偏好已停用" : "偏好已启用");
    } catch (error) {
      toast(error.message || "偏好状态更新失败");
    } finally {
      hideLoader();
    }
  }

  async function deletePreferenceMemory(memoryId) {
    const memory = state.memoryPreferences.find(function (item) { return item.id === memoryId; });
    if (!memory || !confirm("删除这条长期偏好？删除后不会再用于后续学习。")) return;
    showLoader("正在删除偏好");
    try {
      await agentApi.deletePreferenceMemory(memory.id, nextMutationId());
      invalidateLocalDiscoveryPools();
      await loadMemoryData(true);
      toast("偏好已删除");
    } catch (error) {
      toast(error.message || "偏好删除失败");
    } finally {
      hideLoader();
    }
  }

  function openConceptCalculation(conceptId) {
    const concept = state.memoryConcepts.find(function (item) { return item.conceptId === conceptId; });
    if (!concept) return;
    modalContent.innerHTML =
      '<p class="eyebrow">学习证据 · ' + escapeHtml(concept.calculationVersion || "历史状态") + '</p><h2 class="modal-title">' + escapeHtml(concept.label) + '</h2>' +
      '<div class="memory-modal-meta"><span>' + escapeHtml(learningEvidenceLabel(concept)) + '</span><span>' + (concept.accuracyRate === null ? "能力未知" : "答对 " + Math.round(concept.accuracyRate * 100) + "%") + '</span></div>' +
      '<div class="memory-calculation-grid"><span>练习次数<strong>' + concept.reviewCount + '</strong></span><span>答错次数<strong>' + concept.incorrectCount + '</strong></span><span>使用提示<strong>' + (concept.hintUsedCount || 0) + '</strong></span><span>错因<strong>' + escapeHtml(concept.errorCause === "unknown" ? "未知" : concept.errorCause) + '</strong></span></div>' +
      '<p class="privacy-note">练习证据来自不可变复习事件。单次答错不代表不喜欢；旧卡分数只作为历史状态，不能直接断言已经掌握。</p>' +
      '<div class="modal-actions"><button class="primary-btn" id="memory-modal-close" type="button">完成</button></div>';
    openModal();
    document.getElementById("memory-modal-close").addEventListener("click", closeModal);
  }

  function preferenceCategoryLabel(category) {
    return {
      topic_interest: "主题兴趣",
      topic_downrank: "主题降权",
      unit_exclusion: "知识点排除",
      difficulty_preference: "内容难度",
      learning_format: "讲解方式",
      self_familiarity: "自报熟悉",
      custom: "自定义"
    }[category] || "学习偏好";
  }

  function memoryEvidenceLabel(sourceType) {
    return sourceType === "review_event" ? "复习行为" : "助手整理";
  }

  function masteryLevelLabel(level) {
    return {
      needs_review: "需要复习",
      developing: "正在形成",
      familiar: "比较熟悉",
      mastered: "已经掌握"
    }[level] || "待计算";
  }

  function learningEvidenceLabel(concept) {
    if (concept.evidenceKind === "legacy_card_state") return "旧卡历史状态";
    return { limited_evidence: "证据较少", recently_successful: "近期答题较稳", mixed_evidence: "答题表现混合", needs_support: "需要继续巩固" }[concept.evidenceState] || "练习证据";
  }

  function recentEventLabel(type) {
    return {
      recommendation_exposure: "推荐曝光", discovery_opened: "打开推荐", card_saved: "收下卡片", card_opened: "打开卡片",
      card_favorited: "收藏卡片", card_unfavorited: "取消收藏", review_answered: "完成练习", explicit_feedback: "明确反馈"
    }[type] || "近期操作";
  }

  function formatMemoryTime(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return date.getFullYear() + "/" + (date.getMonth() + 1) + "/" + date.getDate();
  }

  async function generateFromFeed() {
    if (state.captureBusy || state.manualInputCollapsed) return;
    if (materialIndex.needsPlan({ text: state.feedText, blocks: state.feedBlocks })) { await startKnowledgePlanFromFeed(); return; }
    const rawText = state.feedText.trim();
    if (!rawText && !state.feedImage) {
      toast("先投喂文字或图片");
      return;
    }
    const material = gachaSourceMaterial();
    const materialKey = gachaSourceMaterialKey(material);
    let sourceCheck = state.sourceCheckKey === materialKey ? state.sourceCheck : null;
    if (!sourceCheck) sourceCheck = await loadGachaSourceCheck();
    if (!sourceCheck) {
      toast(state.sourceCheckError || "资料核对没有完成，请重试");
      return;
    }
    if (sourceCheck.requiresDuplicateDecision && !state.sourceDuplicateAction) {
      toast("发现相似卡，请先选择合并、仍然新建或放弃");
      if (state.view === "feed") renderFeed();
      return;
    }
    if (!isModelConfigured()) {
      toast("资料已经核对，请先配置 Base URL、API Key 和 Model 再制卡");
      setView("model");
      return;
    }
    showLoader(state.feedImage ? "正在识别图片并制作扭蛋" : "正在凝练这颗知识扭蛋");
    try {
      const response = await agentApi.createGachaCardDraft({
        materialDraftId: state.materialDraftId,
        text: material.text,
        blocks: material.blocks,
        userGoal: material.userGoal,
        allowSupplemental: material.allowSupplemental,
        image: material.image,
        source: material.source,
        sourcePlan: {
          checkId: sourceCheck.id,
          duplicateAction: state.sourceDuplicateAction || "create_new",
          targetCardId: state.sourceDuplicateAction === "merge" ? state.sourceDuplicateTargetId : null,
          saveFullSource: Boolean(state.saveFullSource && material.text),
          saveOriginal: state.saveOriginalFile
        }
      });
      if (response.session.status === 'needs_split') {
        hideLoader();
        await startKnowledgePlanFromFeed({ materialDraftId: response.session.id, candidates: response.session.candidates || [] });
        return;
      }
      state.gachaDrafts = [response.session].concat(state.gachaDrafts.filter(function (item) { return item.id !== response.session.id && item.id !== state.materialDraftId; }));
      state.feedText = "";
      state.feedImage = null;
      state.captureSource = null;
      resetSourceProductState();
      state.currentDrawnId = "";
      state.currentDraftId = "";
      const requestFailed = response.session.generation && response.session.generation.calls.some(function (call) { return call.error; });
      state.connectionStatus = requestFailed ? "error" : "ready";
      state.connectionMessage = requestFailed ? "模型请求未完成，请检查连接后重试。" : "模型请求已结束：" + response.session.model;
      state.feedGoal = "";
      toast(response.session.status === "ready" ? "知识卡已装进扭蛋" : "草稿需要处理，材料已保留");
      setView("draw");
      if (response.session.status !== "ready") { state.currentDraftId = response.session.id; renderDraw(); }
    } catch (error) {
      state.connectionStatus = "error";
      state.connectionMessage = "制卡失败：" + error.message;
      toast("制卡没有完成，素材仍为你保留");
      if (state.view === "feed") renderFeed();
    } finally {
      hideLoader();
    }
  }

  async function testConnection() {
    const status = document.getElementById("settings-status");
    status.textContent = "正在保存并测试连接...";
    try {
      saveModelSettingsFromForm();
      const result = await agentApi.testModelConnection();
      state.connectionStatus = "ready";
      state.connectionMessage = "连接成功，扭蛋机将使用：" + result.provider.model;
    } catch (error) {
      state.connectionStatus = "error";
      state.connectionMessage = "测试失败：" + error.message;
    } finally {
      if (state.view === "model") renderModelSettings();
    }
  }

  function isModelConfigured() {
    return Boolean(state.aiConfig.baseUrl && state.aiConfig.model && state.aiConfig.apiKey);
  }

  function saveModelSettingsFromForm() {
    const baseUrl = document.getElementById("model-base-url").value.trim();
    const model = document.getElementById("model-name").value.trim();
    const enteredApiKey = document.getElementById("model-api-key").value.trim();
    const rememberApiKey = document.getElementById("remember-api-key").checked;
    const normalized = window.KnowledgeGachaProviderTransport.normalizeModelConfig({
      baseUrl: baseUrl,
      model: model,
      apiKey: enteredApiKey || state.aiConfig.apiKey
    });
    const next = Object.assign({}, normalized, { temperature: state.aiConfig.temperature });
    storage.saveSettings({ baseUrl: next.baseUrl, model: next.model, temperature: next.temperature, reducedMotion: state.reducedMotion });
    storage.saveApiKey(next.apiKey, rememberApiKey);
    state.aiConfig = Object.assign({}, next, { rememberApiKey: rememberApiKey });
    state.connectionStatus = "unknown";
    return next;
  }

  function toggleApiKeyVisibility() {
    const input = document.getElementById("model-api-key");
    const button = document.getElementById("toggle-api-key");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    button.setAttribute("aria-label", visible ? "显示 API Key" : "隐藏 API Key");
    input.focus();
  }

  function clearModelApiKey() {
    storage.clearApiKey();
    state.aiConfig.apiKey = "";
    state.aiConfig.rememberApiKey = false;
    state.connectionStatus = "unknown";
    state.connectionMessage = "API Key 已清除。";
    renderModelSettings();
  }

  function openCard(cardId) {
    let card = getCard(cardId);
    if (!card) return;
    void agentApi.recordLearningEvent({
      eventId: nextMutationId(), type: "card_opened", cardId: card.id,
      learningUnitId: card.learningUnitId, topicId: card.topicId, topicLabel: card.title
    }).catch(function () {});
    let plain = false;
    function renderDetail() {
      card = getCard(cardId);
      if (!card) { closeModal(); return; }
      const summary = plain && card.plainSummary ? card.plainSummary : card.summary;
      modalContent.innerHTML =
        '<p class="eyebrow">' + (card.favorite ? "已收藏" : "Knowledge Card") + '</p>' +
        '<h2 class="modal-title">' + escapeHtml(card.title) + '</h2>' +
        '<div class="detail-block"><div class="detail-top"><span class="card-pill">熟练度 ' + (card.mastery || 0) + '</span><span class="card-pill">复习 ' + (card.reviewCount || 0) + '</span></div></div>' +
        teachingMarkup(card, summary) + exerciseMarkup(cardExercise(card)) +
        cardSourcesMarkup(card) +
        '<button class="secondary-btn companion-material-entry" id="card-companion" type="button">和伴学讨论这张卡</button>' +
        '<div class="modal-actions"><button class="secondary-btn" id="plain-card" type="button">' + (plain ? "原内容" : "说人话") + '</button><button class="secondary-btn" id="favorite-card" type="button">' + (card.favorite ? "取消收藏" : "收藏") + '</button><button class="primary-btn is-danger" id="delete-card" type="button">删除</button></div>';
      document.getElementById("plain-card").addEventListener("click", function () { plain = !plain; renderDetail(); });
      document.getElementById("card-companion").addEventListener("click", function () {
        closeModal(); void companionUI.open({ context: { kind: "card", cardId: card.id } }).catch(function (error) { toast(error.message); });
      });
      document.getElementById("favorite-card").addEventListener("click", function (event) { void toggleCardFavorite(card, event.currentTarget, function () { renderDetail(); render(); }); });
      document.getElementById("delete-card").addEventListener("click", function () { showDeleteCards([card.id]); });
      bindCitationButtons(modalContent, card, renderDetail);
    }
    renderDetail();
    openModal();
  }

  async function openReviewGacha(cardId, exerciseId) {
    if (state.reviewLoading) return;
    state.reviewLoading = true;
    state.reviewError = "";
    renderReview();
    try {
      const response = await agentApi.openGachaReview(cardId, exerciseId ? { exerciseId: exerciseId } : undefined);
      state.reviewOverview = response.review;
      state.reviewQuestion = response.question;
      state.reviewFeedback = null;
      state.reviewHint = response.question.savedHint || "";
      state.reviewAnswer = response.question.revealedAnswer || null;
      state.reviewRecallResponse = response.question.savedResponse || "";
      state.reviewCardId = "";
      state.reviewOrder = [];
      state.reviewStartedAt = Date.now();
    } catch (error) {
      state.reviewError = error.message || "这颗复习扭蛋暂时无法打开";
      toast(state.reviewError);
      await loadGachaReview(false);
    } finally {
      state.reviewLoading = false;
      if (state.view === "review") renderReview();
    }
  }

  async function answerReview(cardId, chosenIndex) {
    const question = state.reviewQuestion;
    if (state.reviewSubmitting || state.reviewFeedback || !question) return;
    state.reviewSubmitting = true;
    state.reviewError = "";
    renderReview();
    try {
      const response = await agentApi.answerGachaReview(cardId, {
        mutationId: nextMutationId(),
        attemptId: question.attemptId,
        chosenIndex: question.type === "recall" ? undefined : chosenIndex,
        selfAssessedCorrect: question.type === "recall" ? chosenIndex : undefined,
        responseText: question.type === "recall" ? state.reviewRecallResponse : undefined,
        durationMs: state.reviewStartedAt ? Math.max(0, Date.now() - state.reviewStartedAt) : null,
        exerciseId: question.exerciseId,
        exerciseVersion: question.exerciseVersion
      });
      if (state.reviewQuestion?.attemptId === question.attemptId) {
        state.reviewFeedback = response.feedback;
        state.reviewStartedAt = 0;
      }
      state.reviewOverview = response.next;
      state.reviewDay = {
        day: localDayKey(),
        answered: response.feedback.dailyAnswered,
        completed: response.feedback.dailyCompleted,
        continueAfterGoal: response.next.continuingAfterGoal === true,
        lastLearningUnitId: question.learningUnitId || null
      };
      try {
        const learning = await agentApi.loadLearningState();
        applyLearningState(learning.state);
        storage.markSyncClean();
      } catch (syncError) {
        state.agentConnectionMessage = "复习结果已记录，但卡册快照暂未刷新：" + syncError.message;
      }
    } catch (error) {
      state.reviewError = error.message || "复习结果没有记录，请重试";
      toast(state.reviewError);
    } finally {
      state.reviewSubmitting = false;
      if (state.view === "review") renderReview();
      if (state.view === "home") renderHome();
    }
  }

  async function loadReviewHint(cardId) {
    const question = state.reviewQuestion;
    if (state.reviewSubmitting || !question) return;
    state.reviewSubmitting = true;
    renderReview();
    try {
      const response = await agentApi.getGachaReviewHint(cardId, { attemptId: question.attemptId });
      if (state.reviewQuestion?.attemptId !== question.attemptId) return;
      state.reviewHint = response.hint;
      state.reviewQuestion.hintUsed = true;
    } catch (error) {
      toast(error.message || "暂时无法读取提示");
    } finally {
      state.reviewSubmitting = false;
      if (state.view === "review") renderReview();
    }
  }

  async function revealReviewAnswer(cardId) {
    const question = state.reviewQuestion;
    if (state.reviewSubmitting || !question) return;
    const responseInput = document.getElementById("review-recall-response");
    if (responseInput) state.reviewRecallResponse = responseInput.value;
    state.reviewSubmitting = true;
    renderReview();
    try {
      const response = await agentApi.revealGachaReviewAnswer(cardId, { attemptId: question.attemptId, responseText: state.reviewRecallResponse });
      if (state.reviewQuestion?.attemptId !== question.attemptId) return;
      state.reviewAnswer = response;
      state.reviewQuestion.answerRevealed = true;
    } catch (error) {
      toast(error.message || "暂时无法展开答案");
    } finally {
      state.reviewSubmitting = false;
      if (state.view === "review") renderReview();
    }
  }

  async function setReviewGoal(value) {
    if (!Number.isInteger(value) || value < 1 || value > 20) { toast("每日目标请输入 1–20"); return; }
    state.reviewLoading = true;
    try {
      const response = await agentApi.setGachaReviewGoal({ dailyGoal: value, mutationId: nextMutationId() });
      state.reviewOverview = response.review;
      toast("每日目标已调整为 " + response.dailyGoal + " 题");
    } catch (error) {
      toast(error.message || "每日目标没有保存");
    } finally {
      state.reviewLoading = false;
      if (state.view === "review") renderReview();
    }
  }

  async function continueReviewToday() {
    if (state.reviewLoading) return;
    state.reviewLoading = true;
    try {
      const response = await agentApi.continueGachaReview({ mutationId: nextMutationId() });
      state.reviewOverview = response.review;
    } catch (error) {
      toast(error.message || "暂时无法继续复习");
    } finally {
      state.reviewLoading = false;
      if (state.view === "review") renderReview();
    }
  }

  async function deferReview(cardId, action) {
    if (state.reviewLoading || state.reviewSubmitting) return;
    state.reviewLoading = true;
    try {
      const response = await agentApi.deferGachaReview(cardId, { action: action, mutationId: nextMutationId() });
      state.reviewOverview = response.review;
      state.reviewQuestion = null;
      state.reviewFeedback = null;
      state.reviewHint = "";
      state.reviewAnswer = null;
      state.reviewRecallResponse = "";
      state.reviewCardId = "";
      state.reviewOrder = [];
      toast(action === "tomorrow" ? "已安排明天再看" : "已放到一小时后");
    } catch (error) {
      toast(error.message || "暂时无法调整这张卡");
    } finally {
      state.reviewLoading = false;
      if (state.view === "review") renderReview();
    }
  }

  async function generateReviewVariant(cardId) {
    if (state.reviewVariantLoading) return;
    state.reviewVariantLoading = true;
    renderReview();
    try {
      const response = await agentApi.createGachaReviewVariant(cardId, { mutationId: nextMutationId() });
      state.reviewVariantLoading = false;
      await openReviewGacha(cardId, response.exercise.id);
    } catch (error) {
      state.reviewVariantLoading = false;
      toast(error.message || "新题没有生成，请稍后重试");
      if (state.view === "review") renderReview();
    }
  }

  function openReviewCauseCorrection(eventId) {
    modalContent.innerHTML = '<h2 class="modal-title">纠正本次错因</h2><p class="meta">纠正会追加一条记录，原复习事件和原判分保持可回查。</p>' +
      '<div class="form-section form-grid"><div><label class="field-label" for="review-cause-type">更符合的错因</label><select class="select" id="review-cause-type"><option value="unknown">暂时无法确定</option><option value="missing_prerequisite">缺少前提</option><option value="concept_confusion">混淆概念</option><option value="step_order">步骤顺序错误</option><option value="supported_misconception">其他有依据的误区</option></select></div>' +
      '<div><label class="field-label" for="review-cause-note">补充说明（可选）</label><textarea class="feed-input" id="review-cause-note" maxlength="500" placeholder="例如：我漏看了题干中的适用条件"></textarea></div></div>' +
      '<div class="modal-actions"><button class="secondary-btn" id="review-cause-cancel" type="button">取消</button><button class="primary-btn" id="review-cause-save" type="button">追加纠正</button></div>';
    document.getElementById("review-cause-cancel").addEventListener("click", closeModal);
    document.getElementById("review-cause-save").addEventListener("click", async function () {
      const button = document.getElementById("review-cause-save");
      button.disabled = true;
      try {
        await agentApi.correctGachaReviewEvent(eventId, { errorType: document.getElementById("review-cause-type").value,
          note: document.getElementById("review-cause-note").value, mutationId: nextMutationId() });
        closeModal();
        toast("错因纠正已追加，可从事件链回查");
      } catch (error) {
        button.disabled = false;
        toast(error.message || "错因纠正没有保存");
      }
    });
    openModal();
  }

  function readImage(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!supportedTypes.includes(file.type)) {
      toast("只支持 JPG、PNG、WebP 或 GIF 图片");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast("图片不能超过 8MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      state.captureError = "";
      state.feedImage = { name: file.name, mime: file.type || "image/jpeg", dataUrl: String(reader.result || "") };
      state.feedText = "";
      state.captureSource = {
        type: "image",
        title: file.name || "本地图片",
        url: "",
        excerpt: "",
        capturedAt: Date.now()
      };
      resetSourceProductState();
      renderFeed();
      void loadGachaSourceCheck();
    };
    reader.readAsDataURL(file);
  }

  async function drawPendingCard() {
    const draft = readyDrafts()[0];
    if (draft) {
      state.currentDrawnId = "";
      state.currentDraftId = draft.id;
      renderDraw();
      return;
    }
    if (!state.pending.length || state.draftBusy) return;
    const cardId = state.pending[0].id;
    state.draftBusy = true;
    try {
      await syncQueue;
      const response = await agentApi.openPendingCard(cardId);
      applyLearningState(response.state);
      state.currentDrawnId = response.card.id;
      state.plainMode = false;
    } catch (error) { toast(error.message || "打开失败，请重试"); }
    finally { state.draftBusy = false; if (state.view === "draw") renderDraw(); }
  }

  async function confirmCurrentDraft(session) {
    if (state.draftBusy || !session.card) return;
    if (session.batchId) {
      try { await saveDraftEdits(session); await knowledgePlanUI.open(session.planId, 'batch'); await knowledgePlanUI.confirmUnits([session.unitId]); }
      catch (error) { toast(error.message); }
      return;
    }
    state.draftBusy = true;
    renderDraw();
    try {
      await syncQueue;
      if (session.status !== "confirmed") await saveDraftEdits(session);
      const response = await agentApi.confirmGachaCardDraft(session.id);
      const card = sanitizeCard(response.card);
      const existing = state.cards.findIndex(function (item) { return item.id === card.id; });
      if (existing >= 0) state.cards[existing] = card;
      else state.cards.unshift(card);
      state.gachaDrafts = state.gachaDrafts.filter(function (item) { return item.id !== session.id; });
      state.currentDraftId = "";
      state.currentDrawnId = card.id;
      state.plainMode = false;
      applyLearningState((await agentApi.loadLearningState()).state);
      storage.saveLearningStateSnapshot(currentLearningState());
      if (session.discoveryContext) {
        const discovery = await agentApi.listGachaDiscoveryPools();
        state.discoveryPools = Array.isArray(discovery.pools) ? discovery.pools : state.discoveryPools;
        state.currentDiscoveryPoolId = session.discoveryContext.poolId;
      }
      if (session.sourcePlan && session.sourcePlan.saveFullSource) void loadKnowledgeSources();
      toast(session.sourcePlan && session.sourcePlan.duplicateAction === "merge"
        ? "已补充原卡，复习安排在明天"
        : "已入册，首次复习安排在明天");
    } catch (error) {
      toast(error.message || "入册失败，草稿仍为你保留");
    } finally {
      state.draftBusy = false;
      if (state.view === "draw") renderDraw();
    }
  }

  function readyDrafts() {
    return state.gachaDrafts.filter(function (session) { return !session.batchId && session.status !== "confirmed" && session.status !== "material"; });
  }

  function bindCardTiles() {
    document.querySelectorAll("[data-card]").forEach(function (tile) {
      tile.addEventListener("click", function () {
        const id = tile.dataset.card;
        if (state.manageMode && state.view === "album") {
          if (state.selectedIds.has(id)) state.selectedIds.delete(id);
          else state.selectedIds.add(id);
          renderAlbum();
          return;
        }
        openCard(id);
      });
    });
  }

  function cardTile(card, options) {
    const settings = options || {};
    const progress = Math.max(0, Math.min(100, ((card.mastery || 0) / 5) * 100));
    return '<button class="card-tile ' + (settings.managing ? "is-managing " : "") + (settings.selected ? "is-selected" : "") + '" data-card="' + escapeAttr(card.id) + '" style="--card-color:' + escapeAttr(card.color || COLORS[0]) + '" type="button">' +
      (settings.managing ? '<span class="select-badge">' + (settings.selected ? "✓" : "") + '</span>' : "") +
      '<span class="card-topline"><span class="card-pill">知识卡</span><span class="card-pill">' + (card.favorite ? "收藏" : card.mastery ? "复习 " + card.mastery + " 次" : "未复习") + '</span></span>' +
      '<strong class="card-title">' + escapeHtml(card.title) + '</strong><span class="body-copy">' + escapeHtml(card.summary) + '</span>' +
      '<span class="mastery-track"><span class="mastery-fill" style="width:' + progress + '%"></span></span></button>';
  }

  function detailBlock(label, body, extraClass) {
    return '<div class="detail-block ' + (extraClass || "") + '"><span class="detail-label">' + escapeHtml(label) + '</span><p class="detail-copy">' + escapeHtml(body || "") + '</p></div>';
  }

  function evidenceSection(card) {
    const citations = Array.isArray(card.citations) ? card.citations : [];
    if (!citations.length && (card.visualEvidence || []).length) {
      return '<section class="evidence-section" aria-label="图片依据"><span class="detail-label">图片中的依据</span><p class="meta">模型核验的可见信息；原图未保留，不作为逐字引文。</p>' + card.visualEvidence.map(function (item) { return '<p>' + escapeHtml(item.observation) + '</p>'; }).join("") + '</section>';
    }
    if (!citations.length) return "";
    const primary = citations[0];
    return '<section class="evidence-section" aria-label="核验来源">' +
      '<div class="evidence-heading"><span class="detail-label">查看依据</span><span class="evidence-count">' + citations.length + ' 条依据</span></div>' +
      '<article class="evidence-card">' +
        '<div class="evidence-source"><strong>' + escapeHtml(primary.source.title) + '</strong><span class="evidence-path">' + escapeHtml(citationPath(primary)) + '</span></div>' +
        '<blockquote class="evidence-quote">' + escapeHtml(primary.quote) + '</blockquote>' +
        '<div class="evidence-meta"><span>' + escapeHtml(citationLocation(primary)) + '</span><button class="evidence-action" type="button" data-citation-index="0">查看依据</button></div>' +
      '</article>' +
      citations.slice(1).map(function (citation, offset) {
        return '<div class="evidence-row"><div><strong class="evidence-row-title">' + escapeHtml(citation.source.title) + '</strong><span class="evidence-row-meta">' + escapeHtml(citationPath(citation) + ' · ' + citationLocation(citation)) + '</span></div><button class="evidence-action" type="button" data-citation-index="' + (offset + 1) + '">定位</button></div>';
      }).join("") +
      '<button class="source-inline-action" data-remove-source-info type="button">移除来源信息</button>' +
    '</section>';
  }

  function sourceSnapshotSection(card) {
    const snapshot = card && card.sourceSnapshot;
    if (!snapshot || snapshot.sourceType === "discovery" || (!snapshot.excerpt && !safeHttpUrl(snapshot.url) && !snapshot.fullSourceDocumentId)) return "";
    const url = safeHttpUrl(snapshot.url);
    const available = snapshot.status === "available" && snapshot.fullSourceDocumentId;
    return '<section class="source-snapshot"><div class="evidence-heading"><span class="detail-label">卡片原文</span><span class="evidence-count">' + (available ? "已保留原文" : snapshot.status === "removed" ? "原文已移除" : snapshot.status === "unavailable" ? "原始材料未保留" : "仅保留片段") + '</span></div><strong>' + escapeHtml(snapshot.title) + '</strong><p>' + escapeHtml(snapshot.excerpt) + '</p>' +
      (available ? '<p class="meta">保留范围：' + (snapshot.selectionId ? escapeHtml(importRangeLabel(snapshot.retainedRanges)) + (snapshot.originalAvailable ? '，及整个原始文件' : '的解析文字') : snapshot.scope === "full_file_text" ? '文件全部解析文字' : snapshot.scope === "full_text" ? '已保存的全部文字' : '本次选定文字') + '</p><div class="modal-actions"><button class="secondary-btn" data-open-full-source="' + escapeAttr(snapshot.fullSourceDocumentId) + '" type="button">打开已保留原文</button><button class="source-inline-action" data-remove-full-source="' + escapeAttr(snapshot.fullSourceDocumentId) + '" type="button">移除原文附件</button></div>' : '') +
      (url ? '<a class="source-link" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">打开来源网页</a>' : '') +
      (!(card.citations || []).length ? '<button class="source-inline-action" data-remove-source-info type="button">移除来源信息</button>' : '') + '</section>';
  }

  function cardSourcesMarkup(card) {
    const content = sourceSnapshotSection(card) + evidenceSection(card);
    if (!content) return "";
    const imageOnly = !card.sourceSnapshot && !(card.citations || []).length && (card.visualEvidence || []).length;
    return '<details class="card-sources"><summary>' + (imageOnly ? "查看图片依据" : "查看原文") + '</summary><div class="card-sources-content">' + content + '</div></details>';
  }

  function bindCitationButtons(root, card, returnTo) {
    const returnToCard = returnTo || function () { closeModal(); render(); };
    root.querySelectorAll("[data-open-full-source]").forEach(function (button) {
      button.addEventListener("click", function () { void openSourceText(button.dataset.openFullSource, returnToCard); });
    });
    root.querySelectorAll("[data-remove-full-source], [data-remove-source-info]").forEach(function (button) {
      button.addEventListener("click", async function () {
        const documentId = button.dataset.removeFullSource;
        if (!confirm(documentId ? "移除这份共享原文附件？相关卡片、最小依据和复习记录会保留。" : "移除这张卡的来源信息和最小依据？卡片内容、收藏与复习记录会保留。")) return;
        try {
          await syncQueue;
          if (documentId) await agentApi.deleteDocument(documentId);
          else await agentApi.removeCardSourceInfo(card.id);
          applyLearningState((await agentApi.loadLearningState()).state);
          storage.saveLearningStateSnapshot(currentLearningState());
          await loadKnowledgeSources();
          returnToCard();
          toast(documentId ? "原文已移除，最小依据仍保留" : "来源信息已移除");
        } catch (error) { toast(error.message); }
      });
    });
    root.querySelectorAll("[data-citation-index]").forEach(function (button) {
      button.addEventListener("click", function () {
        const citation = card.citations && card.citations[Number(button.dataset.citationIndex)];
        if (citation) void openCitation(citation, returnTo);
      });
    });
  }

  async function openCitation(citation, returnTo) {
    modalContent.innerHTML = '<div class="citation-loading"><h2 class="modal-title">正在读取依据…</h2></div>';
    openModal();
    try {
      const result = await agentApi.resolveCitation(citation);
      const resolved = result.citation;
      const url = safeHttpUrl(resolved.source.sourceUrl);
      modalContent.innerHTML =
        '<p class="eyebrow">' + (result.status === "available" ? "已定位原文片段" : result.status === "removed" ? "原文已移除 · 已保留最小依据" : "仅保留最小依据") + '</p>' +
        '<h2 class="modal-title">' + escapeHtml(resolved.source.title) + '</h2>' +
        '<div class="citation-locator"><span>' + escapeHtml(citationPath(resolved)) + '</span><strong>' + escapeHtml(citationLocation(resolved)) + '</strong></div>' +
        '<div class="citation-excerpt" aria-label="原文定位">' + escapeHtml(result.excerpt.before) + '<mark>' + escapeHtml(result.excerpt.highlight) + '</mark>' + escapeHtml(result.excerpt.after) + '</div>' +
        (result.originalAvailable ? '<button class="secondary-btn" id="citation-original" type="button">' + (resolved.position.pageNumber ? '查看引用原页' : '下载原始文件') + '</button>' : resolved.position.locator ? '<p class="meta">原始文件未保留；当前可回查保存的文字依据。</p>' : '') +
        (result.documentId ? '<div class="modal-actions"><button class="secondary-btn" id="citation-full" type="button">打开已保留原文</button><button class="source-inline-action" id="citation-remove-full" type="button">移除原文附件</button></div>' : '') +
        (url ? '<a class="source-link" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">打开来源网页</a>' : '') +
        '<div class="modal-actions">' + (returnTo ? '<button class="secondary-btn" id="citation-back" type="button">返回卡片</button>' : '') + '<button class="primary-btn" id="citation-close" type="button">完成</button></div>';
      const back = document.getElementById("citation-back");
      const full = document.getElementById("citation-full");
      const originalPage = document.getElementById('citation-original');
      if (originalPage) originalPage.addEventListener('click', function () { void documentImportUI.showOriginal(result.documentId, resolved.position.pageNumber, resolved.position.locator, function () { void openCitation(citation, returnTo); }); });
      if (full) full.addEventListener("click", function () { void openSourceText(result.documentId, function () { void openCitation(citation, returnTo); }); });
      const remove = document.getElementById("citation-remove-full");
      if (remove) remove.addEventListener("click", async function () {
        if (!confirm("移除共享原文附件？卡片、最小依据和复习记录会保留。")) return;
        try {
          await syncQueue;
          await agentApi.deleteDocument(result.documentId);
          applyLearningState((await agentApi.loadLearningState()).state);
          storage.saveLearningStateSnapshot(currentLearningState());
          void openCitation(citation, returnTo);
        } catch (error) { toast(error.message); }
      });
      if (back) back.addEventListener("click", returnTo);
      document.getElementById("citation-close").addEventListener("click", closeModal);
    } catch (error) {
      modalContent.innerHTML =
        '<p class="eyebrow is-warning">引用未通过核对</p>' +
        '<h2 class="modal-title">无法定位这条原文</h2>' +
        '<p class="citation-error">' + escapeHtml(error.message || "引用来源已变化") + '</p>' +
        '<div class="modal-actions">' + (returnTo ? '<button class="secondary-btn" id="citation-back" type="button">返回卡片</button>' : '') + '<button class="primary-btn" id="citation-close" type="button">关闭</button></div>';
      const back = document.getElementById("citation-back");
      if (back) back.addEventListener("click", returnTo);
      document.getElementById("citation-close").addEventListener("click", closeModal);
    }
  }

  function citationPath(citation) {
    return citation.headingPath && citation.headingPath.length ? citation.headingPath.join(" / ") : "正文";
  }

  function citationLocation(citation) {
    const position = citation.position || {};
    const locator = position.locator;
    const method = locator?.extractionMethod === 'ocr_corrected' ? ' · 识别后校对' : locator?.extractionMethod === 'ocr' ? ' · 图片识别' : locator?.extractionMethod === 'manual' ? ' · 手动补充' : '';
    if (position.pageNumber) return "PDF 第 " + position.pageNumber + " 页" + method;
    if (locator?.tableNumber) return '表 ' + locator.tableNumber + ' · 行 ' + locator.rowNumber + ' 列 ' + locator.columnNumber + ' · 段 ' + locator.paragraphNumber;
    if (locator?.paragraphNumber) return 'DOCX 段 ' + locator.paragraphNumber;
    return "字符 " + position.startCharacter + "–" + position.endCharacter;
  }

  function safeHttpUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(String(value));
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function statTile(value, label) {
    return '<div class="stat-block"><strong>' + Number(value || 0) + '</strong><span>' + escapeHtml(label) + '</span></div>';
  }

  function filterButton(value, label) {
    return '<button class="filter-btn ' + (state.filter === value ? "is-active" : "") + '" data-filter="' + value + '" type="button">' + label + '</button>';
  }

  function emptyPanel(text, actionLabel, actionId) {
    return '<section class="empty-panel"><div><p class="empty-copy">' + escapeHtml(text) + '</p>' + (actionLabel ? '<button class="primary-btn" id="' + actionId + '" type="button">' + escapeHtml(actionLabel) + '</button>' : "") + '</div></section>';
  }

  function machineHtml() {
    return '<div class="gacha-machine" aria-hidden="true"><span class="gacha-top-cap"></span><span class="gacha-glass"><i class="capsule-ball ball-a"></i><i class="capsule-ball ball-b"></i><i class="capsule-ball ball-c"></i><i class="capsule-ball ball-d"></i></span><span class="gacha-base"><i class="gacha-slot"></i><i class="gacha-knob"></i></span><span class="gacha-feet"><span></span><span></span></span></div>';
  }

  function icon(name) {
    return '<img class="button-icon" src="./assets/icons/' + escapeAttr(name) + '.svg" alt="">';
  }

  function enableMouseDragScroll() {
    let drag = null;
    let suppressClickUntil = 0;
    const threshold = 6;

    document.addEventListener("pointerdown", function (event) {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (event.target.closest("input, textarea, select, label, [contenteditable='true'], .nav-dock")) return;
      const horizontal = event.target.closest(".sample-list, .recent-card-list");
      let vertical = event.target;
      while (vertical && !(vertical.scrollHeight > vertical.clientHeight && /auto|scroll/.test(window.getComputedStyle(vertical).overflowY))) {
        vertical = vertical.parentElement;
      }
      vertical = vertical || pageViewport;
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: horizontal ? horizontal.scrollLeft : 0,
        startTop: vertical.scrollTop,
        horizontal: horizontal,
        vertical: vertical,
        axis: "",
        moved: false
      };
    });

    document.addEventListener("pointermove", function (event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.max(Math.abs(deltaX), Math.abs(deltaY)) < threshold) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.axis = drag.horizontal && Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
        document.body.classList.add("is-drag-scrolling");
        if (drag.horizontal && drag.axis === "x") drag.horizontal.classList.add("is-dragging");
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      }
      event.preventDefault();
      if (drag.axis === "x") {
        drag.horizontal.scrollLeft = drag.startLeft - deltaX;
      } else {
        drag.vertical.scrollTop = drag.startTop - deltaY;
      }
    }, { passive: false });

    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.moved) suppressClickUntil = performance.now() + 250;
      document.body.classList.remove("is-drag-scrolling");
      if (drag.horizontal) drag.horizontal.classList.remove("is-dragging");
      drag = null;
    }

    document.addEventListener("pointerup", finishDrag);
    document.addEventListener("pointercancel", finishDrag);
    document.addEventListener("click", function (event) {
      if (performance.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, true);
  }

  function filteredCards() {
    let cards = state.cards.slice();
    if (state.filter === "favorite") cards = favoriteCards();
    if (state.filter === "new") cards = state.cards.filter(function (card) { return !card.reviewCount && (card.mastery || 0) === 0; });
    if (state.filter === "due") cards = dueCards();
    if (state.batchFilter) cards = cards.filter(function (card) { return card.batchId === state.batchFilter || (card.batchIds || []).includes(state.batchFilter); });
    const keyword = normalizeText(state.keyword).toLowerCase();
    if (keyword && albumSearchResult?.query === state.keyword.trim()) {
      const ranks = new Map(albumSearchResult.ids.map(function (id, i) { return [id, i]; }));
      return cards.filter(function (card) { return ranks.has(card.id); }).sort(function (a, b) { return ranks.get(a.id) - ranks.get(b.id); });
    }
    if (keyword) cards = cards.filter(function (card) { return [card.title, card.summary, card.mantra, card.source].join(" ").toLowerCase().includes(keyword); });
    return cards;
  }

  function favoriteCards() {
    return state.cards.filter(function (card) { return card.favorite; });
  }

  function dueCards() {
    const now = Date.now();
    const today = localDayKey(now);
    return state.cards.filter(function (card) {
      if (card.lastCorrectReviewDay === today) return false;
      const dueAt = Number(card.dueAt || 0);
      return !dueAt || dueAt <= now;
    }).sort(function (a, b) {
      return Number(a.dueAt || 0) - Number(b.dueAt || 0);
    });
  }

  function getCard(id) {
    return state.cards.find(function (card) { return card.id === id; });
  }

  function ensureReviewOrder(cardId, count) {
    if (state.reviewCardId === cardId && state.reviewOrder.length === count) return;
    state.reviewCardId = cardId;
    state.reviewOrder = shuffled(Array.from({ length: count }, function (_, i) { return i; }));
  }

  function reviewReasonSummary(reasons) {
    const items = Array.isArray(reasons) ? reasons : [];
    const priority = items.find(function (reason) { return reason.code === "weak_concept"; })
      || items.find(function (reason) { return reason.code === "unseen_concept"; })
      || items.find(function (reason) { return reason.code === "format_preference"; })
      || items[0];
    return priority ? priority.summary : "它已经到复习时间，完成后会立即重新规划下一颗。";
  }

  function reviewDifficultyLabel(value) {
    return value === "foundation" ? "巩固基础" : value === "challenge" ? "提高挑战" : "标准难度";
  }

  function formatReviewDueAt(timestamp) {
    const value = Number(timestamp || 0);
    if (!value) return "待重新安排";
    const date = new Date(value);
    if (localDayKey(value) === localDayKey()) return "今天稍后";
    return (date.getMonth() + 1) + " 月 " + date.getDate() + " 日";
  }

  function deleteSelectedCards() {
    if (state.selectedIds.size) showDeleteCards(Array.from(state.selectedIds));
  }

  function showDeleteCards(ids) {
    modalContent.innerHTML = '<h2 class="modal-title">删除 ' + ids.length + ' 张卡片？</h2><label class="field-label"><input id="delete-unused-sources" type="checkbox"> 一并移除没有其他卡片引用的原文附件</label><div class="modal-actions"><button class="secondary-btn" id="cancel-card-delete" type="button">取消</button><button class="primary-btn is-danger" id="confirm-card-delete" type="button">确认删除</button></div>';
    openModal();
    document.getElementById("cancel-card-delete").addEventListener("click", closeModal);
    document.getElementById("confirm-card-delete").addEventListener("click", async function () {
      const cleanup = document.getElementById("delete-unused-sources").checked;
      try {
        await syncQueue;
        const result = await agentApi.deleteCards(ids, { removeUnusedSources: cleanup });
        applyLearningState(result.state);
        storage.saveLearningStateSnapshot(currentLearningState());
        state.selectedIds.clear();
        closeModal();
        render();
        toast("已删除");
      } catch (error) { toast(error.message); }
    });
  }

  async function toggleCardFavorite(card, button, renderSaved) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await syncQueue;
      const response = await agentApi.setCardFavorite(card.id, !card.favorite, nextMutationId());
      applyLearningState(response.state);
      Object.assign(card, response.card);
      if (button.isConnected) renderSaved();
    } catch (error) { toast(error.message || "收藏保存失败，请重试"); }
    finally { if (button.isConnected) button.disabled = false; }
  }

  function localDayKey(timestamp) {
    return storage.localDayKey(timestamp);
  }

  function ensureReviewDay() {
    const today = localDayKey();
    if (!state.reviewDay || state.reviewDay.day !== today) {
      state.reviewDay = { day: today, answered: 0, completed: false };
      saveReviewDay();
    }
    return state.reviewDay;
  }

  function saveReviewDay() {
    persistLearningState();
  }

  function currentLearningState() {
    return {
      cards: state.cards,
      pending: state.pending,
      totalDraws: Math.max(0, Math.floor(Number(state.totalDraws) || 0)),
      reviewDay: state.reviewDay || { day: localDayKey(), answered: 0, completed: false }
    };
  }

  function snapshotLearningState() {
    return JSON.parse(JSON.stringify(currentLearningState()));
  }

  function persistLearningState() {
    const snapshot = snapshotLearningState();
    storage.saveLearningStateSnapshot(snapshot);
    storage.markSyncDirty();
    const revision = ++stateRevision;
    if (!persistenceReady) return;
    const mutationId = nextMutationId();
    syncQueue = syncQueue.catch(function () {}).then(function () {
      return agentApi.replaceLearningState(snapshot, mutationId);
    }).then(function () {
      if (revision === stateRevision) {
        storage.markSyncClean();
      }
    }).catch(function (error) {
      storage.markSyncDirty();
      state.agentConnectionMessage = "扩展内学习状态保存失败：" + error.message;
    });
  }

  async function bootstrapLearningState() {
    const revisionAtStart = stateRevision;
    const localSnapshot = storage.loadLearningStateSnapshot();
    let response;
    let migrated = false;
    try {
      if (!storage.isMigrationComplete()) {
        response = await agentApi.migrateLocalStorage(localSnapshot);
        migrated = true;
      } else if (storage.isSyncDirty()) {
        response = await agentApi.replaceLearningState(localSnapshot, nextMutationId());
      } else {
        response = await agentApi.loadLearningState();
        if (response.version === 0 && hasLearningData(localSnapshot)) {
          response = await agentApi.migrateLocalStorage(localSnapshot);
          migrated = true;
        }
      }
      if (migrated) storage.markMigrationComplete();
      persistenceReady = true;
      if (revisionAtStart === stateRevision) {
        applyLearningState(response.state);
        storage.markSyncClean();
        render();
      } else {
        persistLearningState();
      }
    } catch (error) {
      persistenceReady = true;
      state.agentConnectionMessage = "扩展应用服务初始化失败，学习数据仍保存在侧边栏：" + error.message;
      if (stateRevision > revisionAtStart) persistLearningState();
    }
  }

  async function bootstrapGachaDrafts() {
    try {
      const response = await agentApi.listGachaCardDrafts();
      state.gachaDrafts = Array.isArray(response.sessions) ? response.sessions : [];
      if (["home", "feed", "draw", "settings"].includes(state.view)) render();
    } catch (error) {
      state.agentConnectionMessage = "暂时无法读取待打开扭蛋：" + error.message;
    }
  }

  async function bootstrapGachaReview() {
    await loadGachaReview(false);
  }

  async function loadGachaReview(showLoading) {
    const shouldRenderLoading = showLoading !== false;
    state.reviewLoading = true;
    state.reviewError = "";
    if (shouldRenderLoading && state.view === "review") renderReview();
    try {
      state.reviewOverview = await agentApi.getGachaReview();
    } catch (error) {
      state.reviewError = error.message || "暂时无法读取复习扭蛋";
    } finally {
      state.reviewLoading = false;
      if (["home", "review"].includes(state.view)) render();
    }
  }

  async function bootstrapDiscoveryPools() {
    try {
      const response = await agentApi.listGachaDiscoveryPools();
      state.discoveryPools = Array.isArray(response.pools) ? response.pools : [];
      const active = state.discoveryPools.find(function (pool) { return ["active", "empty"].includes(pool.status) && pool.poolVersion === window.KnowledgeGachaBackendDiscovery.POOL_VERSION && pool.rankingVersion === window.KnowledgeGachaBackendDiscovery.RANKING_VERSION; });
      state.currentDiscoveryPoolId = active ? active.id : "";
      if (["home", "discovery"].includes(state.view)) render();
    } catch (error) {
      state.discoveryError = "暂时无法读取发现扭蛋：" + error.message;
    }
  }

  function applyLearningState(remoteState) {
    storage.saveLearningStateSnapshot(remoteState || {});
    const normalized = storage.loadLearningStateSnapshot();
    state.exercises = remoteState && remoteState.exercises || state.exercises || [];
    state.cards = normalized.cards;
    state.pending = normalized.pending;
    state.totalDraws = normalized.totalDraws;
    state.reviewDay = normalized.reviewDay;
  }

  function hasLearningData(snapshot) {
    return Boolean(snapshot.cards.length || snapshot.pending.length || snapshot.totalDraws || snapshot.reviewDay.answered);
  }

  function nextMutationId() {
    mutationSequence += 1;
    return "mutation_" + Date.now() + "_" + mutationSequence;
  }

  async function wipeAllData() {
    if (state.clearingData) return;
    if (!confirm("确认清空卡片、待打开卡片和本地复习数据？")) return;
    state.clearingData = true;
    showLoader("正在清空本地数据，等待当前任务结束…");
    try {
      await syncQueue;
      await agentApi.clearAllData();
      storage.clearAll();
      window.location.reload();
    } catch (error) {
      toast(error.message || "清空失败，请重试");
      state.clearingData = false;
      hideLoader();
    }
  }

  function showLoader(text) {
    loaderText.textContent = text || "正在生成知识卡";
    loader.classList.add("is-open");
    loader.setAttribute("aria-hidden", "false");
  }

  function hideLoader() {
    loader.classList.remove("is-open");
    loader.setAttribute("aria-hidden", "true");
  }

  function prefersReducedMotion() {
    if (typeof state.reducedMotion === "boolean") return state.reducedMotion;
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function applyMotionPreference() {
    document.body.classList.toggle("reduce-motion", prefersReducedMotion());
  }

  function toggleReducedMotion() {
    state.reducedMotion = !prefersReducedMotion();
    storage.saveSettings({
      baseUrl: state.aiConfig.baseUrl,
      model: state.aiConfig.model,
      temperature: state.aiConfig.temperature,
      reducedMotion: state.reducedMotion
    });
    applyMotionPreference();
    renderSettings();
    window.requestAnimationFrame(function () {
      const toggle = document.getElementById("toggle-reduced-motion");
      if (toggle) toggle.focus({ preventScroll: true });
    });
    toast(state.reducedMotion ? "已减弱扭蛋动画" : "已恢复扭蛋动画");
  }

  function openModal() {
    lastModalTrigger = document.activeElement && typeof document.activeElement.focus === "function" ? document.activeElement : null;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    window.requestAnimationFrame(function () {
      document.getElementById("modal-close").focus({ preventScroll: true });
    });
  }

  function closeModal() {
    if (!modal.classList.contains("is-open")) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (lastModalTrigger && document.contains(lastModalTrigger)) lastModalTrigger.focus({ preventScroll: true });
    lastModalTrigger = null;
  }

  function handleGlobalKeydown(event) {
    if (!modal.classList.contains("is-open")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(modalPanel.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')).filter(function (element) {
      return element.getClientRects().length > 0;
    });
    if (!focusable.length) {
      event.preventDefault();
      document.getElementById("modal-close").focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  let toastTimer = null;
  function toast(message) {
    window.clearTimeout(toastTimer);
    toastNode.textContent = message;
    toastNode.classList.add("is-open");
    toastTimer = window.setTimeout(function () { toastNode.classList.remove("is-open"); }, 2200);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
