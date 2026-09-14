(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const api = factory(commonJs ? require("./discovery-planner.js") : root.KnowledgeGachaDiscoveryPlanner,
    commonJs ? require("../../../shared/rag/hybrid-retriever.js") : root.KnowledgeGachaHybridRetriever);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaDiscoveryRanking = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (planner, hybrid) {
  "use strict";
  const VERSION = "discovery-ranking-v1";
  const DUPLICATE_THRESHOLD = 0.8;
  const WEIGHTS = { source: 18, card: 8, novelty: 18, difficultyStep: 24, downrank: 80, familiarity: 70, diversity: 35 };

  // Repeating a sentence must not improve its score or alter its embedding.
  function text(value) {
    let normalized = String(value || "").normalize("NFKC").trim();
    const period = normalized ? (normalized + normalized).indexOf(normalized, 1) : 0;
    if (period > 0 && period < normalized.length) normalized = normalized.slice(0, period);
    return Array.from(new Set(normalized.split(/[。！？!?；;\n]+/)
      .map(function (part) { return part.trim(); }).filter(Boolean))).join("。 ").slice(0, 600);
  }
  function targetText(item) { return text((item.topic || item.title || "") + "。" + (item.learningObjective || "")); }
  function lexicalSimilarity(a, b) {
    function grams(value) {
      const normalized = planner.semanticText(value);
      return new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, function (_, index) { return normalized.slice(index, index + 2); }));
    }
    const left = grams(a), right = grams(b);
    let overlap = 0;
    left.forEach(function (term) { if (right.has(term)) overlap += 1; });
    return left.size && right.size ? overlap / Math.sqrt(left.size * right.size) : 0;
  }
  function comparison(vectors, strategy) {
    function similarity(a, b) {
      const left = text(a), right = text(b);
      if (!left || !right) return 0;
      if (planner.semanticText(left) === planner.semanticText(right)) return 1;
      return vectors.has(left) && vectors.has(right)
        ? Math.max(0, Math.min(1, hybrid.cosine(vectors.get(left), vectors.get(right)))) : lexicalSimilarity(left, right);
    }
    return { strategy: strategy, similarity: similarity,
      sameTarget: function (a, b) {
        if (a.conceptKey && a.conceptKey === b.conceptKey) return true;
        const left = targetText(a), right = targetText(b);
        const lexicalMatch = lexicalSimilarity(a.topic || a.title, b.topic || b.title) >= 0.86 && lexicalSimilarity(left, right) >= 0.86;
        // Shared question templates do not make two different interests the same subject.
        const differentSubjects = a.seedAnchor && b.seedAnchor && a.baseTopicId && b.baseTopicId && a.baseTopicId !== b.baseTopicId
          && similarity(a.seedAnchor, b.seedAnchor) < 0.65;
        if (differentSubjects) return false;
        return lexicalMatch || (vectors.has(left) && vectors.has(right) && similarity(left, right) >= DUPLICATE_THRESHOLD
          && similarity(a.learningObjective, b.learningObjective) >= 0.7);
      } };
  }
  function lexicalComparison() { return comparison(new Map(), "lexical"); }
  async function prepare(request, outlines, embedding) {
    if (!embedding) return lexicalComparison();
    const texts = new Set();
    function add(value) { const normalized = text(value); if (normalized) texts.add(normalized); }
    function addTarget(item) { add(targetText(item)); add(item.learningObjective); add(item.seedAnchor); }
    outlines.forEach(function (item) { addTarget(item); add(item.newKnowledge); });
    request.seeds.forEach(function (seed) { add(seed.baseSummary); add(seed.anchor); });
    [].concat(request.exclusions.existing || [], request.exclusions.seenTargets || []).forEach(addTarget);
    const values = Array.from(texts), vectors = new Map();
    try {
      for (let index = 0; index < values.length; index += 8) {
        const batch = values.slice(index, index + 8), output = await embedding.embed(batch);
        if (!Array.isArray(output) || output.length !== batch.length || output.some(function (vector) {
          return !vector || vector.length !== embedding.dimensions || !Array.from(vector).every(Number.isFinite) || !Array.from(vector).some(function (value) { return value !== 0; });
        })) throw new Error("Invalid discovery vectors");
        batch.forEach(function (value, offset) { vectors.set(value, output[offset]); });
      }
      return comparison(vectors, "local-semantic");
    } catch (_) {
      // Discard partial inference so candidate order never depends on which batch failed.
      return comparison(new Map(), "lexical-fallback");
    }
  }
  function score(outline, seed, flags, similarities) {
    const levels = ["foundation", "standard", "challenge"];
    const distance = flags.targetDifficulty ? Math.abs(levels.indexOf(outline.difficulty) - levels.indexOf(flags.targetDifficulty)) : 0;
    const novelty = seed.baseSummary ? Math.round(WEIGHTS.novelty * (1 - similarities.similarity(outline.newKnowledge, seed.baseSummary))) : 0;
    const components = {
      base: seed.baseScore,
      source: seed.evidenceStatus === "saved_source" ? WEIGHTS.source : seed.evidenceStatus === "card_extension" ? WEIGHTS.card : 0,
      novelty: novelty,
      difficulty: -WEIGHTS.difficultyStep * distance,
      downrank: flags.downranked ? -WEIGHTS.downrank : 0,
      familiarity: flags.familiar && outline.difficulty === "foundation" ? -WEIGHTS.familiarity : 0
    };
    return { score: Object.values(components).reduce(function (sum, value) { return sum + value; }, 0), components: components };
  }
  function diversityPenalty(candidate, selected, similarities) {
    return selected.reduce(function (penalty, item) {
      const sameTopic = item.seedId === candidate.seedId || item.topicId === candidate.topicId
        || (item.baseTopicId && item.baseTopicId === candidate.baseTopicId);
      const relatedness = similarities.similarity(targetText(item), targetText(candidate));
      return Math.max(penalty, sameTopic ? WEIGHTS.diversity : Math.round(WEIGHTS.diversity * Math.max(0, (relatedness - 0.45) / 0.55)));
    }, 0);
  }
  return { VERSION: VERSION, DUPLICATE_THRESHOLD: DUPLICATE_THRESHOLD, targetText: targetText,
    prepare: prepare, lexicalComparison: lexicalComparison, score: score, diversityPenalty: diversityPenalty };
});
