(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;

  const api = factory();
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaQueryAnalyzer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const synonymGroups = [
    ["缓存", "快取", "cache"], ["并发", "同时执行", "concurrency"],
    ["边际成本", "增量成本", "额外成本"], ["召回", "检索命中", "recall"],
    ["幂等", "重复执行", "idempotent"], ["过期时间", "有效期", "ttl"],
    ["事务", "transaction"], ["复习", "回顾", "温习"]
  ];
  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
  const stopWords = new Set(["可以", "一个", "这个", "我们", "什么", "如何", "能够", "解释", "判断", "学习", "内容", "材料", "以及", "进行", "需要", "的", "了", "是", "在", "和", "与", "能", "the", "a", "is", "of", "to", "and"]);

  function normalizeText(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase(); }

  function terms(value) {
    const text = normalizeText(value);
    const words = new Set();
    (text.match(/[a-z0-9_]+/g) || []).forEach(function (word) { if (!stopWords.has(word)) words.add(word); });
    if (segmenter) for (const part of segmenter.segment(text)) {
      if (part.isWordLike && part.segment.length > 1 && !stopWords.has(part.segment)) words.add(part.segment);
    }
    (text.match(/[\u3400-\u9fff]+/g) || []).forEach(function (run) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const word = run.slice(i, i + 2);
        if (!stopWords.has(word)) words.add(word);
      }
    });
    synonymGroups.forEach(function (group, index) {
      if (group.some(function (word) { return text.includes(word); })) words.add("synonym_" + index);
    });
    return words;
  }


  // Frequency-preserving analyzer for BM25. Chinese word segmentation plus
  // bigrams supports unknown compounds; Latin words are counted once (the old
  // Set-based overlap analyzer intentionally keeps its historical behavior).
  function tokens(value) {
    const text = normalizeText(value), words = [];
    (text.match(/[a-z0-9_]+/g) || []).forEach(function (word) { if (!stopWords.has(word)) words.push(word); });
    if (segmenter) for (const part of segmenter.segment(text)) {
      if (part.isWordLike && /[\u3400-\u9fff]/.test(part.segment) && part.segment.length > 2 && !stopWords.has(part.segment)) words.push(part.segment);
    }
    (text.match(/[\u3400-\u9fff]+/g) || []).forEach(function (run) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const word = run.slice(i, i + 2);
        if (!stopWords.has(word)) words.push(word);
      }
    });
    return words;
  }

  return { terms: terms, tokens: tokens, normalizeText: normalizeText };
});
