import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import quality from "../../src/backend/features/generation/card-quality.js";
import skills from "../../src/harness/skills/skill-registry.js";
import provider from "../../src/backend/provider/provider-transport.js";
import baseline from "./baseline-v1.cjs";
import runner from "./paired-runner.js";

const root = dirname(fileURLToPath(import.meta.url));
const task = skills.loadTask("concept-card");
const args = process.argv.slice(2);
const argument = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const caseId = argument("--case");
const mode = argument("--mode", caseId !== undefined ? "single" : "quick");
if (args.includes("--case") && (!caseId || caseId.startsWith("--"))) throw new Error("--case 需要素材 ID（例如 short-05）");
const cases = runner.selectCases(JSON.parse(await readFile(resolve(root, "cases.json"), "utf8")), mode, caseId);
const out = resolve(argument("--out", resolve(root, "results")));
const prepare = args.includes("--prepare"), resume = args.includes("--resume");
let report;
try { report = JSON.parse(await readFile(resolve(out, "outputs.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (report && !resume) throw new Error("输出目录已有评测。使用 --resume 续跑，或用 --out 指定新目录；不会覆盖历史记录。");
if (prepare && resume) throw new Error("--prepare 与 --resume 不能同时使用");
const configPath = argument("--config", process.env.KG_QUALITY_PROVIDER_FILE);
const config = prepare ? null : configPath ? JSON.parse(await readFile(resolve(configPath), "utf8")) : process.env.KG_QUALITY_PROVIDER_JSON ? JSON.parse(process.env.KG_QUALITY_PROVIDER_JSON) : null;
if (!prepare && !config) throw new Error("缺少模型配置。使用 --config 本机JSON路径 或 KG_QUALITY_PROVIDER_FILE；--prepare 只准备记录，不请求模型。");
if (config) { config.model = argument("--model", config.model || runner.MODEL); config.temperature = 0.3; provider.normalizeModelConfig(config); }
const model = config?.model || runner.MODEL;
if (report && !runner.canResume(report, cases, task, baseline, model, mode)) throw new Error("已有评测的版本、模型、方式或素材不匹配，请使用新的 --out 目录。");
report ||= runner.createReport(cases, task, baseline, model, mode);
const limits = { maxRequests: Number(argument("--max-requests", report.budget.maxRequests || runner.MODES[mode].maxRequests)),
  maxTokens: Number(argument("--max-tokens", report.budget.maxTokens || runner.MODES[mode].maxTokens)) };
if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("预算必须是正整数");
await mkdir(out, { recursive: true });
const checkpoint = value => writeFile(resolve(out, "outputs.json"), JSON.stringify(value, null, 2) + "\n");
if (prepare) {
  report.status = "awaiting_provider";
  Object.assign(report.budget, limits);
  await checkpoint(report);
} else {
  const transport = provider.createProviderTransport({ timeoutMs: 60000 });
  const service = quality.createQualityService({ task, transport, getModelConfig: () => config });
  let completed = report.cases.filter(item => item.current).length;
  try {
    await runner.run({ cases, task, baseline, config, transport, service, report, mode, limits,
      loadImage: async path => ({ dataUrl: "data:image/gif;base64," + (await readFile(resolve(root, path))).toString("base64") }),
      checkpoint: async value => {
        await checkpoint(value);
        const count = value.cases.filter(item => item.current).length;
        if (count !== completed) { completed = count; process.stdout.write(`已处理 ${count}/${cases.length} 份，其中 ${runner.progress(value, cases.length).outputLimited} 份输出达到上限，按失败保留\n`); }
      } });
  } finally { config.apiKey = ""; }
}
const bundle = runner.exportBundle(report, cases, () => randomInt(2));
await writeFile(resolve(out, "card-quality-results.json"), JSON.stringify(bundle, null, 2) + "\n");
await writeFile(resolve(out, "blind-review.json"), JSON.stringify(bundle.blindReview, null, 2) + "\n");
await writeFile(resolve(out, "review-key.json"), JSON.stringify(bundle.reviewKey, null, 2) + "\n");
const ready = report.cases.filter(item => item.current?.status === "ready").length;
await writeFile(resolve(out, "README.md"), `# 单卡质量评测记录\n\n模型：${report.model}；温度参数：0.3；提示：${task.version}；方式：${runner.MODES[mode].label}。${mode === "single" ? "素材：" + cases[0].id + " · " + cases[0].title + "。" : ""}\n\n状态：${report.status}。${cases.length} 份素材，可收下 ${ready} 份；${runner.progress(report, cases.length).outputLimited} 份输出达到上限，按失败保留；程序通过不等于质量验收。\n\n累计尝试 ${report.budget.requestsUsed} 次，已知用量 ${report.budget.knownTokens} token，${report.budget.missingUsage} 次用量未知。${runner.failureMessage(report)}\n\n尚未评分，未开展学习实验。单样本及其他仅新版方式不计算新旧胜率。card-quality-results.json 包含完整导出；outputs.json 用于 --resume 同版本续跑。\n`);
process.stdout.write(`${report.status}: ${report.budget.requestsUsed} 次请求，已知 ${report.budget.knownTokens} token。${runner.failureMessage(report)}\n`);
