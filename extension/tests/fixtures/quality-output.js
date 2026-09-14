// Deterministic transport fixture. Semantic verdicts here are not model-quality evidence.
function checksFor(candidate) {
  return ["grounding", "coherence", "objectiveAlignment", "answerCorrectness", "conditions"].map(rule => {
    const check = { rule, passed: true, reason: "Mock 检查结果，仅用于程序回归" };
    if (rule === "answerCorrectness" && candidate?.exercise?.type === "choice") {
      check.optionChecks = candidate.exercise.options.map((_, index) => ({ index, validAnswer: index === candidate.exercise.correctIndex,
        misconceptionCorrect: true, reason: "Mock 逐项结论，不代表模型识错能力" }));
    }
    if (rule === "answerCorrectness" && candidate?.exercise?.type === "recall") {
      check.comparison = { equivalent: true, followsQuestion: true, reason: "Mock 答案比对，仅验证契约" };
    }
    return check;
  });
}
const checks = checksFor({ exercise: { type: "choice", options: ["10 元", "4 元", "扣除全部月租后的收入"], correctIndex: 1 } });
function requestPayload(request) {
  const content = request.messages.at(-1).content;
  return JSON.parse(Array.isArray(content) ? content.find(item => item.type === "text").text : content);
}
// Authored transport verdicts for lifecycle tests, never semantic evaluation.
// Tests with nonstandard choices pass their explicitly authored expected index.
function verificationOutput(payload, correctIndex = 1) {
  if (payload.operation === "observe_image") return { observations: ["图中央的成本条形与数量标签", "测试图注：磁盘保留原数据，用户页已被修改"], legend: [] };
  if (payload.operation === "solve") return { answerable: true, answer: "Mock 独立答案", basis: "Mock 依据，仅用于验证阶段和预算",
    optionJudgments: (payload.options || []).map((option, index) => ({ index, option, valid: index === correctIndex })) };
  return null;
}
function qualityOutput(payload) {
  const verification = verificationOutput(payload);
  if (verification) return verification;
  if (payload.operation === "review") return { findings: [], checks: checksFor(payload.candidate) };
  const sources = payload.sources || payload.evidence; // Request payload or internal validation context.
  if (!sources?.length) return { status: "insufficient_material", issues: ["没有独立依据，请补充材料"], card: null };
  const source = sources[0];
  const quote = source.kind === "image" ? "" : source.text.includes("每多生产一个单位额外增加的成本") ? "每多生产一个单位额外增加的成本" : source.text.slice(0, 180).trim();
  const ref = claim => ({ claim, evidenceId: source.id, quote, observation: source.kind === "image" ? "图中央的成本条形与数量标签" : undefined });
  return { status: "ready", card: { title: "边际成本", learningObjective: "能判断增加一件产品是否值得", knowledgeType: "mechanism",
    summary: "新增一件产品时，应比较这件产品带来的额外成本和额外收益。已发生且无法改变的支出不属于本次增量。",
    example: { type: "example", text: payload.part === "example" ? "加做一份点心，新增收入 8 元而原料 5 元，增量收益为 3 元。" : "再做一杯咖啡，新增收入 10 元而原料 6 元，增量收益为 4 元。", origin: "authored" },
    boundaries: "", analogy: "", mantra: "" },
    exercise: { type: "choice", question: payload.part === "exercise" ? "加做两杯共新增收入 18 元、原料 12 元，净增多少？" : "再做一杯新增收入 10 元、原料 6 元，增量净收益是多少？",
      options: ["10 元", payload.part === "exercise" ? "6 元" : "4 元", "扣除全部月租后的收入"], correctIndex: 1, answer: payload.part === "exercise" ? "6 元" : "4 元",
      answerExplanation: "本次新增收入减去新增原料支出；不重复计入不变的月租。", rubric: ["比较新增部分", "排除不变的历史支出"], misconceptions: ["只计收入，漏掉新增成本", "", "混淆固定历史支出与增量"] },
    evidence: [ref("summary"), ref("exercise")], checks };
}
module.exports = { findings: [], checks, checksFor, requestPayload, qualityOutput, verificationOutput };
