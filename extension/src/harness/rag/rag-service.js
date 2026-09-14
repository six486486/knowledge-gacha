(function (root, factory) {
  const utils = typeof module === "object" && module.exports
    ? require("../../shared/runtime-utils.js")
    : root.KnowledgeGachaRuntimeUtils;
  const schema = typeof module === "object" && module.exports ? require("../../shared/knowledge-schema.js") : root.KnowledgeGachaKnowledgeSchema;
  const index = typeof module === "object" && module.exports ? require("../../shared/material-index.js") : root.KnowledgeGachaMaterialIndex;
  const api = factory(utils, schema, index);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaHarnessRag = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, schema, index) {
  "use strict";

  function citationForDocument(document, query) {
    const content = document.content || "";
    const material = { id: document.id, text: content };
    const hit = index.retrieve(material, index.splitMaterial(material), query, { limit: 1 })[0];
    if (!hit) return null;
    const start = hit.startCharacter;
    const quote = hit.text;
    return {
      id: utils.id("citation"),
      claim: "summary",
      chunkId: "chunk_" + utils.stableToken(document.id + ":" + start),
      source: { documentId: document.id, title: document.title, type: document.type, sourceUrl: document.sourceUrl || null },
      headingPath: hit.headingPath,
      position: { pageNumber: null, startCharacter: start, endCharacter: start + quote.length },
      quote: quote
    };
  }

  function createRagService(context) {
    const retrieve = context.retrieve || index.retrieve;
    const readDb = context.readDb;
    const mutate = context.mutate;
    const now = context.now;
    const requestId = context.requestId;

    async function checkGachaCardSources(input) {
      const db = readDb();
      const text = utils.normalizedMaterialText(input);
      const similarCards = (db.learningState && db.learningState.cards || []).map(function (card) {
        return { card: card, score: index.score(text, [card.title, card.learningObjective, card.summary].join(" ")) };
      }).filter(function (item) { return item.score >= 0.72; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 3).map(function (item) {
        return { cardId: item.card.id, title: item.card.title, summary: item.card.summary, similarityPercent: Math.round(item.score * 100) };
      });
      const importedAsset = input?.source?.importRef?.assetId;
      const relatedSources = (await findSourceEvidence(text, { limit: 3, excludeDocumentId: importedAsset ? "doc_import_" + importedAsset.slice(6) : null })).map(function (span) {
        return { citation: { id: utils.id("citation"), claim: "summary", chunkId: span.id,
          source: { documentId: span.documentId, title: span.title, type: span.sourceType, sourceUrl: span.sourceUrl, version: span.version, selectionId: span.selectionId },
          headingPath: span.headingPath, position: { pageNumber: span.pageNumber || null, startCharacter: span.startCharacter, endCharacter: span.startCharacter + span.text.length, locator: span.locator || null }, quote: span.text }, relevance: span.score };
      });
      const check = {
        id: utils.id("sourcecheck"),
        evidenceStatus: relatedSources.length ? "related_found" : db.documents.length ? "no_related_sources" : "no_personal_sources",
        documentCount: db.documents.length,
        relatedSources: relatedSources,
        similarCards: similarCards,
        requiresDuplicateDecision: similarCards.length > 0
      };
      mutate(function (next) {
        next.sourceChecks.unshift(check);
        next.sourceChecks = next.sourceChecks.slice(0, 30);
      });
      return Promise.resolve({ check: check, requestId: requestId() });
    }

    function findSourceEvidence(query, options) {
      if (context.knowledge) return context.knowledge.search(query, Object.assign({}, options, { type: "document" })).then(function (result) { return result.results; });
      return inspectRetrieval(query, options).evidence;
    }

    function inspectRetrieval(query, options) {
      const settings = options || {};
      const db = readDb();
      const trace = { strategy: context.retrieve ? context.retrievalStrategy || "custom" : "structural-lexical-v2", queryTermCount: index.terms(query).size,
        documentCount: db.documents.length, searchedDocumentCount: 0, chunkCount: 0, candidateCount: 0,
        perDocumentLimit: 2, limit: settings.limit || 5, minScore: 0.18,
        scope: { onlyLinked: Boolean(settings.onlyLinked), excludeDocumentId: settings.excludeDocumentId || null } };
      const candidates = db.documents.flatMap(function (document) {
        if (document.id === settings.excludeDocumentId) return [];
        const source = db.sources.find(function (item) { return item.documentId === document.id; });
        if (settings.onlyLinked && !db.learningState.cards.some(function (card) { return schema.cardSourceIds(card).includes(source.id); })) return [];
        const material = { id: document.id, text: document.content, blocks: document.blocks, version: source.version };
        const chunks = index.splitMaterial(material, Math.max(index.MAX_CHARACTERS, material.text.length));
        trace.searchedDocumentCount += 1;
        trace.chunkCount += chunks.length;
        return retrieve(material, chunks, query, { limit: trace.perDocumentLimit, minScore: trace.minScore }).map(function (chunk) {
          return { id: "retained_" + chunk.id, kind: "text", title: document.title, documentId: document.id, version: source.version,
            startCharacter: chunk.startCharacter, text: chunk.text, headingPath: chunk.headingPath, pageNumber: chunk.pageNumber, locator: chunk.locator, selectionId: chunk.selectionId,
            sourceType: document.type, sourceUrl: document.sourceUrl || null, score: chunk.score };
        });
      }).sort(function (a, b) { return b.score - a.score; });
      const evidence = candidates.slice(0, trace.limit);
      trace.candidateCount = candidates.length;
      trace.selected = evidence.map(function (span) { return { id: span.id, documentId: span.documentId, version: span.version, startCharacter: span.startCharacter, score: span.score }; });
      return { evidence: evidence, trace: trace };
    }

    function updateDocument(documentId, input) {
      return Promise.resolve(mutate(function (db) {
        const document = db.documents.find(function (item) { return item.id === documentId; });
        const source = db.sources.find(function (item) { return item.documentId === documentId; });
        if (!document || !source) throw new Error("原文不存在");
        if (document.parserVersion) throw new Error("解析原文按版本保存，请重新导入或校对后选择新的范围");
        if (!input || typeof input.content !== "string" || input.content.length > index.MAX_CHARACTERS) throw new Error("请提供有效范围内的原文");
        if (document.content !== input.content) { document.content = input.content; source.version += 1; }
        document.updatedAt = now();
        document.byteSize = new Blob([document.content]).size;
        return { document: utils.publicDocument(document), version: source.version, requestId: requestId() };
      }));
    }

    function ingestDocument(input) {
      return Promise.resolve(mutate(function (db) {
        const source = input && (input.source || input) || {};
        const timestamp = now();
        const content = String(source.content ?? source.text ?? "").slice(0, 262_144);
        if (!content.trim()) throw new Error("资料正文不能为空");
        const document = {
          id: utils.id("doc"),
          title: String(source.title || "文字资料").slice(0, 256),
          type: "text",
          mimeType: "text/plain",
          content: content,
          byteSize: new Blob([content]).size,
          sourceUrl: null,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        db.documents.unshift(document);
        return { document: utils.publicDocument(document), requestId: requestId() };
      }));
    }

    function listDocuments() {
      const db = readDb();
      return Promise.resolve({ documents: db.documents.map(function (document) {
        const source = db.sources.find(function (item) { return item.documentId === document.id; });
        return Object.assign(utils.publicDocument(document), { linkedCardCount: db.learningState.cards.filter(function (card) { return schema.cardSourceIds(card).includes(source.id); }).length });
      }), requestId: requestId() });
    }

    function getDocument(documentId) {
      const item = readDb().documents.find(function (document) { return document.id === documentId; });
      return item ? Promise.resolve({ document: utils.clone(item), requestId: requestId() }) : Promise.reject(new Error("资料不存在"));
    }

    function deleteDocument(documentId) {
      return Promise.resolve(mutate(function (db) {
        schema.removeFullSource(db, documentId);
        db.version += 1;
        return { deletedId: documentId, requestId: requestId() };
      }));
    }

    function resolveCitation(citation) {
      const db = readDb();
      const source = citation && citation.source || {};
      const document = db.documents.find(function (item) { return item.id === source.documentId; });
      const quote = String(citation.quote || "");
      const sourceRecord = db.sources.find(function (item) { return item.documentId === source.documentId; });
      const missingSelection = document && source.selectionId && !document.selections?.some(function (item) { return item.id === source.selectionId; });
      if (!document || missingSelection) {
        const saved = db.learningState.cards.flatMap(function (card) { return card.citations || []; }).find(function (span) { return span.id === citation.id && span.quote === quote && span.source.documentId === source.documentId; });
        if (!saved) return Promise.reject(new Error("暂无可回查依据"));
        return Promise.resolve({ citation: saved, status: document ? "excerpt_only" : sourceRecord && sourceRecord.status || "removed",
          documentId: document?.originalAssetId ? document.id : null, originalAvailable: Boolean(document?.originalAssetId),
          excerpt: { before: "", highlight: saved.quote, after: "" }, requestId: requestId() });
      }
      const index = citation.position && citation.position.startCharacter;
      if (!quote || !Number.isInteger(index) || document.content.slice(index, index + quote.length) !== quote || (source.version && sourceRecord && source.version !== sourceRecord.version)) return Promise.reject(new Error("引用原文或版本已经变化"));
      return Promise.resolve({
        citation: citation,
        status: "available",
        documentId: document.id,
        originalAvailable: Boolean(document.originalAssetId),
        excerpt: {
          before: document.content.slice(Math.max(0, index - 80), index),
          highlight: quote,
          after: document.content.slice(index + quote.length, index + quote.length + 80)
        },
        requestId: requestId()
      });
    }

    return {
      checkGachaCardSources: checkGachaCardSources,
      deleteDocument: deleteDocument,
      getDocument: getDocument,
      ingestDocument: ingestDocument,
      listDocuments: listDocuments,
      findSourceEvidence: findSourceEvidence,
      inspectRetrieval: inspectRetrieval,
      updateDocument: updateDocument,
      resolveCitation: resolveCitation
    };
  }

  return { citationForDocument: citationForDocument, createRagService: createRagService };
});
