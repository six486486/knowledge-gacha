(function (root, factory) {
  const task = typeof module === "object" && module.exports ? require("./definitions/concept-card/task.js") : root.KnowledgeGachaConceptCardTask;
  const planTask = typeof module === "object" && module.exports ? require("./definitions/knowledge-plan/task.js") : root.KnowledgeGachaKnowledgePlanTask;
  const catalog = typeof module === "object" && module.exports ? require("./skill-catalog.generated.js") : root.KnowledgeGachaSkillCatalog;
  const api = factory(task, planTask, catalog);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaHarnessSkills = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (task, planTask, catalog) {
  "use strict";

  const SKILLS = Object.freeze({
    "concept-card": ["get_learning_context", "search_knowledge", "get_document", "validate_card", "create_card"],
    "plain-explanation": ["get_learning_context", "search_knowledge", "get_document"],
    "weak-point-review": ["get_learning_context", "search_knowledge", "schedule_review"],
    "gacha-discovery": [],
    "citation-check": ["search_knowledge", "get_document"]
  });
  Object.values(SKILLS).forEach(Object.freeze);

  function listSkills() {
    return catalog.map(function (entry) { return { name: entry.name, description: entry.description, mode: entry.metadata.mode, version: entry.metadata.version }; });
  }

  function activate(id) {
    const entry = catalog.find(function (item) { return item.name === id; });
    if (!entry) throw new Error("Skill 不可用：" + id);
    return { name: entry.name, version: entry.metadata.version, mode: entry.metadata.mode, instructions: entry.instructions };
  }

  function routeSkill(text) {
    const value = String(text || "").toLocaleLowerCase();
    if (/引用|来源|依据|citation/.test(value)) return "citation-check";
    if (/复习|薄弱|review/.test(value)) return "weak-point-review";
    if (/卡片|制卡|保存|card/.test(value)) return "concept-card";
    if (/发现|推荐|探索/.test(value)) return "gacha-discovery";
    return "plain-explanation";
  }

  function harnessMessages(userInput, skill, activated) {
    if (!Object.hasOwn(SKILLS, skill)) throw new Error("助手不支持该 Skill：" + skill);
    const active = activated || activate(skill);
    return [
      { role: "system", content: "你运行在浏览器扩展内置 Agent Harness。当前 Skill=" + skill + "。只能调用本轮提供的工具；每次运行最多执行一个工具，获得结果后必须完成文字回答。写工具会由 Harness 强制等待用户确认。不要声称访问了未提供的数据。\n\n" + active.instructions },
      { role: "user", content: String(userInput || "").slice(0, 12_000) }
    ];
  }

  function loadTask(id) {
    const resource = id === "knowledge-plan" ? planTask : id === "concept-card" ? task : null;
    if (!resource) throw new Error("任务资产不可用：" + id);
    const active = activate(id);
    const entry = catalog.find(function (item) { return item.name === id; });
    if (entry.metadata["asset-version"] !== resource.version) throw new Error("Skill 与任务资源版本不一致：" + id);
    const prefix = active.instructions + "\n\n当前操作契约：\n";
    return Object.freeze(Object.assign({}, resource, {
      version: resource.version + "+skill." + active.version,
      instructions: prefix + resource.instructions,
      instructionsFor: resource.instructionsFor ? function (operation, action, issues) { return prefix + resource.instructionsFor(operation, action, issues); } : undefined
    }));
  }
  return { SKILLS: SKILLS, listSkills: listSkills, activate: activate, harnessMessages: harnessMessages, routeSkill: routeSkill, loadTask: loadTask };
});
