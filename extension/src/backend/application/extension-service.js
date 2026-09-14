(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const dependencies = commonJs ? {
    agent: require("../../harness/core/agent-harness.js"),
    companion: require("../../harness/core/learning-companion.js"),
    discovery: require("../features/discovery/discovery-service.js"),
    discoveryPlanner: require("../features/discovery/discovery-planner.js"),
    quality: require("../features/generation/card-quality.js"),
    multiCard: require("../features/generation/multi-card-service.js"),
    documentImport: require("../features/import/document-import-service.js"),
    repository: require("../infrastructure/storage/material-repository.js"),
    embedding: require("../infrastructure/embedding/local-embedding-client.js"),
    semantic: require("../../harness/rag/semantic-knowledge-service.js"),
    materialIndex: require("../../shared/material-index.js"),
    mcp: require("../../harness/mcp/mcp-audit-service.js"),
    memory: require("../../harness/memory/memory-service.js"),
    observability: require("../infrastructure/observability/trace-service.js"),
    rag: require("../../harness/rag/rag-service.js"),
    review: require("../features/review/review-service.js"),
    skills: require("../../harness/skills/skill-registry.js"),
    tools: require("../../harness/tools/tool-calling.js"),
    schema: require("../../shared/knowledge-schema.js"),
    store: require("../infrastructure/storage/extension-store.js"),
    utils: require("../../shared/runtime-utils.js")
  } : {
    agent: root.KnowledgeGachaAgentHarness,
    companion: root.KnowledgeGachaLearningCompanion,
    discovery: root.KnowledgeGachaBackendDiscovery,
    discoveryPlanner: root.KnowledgeGachaDiscoveryPlanner,
    quality: root.KnowledgeGachaCardQuality,
    multiCard: root.KnowledgeGachaMultiCard,
    documentImport: root.KnowledgeGachaDocumentImport,
    repository: root.KnowledgeGachaMaterialRepository,
    embedding: root.KnowledgeGachaLocalEmbedding,
    semantic: root.KnowledgeGachaSemanticKnowledge,
    materialIndex: root.KnowledgeGachaMaterialIndex,
    mcp: root.KnowledgeGachaHarnessMcp,
    memory: root.KnowledgeGachaHarnessMemory,
    observability: root.KnowledgeGachaBackendObservability,
    rag: root.KnowledgeGachaHarnessRag,
    review: root.KnowledgeGachaBackendReview,
    skills: root.KnowledgeGachaHarnessSkills,
    tools: root.KnowledgeGachaHarnessTools,
    schema: root.KnowledgeGachaKnowledgeSchema,
    store: root.KnowledgeGachaExtensionStore,
    utils: root.KnowledgeGachaRuntimeUtils
  };
  const api = factory(dependencies);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaExtensionService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (modules) {
  "use strict";

  function createExtensionService(options) {
    const settings = options || {};
    const utils = modules.utils;
    const storage = settings.storage || (typeof localStorage !== "undefined" ? localStorage : utils.memoryStorage());
    const cardDomain = settings.cardDomain || (typeof globalThis !== "undefined" ? globalThis.KnowledgeGachaCardDomain : null);
    const providerModule = settings.providerModule || (typeof globalThis !== "undefined" ? globalThis.KnowledgeGachaProviderTransport : null);
    if (!providerModule || !cardDomain) throw new Error("扩展 Harness 依赖未加载");

    const rawTransport = settings.providerTransport || providerModule.createProviderTransport({ chromeApi: settings.chromeApi });
    const getModelConfig = typeof settings.getModelConfig === "function" ? settings.getModelConfig : function () { return settings.modelConfig || null; };
    const now = typeof settings.now === "function" ? settings.now : Date.now;
    const repository = settings.repository || (settings.indexedDB !== false && (settings.indexedDB || globalThis.indexedDB) ? modules.repository.createMaterialRepository({ indexedDB: settings.indexedDB, profileId: settings.profileId }) : null);
    const store = modules.store.createHarnessStore({ storage: storage, repository: repository, profileId: settings.profileId, now: now, utils: utils });
    const transport = Object.assign({}, rawTransport, { complete: async function (config, input) { await store.flush(); return rawTransport.complete(config, input); } });
    const readDb = store.readDb;
    const writeDb = store.writeDb;
    const mutate = store.mutate;
    const requestId = function () { return utils.id("request"); };
    const serviceContext = { readDb: readDb, writeDb: writeDb, mutate: mutate, now: now, requestId: requestId };
    const parser = settings.documentParser || (globalThis.KnowledgeGachaDocumentParser ? globalThis.KnowledgeGachaDocumentParser.createDocumentParser() : null);
    const importService = modules.documentImport.createDocumentImportService(Object.assign({}, serviceContext, { repository: repository, parser: parser,
      namespace: store.databaseKey, transport: transport, getModelConfig: getModelConfig, flush: store.flush, readPersisted: store.readPersisted }));

    const embedding = settings.embedding === false ? null : settings.embedding || (typeof window !== "undefined" && typeof Worker !== "undefined" ? modules.embedding.createLocalEmbeddingClient() : null);
    const knowledge = modules.semantic.createSemanticKnowledgeService({ readDb: readDb, readPersisted: async function () { await store.flush(); return store.readPersisted(); }, repository: repository, embedding: embedding });
    const ragService = modules.rag.createRagService(Object.assign({}, serviceContext, { knowledge: knowledge }));
    const cardTask = modules.skills.loadTask("concept-card");
    const qualityService = modules.quality.createQualityService({ task: cardTask, transport: transport, getModelConfig: getModelConfig });
    async function planDiscoveryCandidates(request) {
      if (typeof settings.discoveryPlanner === "function") return settings.discoveryPlanner(request);
      const config = getModelConfig() || {};
      if (!String(config.apiKey || "").trim() || !String(config.model || "").trim()) {
        throw Object.assign(new Error("请先配置模型，再生成具体发现候选"), { code: "MODEL_CONFIG_REQUIRED", sent: false });
      }
      return modules.discoveryPlanner.requestOutlines(transport, getModelConfig, request, modules.skills.activate("gacha-discovery"));
    }

    function discoveryDraftCheck(card, discoveryContext, db) {
      if (!discoveryContext || !card) return { passed: true, issues: [] };
      const content = [card.title, card.learningObjective, card.summary, card.boundaries, card.example && card.example.text].join(" ");
      const issues = [];
      if (modules.discoveryPlanner.semanticCoverage(discoveryContext.learningObjective, content) < 0.18) {
        issues.push({ code: "discovery_objective", field: "card.learningObjective", message: "生成卡没有兑现发现候选的学习目标" });
      }
      if (modules.discoveryPlanner.semanticCoverage(discoveryContext.newKnowledge, content) < 0.18) {
        issues.push({ code: "discovery_novelty", field: "card.summary", message: "生成卡没有覆盖候选承诺的新增知识" });
      }
      (discoveryContext.relatedCardIds || []).forEach(function (cardId) {
        const related = db.learningState.cards.find(function (item) { return item.id === cardId; });
        if (related && modules.discoveryPlanner.nearDuplicate(card.summary, related.summary)) {
          issues.push({ code: "discovery_duplicate", field: "card.summary", message: "生成卡重复了关联卡摘要，没有形成新增内容" });
        }
      });
      return { passed: !issues.length, issues: issues };
    }
    const memoryService = modules.memory.createMemoryService(serviceContext);
    const reviewService = modules.review.createReviewService(Object.assign({}, serviceContext, {
      learningContextForDb: modules.memory.learningContextForDb,
      recordLearningEventInDb: modules.memory.recordLearningEventInDb
    }));
    const mcpService = modules.mcp.createMcpAuditService(serviceContext);
    const observabilityService = modules.observability.createObservabilityService(serviceContext);
    const agentService = modules.agent.createAgentHarness({
      searchKnowledge: function (query) { return knowledge.search(query); },
      transport: transport,
      getModelConfig: getModelConfig,
      readDb: readDb,
      writeDb: writeDb,
      mutate: mutate,
      now: now,
      requestId: requestId,
      id: utils.id,
      cardDomain: cardDomain,
      telemetry: {
        recordRun: modules.observability.recordRun,
        harnessResponse: modules.observability.harnessResponse,
        recordAudit: modules.mcp.recordAudit
      }
    });

    async function testModelConnection() {
      const result = await transport.complete(getModelConfig(), {
        messages: [
          { role: "system", content: "你正在进行连接测试。" },
          { role: "user", content: "只回复 OK" }
        ],
        temperature: 0,
        max_tokens: 8
      });
      return { provider: result.provider, requestId: requestId() };
    }

    async function generateCard(input) {
      const material = input || {};
      if (String(material.text || "").length > 12000) throw new Error("请先选择不超过 12000 字的制卡范围");
      const context = await generationContext(material);
      const result = await qualityService.run(context);
      return Object.assign(result, { context: context, provider: { model: result.generation.model, latencyMs: result.generation.elapsedMs }, requestId: requestId() });
    }

    async function generationContext(input) {
      const text = String(input.text || "").trim();
      const source = input.source || {};
      const evidence = [];
      const db = readDb();
      const checked = input.sourcePlan && db.sourceChecks.find(function (item) { return item.id === input.sourcePlan.checkId; }) || (await ragService.checkGachaCardSources(input)).check;
      if (input.blocks?.length) input.blocks.forEach(function (block, i) {
        evidence.push({ id: "material_b" + i, kind: "text", origin: "current", title: source.title, text: block.text, startCharacter: block.startCharacter,
          headingPath: block.headingPath, pageNumber: block.locator?.pageNumber || null, locator: block.locator, version: source.importRef?.version || db.sources.find(function (item) { return item.documentId === source.documentId; })?.version || 1 });
      });
      else if (text && source.type !== "discovery" && !input.companionReferencesOnly) evidence.push({ id: "material", kind: "text", title: source.title || "本次材料", text: text, startCharacter: 0 });
      else if (text && source.type === "discovery") evidence.push({ id: "discovery_outline", kind: "text", origin: "discovery_outline",
        title: source.title || "发现候选提纲", text: text, startCharacter: 0, version: 1 });
      (input.discoveryEvidence || []).slice(0, 5).forEach(function (ref, i) {
        const document = db.documents.find(function (item) { return item.id === ref.documentId; });
        const storedSource = db.sources.find(function (item) { return item.documentId === ref.documentId; });
        const start = Number(ref.startCharacter) || 0;
        if (!document || !storedSource || storedSource.version !== (ref.version || 1) || document.content.slice(start, start + String(ref.quote || "").length) !== ref.quote) return;
        evidence.push({ id: "discovery_source_" + i, kind: "text", origin: "saved_source", title: ref.title || document.title, text: ref.quote,
          documentId: document.id, version: storedSource.version, startCharacter: start, sourceUrl: ref.sourceUrl || document.sourceUrl || null,
          sourceType: ref.sourceType || document.type, headingPath: ref.headingPath || [], pageNumber: ref.pageNumber || null,
          locator: ref.locator || null, selectionId: ref.selectionId || null });
      });
      (input.companionEvidence || []).slice(0, 5).forEach(function (ref, i) {
        const document = db.documents.find(function (item) { return item.id === ref.documentId; });
        const storedSource = db.sources.find(function (item) { return item.documentId === ref.documentId; });
        const savedCard = db.learningState.cards.find(function (item) { return item.id === ref.cardId; });
        const excerpt = (savedCard?.citations || []).find(function (item) { return item.quote === ref.quote && item.source?.documentId === ref.documentId && (item.source.version || 1) === ref.version; });
        if (!ref.quote || (document ? !storedSource || storedSource.version !== ref.version || document.content.slice(ref.start, ref.start + ref.quote.length) !== ref.quote : !excerpt)) throw new Error("伴学的制卡来源已变化，请重新查找");
        evidence.push({ id: "companion_source_" + i, kind: "text", origin: "saved_source", title: storedSource?.title || excerpt?.source.title || ref.title,
          text: ref.quote, documentId: ref.documentId, version: ref.version, startCharacter: ref.start,
          sourceUrl: storedSource?.url || excerpt?.source.sourceUrl || null, sourceType: document?.type || excerpt?.source.type || "text",
          pageNumber: ref.pageNumber || null, headingPath: excerpt?.headingPath || [], locator: excerpt?.position?.locator || null });
      });
      if (input.companionReferencesOnly && !evidence.length) throw new Error("没有可用于整理的原文依据，请重新讨论");
      if (input.image && input.image.dataUrl) evidence.push({ id: "image", kind: "image", title: source.title || "本次图片" });
      const importedDocumentId = source.importRef ? "doc_import_" + source.importRef.assetId.slice(6) : null;
      const relatedSources = source.importRef && !input.allowSupplemental ? [] : checked.relatedSources || [];
      relatedSources.filter(function (item) { return item.citation.source.documentId !== importedDocumentId; }).slice(0, 3).forEach(function (item, i) {
        const citation = item.citation;
        const doc = db.documents.find(function (document) { return document.id === citation.source.documentId; });
        const start = citation.position.startCharacter;
        if (!doc || doc.content.slice(start, start + citation.quote.length) !== citation.quote) return;
        const record = db.sources.find(function (s) { return s.documentId === doc.id; });
        evidence.push({ id: "related_" + i, kind: "text", title: doc.title, text: citation.quote, documentId: doc.id, version: record.version,
          startCharacter: start, sourceUrl: doc.sourceUrl || null, sourceType: doc.type, headingPath: citation.headingPath,
          pageNumber: citation.position.pageNumber, locator: citation.position.locator, selectionId: citation.source.selectionId });
      });
      const learningContext = modules.memory.learningContextForDb(db, now(), {
        mode: "generation",
        topicId: input.topicId || source.topicId || null,
        learningUnitId: input.learningUnitId || source.learningUnitId || null
      });
      return { userGoal: String(input.userGoal || (source.type === "discovery" ? text : "")).slice(0, 600), materialLength: text.length,
        evidence: evidence, image: input.image || null,
        relatedCards: (checked.similarCards || []).slice(0, 3).map(function (item) { return { title: item.title, summary: item.summary }; }),
        learningContext: learningContext, companionReferencesOnly: input.companionReferencesOnly === true };
    }

    function reviewVariantContext(db, card) {
      const sources = [];
      const sourceForCitation = new Map();
      (card.citations || []).forEach(function (citation) {
        if (!citation?.quote) return;
        const key = JSON.stringify([citation.source?.documentId || "", citation.source?.version || 1, citation.position?.startCharacter || 0, citation.quote]);
        let source = sources.find(function (item) { return item.locationKey === key; });
        if (!source && sources.length < 8) {
          source = { id: "review_source_" + sources.length, kind: "text", title: citation.source?.title || card.title, text: citation.quote,
            documentId: citation.source?.documentId || null, version: citation.source?.version || 1,
            startCharacter: citation.position?.startCharacter || 0, headingPath: citation.headingPath || [], pageNumber: citation.position?.pageNumber || null,
            locator: citation.position?.locator || null, sourceUrl: citation.source?.sourceUrl || null, sourceType: citation.source?.type || "text", locationKey: key };
          sources.push(source);
        }
        if (source) sourceForCitation.set(citation, source);
      });
      if (!sources.length) throw new Error("这张卡没有可核验的保存依据，暂时不能生成新题");
      const references = (card.citations || []).map(function (citation, index) {
        const source = sourceForCitation.get(citation);
        return source && ["summary", "exercise", "boundaries", "example"].includes(citation.claim)
          ? { id: "review_ref_" + index, evidenceId: source.id, quote: source.text, occurrence: 0, claim: citation.claim } : null;
      }).filter(Boolean).slice(0, 32);
      sources.forEach(function (source) { delete source.locationKey; });
      return {
        sources: sources,
        references: references,
        context: {
          userGoal: (card.learningObjective || "能解释" + card.title) + "\n为同一学习目标生成不同情景或回忆路径，不能只重排原题选项。",
          evidence: sources,
          image: null,
          materialLength: sources.reduce(function (total, source) { return total + source.text.length; }, 0),
          relatedCards: [{ title: card.title, summary: card.summary }],
          learningContext: modules.memory.learningContextForDb(db, now(), { mode: "review", topicId: card.topicId, learningUnitId: card.learningUnitId })
        }
      };
    }

    async function createGachaReviewVariant(cardId, input) {
      input = input || {};
      const snapshot = readDb();
      const card = snapshot.learningState.cards.find(function (item) { return item.id === cardId; });
      if (!card) throw new Error("复习卡不存在");
      const mutationId = String(input.mutationId || "").slice(0, 180);
      const fingerprint = utils.stableToken(JSON.stringify({ cardId: cardId, cardVersion: card.version || 1, request: "review_variant_v1" }));
      const prior = mutationId && (snapshot.reviewMutations || []).find(function (item) { return item.id === mutationId; });
      if (prior) {
        if (prior.action !== "generate_review_variant:" + cardId || prior.fingerprint !== fingerprint) throw new Error("同一操作标识不能用于不同的新题请求");
        const exercise = snapshot.exercises.find(function (item) { return item.id === prior.result.exerciseId; });
        if (!exercise) throw new Error("已生成的新题后来被移除，请重新请求");
        return { exercise: exercise, alreadyApplied: true, requestId: requestId() };
      }
      const prepared = reviewVariantContext(snapshot, card);
      const base = snapshot.exercises.find(function (item) { return (card.exerciseIds || []).includes(item.id); });
      if (!base) throw new Error("这张卡没有可复习的已保存练习");
      const initial = { status: "ready", card: modules.quality.pick(card, modules.quality.CARD_FIELDS), exercise: modules.quality.pick(base, modules.quality.EXERCISE_FIELDS), evidence: prepared.references, checks: [] };
      const generated = await qualityService.run(prepared.context, initial, "exercise");
      if (generated.status !== "ready" || !generated.quality?.passed || !generated.exercise) throw new Error(generated.quality?.issues?.map(function (issue) { return issue.message; }).filter(Boolean).join("；") || "新题没有通过独立核验，请重试");
      return mutate(function (db) {
        const current = db.learningState.cards.find(function (item) { return item.id === cardId; });
        if (!current || (current.version || 1) !== (card.version || 1)) throw new Error("卡片内容已变化，请重新生成新题");
        const duplicate = mutationId && (db.reviewMutations || []).find(function (item) { return item.id === mutationId; });
        if (duplicate) {
          if (duplicate.action !== "generate_review_variant:" + cardId || duplicate.fingerprint !== fingerprint) throw new Error("同一操作标识不能用于不同的新题请求");
          return { exercise: db.exercises.find(function (item) { return item.id === duplicate.result.exerciseId; }), alreadyApplied: true, requestId: requestId() };
        }
        const timestamp = now();
        const exercise = Object.assign({}, generated.exercise, { id: utils.id("exercise_review_variant"), cardId: current.id, learningUnitId: current.learningUnitId,
          version: 1, purpose: "review_variant", origin: "generated_review_variant", variantOf: base.id, createdAt: timestamp,
          quality: { promptVersion: generated.generation.promptVersion, checkedAt: timestamp, model: generated.generation.model, checks: generated.quality.checks } });
        db.exercises.push(exercise);
        current.exerciseIds = Array.from(new Set([].concat(current.exerciseIds || [], exercise.id)));
        current.updatedAt = timestamp;
        if (mutationId) db.reviewMutations.push({ id: mutationId, action: "generate_review_variant:" + cardId, fingerprint: fingerprint, result: { exerciseId: exercise.id }, appliedAt: timestamp });
        modules.observability.recordRun(db, utils.id("run"), "concept-card", "completed", timestamp - generated.generation.elapsedMs, generated.generation.elapsedMs, 0,
          { source: "extension_workflow", operation: "review_variant", promptVersion: generated.generation.promptVersion, durationBasis: "generation_elapsed", occurredAt: timestamp });
        db.version += 1;
        return { exercise: exercise, alreadyApplied: false, requestId: requestId() };
      });
    }

    async function createGachaCardDraft(input) {
      input = input || {};
      const text = String(input.text || "").trim();
      if (text.length > 12000) throw new Error("请先选择不超过 12000 字的制卡范围");
      const material = { text: text, blocks: input.blocks || null, userGoal: String(input.userGoal || ""), image: input.image || null, source: Object.assign({ type: "manual", title: "手动输入", capturedAt: now() }, input.source || {}) };
      delete material.source.fullText;
      delete material.source.excerpt;
      const generated = await generateCard(input);
      const db = readDb();
      const discoveryCheck = discoveryDraftCheck(generated.card, input.discoveryContext, db);
      if (input.discoveryContext && generated.status === "ready" && generated.quality?.passed && !discoveryCheck.passed) {
        generated.status = "needs_revision";
        generated.quality = Object.assign({}, generated.quality, { passed: false,
          issues: (generated.quality.issues || []).concat(discoveryCheck.issues) });
      }
      const sourcePlan = input.sourcePlan || {};
      const sourceCheck = db.sourceChecks.find(function (item) { return item.id === sourcePlan.checkId; }) || null;
      const timestamp = now();
      const session = {
        id: utils.id("draft"), runId: utils.id("run"), saveRunId: null, status: generated.status, source: material.source, material: material,
        companionActionId: input.companionActionId || null,
        sourceCheck: sourceCheck, sourcePlan: sourcePlan, discoveryContext: input.discoveryContext ? utils.clone(input.discoveryContext) : null, card: generated.card ? Object.assign({}, generated.card, {
          id: utils.id("card"), contentVersion: 2, learningUnitId: input.learningUnitId || undefined, topicId: input.topicId || undefined, citations: [], sourceSnapshot: null
        }) : null, model: generated.provider.model,
        exercise: generated.exercise ? Object.assign({}, generated.exercise, { id: utils.id("exercise"), version: 1 }) : null,
        evidence: generated.evidence, candidates: generated.candidates || [], context: generated.context, quality: generated.quality, generation: generated.generation, history: [generated.generation], edits: [], revision: 1, validatedRevision: generated.quality.passed ? 1 : null,
        approvalId: null, savedCardId: null, reviewDueAt: null, failureMessage: null, createdAt: timestamp, updatedAt: timestamp
      };
      mutate(function (next) {
        if (input.materialDraftId) next.drafts = next.drafts.filter(function (draft) { return draft.id !== input.materialDraftId || draft.status === "confirmed"; });
        next.drafts.unshift(session);
        modules.observability.recordRun(next, session.runId, "concept-card", generated.quality.passed ? "completed" : "failed", timestamp - generated.generation.elapsedMs, generated.generation.elapsedMs, 0,
          { source: "extension_workflow", operation: "generate_card", promptVersion: generated.generation.promptVersion, durationBasis: "generation_elapsed", occurredAt: timestamp,
            errorCode: generated.quality.passed ? null : "card_quality_not_ready" });
      });
      return { session: session, requestId: requestId() };
    }

    function listGachaCardDrafts() {
      const db = readDb();
      return Promise.resolve({ sessions: db.drafts.filter(function (item) { return item.status !== "confirmed"; }).map(function (item) { return publicDraft(db, item); }), requestId: requestId() });
    }

    function publicDraft(db, session) {
      if (!session.materialId || session.status === "confirmed") return session;
      const material = db.materials.find(function (item) { return item.id === session.materialId; });
      if (!material) return session;
      const plan = db.knowledgePlans.find(function (item) { return item.id === session.planId; });
      return Object.assign({}, session, { material: { text: material.text || "", blocks: material.blocks, image: material.image, source: material.source, userGoal: plan?.userGoal || "" },
        context: session.context ? Object.assign({}, session.context, { image: material.image || null }) : null });
    }

    function saveGachaMaterialDraft(input, draftId) {
      return Promise.resolve(mutate(function (db) {
        if (!input || (!String(input.text || "").trim() && !input.image)) throw new Error("请先选择制卡材料");
        if (String(input.text || "").length > modules.materialIndex.MAX_CHARACTERS) throw new Error("请先选择不超过 100 万字符的范围");
        let session = db.drafts.find(function (draft) { return draft.id === draftId && draft.status === "material"; });
        if (!session) {
          session = { id: utils.id("draft"), status: "material", createdAt: now() };
          db.drafts.unshift(session);
        }
        session.material = utils.clone(input);
        session.source = input.source;
        session.updatedAt = now();
        return { session: session, requestId: requestId() };
      }));
    }

    function getGachaCardDraft(draftId) {
      const db = readDb();
      const session = db.drafts.find(function (item) { return item.id === draftId; });
      if (!session) return Promise.reject(new Error("草稿不存在"));
      return Promise.resolve({ session: publicDraft(db, session), requestId: requestId() });
    }

    function updateGachaCardDraft(draftId, card, exercise) {
      return Promise.resolve(mutate(function (db) {
        const session = db.drafts.find(function (item) { return item.id === draftId; });
        if (!session || session.status === "confirmed" || session.status === "generating") throw new Error("草稿已确认、生成中或不存在");
        const changes = [];
        const fields = session.card && session.card.contentVersion === 2 ? modules.quality.CARD_FIELDS : ["title", "summary", "analogy", "mantra", "plainSummary", "question", "options", "correctIndex"];
        fields.forEach(function (key) {
          if (session.card && card && Object.hasOwn(card, key) && JSON.stringify(card[key]) !== JSON.stringify(session.card[key])) { session.card[key] = utils.clone(card[key]); changes.push(key); }
        });
        if (exercise && session.exercise) modules.quality.EXERCISE_FIELDS.forEach(function (key) {
          if (Object.hasOwn(exercise, key) && JSON.stringify(exercise[key]) !== JSON.stringify(session.exercise[key])) { session.exercise[key] = utils.clone(exercise[key]); changes.push("exercise." + key); }
        });
        if (changes.length && session.card && session.card.contentVersion === 2) {
          session.revision += 1;
          session.validatedRevision = null;
          session.status = "needs_review";
          session.edits.push({ at: now(), fields: changes, revision: session.revision });
          session.manualFields = Array.from(new Set((session.manualFields || []).concat(changes)));
          session.quality = { passed: false, issues: [{ code: "edited", message: "内容已修改，请重新核验解释、依据和答案" }], evidence: [], checks: [] };
        }
        session.updatedAt = now();
        return { session: session, requestId: requestId() };
      }));
    }

    async function reviseGachaCardDraft(draftId, action) {
      if (!["summary", "example", "exercise", "review", "retry"].includes(action)) throw new Error("未知修改方式");
      const snapshotDb = readDb();
      const record = snapshotDb.drafts.find(function (item) { return item.id === draftId; });
      const snapshot = record && publicDraft(snapshotDb, record);
      if (!snapshot || snapshot.status === "confirmed" || snapshot.status === "generating") throw new Error("草稿已确认、生成中或不存在");
      if (snapshot.batchId && action === "retry") {
        const view = await multiCardService.generateCardBatch(snapshot.planId, { unitIds: [snapshot.unitId], retry: true, maxUnits: 1 });
        return getGachaCardDraft(view.sessions.find(function (item) { return item.id === draftId; }).id);
      }
      const context = snapshot.context || await generationContext(snapshot.material || {});
      if (action !== "retry" && !snapshot.card) throw new Error("请先补充材料后重新生成");
      const initial = action === "retry" ? null : { status: "ready", card: snapshot.card, exercise: snapshot.exercise, evidence: snapshot.evidence || [], checks: [],
        generation: { imageObservation: snapshot.generation?.imageObservation || null } };
      const result = await qualityService.run(context, initial, action === "retry" ? undefined : action);
      return mutate(function (db) {
        const session = db.drafts.find(function (item) { return item.id === draftId; });
        if (!session || session.status === "confirmed" || session.status === "generating" || session.revision !== snapshot.revision) throw new Error("草稿已变化，本次结果未覆盖新修改");
        const discoveryCheck = discoveryDraftCheck(result.card, session.discoveryContext, db);
        if (result.status === "ready" && result.quality?.passed && !discoveryCheck.passed) {
          result.status = "needs_revision";
          result.quality = Object.assign({}, result.quality, { passed: false, issues: (result.quality.issues || []).concat(discoveryCheck.issues) });
        }
        const oldCard = session.card || session.cardIdentity;
        const oldExercise = session.exercise;
        session.card = result.card ? Object.assign({}, result.card, modules.quality.pick(oldCard || {}, ["learningUnitId", "topicId", "batchId", "batchIds"]),
          { id: oldCard && oldCard.id || utils.id("card"), contentVersion: 2, citations: [], sourceSnapshot: null }) : null;
        if (session.card) delete session.cardIdentity;
        else if (oldCard) session.cardIdentity = modules.quality.pick(oldCard, ["id", "learningUnitId", "topicId", "batchId", "batchIds"]);
        session.exercise = result.exercise ? Object.assign({}, result.exercise, { id: oldExercise && oldExercise.id || utils.id("exercise"), version: (oldExercise && oldExercise.version || 1) + (action === "exercise" ? 1 : 0) }) : null;
        session.status = result.status;
        session.evidence = result.evidence;
        session.candidates = result.candidates || [];
        session.quality = result.quality;
        session.context = session.materialId ? Object.assign({}, context, { image: null }) : context;
        session.generation = result.generation;
        session.model = result.generation.model;
        session.history = (session.history || []).concat(result.generation);
        session.edits = (session.edits || []).concat({ at: now(), fields: [action], revision: (session.revision || 0) + 1 });
        session.revision = (session.revision || 0) + 1;
        session.validatedRevision = result.quality.passed ? session.revision : null;
        session.updatedAt = now();
        return { session: session, requestId: requestId() };
      });
    }

    function confirmGachaCardDraft(draftId, confirmation) {
      return Promise.resolve(mutate(function (db) {
        const session = db.drafts.find(function (item) { return item.id === draftId; });
        if (!session || !session.card) throw new Error("草稿不存在");
        if (session.status === "confirmed") {
          const saved = db.learningState.cards.find(function (item) { return item.id === session.savedCardId; });
          if (!saved) throw new Error("这张草稿已收下，卡片后来已删除");
          return { session: session, card: saved, requestId: requestId() };
        }
        if (session.batchId) {
          if (!confirmation || confirmation.revision !== session.revision) throw new Error("卡片已变化，请重新查看并确认本次选择");
          const unit = db.knowledgePlans.find(function (item) { return item.id === session.planId; })?.units.find(function (item) { return item.id === session.unitId; });
          if (!unit?.selected || unit.disposition !== "active" || unit.duplicateAction === "undecided") throw new Error("学习目标选择已变化，请重新确认");
          session.sourcePlan.duplicateAction = unit.duplicateAction;
          session.sourcePlan.targetCardId = unit.relatedCardId;
          if ((unit.duplicateAction === "merge" ? unit.relatedCardId : null) !== confirmation.mergeTargetId) throw new Error("合并方式已变化，请重新查看差异");
        }
        if (session.card.contentVersion !== 2 || !session.quality || !session.quality.passed || session.status !== "ready" || session.revision !== session.validatedRevision) throw new Error("草稿尚未通过质量核验，请先修复或重新核验");
        const discoveryCheck = discoveryDraftCheck(session.card, session.discoveryContext, db);
        if (!discoveryCheck.passed) throw new Error(discoveryCheck.issues.map(function (item) { return item.message; }).join("；"));
        const checked = modules.quality.validate(Object.assign({}, session, { checks: session.quality.checks }), session.context, cardTask, true);
        if (!checked.passed) throw new Error(checked.issues.map(function (item) { return item.message; }).join("；"));
        const timestamp = now();
        let card = cardDomain.sanitizeCard(Object.assign({}, session.card, { dueAt: timestamp + 86_400_000, updatedAt: timestamp }));
        let mergedExisting = null;
        const plan = session.sourcePlan || {};
        if (plan.duplicateAction === "merge" && plan.targetCardId) {
          const existing = db.learningState.cards.find(function (item) { return item.id === plan.targetCardId; });
          if (!existing) throw new Error("要合并的卡片已删除，请修改草稿后重试");
          if (session.batchId && existing.version !== confirmation.mergeTargetVersion) throw new Error("原卡已更新，请重新查看合并差异");
          card = cardDomain.sanitizeCard(Object.assign({}, card, { id: existing.id, learningUnitId: existing.learningUnitId, version: (existing.version || 1) + 1,
            favorite: existing.favorite, mastery: existing.mastery, reviewCount: existing.reviewCount, lastCorrectReviewDay: existing.lastCorrectReviewDay,
            createdAt: existing.createdAt, citations: existing.citations, sourceIds: existing.sourceIds, sourceSnapshot: existing.sourceSnapshot }));
          mergedExisting = existing;
          if (session.batchId) card.batchIds = Array.from(new Set([].concat(existing.batchIds || [], existing.batchId || [], session.batchId)));
          card.dueAt = existing.dueAt;
        }
        attachDraftSource(db, session, card);
        attachQualityEvidence(db, session, card, checked.evidence);
        card.learningUnitId = card.learningUnitId || "unit_" + card.id;
        const exercise = Object.assign({}, session.exercise, { cardId: card.id, learningUnitId: card.learningUnitId, contentVersion: 2 });
        db.exercises = db.exercises.filter(function (item) { return item.id !== exercise.id; });
        db.exercises.push(exercise);
        card.exerciseIds = [exercise.id];
        card.quality = { promptVersion: session.generation.promptVersion, checks: checked.checks, checkedAt: timestamp, model: session.model };
        if (mergedExisting) {
          card.learningStage = mergedExisting.learningStage || "scheduled";
          card.initialLearningCompletedAt = mergedExisting.initialLearningCompletedAt || null;
          card.releaseGroupId = mergedExisting.releaseGroupId || null;
          card.reviewScheduleVersion = mergedExisting.reviewScheduleVersion || "legacy-card-schedule";
        } else {
          const releaseGroupId = session.batchId || "save_" + session.id;
          card.learningStage = "new";
          card.initialLearningCompletedAt = null;
          card.releaseGroupId = releaseGroupId;
          card.reviewScheduleVersion = "review-schedule-v2";
          card.dueAt = modules.review.nextNewCardDueAt(db.learningState.cards, timestamp, db.reviewSettings?.dailyGoal, releaseGroupId);
        }
        db.learningState.cards = db.learningState.cards.filter(function (item) { return item.id !== card.id; });
        db.learningState.cards.unshift(card);
        db.version += 1;
        session.status = "confirmed";
        session.card = card;
        session.saveRunId = utils.id("run");
        session.savedCardId = card.id;
        session.reviewDueAt = card.dueAt;
        session.updatedAt = timestamp;
        if (session.batchId) {
          const batch = db.cardBatches.find(function (item) { return item.id === session.batchId; });
          const entry = batch?.entries.find(function (item) { return item.draftId === session.id; });
          if (entry) { entry.savedCardId = card.id; entry.savedAt = timestamp; }
          const knowledgePlan = db.knowledgePlans.find(function (item) { return item.id === session.planId; });
          const unit = knowledgePlan?.units.find(function (item) { return item.id === session.unitId; });
          if (unit) unit.savedCardId = card.id;
          if (knowledgePlan && knowledgePlan.units.filter(function (item) { return item.selected && item.disposition === "active"; }).every(function (item) {
            return db.drafts.some(function (draft) { return draft.planId === session.planId && draft.unitId === item.id && draft.status === "confirmed"; });
          })) {
            const shared = db.materials.find(function (item) { return item.id === session.materialId; });
            if (shared) { shared.completedAt = timestamp; delete shared.text; delete shared.image; delete shared.blocks; }
            if (batch) batch.status = "completed";
          }
        }
        if (session.discoveryContext) {
          const discoveryPool = db.discoveryPools.find(function (pool) { return pool.id === session.discoveryContext.poolId; });
          const discoveryCandidate = discoveryPool?.candidates.find(function (candidate) { return candidate.id === session.discoveryContext.candidateId; });
          if (discoveryCandidate) {
            discoveryCandidate.status = "saved";
            discoveryCandidate.savedCardId = card.id;
            discoveryCandidate.savedAt = timestamp;
            discoveryPool.metrics = discoveryPool.metrics || {};
            discoveryPool.metrics.saved = Number(discoveryPool.metrics.saved || 0) + 1;
            discoveryPool.updatedAt = timestamp;
            modules.memory.recordLearningEventInDb(db, {
              eventId: "discovery_saved:" + discoveryPool.id + ":" + discoveryCandidate.id,
              type: "discovery_saved", poolId: discoveryPool.id, candidateId: discoveryCandidate.id, cardId: card.id,
              learningUnitId: card.learningUnitId, topicId: card.topicId, topicLabel: card.title,
              invalidateCache: false, advanceVersion: false
            }, timestamp);
          }
        }
        delete session.material;
        delete session.context;
        delete session.sourceCheck;
        delete session.evidence;
        modules.schema.upgradeDb(db);
        modules.memory.recordLearningEventInDb(db, {
          eventId: "card_saved:" + session.id,
          type: "card_saved",
          cardId: card.id,
          learningUnitId: card.learningUnitId,
          topicId: card.topicId,
          topicLabel: card.title,
          invalidateCache: session.discoveryContext ? false : undefined,
          advanceVersion: session.discoveryContext ? false : undefined
        }, timestamp);
        modules.observability.recordRun(db, session.saveRunId, "concept-card", "completed", timestamp, 0, 1,
          { source: "extension_workflow", operation: "save_card", promptVersion: session.generation?.promptVersion, durationBasis: "save_event", occurredAt: timestamp });
        return { session: session, card: card, requestId: requestId() };
      }));
    }

    function attachDraftSource(db, session, card) {
      if (session.context?.companionReferencesOnly) return;
      const shared = session.materialId ? db.materials.find(function (item) { return item.id === session.materialId; }) : session.material;
      if (shared?.source?.importRef) { attachImportedSource(db, session, card, shared); return; }
      if (session.materialId) { attachBatchSource(db, session, card); return; }
      const material = session.material;
      // Pre-migration drafts never stored their input; a model's source field is not an original quote.
      if (!material || material.source.type === "discovery") return;
      const text = material.text || "";
      const metadata = material.source;
      let document = db.documents.find(function (item) { return item.id === metadata.documentId && text && item.content.includes(text); });
      if (!document && text) document = db.documents.find(function (item) {
        return item.content === text && item.title === metadata.title && (item.sourceUrl || null) === (metadata.url || null);
      });
      const documentId = document ? document.id : "doc_" + session.id;
      let source = db.sources.find(function (item) { return item.documentId === documentId; });
      if (!source) {
        source = { id: modules.schema.sourceId(documentId), documentId: documentId, type: metadata.type, title: metadata.title,
          url: metadata.url || null, capturedAt: metadata.capturedAt, version: 1, retention: "excerpt", status: text ? "excerpt_only" : "unavailable",
          scope: metadata.scope || "selected_text", range: metadata.range || null };
        db.sources.push(source);
      }
      if (!document && session.sourcePlan && session.sourcePlan.saveFullSource && text) {
        document = { id: documentId, title: source.title, type: source.url ? "webpage" : "text", mimeType: metadata.mimeType || "text/plain", content: text,
          sourceUrl: source.url, scope: source.scope, byteSize: new Blob([text]).size, createdAt: now(), updatedAt: now() };
        db.documents.push(document);
        source.retention = "full_text";
        source.status = "available";
      }
      // Preserve an exact substring of the actual input; do not present generated text as evidence.
      const materialRef = (session.evidence || []).find(function (ref) { return ref.evidenceId === "material" && ref.quote; });
      const candidate = String(materialRef && materialRef.quote || card.source || "").trim();
      const localStart = candidate && text.includes(candidate) ? text.indexOf(candidate) : 0;
      const quote = text.slice(localStart, localStart + Math.min(candidate && text.includes(candidate) ? candidate.length : 240, 240)).trim();
      let base = document ? document.content.indexOf(text) : 0;
      const range = metadata.range;
      if (document && range && Number.isInteger(range.start) && Number.isInteger(range.end)) {
        const selected = document.content.slice(range.start, range.end);
        if (selected.trim() === text) base = range.start + selected.indexOf(text);
      }
      const start = base + text.indexOf(quote);
      if (quote) card.citations = (card.citations || []).concat([{
        id: "citation_" + session.id, chunkId: "chunk_" + session.id, claim: "card",
        source: { documentId: documentId, sourceId: source.id, version: source.version, title: source.title, type: source.url ? "webpage" : "text", sourceUrl: source.url },
        headingPath: [], quote: quote, position: { startCharacter: start, endCharacter: start + quote.length, pageNumber: null }
      }]);
      card.sourceIds = Array.from(new Set((card.sourceIds || []).concat(source.id)));
      card.sourceSnapshot = { sourceId: source.id, sourceVersion: source.version, sourceType: metadata.type, title: source.title, url: source.url,
        capturedAt: source.capturedAt, excerpt: quote, fullSourceDocumentId: document ? document.id : null, status: source.status, scope: source.scope };
    }

    function attachImportedSource(db, session, card, material) {
      const ref = material.source.importRef;
      const documentId = "doc_import_" + ref.assetId.slice(6);
      const metadata = material.source;
      let document = db.documents.find(function (item) { return item.id === documentId; });
      let source = db.sources.find(function (item) { return item.documentId === documentId; });
      if (!source) {
        source = { id: modules.schema.sourceId(documentId), documentId: documentId, version: ref.version, type: ref.kind,
          title: metadata.title, url: null, capturedAt: metadata.capturedAt, status: "excerpt_only", retention: "excerpt", scope: metadata.scope };
        db.sources.push(source);
      }
      if (session.sourcePlan?.saveFullSource || session.sourcePlan?.saveOriginal) {
        if (!document) {
          document = { id: documentId, title: metadata.title, type: ref.kind, mimeType: metadata.mimeType, content: "", blocks: [], selections: [],
            sourceUrl: null, scope: metadata.scope, parserVersion: ref.parserVersion, pageCount: ref.pageCount, byteSize: 0, createdAt: now() };
          db.documents.push(document);
        }
        let selection = document.selections.find(function (item) { return item.id === ref.selectionId; });
        if (!selection) {
          const offset = document.content.length + (document.content ? 2 : 0);
          document.content += (document.content ? "\n\n" : "") + material.text;
          document.blocks.push(...(material.blocks || []).map(function (block) { return Object.assign({}, block, { id: ref.selectionId + "_" + block.id,
            startCharacter: offset + block.startCharacter, endCharacter: offset + block.endCharacter, selectionId: ref.selectionId }); }));
          selection = { id: ref.selectionId, startCharacter: offset, endCharacter: offset + material.text.length, ranges: ref.ranges };
          document.selections.push(selection);
        }
        if (document.content.slice(selection.startCharacter, selection.endCharacter) !== material.text) throw new Error("已保存的解析版本不一致，请重新选择范围");
        if (session.sourcePlan.saveOriginal) { document.originalAssetId = ref.assetId; document.originalByteSize = ref.fileBytes; }
        document.byteSize = new Blob([document.content]).size; document.updatedAt = now();
        source.status = "available"; source.retention = document.originalAssetId ? "original" : "full_text";
      }
      const selection = document?.selections.find(function (item) { return item.id === ref.selectionId; });
      material.importDocumentOffset = selection?.startCharacter || 0;
      material.sourceId = source.id;
      if (selection) material.retainedDocumentId = document.id;
      if (session.materialId) { card.learningUnitId = card.learningUnitId || session.unitId; card.batchId = session.batchId; }
      card.sourceSnapshot = { sourceId: source.id, sourceVersion: source.version, sourceType: ref.kind, title: source.title, url: null,
        capturedAt: source.capturedAt, excerpt: "", fullSourceDocumentId: selection || document?.originalAssetId ? document.id : null,
        status: selection || document?.originalAssetId ? "available" : "excerpt_only", scope: metadata.scope, selectionId: ref.selectionId,
        originalAvailable: Boolean(document?.originalAssetId), retainedRanges: selection?.ranges || [] };
      card.sourceIds = Array.from(new Set((card.sourceIds || []).concat(source.id)));
    }

    function attachBatchSource(db, session, card) {
      const material = db.materials.find(function (item) { return item.id === session.materialId; });
      if (material && typeof material.text !== "string" && material.retainedDocumentId) {
        const retained = db.documents.find(function (item) { return item.id === material.retainedDocumentId; });
        const sourceRecord = db.sources.find(function (item) { return item.documentId === material.retainedDocumentId; });
        if (retained && sourceRecord?.version === (material.documentVersion || material.version)) material.text = retained.content.slice(material.documentOffset, material.documentOffset + material.originalLength);
      }
      if (!material || typeof material.text !== "string") throw new Error("卡组原文已移除，请重新选择材料");
      const documentId = material.documentId || "doc_" + material.id;
      let document = db.documents.find(function (item) { return item.id === documentId; });
      let source = db.sources.find(function (item) { return item.documentId === documentId; });
      if (document && (source?.version !== (material.documentVersion || material.version) || document.content.slice(material.documentOffset, material.documentOffset + material.text.length) !== material.text)) throw new Error("卡组原文或版本已变化，请重新生成");
      if (material.documentId && (!document || source?.version !== material.documentVersion || document.content.slice(material.documentOffset, material.documentOffset + material.text.length) !== material.text)) throw new Error("卡组原文或版本已变化，请重新生成");
      if (!source) {
        source = { id: modules.schema.sourceId(documentId), documentId: documentId, version: material.version, type: material.source.type,
          title: material.source.title, url: material.source.url || null, capturedAt: material.source.capturedAt,
          status: "excerpt_only", retention: "excerpt", scope: material.source.scope || "selected_text", range: material.source.range || null };
        db.sources.push(source);
      }
      if (!document && session.sourcePlan.saveFullSource) {
        document = { id: documentId, title: source.title, type: source.url ? "webpage" : "text", mimeType: material.source.mimeType || "text/plain", content: material.text,
          sourceUrl: source.url, scope: source.scope, byteSize: new Blob([material.text]).size, createdAt: now(), updatedAt: now() };
        db.documents.push(document);
        source.status = "available"; source.retention = "full_text";
      }
      material.sourceId = source.id;
      if (document) material.retainedDocumentId = document.id;
      card.learningUnitId = card.learningUnitId || session.unitId;
      card.batchId = session.batchId;
      card.sourceSnapshot = { sourceId: source.id, sourceVersion: source.version, sourceType: material.source.type, title: source.title, url: source.url,
        capturedAt: source.capturedAt, excerpt: "", fullSourceDocumentId: document ? document.id : null, status: source.status, scope: source.scope };
      card.sourceIds = Array.from(new Set((card.sourceIds || []).concat(source.id)));
    }

    function attachQualityEvidence(db, session, card, refs) {
      card.citations = (card.citations || []).filter(function (span) { return span.id !== "citation_" + session.id; });
      card.visualEvidence = [];
      if (session.discoveryContext || session.source?.type === "discovery") card.discoveryBasis = Object.assign({}, session.discoveryContext || {}, { verification: "model_suggestion" });
      refs.forEach(function (ref, index) {
        if (ref.kind === "image") {
          card.visualEvidence.push({ claim: ref.claim, observation: ref.observation, sourceTitle: session.source.title, verification: "model_visual_review" });
          return;
        }
        const input = session.context.evidence.find(function (item) { return item.id === ref.evidenceId; });
        if (!input) throw new Error("核验依据已变化，请重新生成");
        if (input.origin === "discovery_outline") {
          return;
        }
        const importedMaterial = session.materialId ? db.materials.find(function (item) { return item.id === session.materialId; }) : session.material;
        const importRef = input.origin === "current" && importedMaterial?.source?.importRef;
        let source;
        let start = ref.startCharacter;
        if (importRef) {
          source = db.sources.find(function (item) { return item.id === card.sourceSnapshot.sourceId; });
          if (importedMaterial.text.slice(start, start + ref.quote.length) !== ref.quote || importRef.version !== input.version) throw new Error("导入依据已变化，请重新选择范围");
          start += importedMaterial.importDocumentOffset || 0;
        } else if (input.origin === "current" && session.materialId) {
          source = db.sources.find(function (item) { return item.id === card.sourceSnapshot.sourceId; });
          const material = db.materials.find(function (item) { return item.id === session.materialId; });
          const localStart = start - material.documentOffset;
          if (material.text.slice(localStart, localStart + ref.quote.length) !== ref.quote || (material.documentVersion || material.version) !== input.version) throw new Error("目标依据已变化，请重新生成并核验");
        } else if (ref.evidenceId === "material" || input.origin === "current" && !session.materialId) {
          source = db.sources.find(function (item) { return item.id === card.sourceSnapshot.sourceId; });
          const doc = db.documents.find(function (item) { return item.id === source.documentId; });
          if (doc) {
            const text = session.material.text;
            let base = doc.content.indexOf(text);
            const range = session.source.range;
            if (range && doc.content.slice(range.start, range.end).trim() === text) base = range.start + doc.content.slice(range.start, range.end).indexOf(text);
            start += base;
          }
        } else {
          source = db.sources.find(function (item) { return item.documentId === input.documentId; });
          const doc = db.documents.find(function (item) { return item.id === input.documentId; });
          if (doc && (doc.content.slice(start, ref.endCharacter) !== ref.quote || source.version !== input.version)) throw new Error("相关来源已变化，请重新生成并核验");
          if (!source) {
            source = { id: modules.schema.sourceId(input.documentId), documentId: input.documentId, version: input.version, title: input.title, type: input.sourceType,
              url: input.sourceUrl, status: "removed", retention: "excerpt", scope: "selected_text" };
            db.sources.push(source);
          }
        }
        card.citations.push({ id: "citation_" + session.id + "_" + index, chunkId: "chunk_" + (input.chunkId || session.id + "_" + index), claim: ref.claim,
          source: { documentId: source.documentId, sourceId: source.id, version: input.version || source.version, title: source.title, type: source.url ? "webpage" : ["pdf", "docx"].includes(source.type) ? source.type : "text", sourceUrl: source.url || null, selectionId: importRef?.selectionId || input.selectionId || null },
          headingPath: input.headingPath || [], quote: ref.quote, position: { startCharacter: start, endCharacter: start + ref.quote.length, pageNumber: input.pageNumber || null, locator: input.locator || null } });
      });
      if (card.sourceSnapshot) card.sourceSnapshot.excerpt = (refs.find(function (item) {
        return item.evidenceId === "material" || session.context.evidence.some(function (input) { return input.id === item.evidenceId && input.origin === "current"; });
      }) || {}).quote || "";
      card.source = "";
      card.sourceIds = modules.schema.cardSourceIds(card);
    }

    function discardGachaCardDraft(draftId) {
      return Promise.resolve(mutate(function (db) {
        db.drafts = db.drafts.filter(function (draft) { return draft.id !== draftId || draft.status === "confirmed"; });
        return { discardedId: draftId, requestId: requestId() };
      }));
    }

    function removeCardSourceInfo(cardId) {
      return Promise.resolve(mutate(function (db) {
        const card = db.learningState.cards.find(function (item) { return item.id === cardId; });
        if (!card) throw new Error("卡片不存在");
        card.citations = [];
        card.sourceSnapshot = null;
        card.sourceIds = [];
        card.source = "";
        card.visualEvidence = [];
        db.drafts.forEach(function (draft) { if (draft.savedCardId === cardId) draft.card = utils.clone(card); });
        db.version += 1;
        return { card: card, state: utils.clone(db.learningState), requestId: requestId() };
      }));
    }

    function deleteCards(cardIds, options) {
      return Promise.resolve(mutate(function (db) {
        const ids = new Set(cardIds);
        const removed = db.learningState.cards.filter(function (card) { return ids.has(card.id); });
        db.learningState.cards = db.learningState.cards.filter(function (card) { return !ids.has(card.id); });
        if (options && options.removeUnusedSources) {
          const referenced = new Set([].concat(db.learningState.cards, db.learningState.pending || []).flatMap(modules.schema.cardSourceIds));
          removed.flatMap(modules.schema.cardSourceIds).forEach(function (id) {
            const source = db.sources.find(function (item) { return item.id === id; });
            if (source && !referenced.has(id)) modules.schema.removeFullSource(db, source.documentId);
          });
        }
        db.version += 1;
        return { state: utils.clone(db.learningState), requestId: requestId() };
      }));
    }

    function loadLearningState() {
      const db = readDb();
      return Promise.resolve({ state: Object.assign(utils.clone(db.learningState), { exercises: utils.clone(db.exercises) }), version: db.version, requestId: requestId() });
    }

    function setCardFavorite(cardId, favorite, mutationId) {
      return Promise.resolve(mutate(function (db) {
        if (typeof favorite !== "boolean") throw new Error("收藏状态无效");
        const card = db.learningState.cards.find(function (item) { return item.id === cardId; });
        if (!card) throw new Error("卡片不存在或已删除，请刷新卡册");
        if (Boolean(card.favorite) !== favorite) {
          card.favorite = favorite;
          card.updatedAt = now();
          modules.memory.recordLearningEventInDb(db, { eventId: (mutationId || utils.id("favorite")) + ":" + cardId,
            type: favorite ? "card_favorited" : "card_unfavorited", cardId: cardId, learningUnitId: card.learningUnitId,
            topicId: card.topicId, topicLabel: card.title }, now());
          db.version += 1;
        }
        return { card: utils.clone(card), state: Object.assign(utils.clone(db.learningState), { exercises: utils.clone(db.exercises) }), requestId: requestId() };
      }));
    }

    function openPendingCard(cardId) {
      return Promise.resolve(mutate(function (db) {
        const pending = db.learningState.pending.find(function (item) { return item.id === cardId; });
        let card = db.learningState.cards.find(function (item) { return item.id === cardId; });
        if (!pending && !card) throw new Error("待打开卡片不存在或已移除，请刷新卡册");
        if (pending) {
          db.learningState.pending = db.learningState.pending.filter(function (item) { return item.id !== cardId; });
          if (!card) {
            card = cardDomain.sanitizeCard(pending);
            db.learningState.cards.unshift(card);
            db.learningState.totalDraws = Math.max(0, Number(db.learningState.totalDraws) || 0) + 1;
          }
          modules.schema.upgradeDb(db);
          db.version += 1;
        }
        return { card: utils.clone(card), state: Object.assign(utils.clone(db.learningState), { exercises: utils.clone(db.exercises) }), requestId: requestId() };
      }));
    }

    function migrateLocalStorage(state) {
      return Promise.resolve(mutate(function (db) {
        const applied = db.migrations.includes("local_storage_v1");
        if (!applied) {
          db.learningState = utils.clone(state);
          modules.schema.upgradeDb(db);
          db.version += 1;
          db.migrations.push("local_storage_v1");
        }
        return { alreadyApplied: applied, imported: { cards: state.cards.length, pending: state.pending.length }, state: utils.clone(db.learningState), version: db.version, requestId: requestId() };
      }));
    }

    function replaceLearningState(state, mutationId) {
      return Promise.resolve(mutate(function (db) {
        const previous = new Map((db.learningState.cards || []).map(function (card) { return [card.id, Boolean(card.favorite)]; }));
        db.learningState = utils.clone(state);
        delete db.learningState.exercises;
        modules.schema.upgradeDb(db);
        db.learningState.cards.forEach(function (card) {
          if (!previous.has(card.id) || previous.get(card.id) === Boolean(card.favorite)) return;
          modules.memory.recordLearningEventInDb(db, {
            eventId: (mutationId || "favorite:" + now()) + ":" + card.id,
            type: card.favorite ? "card_favorited" : "card_unfavorited",
            cardId: card.id,
            learningUnitId: card.learningUnitId,
            topicId: card.topicId,
            topicLabel: card.title
          }, now());
        });
        db.version += 1;
        return { state: utils.clone(db.learningState), version: db.version, requestId: requestId() };
      }));
    }

    const discoveryService = modules.discovery.createDiscoveryService(Object.assign({}, serviceContext, {
      embedding: embedding,
      checkGachaCardSources: ragService.checkGachaCardSources,
      createGachaCardDraft: createGachaCardDraft,
      planDiscoveryCandidates: planDiscoveryCandidates,
      learningContextForDb: modules.memory.learningContextForDb,
      recordLearningEventInDb: modules.memory.recordLearningEventInDb,
      applyExplicitFeedbackInDb: modules.memory.applyExplicitFeedbackInDb,
      recordDiscoveryRun: function (db, pool, status, generation) {
        modules.observability.recordRun(db, pool.runId, "gacha-discovery", status, pool.createdAt, generation?.elapsedMs || 0, generation?.calls || 1,
          { source: "extension_workflow", operation: "discovery_plan", promptVersion: generation?.promptVersion, durationBasis: "generation_elapsed", occurredAt: now(), errorCode: status === "failed" ? "discovery_generation_failed" : null });
        const run = db.runs.find(function (item) { return item.id === pool.runId; });
        if (run) Object.assign(run, { usage: generation?.usage || null, model: generation?.model || null,
          planVersion: generation?.planVersion || modules.discoveryPlanner.PLAN_VERSION,
          promptVersion: generation?.promptVersion || modules.discoveryPlanner.PROMPT_VERSION,
          candidateCount: pool.candidates.length });
      }
    }));

    const multiCardService = modules.multiCard.createMultiCardService(Object.assign({}, serviceContext, {
      storage: storage, lockNamespace: store.databaseKey, task: modules.skills.loadTask("knowledge-plan"), transport: transport,
      getModelConfig: getModelConfig, cardDomain: cardDomain, qualityService: qualityService,
      findSourceEvidence: ragService.findSourceEvidence, confirmDraft: confirmGachaCardDraft,
      learningContextForDb: modules.memory.learningContextForDb,
      recordGeneration: function (db, draft) { modules.observability.recordRun(db, utils.id("run"), "concept-card", draft.status === "ready" ? "completed" : "failed", now() - draft.generation.elapsedMs, draft.generation.elapsedMs, 0,
        { source: "extension_workflow", operation: "generate_plan_card", promptVersion: draft.generation.promptVersion, durationBasis: "generation_elapsed", occurredAt: now(), errorCode: draft.status === "ready" ? null : "card_quality_not_ready" }); }
    }));

    const companionService = modules.companion.createLearningCompanion(Object.assign({}, serviceContext, {
      id: utils.id, namespace: store.databaseKey, flush: store.flush, transport: transport, getModelConfig: getModelConfig,
      companionContextOptions: settings.companionContextOptions,
      searchKnowledge: function (query, input) { return knowledge.search(query, input); },
      learningContextForDb: modules.memory.learningContextForDb, createCardDraft: createGachaCardDraft,
      createPreferenceMemory: memoryService.createPreferenceMemory, recordRun: modules.observability.recordRun
    }));
    const service = Object.assign({}, multiCardService, importService, companionService, {
      baseUrl: "extension://application",
      profileId: settings.profileId || "",
      health: function () { return Promise.resolve({ status: "ok", service: "extension-application", version: "1.1.0", modelConfigured: Boolean(getModelConfig() && getModelConfig().apiKey) }); },
      testModelConnection: testModelConnection,
      generateCard: generateCard,
      checkGachaCardSources: ragService.checkGachaCardSources,
      createGachaCardDraft: createGachaCardDraft,
      listGachaCardDrafts: listGachaCardDrafts,
      getGachaCardDraft: getGachaCardDraft,
      updateGachaCardDraft: updateGachaCardDraft,
      reviseGachaCardDraft: reviseGachaCardDraft,
      confirmGachaCardDraft: confirmGachaCardDraft,
      discardGachaCardDraft: discardGachaCardDraft,
      saveGachaMaterialDraft: saveGachaMaterialDraft,
      removeCardSourceInfo: removeCardSourceInfo,
      deleteCards: deleteCards,
      listGachaDiscoveryPools: discoveryService.listGachaDiscoveryPools,
      createGachaDiscoveryPool: discoveryService.createGachaDiscoveryPool,
      openGachaDiscoveryCandidate: discoveryService.openGachaDiscoveryCandidate,
      sendGachaDiscoveryFeedback: discoveryService.sendGachaDiscoveryFeedback,
      ingestDocument: ragService.ingestDocument,
      listDocuments: ragService.listDocuments,
      getDocument: ragService.getDocument,
      updateDocument: ragService.updateDocument,
      deleteDocument: ragService.deleteDocument,
      getFilesystemSourceCapabilities: function () { return Promise.reject(new Error("纯扩展模式请使用文件选择器添加资料")); },
      importFilesystemSource: function () { return Promise.reject(new Error("纯扩展不能直接读取任意本机路径")); },
      searchKnowledge: async function (input) { const result = await knowledge.search(input?.query, input || {}); return { results: result.results.map(modules.tools.knowledgeResult), trace: result.trace, requestId: requestId() }; },
      searchCards: async function (input) { return knowledge.search(input?.query, { type: "card", limit: Number.MAX_SAFE_INTEGER }); },
      resolveCitation: ragService.resolveCitation,
      listMcpAudit: mcpService.listMcpAudit,
      getObservabilityDashboard: observabilityService.getObservabilityDashboard,
      getAgentTrace: observabilityService.getAgentTrace,
      runAgent: agentService.runAgent,
      continueAgent: agentService.continueAgent,
      loadLearningState: loadLearningState,
      setCardFavorite: setCardFavorite,
      openPendingCard: openPendingCard,
      migrateLocalStorage: migrateLocalStorage,
      replaceLearningState: replaceLearningState,
      clearAllData: async function () { await importService.stopImports(); store.clear(); await store.flush(); if (repository) { storage.removeItem(store.databaseKey); await repository.clear(); } return { cleared: true, requestId: requestId() }; },
      listConceptMasteries: memoryService.listConceptMasteries,
      planWeakPointReview: reviewService.planWeakPointReview,
      getGachaReview: reviewService.getGachaReview,
      openGachaReview: reviewService.openGachaReview,
      answerGachaReview: reviewService.answerGachaReview,
      getGachaReviewHint: reviewService.getGachaReviewHint,
      revealGachaReviewAnswer: reviewService.revealGachaReviewAnswer,
      setGachaReviewGoal: reviewService.setGachaReviewGoal,
      continueGachaReview: reviewService.continueGachaReview,
      deferGachaReview: reviewService.deferGachaReview,
      correctGachaReviewEvent: reviewService.correctGachaReviewEvent,
      getGachaReviewEvidence: reviewService.getGachaReviewEvidence,
      createGachaReviewVariant: createGachaReviewVariant,
      listPreferenceMemories: memoryService.listPreferenceMemories,
      getDiscoveryInterests: memoryService.getDiscoveryInterests,
      saveDiscoveryInterests: memoryService.saveDiscoveryInterests,
      createPreferenceMemory: memoryService.createPreferenceMemory,
      updatePreferenceMemory: memoryService.updatePreferenceMemory,
      deletePreferenceMemory: memoryService.deletePreferenceMemory,
      getLearningContext: memoryService.getLearningContext,
      recordLearningEvent: memoryService.recordLearningEvent,
      clearRecentLearningContext: memoryService.clearRecentLearningContext,
      listMemoryCandidates: memoryService.listMemoryCandidates,
      confirmMemoryCandidate: memoryService.confirmMemoryCandidate,
      ignoreMemoryCandidate: memoryService.ignoreMemoryCandidate
    });
    service.dispose = function () { companionService.dispose(); knowledge.dispose(); importService.dispose(); };
    if (!repository) return service;
    const pendingDiscoveryOpens = new Map();
    const materialMethods = ["createKnowledgePlan", "createGachaCardDraft", "saveGachaMaterialDraft", "generateCard"];
    const cleanupMethods = ["confirmGachaCardDraft", "confirmCardBatch", "deleteDocument", "updateDocument", "deleteCards", "discardGachaCardDraft", "discardKnowledgePlan"];
    Object.keys(service).forEach(function (name) {
      const operation = service[name];
      if (typeof operation !== "function") return;
      if (name === "dispose") return;
      service[name] = function (...args) {
        const perform = function () { return store.run(async function () {
        if (materialMethods.includes(name) && args[0]?.source?.importRef) args[0] = await importService.validateImportedMaterial(args[0]);
        const result = await operation(...args);
        await store.flush();
        if (["createKnowledgePlan", "createGachaCardDraft", "saveGachaMaterialDraft"].includes(name) && args[0]?.source?.importRef) await importService.discardDocumentImport(args[0].source.importRef.importId);
        if (cleanupMethods.includes(name)) {
          await importService.collectUnusedAssets();
          try { await knowledge.prune(); } catch (_) { /* Derived index cleanup retries later; the business commit already succeeded. */ }
        }
        return result;
        }, name === "clearAllData"); };
        if (name !== "openGachaDiscoveryCandidate" || !globalThis.navigator?.locks) return perform();
        const key = args[0] + ":" + args[1];
        if (pendingDiscoveryOpens.has(key)) return pendingDiscoveryOpens.get(key);
        // Read the latest snapshot after acquiring the lock; retain it through
        // the final flush so another page cannot regenerate an unsaved result.
        const opening = navigator.locks.request(store.databaseKey + ":discovery_open:" + key, { ifAvailable: true }, function (lock) {
          if (!lock) throw new Error("这条候选正在另一个窗口打开，请稍后查看");
          return perform();
        }).finally(function () { pendingDiscoveryOpens.delete(key); });
        pendingDiscoveryOpens.set(key, opening);
        return opening;
      };
    });
    return service;
  }

  return { DB_KEY: modules.store.DB_KEY, SKILLS: modules.skills.SKILLS, createExtensionService: createExtensionService };
});
