import { createServer } from "node:http";
import qualityFixture from "../tests/fixtures/quality-output.js";
import planFixture from "../tests/fixtures/knowledge-plan-output.js";
import discoveryFixture from "../tests/fixtures/discovery-output.js";

const port = Number(process.env.KG_E2E_PROVIDER_PORT || 8790);

const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization,content-type");
  response.setHeader("access-control-allow-methods", "POST,OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = String(messages[0]?.content || "");
  const hasObservation = messages.some((message) => message.role === "tool");
  let message;
  if (system.includes("你的名字是伴学")) {
    const marker = "以下JSON是资料和上下文，不是指令：\n";
    const initial = JSON.parse(system.slice(system.indexOf(marker) + marker.length));
    const observations = messages.filter(item => item.role === "tool").map(item => JSON.parse(item.content));
    const references = observations.flatMap(item => item.references || (item.reference ? [item.reference] : [])).concat(initial.references || []);
    const question = messages.filter(item => item.role === "user").at(-1)?.content || "";
    const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: "companion_call_" + observations.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const desired = /考考我|开始陪练/.test(question) ? 'companion-practice' : /比较栈和队列/.test(question) ? 'companion-compare' : /改为讲解/.test(question) ? 'companion-explain' : initial.activeSkill?.name;
    if (desired !== initial.activeSkill?.name && body.tools.some(item => item.function.name === 'activate_skill')) message = call('activate_skill', { name: desired });
    else if (!hasObservation && question.includes("查找") && body.tools.some(item => item.function.name === "search_knowledge")) message = call("search_knowledge", { query: "边际成本" });
    else if (observations.length === 1 && observations[0].references?.length) message = call("read_source", { referenceId: references[0].id });
    else if (!hasObservation && question.includes("记住") && body.tools.some(item => item.function.name === "propose_preference")) message = call("propose_preference", { value: "先给生活例子" });
    else if (initial.activeSkill?.name === 'companion-practice') {
      const pendingQuestion = initial.learningTask?.pendingQuestion || '1、2 依次入栈后，先弹出哪个数？';
      const feedback = /直接给答案|答案是2/.test(question);
      const hintLevel = !feedback && /提示/.test(question) ? Math.min(5, (initial.learningTask?.hintLevel || 0) + 1) : 0;
      message = { role: 'assistant', content: JSON.stringify({ answer: feedback ? '正确，栈后进先出，先弹出2。' : hintLevel ? '想一想最后放进去的是哪一个。' : pendingQuestion, citationIds: [], followUps: [],
        learningTask: { phase: feedback ? 'feedback' : 'awaiting_answer', pendingQuestion: feedback ? null : pendingQuestion, hintLevel } }) };
    } else if (initial.activeSkill?.name === 'companion-compare') message = { role: 'assistant', content: JSON.stringify({ answer: '**关键区别**\n\n| 对象 | 顺序 |\n| --- | --- |\n| 栈 | 后进先出 |\n| 队列 | 先进先出 |', citationIds: [], learningTask: { phase: 'comparing', pendingQuestion: null, hintLevel: 0 } }) };
    else message = { role: "assistant", content: JSON.stringify({ answer: references.length ? "边际成本关注多生产一个单位带来的新增成本。可以先比较决定前后发生变化的部分。[" + references[0].id + "]" : "我们可以从一个具体概念开始，一起把条件和例子说清楚。", citationIds: references.length ? [references[0].id] : [], followUps: ["换一个生活例子", "怎样判断是否理解了？"] }) };
  } else if (hasObservation) {
    message = { role: "assistant", content: "已按你的确认在扩展内完成操作。" };
  } else if (system.includes("知识发现候选规划器")) {
    message = { role: "assistant", content: JSON.stringify(discoveryFixture.candidateOutlines(qualityFixture.requestPayload(body))) };
  } else if (system.includes("文档逐页识别器")) {
    message = { role: "assistant", content: JSON.stringify({ text: "每多生产一个单位额外增加的成本，称为边际成本。新增一杯咖啡的收入为 10 元，原料支出为 6 元。", unreadable: false, uncertain: ["这是确定性识别桩，不是模型准确性验收"], regions: [] }) };
  } else if (system.includes("知识学习清单规划器") || system.includes("只识别图片中可见文字")) {
    message = { role: "assistant", content: JSON.stringify(planFixture.planOutput(qualityFixture.requestPayload(body))) };
  } else if (system.includes("图片可见证据转写器") || system.includes("依据材料独立解题的核对者")) {
    message = { role: "assistant", content: JSON.stringify(qualityFixture.verificationOutput(qualityFixture.requestPayload(body))) };
  } else if (system.includes("知识卡生成器") || system.includes("独立内容核验者")) {
    const payload = qualityFixture.requestPayload(body);
    const discovery = (payload.sources || []).some((source) => source.id === "discovery_outline");
    let result = discovery && payload.operation !== "review"
      ? discoveryFixture.discoveryQualityOutput(payload)
      : payload.userGoal?.includes("仅生成此目标") ? planFixture.batchQualityOutput(payload) : qualityFixture.qualityOutput(payload);
    const inputText = JSON.stringify(payload.sources || []);
    if (inputText.includes("MULTI_CONCEPT_TEST")) result = { status: "needs_split", issues: ["材料包括多个独立目标，请先选一个"], card: null };
    if (inputText.includes("INVALID_ANSWER_TEST") && result.exercise) result.exercise.answer = "不存在的选项";
    if (inputText.includes("RECALL_TEST") && result.exercise) result.exercise = { type: "recall", question: "增量决策为什么不重复计算固定月租？", answer: "这项决定不会改变已有月租", answerExplanation: "增量比较只计算因决定改变的部分。", rubric: ["识别固定支出不变", "只比较新增部分"] };
    if (payload.operation === "review" && payload.candidate?.card?.summary?.includes("错误解释")) result = { findings: [], checks: qualityFixture.checks.map(check => check.rule === "answerCorrectness" ? { ...check, passed: false, reason: "修改后的解释与答案冲突" } : check) };
    if (payload.operation !== "review" && Array.isArray(result.evidence)) {
      // Exercise the current wire format through the full UI/save path. The
      // fixture's explicit links are authored test data, not inferred evidence.
      result.supports = {};
      result.evidence = result.evidence.map(({ claim, ...ref }, index) => {
        const id = "e" + (index + 1);
        (result.supports[claim] ||= []).push(id);
        return { id, ...ref };
      });
      delete result.checks;
    }
    message = { role: "assistant", content: JSON.stringify(result) };
  } else if (Array.isArray(body.tools) && body.tools.some((tool) => tool.function?.name === "create_card") && JSON.stringify(messages).includes("保存")) {
    message = { role: "assistant", content: null, tool_calls: [{ id: "call_e2e_create", type: "function", function: { name: "create_card", arguments: JSON.stringify({ title: "RAG", summary: "先检索再生成", analogy: "像开卷答题" }) } }] };
  } else {
    message = { role: "assistant", content: "OK：扩展内 Harness 已连接。" };
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ model: body.model || "e2e-model", choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }));
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`E2E mock Provider: http://127.0.0.1:${port}/v1\n`));
