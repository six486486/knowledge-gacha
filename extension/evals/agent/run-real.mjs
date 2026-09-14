import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import provider from "../../src/backend/provider/provider-transport.js";
import application from "../../src/backend/application/extension-service.js";
import utils from "../../src/shared/runtime-utils.js";
import domain from "../../src/frontend/domain/card-domain.js";
import skills from "../../src/harness/skills/skill-registry.js";

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const configFile = argument("--config"), outputFile = argument("--out");
if (!configFile || !outputFile) throw new Error("Use --config <local provider JSON> --out <new report JSON>. Runs only in disposable memory; never reads browser storage.");
const output = resolve(outputFile);
try { await access(output); throw new Error("Report exists; use a new output path."); } catch (error) { if (error.code !== "ENOENT") throw error; }
let config;
try { config = JSON.parse(await readFile(resolve(configFile), "utf8")); } catch { throw new Error("Cannot read model configuration; file contents are intentionally omitted."); }
const transport = provider.createProviderTransport({ timeoutMs: 60000 });
const report = { generatedAt: new Date().toISOString(), purpose: "Three product workflows with bundled Skills, scoped RAG and memory; small integration sample, not a content-quality benchmark.",
  limits: { maxRequests: 10, maxTokens: 24000 }, calls: [], steps: {}, model: config.model };
let step = "setup", usedTokens = 0;
const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
const service = application.createExtensionService({ storage: utils.memoryStorage(), indexedDB: false, profileId: "disposable-agent-eval", cardDomain: domain,
  providerModule: provider, getModelConfig: () => config, providerTransport: { complete: async (settings, request) => {
    if (report.calls.length >= report.limits.maxRequests || usedTokens >= report.limits.maxTokens) throw Object.assign(new Error("Evaluation budget exhausted"), { code: "EVAL_BUDGET" });
    const raw = request.messages.find(message => message.role === "user")?.content;
    let payload = {};
    try { payload = JSON.parse(typeof raw === "string" ? raw : raw?.find(item => item.type === "text")?.text || "{}"); } catch { /* observation is optional */ }
    const call = { step, operation: payload.operation || (payload.seeds ? "discovery" : "unknown"),
      activatedSkills: skills.listSkills().filter(entry => request.messages[0].content.includes(skills.activate(entry.name).instructions)).map(entry => entry.name),
      toolCount: request.tools?.length || 0, preferenceIds: payload.learningContext?.appliedPreferenceIds || [],
      sourceOrigins: (payload.sources || []).map(source => ({ id: source.id, origin: source.origin || "provided", documentId: source.documentId || null })) };
    report.calls.push(call);
    try {
      const result = await transport.complete(settings, request);
      call.usage = result.provider?.usage || null; call.latencyMs = result.provider?.latencyMs; call.finishReason = result.finishReason;
      usedTokens += Number(call.usage?.totalTokens) || 0;
      return result;
    } catch (error) { call.errorCode = error.code || "MODEL_FAILED"; throw error; }
    finally { report.totalTokens = usedTokens; await save(); }
  } } });

async function run(name, operation) {
  step = name;
  try { report.steps[name] = await operation(); } catch (error) { report.steps[name] = { errorCode: error.code || "WORKFLOW_FAILED" }; }
  await save();
  console.log(JSON.stringify({ step: name, status: report.steps[name].status || report.steps[name].errorCode || "completed", calls: report.calls.length, totalTokens: usedTokens }));
}

await service.createPreferenceMemory({ category: "learning_format", value: "先给日常例子；不改变材料中的事实和条件。" });
await service.createPreferenceMemory({ category: "topic_interest", value: "缓存", topicLabel: "缓存" });
await service.ingestDocument({ source: { title: "成本例题原文", content: "# 边际成本\n边际成本是每多生产一个单位额外增加的成本。在本题中，多制作一杯饮品新增 3 元原料支出，月租不随本次产量改变。" } });
await run("card", async () => {
  const result = (await service.createGachaCardDraft({ text: "边际成本是每多生产一个单位额外增加的成本。", source: { type: "manual", title: "短材料" } })).session;
  return { status: result.status, card: result.card, exercise: result.exercise, evidence: result.evidence, quality: result.quality, generation: result.generation };
});
await run("plan", async () => {
  const created = await service.createKnowledgePlan({ text: "# 边际成本\n边际成本是每多生产一个单位额外增加的成本。\n\n# 固定支出\n月租在本次决策中保持不变，不计入此次增量；但扩大场地后租金可能改变。", source: { type: "manual", title: "成本清单" } });
  const result = await service.analyzeKnowledgePlan(created.plan.id, { maxRequests: 2 });
  return { status: result.plan.status, units: result.plan.units, coverage: result.plan.coverage, generation: result.plan.generation };
});
await run("discovery", async () => {
  const result = await service.createGachaDiscoveryPool();
  return { status: result.pool.status, candidates: result.pool.candidates, usedPreferenceIds: result.pool.usedPreferenceIds, generation: result.pool.generation };
});
report.finishedAt = new Date().toISOString();
report.modelSuccessIsNotContentAcceptance = true;
await save();
