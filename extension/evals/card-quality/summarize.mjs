// Rebuild descriptive metrics from the archived model run and explicit AI ratings.
// This script does not generate grades, call a model, or change the archived run.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
const root = import.meta.dirname;
const read = async name => JSON.parse(await readFile(resolve(root, name), "utf8"));
const { values } = parseArgs({ options: { run: { type: "string" }, ratings: { type: "string" }, out: { type: "string" } } });
if (Object.keys(values).length && !(values.run && values.ratings && values.out)) throw Error("Provide --run, --ratings and --out together to keep each evaluation separate");
// Explicit paths are relative to the invoking directory; no flags rebuilds the first archived run.
const bundle = await read(values.run ? resolve(values.run) : "results/run-2026-09-02.json");
const assessment = await read(values.ratings ? resolve(values.ratings) : "results/ai-ratings.json");
if (assessment.runExecutedAt && assessment.runExecutedAt !== bundle.outputs.executedAt) throw Error("Ratings belong to a different run");
const outputDirectory = values.out ? resolve(values.out) : resolve(root, "results");
const samples = JSON.parse(bundle.outputs.corpus);
const report = structuredClone(bundle.outputs);
if (report.evaluationMode && report.evaluationMode !== "paired") throw Error("Only a complete paired evaluation can produce comparative acceptance metrics");
const mapping = new Map(bundle.reviewKey.map(item => [item.label, item.version]));
const ratings = new Map(assessment.ratings.map(item => [item.label, item]));
if (samples.length !== 24 || report.cases.length !== 24 || ratings.size !== 48 || mapping.size !== 48) throw Error("Incomplete evaluation");
const dimensions = assessment.dimensions;
const blind = bundle.blindReview.map(row => {
  const grade = ratings.get(row.label);
  if (!grade || !mapping.has(row.label)) throw Error("Missing grade: " + row.label);
  if (grade.scores && (grade.scores.length !== 5 || grade.scores.some(n => !Number.isInteger(n) || n < 1 || n > 5))) throw Error("Invalid score: " + row.label);
  return { ...row, scores: Object.fromEntries(dimensions.map((name, i) => [name, grade.scores?.[i] ?? null])),
    reviewer: assessment.reviewer, criticalError: grade.criticalError, criticalType: grade.criticalType,
    outcomeScore: grade.outcomeScore, disputed: Boolean(grade.disputed), notes: grade.notes, secondPass: grade.secondPass || null,
    scoreApplicability: grade.scores ? "teaching_output" : "state_response_only" };
});
const gradeFor = (id, version) => blind.find(row => row.label.startsWith(id + "-") && mapping.get(row.label) === version);
report.cases.forEach(item => { item.ratings = { old: gradeFor(item.id, "old"), current: gradeFor(item.id, "current") }; });
report.status = assessment.acceptance?.passed ? "reviewed_accepted" : "reviewed_not_accepted";
report.reviewers = [{ name: assessment.reviewer, kind: "AI", independentHumanReviewers: 0 }];
report.reviewMethod = assessment.method;
report.acceptance = assessment.acceptance || { passed: false, reasons: ["ready 输出仍有关键条件/答案错误", "预期单卡仅9/15可收下，图片0/4", "修复丢失字段及误区数组格式导致阻断", "短片段中位耗时约50秒，不支持快速制卡结论"] };
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const rounded = n => Math.round(n * 100) / 100;
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, mean: rounded(mean(values)), median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    p95NearestRank: sorted[Math.ceil(n * .95) - 1], max: sorted.at(-1) };
};
const cohort = samples.filter(item => item.expectedStatus === "ready").map(item => item.id);
const metrics = { model: report.model, promptVersion: report.promptVersion, temperature: report.temperature,
  runStatus: bundle.outputs.status, reviewedCases: report.cases.length, reviewedOutputs: blind.length,
  expectedCardCohort: cohort, scoreMethod: assessment.missingRule, categories: {}, scores: {}, latencyMs: {}, requests: {}, citations: {}, criticalErrors: {} };
