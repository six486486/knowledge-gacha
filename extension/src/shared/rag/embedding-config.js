(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaEmbeddingConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  return Object.freeze({ model: "bge-small-zh-v1.5", dimensions: 512,
    fingerprint: "bge-small-zh-v1.5:75c43b06:q8:cls:norm:windows-v1",
    queryPrefix: "为这个句子生成表示以用于检索相关文章：",
    windowCharacters: 360, overlapCharacters: 40 });
});
