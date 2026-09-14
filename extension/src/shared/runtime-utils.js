(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaRuntimeUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function id(prefix) {
    const token = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "")
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
    return prefix + "_" + token;
  }

  function stableToken(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0").repeat(4);
  }

  function memoryStorage() {
    const data = {};
    return {
      getItem: function (key) { return Object.hasOwn(data, key) ? data[key] : null; },
      setItem: function (key, value) { data[key] = String(value); },
      removeItem: function (key) { delete data[key]; }
    };
  }

  function localDay(timestamp) {
    const date = new Date(timestamp);
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }

  function similarity(left, right) {
    const a = new Set(String(left || "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const b = new Set(String(right || "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    if (!a.size || !b.size) return 0;
    let hit = 0;
    a.forEach(function (token) { if (b.has(token)) hit += 1; });
    return hit / Math.max(1, Math.min(a.size, b.size));
  }

  function normalizedMaterialText(input) {
    return String(input && input.text || input && input.source && input.source.title || "图片信息").trim();
  }

  function cardPrompt() {
    const task = typeof module === "object" && module.exports ? require("../harness/skills/definitions/concept-card/task.js") : globalThis.KnowledgeGachaConceptCardTask;
    return task.instructions;
  }

  function publicDocument(document) {
    const copy = clone(document);
    delete copy.content;
    delete copy.blocks;
    return copy;
  }

  return {
    cardPrompt: cardPrompt,
    clone: clone,
    id: id,
    localDay: localDay,
    memoryStorage: memoryStorage,
    normalizedMaterialText: normalizedMaterialText,
    publicDocument: publicDocument,
    similarity: similarity,
    stableToken: stableToken
  };
});
