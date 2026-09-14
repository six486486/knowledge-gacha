(function (root, factory) {
  const commonJs = typeof module === "object" && module.exports;
  const dependencies = commonJs ? {
    skills: require("../skills/skill-registry.js"),
    tools: require("../tools/tool-calling.js")
  } : {
    skills: root.KnowledgeGachaHarnessSkills,
    tools: root.KnowledgeGachaHarnessTools
  };
  const api = factory(dependencies);
  if (commonJs) module.exports = api;
  else root.KnowledgeGachaAgentHarness = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (modules) {
  "use strict";

  function createAgentHarness(context) {
    const transport = context.transport;
    const getModelConfig = context.getModelConfig;
    const readDb = context.readDb;
    const writeDb = context.writeDb;
    const mutate = context.mutate;
    const now = context.now;
    const requestId = context.requestId;
    const cardDomain = context.cardDomain;
    const telemetry = context.telemetry;
    const continuing = new Set();

    async function runAgent(input) {
      const db = readDb();
      const timestamp = now();
      const skill = modules.skills.routeSkill(input && input.userInput);
      const activeSkill = modules.skills.activate(skill);
      const skillRef = { name: skill, version: activeSkill.version };
      const messages = modules.skills.harnessMessages(input && input.userInput, skill, activeSkill);
      const allowed = modules.skills.SKILLS[skill];
      const runId = context.id("run");
      const toolDefinitions = allowed.map(modules.tools.toolDefinition);
      let stepCount = 0;
      try {
        const first = await transport.complete(getModelConfig(), {
          messages: messages,
          tools: toolDefinitions,
          tool_choice: "auto",
          temperature: 0.3
        });

        if (first.toolCalls.length) {
          if (first.toolCalls.length !== 1) throw new Error("扩展 Harness 每轮只允许一个工具调用");
          const call = first.toolCalls[0];
          const toolName = call.function && call.function.name;
          if (!allowed.includes(toolName)) throw new Error("模型请求了当前 Skill 未授权的工具");
          const args = modules.tools.parseToolArguments(call.function && call.function.arguments);
          stepCount = 1;

          if (modules.tools.WRITE_TOOLS.has(toolName)) {
            const approval = {
              id: context.id("approval"),
              runId: runId,
              stepId: context.id("step"),
              toolName: toolName,
              status: "pending",
              reason: "模型希望执行“" + toolName + "”，确认前不会修改本地数据。",
              createdAt: timestamp
            };
            mutate(function (next) {
              next.pendingRuns[runId] = {
                runId: runId,
                skill: skill,
                skillVersion: skillRef.version,
                messages: messages,
                userInput: input.userInput,
                call: call,
                args: args,
                first: first,
                approval: approval,
                model: first.provider.model
              };
              telemetry.recordRun(next, runId, skillRef, "waiting_approval", timestamp, Math.max(0, now() - timestamp), 1, { occurredAt: now() });
              telemetry.recordAudit(next, toolName, "approval_required", true, first.provider.latencyMs, timestamp);
            });
            return telemetry.harnessResponse(runId, skillRef, "waiting_approval", null, approval, first.provider.model, 1, requestId());
          }

          const observation = toolName === "search_knowledge" && context.searchKnowledge
            ? (await context.searchKnowledge(args.query)).results.map(modules.tools.knowledgeResult)
            : await modules.tools.executeReadTool(db, toolName, args, now());
          const final = await transport.complete(getModelConfig(), {
            messages: messages.concat([
              { role: "assistant", content: first.content || null, tool_calls: [call] },
              { role: "tool", tool_call_id: call.id, content: JSON.stringify(observation) }
            ]),
            tools: toolDefinitions,
            temperature: 0.3
          });
          mutate(function (next) {
            telemetry.recordRun(next, runId, skillRef, "completed", timestamp, Math.max(0, now() - timestamp), 1, { occurredAt: now() });
            telemetry.recordAudit(next, toolName, "completed", false, first.provider.latencyMs + final.provider.latencyMs, timestamp);
          });
          return telemetry.harnessResponse(runId, skillRef, "completed", final.content || "工具已执行完成。", null, final.provider.model, 1, requestId());
        }

        mutate(function (next) {
          telemetry.recordRun(next, runId, skillRef, "completed", timestamp, Math.max(0, now() - timestamp), 0, { occurredAt: now() });
        });
        return telemetry.harnessResponse(runId, skillRef, "completed", first.content || "模型没有返回文字回答。", null, first.provider.model, 0, requestId());
      } catch (error) {
        mutate(function (next) {
          telemetry.recordRun(next, runId, skillRef, "failed", timestamp, Math.max(0, now() - timestamp), stepCount,
            { occurredAt: now(), errorCode: "agent_run_failed" });
        });
        throw error;
      }
    }

    async function continueAgent(runId, input) {
      const db = readDb();
      const pending = db.pendingRuns[runId];
      if (!pending || pending.approval.id !== input.approvalId) throw new Error("待确认操作不存在或已经处理");
      if (continuing.has(runId)) throw new Error("此操作正在处理，请等待完成");
      const approved = input.decision === "approve";
      const hasSnapshot = Array.isArray(pending.messages) && Boolean(pending.skillVersion);
      const continuationSkill = hasSnapshot ? { name: pending.skill, version: pending.skillVersion } : modules.skills.activate(pending.skill);
      const messages = hasSnapshot ? pending.messages : modules.skills.harnessMessages(pending.userInput, pending.skill, continuationSkill);
      const previousRun = db.runs.find(function (item) { return item.id === runId; });
      // Historical browser-v1 rows remain historical. Legacy resumptions record
      // their newly activated version separately instead of inventing an old one.
      const skillRef = previousRun?.skill || { name: pending.skill, version: "unknown" };
      const timestamp = previousRun?.createdAt ?? pending.approval.createdAt;
      const retryCount = (previousRun?.retryCount || 0) + (previousRun?.status === "failed" ? 1 : 0);
      continuing.add(runId);
      try {
        if (pending.resolution && pending.resolution.approved !== approved) throw new Error("操作决定已生效，请按原决定重试以获取结果");
        if (!pending.resolution) {
          const observation = approved
            ? modules.tools.executeWriteTool(db, pending.call.function.name, pending.args, cardDomain, now())
            : { status: "rejected_by_user" };
          // Persist the effect and its result together. A model failure after the
          // write must not create a second card when the user retries the answer.
          pending.resolution = { approved: approved, observation: observation };
          writeDb(db);
        }
        const observation = pending.resolution.observation;
        const final = await transport.complete(getModelConfig(), {
          messages: messages.concat([
            { role: "assistant", content: pending.first.content || null, tool_calls: [pending.call] },
            { role: "tool", tool_call_id: pending.call.id, content: JSON.stringify(observation) }
          ]),
          tools: modules.skills.SKILLS[pending.skill].map(modules.tools.toolDefinition),
          temperature: 0.3
        });
        mutate(function (next) {
          delete next.pendingRuns[runId];
          telemetry.recordRun(next, runId, skillRef, "completed", timestamp, Math.max(0, now() - timestamp), 1,
            { occurredAt: now(), continuationSkill: continuationSkill, retryCount: retryCount });
          telemetry.recordAudit(next, pending.call.function.name, approved ? "completed" : "cancelled", true, final.provider.latencyMs, now());
        });
        return telemetry.harnessResponse(
          runId,
          skillRef,
          "completed",
          final.content || (approved ? "操作已完成。" : "已按你的选择取消操作。"),
          null,
          final.provider.model,
          1,
          requestId()
        );
      } catch (error) {
        mutate(function (next) {
          telemetry.recordRun(next, runId, skillRef, "failed", timestamp, Math.max(0, now() - timestamp), 1,
            { occurredAt: now(), continuationSkill: continuationSkill, retryCount: retryCount, errorCode: pending.resolution ? "agent_answer_failed_after_decision" : "agent_tool_failed" });
        });
        throw error;
      } finally { continuing.delete(runId); }
    }

    return { continueAgent: continueAgent, runAgent: runAgent };
  }

  return { createAgentHarness: createAgentHarness };
});
