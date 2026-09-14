(function (root, factory) {
  const cjs = typeof module === "object" && module.exports;
  const api = factory(cjs ? require("../skills/skill-registry.js") : root.KnowledgeGachaHarnessSkills);
  if (cjs) module.exports = api;
  else root.KnowledgeGachaCompanionSkills = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (registry) {
  "use strict";
  const BY_MODE = Object.freeze({ explain: "companion-explain", compare: "companion-compare", practice: "companion-practice" });
  const NAMES = Object.freeze(Object.values(BY_MODE));
  const PHASES = Object.freeze({ "companion-explain": ["explaining", "completed"], "companion-compare": ["comparing", "completed"],
    "companion-practice": ["awaiting_answer", "feedback", "completed"] });
  function catalog() { return registry.listSkills().filter(function (skill) { return NAMES.includes(skill.name); }); }
  function initial(session) {
    const name = BY_MODE[session.mode] || (NAMES.includes(session.learningTask?.skillId) ? session.learningTask.skillId : BY_MODE.explain);
    return registry.activate(name);
  }
  function activate(name, session, turn) {
    if (!NAMES.includes(name)) throw new Error("教学能力不存在，请使用目录中的名称");
    if (session.mode !== "auto" && BY_MODE[session.mode] && BY_MODE[session.mode] !== name) throw new Error("用户已固定教学方式，请在当前方式内回答；用户可切回自动");
    if (name === turn.skill.name) return { skill: turn.skill, alreadyActive: true };
    if (turn.skillActivations >= 1) throw new Error("本轮已经切换教学方式，请完成当前任务后再切换");
    const skill = registry.activate(name);
    turn.skillActivations += 1;
    turn.skill = { name: skill.name, version: skill.version };
    turn.skillInstructions = skill.instructions;
    turn.learningTask = null;
    return { skill: turn.skill, activated: true, note: "宿主已加载教学规则，请据此继续；权限与业务工具预算不变。" };
  }
  function nextTask(output, turn, makeId) {
    const previous = turn.learningTask;
    const data = output.learningTask;
    // Plain explanation/compare responses remain compatible with existing Providers.
    if (data === undefined && turn.skill.name !== BY_MODE.practice) return { skillId: turn.skill.name, skillVersion: turn.skill.version,
      phase: PHASES[turn.skill.name][0], pendingQuestion: null, questionId: null, hintLevel: 0 };
    if (!data || Array.isArray(data) || Object.keys(data).some(function (key) { return !["phase", "pendingQuestion", "hintLevel"].includes(key); }) ||
        !PHASES[turn.skill.name].includes(data.phase)) throw new Error("请返回与当前教学方式一致的 learningTask.phase");
    const question = data.pendingQuestion;
    if (question !== null && (typeof question !== "string" || !question.trim() || question.length > 1200)) throw new Error("pendingQuestion 必须为题目文字（最多1200字）或 null");
    if (!Number.isInteger(data.hintLevel) || data.hintLevel < 0 || data.hintLevel > 5) throw new Error("hintLevel 必须为0到5的整数");
    if (data.phase === "awaiting_answer" ? !question : question !== null || data.hintLevel !== 0) throw new Error("等待作答时必须保留题目；其他阶段清空题目与提示次数");
    const same = Boolean(question && previous?.pendingQuestion === question);
    if (same && data.hintLevel < previous.hintLevel) throw new Error("同一道题不能降低已使用的提示次数");
    if (question && !same && data.hintLevel !== 0) throw new Error("新题目应从0次提示开始");
    function visibleText(value) {
      return value.replace(/\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g, function (_, bold, underline, code) { return bold || underline || code; })
        .replace(/^\s*[-+*]\s+/gm, "").replace(/\s+/g, "");
    }
    if (question && !same && !visibleText(output.answer).includes(visibleText(question))) throw new Error("新题目必须出现在回答正文中（可有Markdown排版），不能只保存在状态里");
    return { skillId: turn.skill.name, skillVersion: turn.skill.version, phase: data.phase, pendingQuestion: question,
      questionId: question ? same ? previous.questionId : makeId("question") : null, hintLevel: data.hintLevel };
  }
  return { BY_MODE: BY_MODE, NAMES: NAMES, catalog: catalog, initial: initial, activate: activate, nextTask: nextTask };
});
