// Authored flow fixtures, not a semantic-quality evaluation.
const { qualityOutput } = require("./quality-output.js");

function planOutput(payload) {
  if (payload.operation === "transcribe") return { transcription: "# 图片中的成本\n每多生产一个单位额外增加的成本。", unreadable: ["右下角模糊数字"] };
  const groups = new Map();
  for (const chunk of payload.chunks) {
    const title = chunk.headingPath.at(-1) || "材料主题";
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(chunk.id);
  }
  const units = [...groups].map(([title, evidenceIds], ordinal) => {
    const existing = payload.existingUnits?.find(unit => unit.title === title);
    const related = payload.relatedCards?.find(card => card.title === title);
    return { key: "goal_" + ordinal, title, learningObjective: "能解释" + title + "在决策中的作用", evidenceIds,
      importance: "core", matchesUnitId: existing?.id || null, relatedCardId: related?.id || null,
      relationToCard: related ? "same_goal" : "different", reason: "材料中的核心学习目标", supplementalEvidenceIds: [] };
  });
  return { overview: [...groups.keys()].join("、"), units, coverage: payload.chunks.map(chunk => ({ chunkId: chunk.id,
    unitKeys: units.filter(unit => unit.evidenceIds.includes(chunk.id)).map(unit => unit.key), reason: "" })),
    relations: units.length > 1 ? [{ fromKey: units[0].key, toKey: units[1].key, type: "comparison" }] : [] };
}

function batchQualityOutput(payload) {
  const sources = payload.sources || [];
  const preferred = sources.find(source => source.kind === "text" && !/^\s*#/.test(source.text)) || sources[0];
  const result = qualityOutput({ ...payload, sources: preferred ? [preferred, ...sources.filter(source => source !== preferred)] : sources });
  if (payload.operation !== "review" && result.card) {
    const goal = payload.userGoal.split("\n")[0];
    result.card.learningObjective = goal;
    result.card.title = goal.replace(/^能解释/, "").replace(/在决策中的作用$/, "").slice(0, 80);
  }
  return result;
}

module.exports = { planOutput, batchQualityOutput };