for (const category of [...new Set(samples.map(item => item.category))]) {
  const group = report.cases.filter(item => item.category === category);
  metrics.categories[category] = { count: group.length, currentStates: group.reduce((a, item) => (a[item.current.status] = (a[item.current.status] || 0) + 1, a), {}),
    expectedStateMatches: group.filter(item => item.current.status === item.expectedStatus).length,
    oldReady: group.filter(item => item.old.card).length };
}
for (const version of ["old", "current"]) {
  const rows = cohort.map(id => gradeFor(id, version));
  const ready = id => version === "old" ? Boolean(report.cases.find(item => item.id === id).old.card) : report.cases.find(item => item.id === id).current.status === "ready";
  metrics.scores[version] = { content: Object.fromEntries(dimensions.map(name => [name, rounded(mean(rows.map(row => row.scores[name])))])),
    deliveryAdjusted: Object.fromEntries(dimensions.map(name => [name, rounded(mean(rows.map((row, i) => ready(cohort[i]) ? row.scores[name] : 1)))])),
    ready: cohort.filter(ready).length,
    readyWithoutCriticalFactAnswer: cohort.filter(id => ready(id) && gradeFor(id, version).criticalType !== "fact_answer").length };
  metrics.criticalErrors[version] = blind.filter(row => mapping.get(row.label) === version && row.criticalError).map(row => ({ label: row.label, type: row.criticalType, message: row.criticalError }));
  const calls = report.cases.flatMap(item => version === "old" ? [{ ...item.old.provider, operation: "baseline" }] : item.current.generation.calls);
  metrics.requests[version] = { count: calls.length, operationCounts: calls.reduce((a, call) => (a[call.operation] = (a[call.operation] || 0) + 1, a), {}),
    knownTokens: calls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0), missingUsage: calls.filter(call => !call.usage).length,
    errors: calls.filter(call => call.error).length };
  metrics.latencyMs[version] = {};
  for (const category of ["all", "short", "image"]) {
    const group = report.cases.filter(item => category === "all" || item.category === category);
    metrics.latencyMs[version][category] = distribution(group.map(item => version === "old" ? item.old.provider.latencyMs : item.current.generation.elapsedMs));
  }
}
const previousCalls = report.cases.flatMap(item => (item.currentAttempts || []).flatMap(attempt => attempt.generation.calls)).filter(call => call.sent !== false);
metrics.requests.previousInterruptedAttempts = { count: previousCalls.length, errors: previousCalls.filter(call => call.error).length,
  knownTokens: previousCalls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0), missingUsage: previousCalls.filter(call => !call.usage).length };
metrics.requests.knownTokensIncludingHistory = Object.values(metrics.requests).filter(item => item && typeof item === "object").reduce((sum, item) => sum + (item.knownTokens || 0), 0);
const audit = [];
for (const item of report.cases) {
  const source = samples.find(sample => sample.id === item.id);
  for (const ref of item.current.evidence || []) {
    if (source.imagePath) {
      audit.push({ id: item.id, claim: ref.claim, kind: "image_observation", passed: ref.evidenceId === "image" && !ref.quote && Boolean(ref.observation) && ref.startCharacter === undefined && ref.endCharacter === undefined,
        scope: "可见标签/色块由AI另行复核；没有文本偏移不等于语义被支持" });
    } else {
      let start = -1;
      for (let i = 0; i <= (ref.occurrence || 0); i++) { start = source.text.indexOf(ref.quote, start + 1); if (start < 0) break; }
      const stored = item.current.quality.evidence.find(span => span.claim === ref.claim && span.quote === ref.quote && span.startCharacter === start);
      audit.push({ id: item.id, claim: ref.claim, kind: "text", quote: ref.quote, startCharacter: start, endCharacter: start + ref.quote.length,
        passed: ref.evidenceId === "material" && Boolean(ref.quote) && start >= 0 && Boolean(stored) && stored.endCharacter === start + ref.quote.length });
    }
  }
}
metrics.citations = { text: audit.filter(row => row.kind === "text").length, textPassed: audit.filter(row => row.kind === "text" && row.passed).length,
  readyText: audit.filter(row => row.kind === "text" && report.cases.find(item => item.id === row.id).current.status === "ready").length,
  visualObservations: audit.filter(row => row.kind === "image_observation").length, failures: audit.filter(row => !row.passed), semanticSupportAllPassed: assessment.semanticSupportAllPassed === true };
await mkdir(outputDirectory, { recursive: true });
for (const [name, value] of Object.entries({ "outputs.json": report, "blind-review.json": blind, "review-key.json": bundle.reviewKey, "metrics.json": metrics, "citation-audit.json": audit })) {
  await writeFile(resolve(outputDirectory, name), JSON.stringify(value, null, 2) + "\n");
}
console.log(JSON.stringify(metrics, null, 2));
