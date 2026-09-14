(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaCardDomain = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COLORS = ["#ff6f61", "#63d8ad", "#ffd84d", "#72a7ff", "#ff8aa1"];

  function contextNow(context) {
    if (context && typeof context.now === "function") return Number(context.now());
    if (context && Number.isFinite(context.now)) return Number(context.now);
    return Date.now();
  }

  function contextRandom(context) {
    if (context && typeof context.random === "function") return Number(context.random());
    return Math.random();
  }

  function contextColors(context) {
    return context && Array.isArray(context.colors) && context.colors.length ? context.colors : COLORS;
  }

  function parseCardsResponse(content, rawText, context) {
    const payload = extractJson(content);
    let cards = payload.cards || payload.data || payload.result || payload.items || payload;
    if (!Array.isArray(cards) && cards && typeof cards === "object") cards = [cards];
    if (!Array.isArray(cards) || !cards.length) throw new Error("模型没有生成卡片");
    if (cards.length > 1) throw new Error("材料包含多个知识点，待拆分；请选择一个学习目标");
    return cards.map(function (card, index) {
      return normalizeCard(card, rawText, index, context);
    });
  }

  function parseSampleSuggestions(content) {
    const payload = extractJson(content);
    const items = payload.samples || payload.items || payload.data || payload.cards || payload.result;
    if (!Array.isArray(items) || items.length < 3) throw new Error("模型没有返回 3 条知识点");
    return items.slice(0, 3).map(function (item) {
      const title = normalizeText(firstValue(item, ["title", "t", "name", "topic"])).slice(0, 18);
      const text = normalizeText(firstValue(item, ["text", "content", "c", "summary", "explanation"])).slice(0, 240);
      if (title.length < 2 || text.length < 24) throw new Error("模型返回的知识点不完整");
      return { title: title, text: text };
    });
  }

  function normalizeCard(card, rawText, index, context) {
    const now = contextNow(context);
    const colors = contextColors(context);
    const source = normalizeText(firstValue(card, ["source", "src", "来源", "原文", "片段"]) || rawText).slice(0, 120);
    const title = normalizeText(firstValue(card, ["title", "t", "标题", "知识点", "name"]));
    const options = normalizeOptions(firstValue(card, ["options", "o", "选项", "choices", "answers"]));
    const correctIndex = parseCorrectIndex(firstValue(card, ["correctIndex", "correct_index", "answerIndex", "c", "answer", "正确选项", "答案"]), options);
    return sanitizeCard({
      id: `ai_${now}_${Math.floor(contextRandom(context) * 1000)}`,
      title: title,
      source: source,
      color: colors[index % colors.length],
      summary: normalizeText(firstValue(card, ["summary", "s", "解释", "简述", "description"])),
      analogy: normalizeText(firstValue(card, ["example", "e", "lifeExample", "analogy", "a", "例子", "生活例子", "类比", "比喻"])),
      mantra: normalizeText(firstValue(card, ["mantra", "m", "口诀", "记忆点", "一句话"])),
      plainSummary: normalizeText(firstValue(card, ["plainSummary", "plain", "p", "人话", "说人话", "人话解释"])).slice(0, 96),
      question: normalizeText(firstValue(card, ["question", "q", "题目", "quiz"])),
      options: options,
      correctIndex: correctIndex,
      citations: firstValue(card, ["citations", "引用", "evidence"]),
      favorite: false,
      mastery: 0,
      reviewCount: 0,
      createdAt: now,
      updatedAt: now,
      dueAt: now
    }, context);
  }

  function generateLocalCard(rawText, image, context) {
    const text = normalizeText(rawText || "");
    const sentence = splitSentences(text)[0] || (image ? "这张图片里的信息需要先被整理成一个可复习的知识点。" : "今天遇到的新知识，还没有被整理成一句话。");
    const keyword = pickKeywords(text)[0] || (image ? "图片信息" : "知识点");
    const title = compactTitle(keyword, "知识点");
    const now = contextNow(context);
    const colors = contextColors(context);
    const correctIndex = now % 3;
    const correct = `用自己的话解释「${title}」`;
    const options = ["只把名词背下来", correct, "先收藏以后再说"];
    const ordered = rotateToIndex(options, 1, correctIndex);
    return sanitizeCard({
      id: `demo_${now}_${Math.floor(contextRandom(context) * 1000)}`,
      title: title,
      source: sentence.slice(0, 120),
      color: colors[now % colors.length],
      summary: `「${title}」的关键不是记住一个词，而是看懂它解决了什么问题：${shortText(sentence, 42)}`,
      analogy: fallbackAnalogy(title, sentence),
      mantra: fallbackMantra(title, sentence),
      plainSummary: `${title}就是先抓住最有用的那一点，再决定下一步怎么做。`,
      question: `理解「${title}」时最该先做什么？`,
      options: ordered,
      correctIndex: correctIndex,
      favorite: false,
      mastery: 0,
      reviewCount: 0,
      createdAt: now,
      updatedAt: now,
      dueAt: now
    }, context);
  }

  function sanitizeCard(card, context) {
    const now = contextNow(context);
    const colors = contextColors(context);
    const next = Object.assign({
      id: `card_${now}`,
      title: "知识点",
      source: "",
      color: colors[0],
      summary: "",
      analogy: "",
      mantra: "",
      plainSummary: "",
      question: "",
      options: [],
      correctIndex: 0,
      citations: [],
      sourceSnapshot: null,
      favorite: false,
      mastery: 0,
      reviewCount: 0,
      lastCorrectReviewDay: "",
      createdAt: now,
      updatedAt: now,
      dueAt: now
    }, card || {});
    next.title = normalizeText(next.title || "知识点");
    next.source = normalizeText(next.source || "").slice(0, 120);
    next.summary = normalizeText(next.summary || "");
    next.analogy = normalizeText(next.analogy || "");
    next.mantra = normalizeText(next.mantra || "");
    next.plainSummary = normalizeText(next.plainSummary || "").slice(0, 96);
    next.question = normalizeText(next.question || "");
    next.options = normalizeOptions(next.options);
    next.correctIndex = parseCorrectIndex(next.correctIndex, next.options);
    next.citations = normalizeCitations(next.citations, next.contentVersion);
    next.sourceSnapshot = normalizeSourceSnapshot(next.sourceSnapshot);
    next.id = normalizeText(next.id || `card_${now}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || `card_${now}`;
    next.color = /^#[0-9A-Fa-f]{6}$/.test(String(next.color || "")) ? String(next.color) : colors[0];
    next.favorite = Boolean(next.favorite);
    next.mastery = boundedInteger(next.mastery, 0, 5, 0);
    next.reviewCount = boundedInteger(next.reviewCount, 0, Number.MAX_SAFE_INTEGER, 0);
    next.lastCorrectReviewDay = normalizeText(next.lastCorrectReviewDay || "").slice(0, 10);
    if (next.lastCorrectReviewDay && !/^\d{4}-\d{2}-\d{2}$/.test(next.lastCorrectReviewDay)) next.lastCorrectReviewDay = "";
    next.createdAt = nonNegativeTimestamp(next.createdAt, now);
    next.updatedAt = nonNegativeTimestamp(next.updatedAt, next.createdAt);
    next.dueAt = nonNegativeTimestamp(next.dueAt, next.updatedAt);
    return next;
  }

  function normalizeSourceSnapshot(value) {
    if (!value || typeof value !== "object") return null;
    const sourceType = ["selection", "page", "screenshot", "manual", "image", "file", "pdf", "docx"].includes(value.sourceType)
      ? value.sourceType : "manual";
    const title = normalizeText(value.title || "知识素材").slice(0, 512);
    const excerpt = String(value.excerpt || "").trim().slice(0, 240);
    if (!excerpt && !value.sourceId) return null;
    const rawUrl = value.url == null ? "" : String(value.url);
    const url = /^https?:\/\/[^\s]+$/i.test(rawUrl) ? rawUrl : null;
    const documentId = /^doc_[A-Za-z0-9_-]+$/.test(String(value.fullSourceDocumentId || ""))
      ? String(value.fullSourceDocumentId) : null;
    return {
      sourceType: sourceType,
      title: title,
      url: url,
      excerpt: excerpt,
      capturedAt: nonNegativeTimestamp(value.capturedAt, 0),
      fullSourceDocumentId: documentId,
      sourceId: value.sourceId || null,
      sourceVersion: boundedInteger(value.sourceVersion, 1, Number.MAX_SAFE_INTEGER, 1),
      status: ["available", "excerpt_only", "removed", "unavailable"].includes(value.status) ? value.status : "excerpt_only",
      scope: value.scope || "selected_text",
      ...(value.selectionId ? { selectionId: value.selectionId, originalAvailable: value.originalAvailable === true,
        retainedRanges: Array.isArray(value.retainedRanges) ? value.retainedRanges : [] } : {})
    };
  }

  function boundedInteger(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  }

  function nonNegativeTimestamp(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : Math.max(0, Math.floor(Number(fallback) || 0));
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function shortText(text, limit) {
    const normalized = normalizeText(text);
    return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
  }

  function splitSentences(text) {
    return normalizeText(text)
      .split(/[。！？!?；;.\n]/)
      .map(function (item) { return item.trim(); })
      .filter(function (item) { return item.length >= 8; })
      .slice(0, 8);
  }

  function pickKeywords(text) {
    const normalized = normalizeText(text);
    const definedConcepts = [];
    const definitionPattern = /(?:^|[。！？；，,\s])([\u4e00-\u9fff]{2,10})(?:是指|指的是|指|是)/g;
    let match = definitionPattern.exec(normalized);
    while (match) {
      definedConcepts.push(match[1]);
      match = definitionPattern.exec(normalized);
    }
    const english = normalized.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
    const chinese = normalized
      .replace(/[A-Za-z0-9_\-，。！？、；：,.!?;:"'()（）[\]【】]/g, " ")
      .split(/\s+/)
      .map(function (item) { return item.trim(); })
      .filter(function (item) { return item.length >= 2 && item.length <= 10; });
    return Array.from(new Set(definedConcepts.concat(english, chinese))).slice(0, 6);
  }

  function compactTitle(text, fallback) {
    const cleaned = normalizeText(text);
    if (!cleaned) return fallback;
    return cleaned.length > 10 ? `${cleaned.slice(0, 10)}…` : cleaned;
  }

  function fallbackAnalogy(title, source) {
    const safeTitle = shortText(title || "这个点", 10);
    const templates = [
      `像收快递前先看取件码：「${safeTitle}」就是帮你找准下一步的线索。`,
      `像做饭前先尝咸淡：「${safeTitle}」先告诉你问题出在哪，再决定怎么改。`,
      `像出门前看天气：「${safeTitle}」不是名词装饰，而是帮你做判断。`,
      `像整理账单先找最大支出：「${safeTitle}」帮你抓住最该处理的地方。`,
      `像修水管先找漏点：「${safeTitle}」先定位关键问题，再谈解决办法。`
    ];
    return templates[hashText(`${source}${title}`) % templates.length];
  }

  function fallbackMantra(title, source) {
    const safeTitle = shortText(title || "知识点", 8);
    const templates = [
      `${safeTitle}：先问它解决什么。`,
      `记住${safeTitle}的关键条件。`,
      `能举例，才算懂${safeTitle}。`,
      `别背词，先抓${safeTitle}的作用。`,
      `${safeTitle}要和真实场景连上。`
    ];
    return templates[hashText(`${title}${source}`) % templates.length];
  }

  function hashText(text) {
    let hash = 0;
    const normalized = normalizeText(text);
    for (let index = 0; index < normalized.length; index += 1) {
      hash = ((hash * 31) + normalized.charCodeAt(index)) >>> 0;
    }
    return hash;
  }

  function normalizeOptions(options) {
    let source = options;
    if (!Array.isArray(source) && source && typeof source === "object") {
      source = [source.A, source.B, source.C].filter(Boolean);
    }
    if (typeof source === "string") {
      source = source.split(/[|,，、/]/).map(function (item) { return item.trim(); }).filter(Boolean);
    }
    const list = Array.isArray(source) ? source.filter(Boolean).map(function (item) { return normalizeText(item); }) : [];
    return list.slice(0, 5);
  }

  function normalizeCitations(citations, contentVersion) {
    if (!Array.isArray(citations)) return [];
    const seen = new Set();
    // Version 2 keeps field-level links for up to eight distinct passages.
    // Do not discard a valid ninth link when a checked card is saved/reloaded.
    return citations.slice(0, contentVersion === 2 ? 32 : 8).map(normalizeCitation).filter(function (citation) {
      if (!citation || seen.has(citation.id)) return false;
      seen.add(citation.id);
      return true;
    });
  }

  function normalizeCitation(value) {
    if (!value || typeof value !== "object") return null;
    const source = value.source;
    const position = value.position;
    const id = String(value.id || "");
    const chunkId = String(value.chunkId || "");
    const claim = String(value.claim || "");
    const quote = String(value.quote || "");
    const documentId = source && String(source.documentId || "");
    const title = source && normalizeText(source.title || "");
    const type = source && String(source.type || "");
    const sourceUrl = source && source.sourceUrl != null ? String(source.sourceUrl) : null;
    const startCharacter = position && Number(position.startCharacter);
    const endCharacter = position && Number(position.endCharacter);
    const pageNumber = position && position.pageNumber != null ? Number(position.pageNumber) : null;
    const validUrl = sourceUrl === null || /^https?:\/\/[^\s]+$/i.test(sourceUrl);
    if (!/^citation_[A-Za-z0-9_-]+$/.test(id)
      || !/^chunk_[A-Za-z0-9_-]+$/.test(chunkId)
      || !/^doc_[A-Za-z0-9_-]+$/.test(documentId)
      || !["summary", "analogy", "mantra", "question", "card", "exercise", "boundaries", "example"].includes(claim)
      || !["text", "webpage", "pdf", "docx"].includes(type)
      || !title || title.length > 512 || !validUrl
      || !quote.trim() || quote !== quote.trim() || quote.length > 2000
      || !Number.isInteger(startCharacter) || startCharacter < 0
      || !Number.isInteger(endCharacter) || endCharacter <= startCharacter
      || quote.length !== endCharacter - startCharacter
      || (pageNumber !== null && (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100000))) return null;
    const headingPath = Array.isArray(value.headingPath)
      ? value.headingPath.slice(0, 8).map(normalizeText).filter(Boolean).map(function (item) { return item.slice(0, 200); })
      : [];
    return {
      id: id,
      claim: claim,
      chunkId: chunkId,
      source: { documentId: documentId, title: title, type: type, sourceUrl: sourceUrl, sourceId: source.sourceId || null, version: boundedInteger(source.version, 1, Number.MAX_SAFE_INTEGER, 1), selectionId: source.selectionId || null },
      headingPath: headingPath,
      quote: quote,
      position: { startCharacter: startCharacter, endCharacter: endCharacter, pageNumber: pageNumber, locator: normalizeLocator(position.locator) }
    };
  }

  function normalizeLocator(value) {
    if (!value || !["pdf", "docx", "md", "txt"].includes(value.format)) return null;
    const result = { format: value.format, extractionMethod: ["text", "ocr", "ocr_corrected", "manual"].includes(value.extractionMethod) ? value.extractionMethod : "text",
      parserVersion: String(value.parserVersion || "").slice(0, 160), revision: boundedInteger(value.revision, 1, Number.MAX_SAFE_INTEGER, 1) };
    ["pageNumber", "paragraphNumber", "tableNumber", "rowNumber", "columnNumber", "rowSpan", "columnSpan"].forEach(function (key) { if (Number.isInteger(value[key]) && value[key] > 0) result[key] = value[key]; });
    const region = value.region;
    if (region && [region.x, region.y, region.width, region.height].every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= 1.01 && region.y + region.height <= 1.01) result.region = { x: region.x, y: region.y, width: region.width, height: region.height };
    return result;
  }

  function parseCorrectIndex(value, options) {
    if (Number.isInteger(value)) return Math.max(0, Math.min(value, 2));
    const text = normalizeText(value);
    if (/^[ABCabc]$/.test(text)) return text.toUpperCase().charCodeAt(0) - 65;
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return Math.max(0, Math.min(numeric >= 0 && numeric <= 2 ? numeric : numeric - 1, 2));
    const matched = options.findIndex(function (option) { return option === text; });
    return matched >= 0 ? matched : 0;
  }

  function rotateToIndex(options, sourceIndex, targetIndex) {
    const next = options.slice();
    const item = next.splice(sourceIndex, 1)[0];
    next.splice(targetIndex, 0, item);
    return next.slice(0, 3);
  }

  function shuffled(list, random) {
    const next = list.slice();
    const randomValue = typeof random === "function" ? random : Math.random;
    for (let index = next.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(randomValue() * (index + 1));
      const current = next[index];
      next[index] = next[swap];
      next[swap] = current;
    }
    return next;
  }

  function extractJson(content) {
    const cleaned = stripThinking(content).replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const jsonText = findBalancedJson(cleaned);
    if (!jsonText) throw new Error("模型返回不是 JSON");
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) return { cards: parsed };
    return parsed && typeof parsed === "object" ? parsed : {};
  }

  function stripThinking(content) {
    return String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  function findBalancedJson(raw) {
    const text = String(raw || "");
    for (let start = 0; start < text.length; start += 1) {
      const first = text[start];
      if (first !== "{" && first !== "[") continue;
      const stack = [first === "{" ? "}" : "]"];
      let inString = false;
      let escaped = false;
      for (let index = start + 1; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (inString && char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (char === "{" || char === "[") {
          stack.push(char === "{" ? "}" : "]");
          continue;
        }
        if (char === "}" || char === "]") {
          if (stack.pop() !== char) break;
          if (!stack.length) return text.slice(start, index + 1);
        }
      }
    }
    return "";
  }

  function firstValue(source, keys) {
    for (const key of keys) {
      const value = source && source[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return "";
  }

  return {
    COLORS: COLORS,
    compactTitle: compactTitle,
    extractJson: extractJson,
    fallbackAnalogy: fallbackAnalogy,
    fallbackMantra: fallbackMantra,
    findBalancedJson: findBalancedJson,
    firstValue: firstValue,
    generateLocalCard: generateLocalCard,
    hashText: hashText,
    normalizeCard: normalizeCard,
    normalizeCitation: normalizeCitation,
    normalizeCitations: normalizeCitations,
    normalizeOptions: normalizeOptions,
    normalizeText: normalizeText,
    parseCardsResponse: parseCardsResponse,
    parseCorrectIndex: parseCorrectIndex,
    parseSampleSuggestions: parseSampleSuggestions,
    pickKeywords: pickKeywords,
    rotateToIndex: rotateToIndex,
    sanitizeCard: sanitizeCard,
    shortText: shortText,
    shuffled: shuffled,
    splitSentences: splitSentences,
    stripThinking: stripThinking
  };
});
