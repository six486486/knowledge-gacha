(function (root, factory) {
  const common = typeof module === "object" && module.exports;
  const api = factory(common ? require("../../../frontend/domain/card-domain.js") : root.KnowledgeGachaCardDomain);
  if (common) module.exports = api;
  else root.KnowledgeGachaCardQuality = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (domain) {
  "use strict";
  const CARD_FIELDS = ["title", "learningObjective", "knowledgeType", "summary", "example", "boundaries", "analogy", "mantra"];
  const EXERCISE_FIELDS = ["type", "question", "options", "correctIndex", "answer", "answerExplanation", "rubric", "misconceptions"];
  function pick(input, fields) {
    const out = {};
    fields.forEach(function (key) { if (input && Object.hasOwn(input, key)) out[key] = input[key]; });
    return out;
  }
  const REFERENCE_FIELDS = ["evidenceId", "quote", "occurrence", "observation"];
  function referenceKey(ref) { return JSON.stringify({ evidenceId: ref.evidenceId, quote: ref.quote || "", occurrence: ref.occurrence || 0, observation: ref.observation || "" }); }
  function candidateForRequest(candidate) {
    const evidence = [], supports = {}, invalidReferences = [];
    (candidate.evidence || []).forEach(function (ref, index) {
      if (!ref || ref.invalidReference || !["summary", "exercise", "boundaries", "example"].includes(ref.claim)) {
        invalidReferences.push(Object.assign({ claim: ref && ref.claim || null }, ref && ref.invalidReference || { code: "invalid_reference", index: index }));
        return;
      }
      let entry = evidence.find(function (item) { return referenceKey(item) === referenceKey(ref); });
      if (!entry) { entry = Object.assign({ id: "c" + (evidence.length + 1) }, pick(ref, REFERENCE_FIELDS)); evidence.push(entry); }
      (supports[ref.claim] || (supports[ref.claim] = [])).push(entry.id);
    });
    return Object.assign(pick(candidate, ["status", "card", "exercise"]), { evidence: evidence, supports: supports }, invalidReferences.length ? { invalidReferences: invalidReferences } : {});
  }
  function parse(content, existingReferences) {
    const payload = domain.extractJson(content);
    if (Array.isArray(payload.cards)) return { status: payload.cards.length > 1 ? "needs_split" : "needs_revision", card: payload.cards.length === 1 ? payload.cards[0] : null, candidates: payload.cards, exercise: null, evidence: [], issues: [payload.cards.length > 1 ? "材料需要拆分为多个学习目标，所有候选已保留" : "模型仍返回旧结构，需要学习目标和独立练习"] };
    const card = payload.card ? pick(payload.card, CARD_FIELDS) : null;
    if (card && card.example && typeof card.example === "object" && !Array.isArray(card.example)) {
      card.example = Object.assign({}, card.example);
      ["type", "origin"].forEach(function (field) {
        if (typeof card.example[field] === "string") card.example[field] = card.example[field].trim().toLowerCase();
      });
    }
    return { status: payload.status || "ready", card: card,
      exercise: payload.exercise ? normalizeExercise(pick(payload.exercise, EXERCISE_FIELDS)) : null, evidence: expandEvidence(payload.evidence, payload.supports, existingReferences),
      checks: payload.checks, issues: Array.isArray(payload.issues) ? payload.issues.map(function (issue) {
        if (present(issue)) return issue;
        return issue && (present(issue.message) ? issue.message : present(issue.reason) ? issue.reason : "");
      }).filter(present) : [] };
  }
  function expandEvidence(evidence, supports, existingReferences) {
    if (supports !== undefined) {
      function invalid(claim, code, id) { return { claim: claim, invalidReference: { code: code, referenceId: typeof id === "string" ? id.slice(0, 80) : null } }; }
      if (!supports || typeof supports !== "object" || Array.isArray(supports) || (evidence !== undefined && !Array.isArray(evidence))) return [invalid(null, "invalid_supports_structure")];
      evidence = evidence || [];
      // Only expand explicit model links. Missing or unknown IDs must not turn
      // into inferred support, even if another field quotes the same source.
      return Object.entries(supports).flatMap(function ([claim, ids]) {
        if (!Array.isArray(ids) || ids.length > 8) return [invalid(claim, "invalid_reference_list")];
        return ids.map(function (id) {
          const matches = evidence.filter(function (ref) { return ref && present(id) && ref.id === id; });
          const existing = (existingReferences || []).filter(function (ref) { return ref && present(id) && ref.id === id; });
          if (matches.length > 1 || existing.length > 1) return invalid(claim, "duplicate_reference_id", id);
          if (matches[0] && existing[0] && referenceKey(matches[0]) !== referenceKey(existing[0])) return invalid(claim, "reference_id_redefined", id);
          const source = matches[0] || existing[0];
          if (!source) return invalid(claim, "unknown_reference_id", id);
          if (source.claim !== undefined || source.claims !== undefined) return invalid(claim, "mixed_reference_structure", id);
          const ref = Object.assign({}, source, { claim: claim });
          delete ref.id;
          return ref;
        });
      });
    }
    if (!Array.isArray(evidence)) return [];
    return evidence.flatMap(function (ref) {
      if (!ref || !Array.isArray(ref.claims)) return [ref];
      // Expand only model-specified links; never infer that a quote supports a claim.
      if (!ref.claims.length || ref.claims.length > 4) return [ref];
      return ref.claims.map(function (claim) { const next = Object.assign({}, ref, { claim: claim }); delete next.claims; return next; });
    });
  }
  function normalizeExercise(exercise) {
    const count = exercise.options && exercise.options.length;
    const index = exercise.correctIndex;
    let reasons = exercise.misconceptions;
    if (exercise.type === "choice" && Array.isArray(exercise.options) && Array.isArray(reasons) && reasons.some(function (item) { return item && typeof item === "object"; })) {
      const valid = reasons.every(function (item) {
        return item && Number.isInteger(item.index) && item.index >= 0 && item.index < count &&
          typeof item.explanation === "string" && (item.index === index ? !item.explanation.trim() : present(item.explanation));
      }) && new Set(reasons.map(function (item) { return item.index; })).size === reasons.length &&
        exercise.options.every(function (_, i) { return i === index || reasons.some(function (item) { return item.index === i; }); });
      // Explicit indices are authoritative. Never repair a missing/duplicate
      // index by shifting explanations onto different options.
      exercise.misconceptions = reasons = valid ? exercise.options.map(function (_, i) {
        return reasons.find(function (item) { return item.index === i; })?.explanation || "";
      }) : null;
    }
    if (exercise.type === "choice" && Array.isArray(exercise.options) && count >= 2 && count <= 5 &&
      Number.isInteger(index) && index >= 0 && index < count && Array.isArray(reasons) && reasons.length === count - 1 && reasons.every(present)) {
      // Compact arrays contain distractors in option order. Only the correct
      // option's empty slot is added; no distractor explanation is invented.
      exercise.misconceptions = reasons.slice();
      exercise.misconceptions.splice(index, 0, "");
    }
    return exercise;
  }
  function mergeRepair(previous, patch) {
    if (!previous || ["needs_split", "insufficient_material"].includes(patch.status)) return patch;
    const next = Object.assign({}, previous, patch);
    next.card = Object.assign({}, previous.card || {}, patch.card || {});
    if (patch.card && patch.card.example && typeof patch.card.example === "object") {
      next.card.example = Object.assign({}, previous.card && previous.card.example || {}, patch.card.example);
    }
    next.exercise = normalizeExercise(Object.assign({}, previous.exercise || {}, patch.exercise || {}));
    const replacedClaims = new Set((patch.evidence || []).map(function (ref) { return ref && ref.claim; }));
    next.evidence = (previous.evidence || []).filter(function (ref) { return !ref || !replacedClaims.has(ref.claim); }).concat(patch.evidence || []);
    next.checks = patch.checks || [];
    return next;
  }
  function present(value) { return typeof value === "string" && value.trim().length > 0; }
  function findingIssues(verdict, candidate) {
    const invalid = () => { throw Object.assign(new Error("事实审校没有返回有效的字段与原句"), { code: "SEMANTIC_REVIEW_INVALID" }); };
    if (!Array.isArray(verdict.findings) || verdict.findings.length > 8) return invalid();
    return verdict.findings.map(function (finding) {
      const field = typeof finding?.field === "string" ? finding.field.replace(/\[(\d+)\]/g, ".$1") : "";
      if (!/^(?:card\.(?:title|learningObjective|summary|example\.text|boundaries|analogy|mantra)|exercise\.(?:question|answer|answerExplanation|(?:options|rubric|misconceptions)(?:\.\d+)?))$/.test(field) ||
        !present(finding.quote) || finding.quote.length > 1600 || !present(finding.reason) || finding.reason.length > 1200) return invalid();
      const value = field.split(".").reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, candidate);
      const values = Array.isArray(value) ? value : [value];
      if (!values.some(value => present(value) && value.includes(finding.quote))) return invalid();
      return { code: "semantic_fact", field, quote: finding.quote, message: finding.reason };
    });
  }
  function boundaryRelations(text) {
    const entries = [];
    if (!present(text)) return entries;
    // Only relations between source-named variables. A true comparison of
    // example numbers does not establish an inclusive rule at the boundary.
    const pattern = /\b([A-Za-z_][\w-]*)\s*(<=|>=|≤|≥|小于等于|大于等于|不超过|未超过|不大于|不少于|不小于)\s*(?:其|该)?\s*([A-Za-z_][\w-]*)\b/g;
    for (const match of String(text || "").matchAll(pattern)) {
      const before = text.slice(0, match.index).split(/[。；！？\n]/).at(-1).replace(/[“‘"']/g, "");
      const after = text.slice(match.index + match[0].length).replace(/^[”’"']/g, "");
      if (/(?:不是|并非|错误地认为|误以为|不能认为|不能推出|不能推导出|不能得出)\s*$/.test(before) ||
        /^(?:的(?:说法|规则|判断))?(?:是|并)?(?:错误|不成立|不准确)/.test(after)) continue;
      const reversed = [">=", "≥", "大于等于", "不少于", "不小于"].includes(match[2]);
      entries.push({ left: match[1], right: match[3], key: reversed ? match[3] + "<=" + match[1] : match[1] + "<=" + match[3], quote: match[0] });
    }
    return entries;
  }
  function boundaryIssues(candidate, context) {
    const sources = (context.evidence || []).filter(source => source.kind !== "image" && present(source.text)).map(source => source.text);
    const supported = new Set(sources.flatMap(boundaryRelations).map(entry => entry.key));
    const named = name => sources.some(text => text.split(/[^A-Za-z0-9_-]+/).includes(name));
    const fields = { "card.summary": candidate.card?.summary, "card.example.text": candidate.card?.example?.text, "card.boundaries": candidate.card?.boundaries,
      "exercise.answer": candidate.exercise?.answer, "exercise.answerExplanation": candidate.exercise?.answerExplanation };
    for (const key of ["rubric", "misconceptions"]) (Array.isArray(candidate.exercise?.[key]) ? candidate.exercise[key] : []).forEach((value, index) => { fields["exercise." + key + "." + index] = value; });
    return Object.entries(fields).flatMap(function ([field, text]) {
      const entry = boundaryRelations(text).find(entry => named(entry.left) && named(entry.right) && !supported.has(entry.key));
      if (!entry) return [];
      const option = field.startsWith("exercise.misconceptions.") && candidate.exercise?.options?.[Number(field.split(".").at(-1))];
      if (present(option) && (text.startsWith(option + "：") || text.startsWith(option + ":")) && text.indexOf(entry.quote) < option.length && !boundaryRelations(text.slice(option.length + 1)).some(entry => !supported.has(entry.key))) return [];
      return [{ code: "boundary_unverified", field, quote: entry.quote, message: "材料没有给出“" + entry.quote + "”的等号归属，不能补成非严格阈值规则。保留已有例子的明确比较，删除无依据的一般规则；若题目依赖临界值则改问已有明确依据的情景。" }];
    });
  }
  function generic(value) { return /只(?:把)?(?:背|记住|把名词背)|先收藏以后再说|以后再说|用自己的话解释它|最该先抓什么|先抓住最有用的那一点/.test(String(value || "")); }
  function hasInlineCompound(text) {
    if (!present(text)) return false;
    for (const header of text.matchAll(/\bdef\s+\w+\([^\n]*?\)\s*:/g)) {
      const body = text.slice(header.index + header[0].length).split("\n")[0];
      let quote = "", escape = false, depth = 0, start = true;
      for (let i = 0; i < body.length; i++) {
        const char = body[i];
        if (quote) { if (escape) escape = false; else if (char === "\\") escape = true; else if (char === quote) quote = ""; continue; }
        if (char === "#") break;
        if (char === "'" || char === '"') { quote = char; start = false; continue; }
        if (/\s/.test(char)) continue;
        if (start && depth === 0 && /^(?:if|for|while|try|with)\b/.test(body.slice(i))) return true;
        if ("([{".includes(char)) depth++;
        if (")]}".includes(char)) depth = Math.max(0, depth - 1);
        start = char === ";" && depth === 0;
      }
    }
    return false;
  }
  function lastReturnedNumber(text) {
    let found = null;
    for (const match of String(text || "").matchAll(/返回(?:值)?(?:为|是|：|:)?\s*([+-]?\d+(?:\.\d+)?)(?![\d.])/g)) {
      if (/(?:不是|而非|不应|并非|错误地)\s*$/.test(text.slice(0, match.index))) continue;
      found = Number(match[1]);
    }
    return found;
  }
  function numericAnswerIssue(exercise, explanation) {
    if (!/(?:第[一二三四五六七八九十\d]+次[\s\S]*返回|连续调用[\s\S]*返回)/.test(exercise?.question || "")) return [];
    const answer = lastReturnedNumber(exercise.answer), derived = lastReturnedNumber(explanation);
    return answer !== null && derived !== null && answer !== derived ? [{ code: "numeric_answer_mismatch", field: "exercise.answer",
      message: "同一调用结果的参考答案写返回" + answer + "，但解析或独立解题写返回" + derived + "。请核对题干并统一答案、解析和评分要点；不能只修改其中一处。" }] : [];
  }
  function arithmeticValue(text) {
    // Parse only decimal literals, parentheses and four arithmetic operators.
    // Never execute generated code or resolve names/functions from the text.
    const input = text.replace(/[×÷−]/g, c => ({ "×": "*", "÷": "/", "−": "-" })[c]).replace(/\s/g, "");
    let position = 0;
    function atom(depth) {
      if (depth > 20) throw new Error("depth");
      if (input[position] === "+" || input[position] === "-") { const sign = input[position++] === "-" ? -1 : 1; return sign * atom(depth + 1); }
      if (input[position] === "(") { position++; const value = sum(depth + 1); if (input[position++] !== ")") throw new Error("parenthesis"); return value; }
      const match = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(position));
      if (!match) throw new Error("literal");
      position += match[0].length; return Number(match[0]);
    }
    function product(depth) { let value = atom(depth); while (["*", "/"].includes(input[position])) { const op = input[position++], next = atom(depth); value = op === "*" ? value * next : value / next; } return value; }
    function sum(depth) { let value = product(depth); while (["+", "-"].includes(input[position])) { const op = input[position++], next = product(depth); value = op === "+" ? value + next : value - next; } return value; }
    try { const value = sum(0); return position === input.length && Number.isFinite(value) ? value : null; } catch { return null; }
  }
  function calculationIssues(candidate) {
    const fields = { "card.summary": candidate.card?.summary, "card.example.text": candidate.card?.example?.text,
      "exercise.answer": candidate.exercise?.answer, "exercise.answerExplanation": candidate.exercise?.answerExplanation };
    const issues = [];
    for (const [field, text] of Object.entries(fields)) {
      if (!present(text)) continue;
      for (const match of text.matchAll(/([\d.(][\d.\s()+\-*/×÷−]{1,300})\s*(=|≈)\s*([+-]?\d+(?:\.\d+)?)(%)?(?![\d.]|\s*[+\-*/×÷])/g)) {
        if (!/[+*/×÷−-]/.test(match[1]) || /[\w.]/.test(text.charAt(match.index - 1))) continue;
        const prefix = text.slice(0, match.index).split(/[，。；\n]/).at(-1);
        if (/(?:不是|不能|错误|误写)[^，。；\n]{0,16}$/.test(prefix)) continue;
        const expected = arithmeticValue(match[1]);
        if (expected === null) continue;
        const scale = match[4] ? 100 : 1, actual = Number(match[3]) / scale;
        const decimals = (match[3].split(".")[1] || "").length;
        const tolerance = match[2] === "≈" ? 0.5 * 10 ** -decimals / scale : Math.max(1, Math.abs(expected)) * 1e-10;
        if (Math.abs(expected - actual) > tolerance + 1e-12) {
          issues.push({ code: "numeric_calculation", field, message: "算式“" + match[0].trim() + "”的结果不符。按四则运算得到" + Number(expected.toPrecision(12)) + "；请同步修正后续计算和答案，不执行或保留错误演算。" });
          break;
        }
      }
    }
    return issues;
  }
  function iscloseIssues(candidate) {
    const fields = { "card.example.text": candidate.card?.example?.text, "exercise.answer": candidate.exercise?.answer,
      "exercise.answerExplanation": candidate.exercise?.answerExplanation };
    (Array.isArray(candidate.exercise?.rubric) ? candidate.exercise.rubric : []).forEach((text, i) => { fields["exercise.rubric." + i] = text; });
    const issues = [];
    const bindings = new Map(), question = candidate.exercise?.question;
    if (present(question) && !/\b(?:if|for|while|def|lambda)\b|循环|重新赋值|自增|自减|递增|递减|修改|改变|更新|\b\w+\s*(?:\+=|-=|\*=|\/=|\+\+|--)/.test(question)) {
      for (const match of question.matchAll(/\b([A-Za-z_]\w*)\s*=(?!=)\s*([\d.eE\s()+\-*/]+)/g)) {
        const value = arithmeticValue(match[2]);
        bindings.set(match[1], bindings.has(match[1]) ? null : value);
      }
    }
    for (const [field, text] of Object.entries(fields)) {
      if (!present(text)) continue;
      for (const match of text.matchAll(/\bmath\.isclose\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g)) {
        const args = match[1].split(",").map(value => value.trim());
        if (args.length < 2 || args.length > 4) continue;
        const numeric = value => arithmeticValue(value) ?? (field.startsWith("exercise.") ? bindings.get(value) ?? null : null);
        const a = numeric(args[0]), b = numeric(args[1]), tolerances = { rel_tol: 1e-9, abs_tol: 0 };
        const seen = new Set();
        let supported = a !== null && b !== null;
        for (const arg of args.slice(2)) {
          const pair = /^(rel_tol|abs_tol)\s*=\s*(.+)$/.exec(arg);
          if (!pair || seen.has(pair[1])) { supported = false; break; }
          const value = numeric(pair[2]);
          if (value === null || value < 0) { supported = false; break; }
          seen.add(pair[1]); tolerances[pair[1]] = value;
        }
        if (!supported) continue; // Names, calls, invalid arguments and special values remain subject to semantic review.
        const result = Math.abs(a - b) <= Math.max(tolerances.rel_tol * Math.max(Math.abs(a), Math.abs(b)), tolerances.abs_tol) ? "True" : "False";
        const before = text.slice(0, match.index).split(/[。；\n]/).at(-1);
        const after = text.slice(match.index + match[0].length).split(/[。；\n]/)[0];
        if (/错误|误以为|不能认为|不能说/.test(before) || /(?:说法|判断|结论).{0,6}(?:错误|不成立)/.test(after)) continue;
        const assertion = /^([^。；\n]{0,40}?(?:返回|得到|结果(?:为|是)|为|是|->|→|==|=))\s*[`“”]?\s*(True|False)/.exec(after);
        if (!assertion || /如果|若|改变|调整|另一次/.test(assertion[1])) continue;
        const uncertain = /可能|也许|或许|可(?:以)?(?:会)?(?:返回|得到)|合适|适当|取决/.test(assertion[1]);
        if (!uncertain && assertion[2] === result) continue;
        issues.push({ code: "deterministic_result", field, quote: match[0] + assertion[0], requiresNewQuestion: field.startsWith("exercise.") && /结果可能|可能.{0,8}结果/.test(question || ""),
          message: "调用“" + match[0] + "”的数值和参数已确定（a=" + a + "，b=" + b + "），结果为" + result + "（rel_tol=" + tolerances.rel_tol + "，abs_tol=" + tolerances.abs_tol + "）。请明确写出这个结果；若另讲容差选择，请分开说明改变参数后的另一种调用，不把本次结果写成可能。" });
      }
    }
    return issues;
  }
  function bracketedRecordLists(text) {
    // A deliberately small literal grammar: homogeneous tuples/lists of finite
    // numbers or plain strings. No eval, code execution, names or function calls.
    const lists = [];
    for (const match of String(text || "").matchAll(/\[\s*[\[(]/g)) {
      let position = 0;
      const input = text.slice(match.index, match.index + 2000);
      function space() { while (/\s/.test(input[position] || "") && position < input.length) position++; }
      function sequence(open, close, scalar) {
        space(); if (input[position++] !== open) throw new Error("open");
        const values = []; space();
        while (input[position] !== close) {
          if (values.length >= 16) throw new Error("limit");
          values.push(scalar()); space();
          if (input[position] === close) break;
          if (input[position++] !== ",") throw new Error("comma"); space();
        }
        if (input[position++] !== close) throw new Error("close");
        return values;
      }
      let rowKind;
      try {
        const rows = sequence("[", "]", () => {
          space(); const open = input[position];
          if (!["(", "["].includes(open) || (rowKind && rowKind !== open)) throw new Error("row");
          rowKind = open;
          const row = sequence(open, open === "(" ? ")" : "]", () => {
            space(); const part = input.slice(position), token = /^(?:'([^'\\\n]*)'|"([^"\\\n]*)"|([+-]?(?:\d+(?:\.\d+)?|\.\d+)))/.exec(part);
            if (!token) throw new Error("literal");
            position += token[0].length;
            const value = token[3] !== undefined ? Number(token[3]) : token[1] ?? token[2];
            if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error("number");
            return value;
          });
          if (open === "(" && row.length === 1 && !/,\s*\)$/.test(input.slice(0, position))) throw new Error("tuple");
          return row;
        });
        if (!rows.length || !rows[0].length || rows.some(row => row.length !== rows[0].length)) continue;
        lists.push({ start: match.index, end: match.index + position, rows, rowKind });
      } catch { /* Unsupported syntax is never certified. */ }
    }
    return lists;
  }
  function recordLists(text) {
    const lists = bracketedRecordLists(text);
    // Also recognize prose such as ("x", 3)、("y", 1). Parse only bounded
    // literal rows with the same grammar; never evaluate generated code.
    const scalar = String.raw`(?:'[^'\\\n]*'|"[^"\\\n]*"|[+-]?(?:\d+(?:\.\d+)?|\.\d+))`;
    const row = String.raw`\(\s*${scalar}(?:\s*,\s*${scalar}){1,3}\s*\)`;
    const groups = new RegExp(String.raw`${row}(?:\s*[、,，]\s*${row})+`, "g");
    for (const match of String(text || "").matchAll(groups)) {
      if (lists.some(list => match.index >= list.start && match.index < list.end) || match[0].length > 1900) continue;
      const rows = match[0].match(new RegExp(row, "g"));
      if (rows.length > 16) continue;
      const parsed = bracketedRecordLists("[" + rows.join(",") + "]")[0];
      if (parsed) lists.push({ ...parsed, start: match.index, end: match.index + match[0].length, bare: true });
    }
    return lists.sort((a, b) => a.start - b.start);
  }
  function sortSteps(text, plan) {
    return Array.from(String(text || "").matchAll(/按(?:(?:(?:主要|次要)键[（(])?第([一二三四1-4])(?:个)?(?:元素|字段|项)[）)]?(?:（[^）]{0,12}）|\([^)]{0,12}\))?|([A-Za-z_\p{Script=Han}]{1,12}?))\s*(升序|降序)?(?:稳定)?排序/gu), match => {
      const label = match[2] || /主要键|次要键/.exec(match[0])?.[0] || /[（(]([^）)]{1,12})[)）]/.exec(match[0])?.[1];
      const mappings = (plan || []).filter(step => step.label === label);
      const key = match[1] ? "一二三四".includes(match[1]) ? "一二三四".indexOf(match[1]) : Number(match[1]) - 1 : mappings.length === 1 ? mappings[0].key : undefined;
      const numbered = /第([一二三四1-4])步[^。；\n]*$/.exec(text.slice(0, match.index));
      const stage = numbered ? "一二三四".includes(numbered[1]) ? "一二三四".indexOf(numbered[1]) + 1 : Number(numbered[1]) : null;
      return { start: match.index, end: match.index + match[0].length, key, label, stage,
        reverse: match[3] ? match[3] === "降序" : !match[1] && mappings.length === 1 ? mappings[0].reverse : false };
    });
  }
  function sortTrace(text, initial, plan) {
    const lists = recordLists(text), steps = sortSteps(text, plan);
    if (!lists.length || Array.from(text.matchAll(/\[\s*[\[(]/g)).length !== lists.filter(list => !list.bare).length || /\b(?:sort|sorted)\s*\(|逆序|倒序|不稳定|自定义|大小写|随机/.test(text)) return null;
    if (Array.from(text.matchAll(/按[^。；:：，,\n]{1,45}?排序/g)).length !== steps.length ||
      Array.from(text.matchAll(/升序|降序/g)).some(match => !steps.some(step => match.index >= step.start && match.index < step.end))) return null;
    const first = initial || lists[0];
    // Prose often states the plan, then explains the same numbered steps.
    // Numbered explanations refer to existing steps, not extra sorting calls.
    const numbered = steps.filter(step => step.stage !== null);
    const explainedPlan = numbered.length && numbered.every((step, index) => step.stage === index + 1) ? numbered : null;
    const operations = plan || explainedPlan || steps;
    if (!operations.length || operations.length > 4) return null;
    if (steps.some((step, index) => {
      const expected = operations[step.stage !== null ? step.stage - 1 : index];
      return !expected || step.key !== expected.key || step.reverse !== expected.reverse;
    })) return null;
    const states = [first.rows];
    for (const step of operations) {
      const rows = states.at(-1), kind = typeof rows[0][step.key];
      if (!["number", "string"].includes(kind) || rows.some(row => typeof row[step.key] !== kind || (kind === "string" && /[^\x20-\x7e]/.test(row[step.key])))) return null;
      states.push(rows.slice().sort((a, b) => (a[step.key] < b[step.key] ? -1 : a[step.key] > b[step.key] ? 1 : 0) * (step.reverse ? -1 : 1)));
    }
    for (const [i, list] of lists.entries()) {
      const prefix = text.slice(i ? lists[i - 1].end : 0, list.start).split(/[。；\n]/).at(-1);
      const preceding = steps.filter(step => step.start < list.start);
      const stage = /最终(?:顺序|结果|列表)?(?:为|是|得到|：|:)?\s*$/.test(prefix) ? states.length - 1 :
        steps.length ? preceding.at(-1)?.stage ?? preceding.length : states.length - 1;
      if (!initial && i === 0 && stage !== 0) return null;
      if (list.rowKind !== first.rowKind || JSON.stringify(list.rows) !== JSON.stringify(states[stage])) return { mismatch: true, expected: states[stage], stage };
    }
    return { initial: first, plan: operations, states };
  }
  function sortingIssues(candidate, context) {
    const source = (context.evidence || []).map(item => item.text || "").join("\n");
    const question = candidate.exercise?.question, questionTrace = present(question) ? sortTrace(question) : null;
    const fields = { "card.example.text": candidate.card?.example?.text, "exercise.question": question,
      "exercise.answer": candidate.exercise?.answer, "exercise.answerExplanation": candidate.exercise?.answerExplanation };
    return Object.entries(fields).flatMap(([field, text]) => {
      if (!present(text) || (!/\[\s*[\[(]/.test(text) && !recordLists(text).length)) return [];
      const fromQuestion = field !== "exercise.question" && field.startsWith("exercise.") && questionTrace && !questionTrace.mismatch;
      if (!fromQuestion && (!/排序|sort/.test(text) || !/先[\s\S]*(?:再|然后)/.test(text) || source.includes(text))) return [];
      const trace = /Python|稳定排序/.test(source) ? sortTrace(text, fromQuestion ? questionTrace.initial : null, fromQuestion ? questionTrace.plan : null) : null;
      if (trace && !trace.mismatch) return [];
      return [{ code: trace?.mismatch ? "sorting_trace_mismatch" : "generated_trace_unverified", field,
        message: trace?.mismatch ? "第" + trace.stage + "步列表与稳定排序结果不符；本步应为" + JSON.stringify(trace.expected) + "。同步核对示例、答案和解析中的每一步，不将中间结果写成最终结果。" :
          "这段列表排序无法按明确的字面输入、字段序号和方向逐步核对。请移除复杂列表，改成新情境下选择排序方法或执行次序的应用题；不要原样重复未核验的轨迹。" }];
    });
  }
  function sortingPriorityIssues(candidate, context) {
    if (!(context.evidence || []).some(source => /稳定|stable/.test(source.text || "") && /排序|sort/.test(source.text || ""))) return [];
    const exercise = candidate.exercise || {}, issues = [];
    if (/先按次要键[^。\n]{0,14}再按主要键/.test(exercise.question || "") &&
      /什么顺序|什么次序/.test(exercise.question || "") && !/是否|错误|纠正/.test(exercise.question)) {
      issues.push({ code: "exercise_answer_leak", field: "exercise.question", requiresNewQuestion: true,
        message: "题干已经给出先次要键后主要键的执行答案，又要求回忆执行次序。改为给业务目标的主要/次要优先级，询问如何实现；保留稳定性这一目标，不直接提示执行步骤。" });
    }
    const order = text => /先按([^，。；\s]{1,14}?)排序[^。\n]*?再按([^，。；\s]{1,14}?)排序/.exec(text || "");
    const requested = order(exercise.question), answered = order(exercise.answer);
    if (requested && answered && requested[1] === answered[2] && requested[2] === answered[1] && !/主要|次要|主键|次键|优先/.test(exercise.question)) {
      issues.push({ code: "sorting_priority_ambiguous", field: "exercise.question", requiresNewQuestion: true,
        message: "题干给出的先后排序顺序与答案相反，也没有区分目标优先级与实际执行次序。请用主要键、次要键明确目标，再写先次要键后主要键的执行步骤，不把两种顺序都叫先按再按。" });
    }
    const fields = { "card.example.text": candidate.card?.example?.text, "exercise.answer": exercise.answer, "exercise.answerExplanation": exercise.answerExplanation };
    for (const [field, text] of Object.entries(fields)) {
      if (!present(text)) continue;
      const labels = {};
      for (const match of (text + (field.startsWith("exercise.") ? "\n" + (exercise.question || "") : "")).matchAll(/([^，。；：:\s()（）]{1,16})[（(](主要|次要)键[)）]/g)) {
        labels[match[2]] = match[1].replace(/^(?:先|再|然后|接着)?(?:按|以)/, "");
      }
      if (!labels.主要 || !labels.次要 || labels.主要 === labels.次要) continue;
      const wrong = labels.次要 + "相同的记录";
      const start = text.indexOf(wrong);
      if (start < 0) continue;
      const clause = text.slice(start).split(/[。；\n]/)[0];
      if (clause.includes("保持" + labels.主要 + "排序后") && !/第一次|第一步|中间|之前/.test(clause)) {
        issues.push({ code: "sorting_priority_mismatch", field, quote: clause,
          message: "最后按主要键“" + labels.主要 + "”排序，应是“" + labels.主要 + "相同”的记录保持次要键“" + labels.次要 + "”排序后的顺序。这里将主次键写反了；同步修正例子、题干和答案。" });
      }
    }
    return issues;
  }
  function applicationConditionIssues(candidate, context) {
    const exercise = candidate.exercise || {}, question = present(exercise.question) ? exercise.question : "";
    const source = (context.evidence || []).map(item => item.text || "").join("\n");
    const fields = { "exercise.answer": exercise.answer, "exercise.answerExplanation": exercise.answerExplanation };
    (Array.isArray(exercise.rubric) ? exercise.rubric : []).forEach((value, index) => { fields["exercise.rubric." + index] = value; });
    const issues = [];
    const negated = (clause, index, end) => /(?:不能|不可|不应|不允许|不要|避免|并非|不|错误地认为)[^，,]{0,10}$/.test(clause.slice(0, index)) ||
      /^(?:的(?:说法|做法|结论))?(?:会|将|就|是|则)?(?:违反|破坏|错误|不成立|不满足|无法保持)/.test(clause.slice(end));
    // Narrow, explicit physical constraint: do not infer arbitrary fixed
    // variables from prose or treat every mention of a distance as fixed.
    const fixedDistance = /(?:同一|固定)(?:构图[与和、])?(?:对焦距离|拍摄距离|物距)/.test(question) ||
      /保持(?:对焦距离|拍摄距离|物距)不变/.test(question);
    if (/景深/.test(source + candidate.card?.summary) && fixedDistance) {
      const change = /(?:缩短|增加|增大|减小|改变|调整)[^，。；]{0,6}(?:对焦距离|拍摄距离|物距)|(?:更近|更远)(?:的)?拍摄距离|(?:相机|镜头)[^，。；]{0,12}(?:更近|更远|靠近|远离)/g;
      for (const [field, text] of Object.entries(fields)) {
        if (!present(text)) continue;
        for (const clause of text.split(/[。；\n]/)) {
          const match = Array.from(clause.matchAll(change)).find(m => !negated(clause, m.index, m.index + m[0].length));
          if (match) { issues.push({ code: "question_condition_conflict", field, requiresNewQuestion: true, quote: match[0],
            message: "题干固定了对焦/拍摄距离，答案却建议改变该距离。保留固定条件时只能选择允许调整的量；若要讨论距离变化，必须同时改写题干、答案和评分要点，不能声称两者同时成立。" }); break; }
        }
      }
    }
    // CLT is asymptotic; a sample count alone is not an error bound.
    if (/中心极限定理|\bCLT\b/i.test(source + candidate.card?.summary)) {
      const premises = source + "\n" + question;
      const accuracyGiven = /Berry[ -]?Esseen|误差(?:上界|不超过|小于|≤)|假定[^。\n]{0,25}(?:近似|样本量足够)/i.test(premises) ||
        /(?:原始分布|总体|随机变量)(?:本身)?(?:是|为|服从)正态分布/.test(premises);
      if (!accuracyGiven) for (const [field, text] of Object.entries(fields)) {
        if (!present(text)) continue;
        for (const clause of text.split(/[。；\n]/)) {
          const match = /(?:\bn|样本量|样本数|样本大小)\s*(?:为|是|=|＝)\s*\d+\s*(?:已|已经|就|便|通常)?(?:足够大|够大|足以)/i.exec(clause);
          if (match && !negated(clause, match.index, match.index + match[0].length)) {
            issues.push({ code: "finite_sample_unverified", field, requiresNewQuestion: true, quote: match[0],
              message: "独立同分布与有限方差只给出渐近收敛，不能仅凭这个样本数保证正态近似精度。现有材料未给出分布或误差依据；请改问渐近结论或能否作此保证，不自行补出任意样本量足够大的前提。" }); break;
          }
        }
      }
    }
    return issues;
  }
  function transactionIssues(candidate, context) {
    const source = (context.evidence || []).map(item => item.text || "").join("\n");
    if (!/SQLite/.test(source) || !/原子|全部发生或全部不发生/.test(source) || /提交[^。\n]*(?:崩溃|丢失|恢复|持久)/.test(source)) return [];
    const fields = { "card.example.text": candidate.card?.example?.text, "exercise.question": candidate.exercise?.question };
    return Object.entries(fields).flatMap(([field, text]) => {
      if (present(text) && !/隔离|快照|其他事务|另一事务|可见性/.test(source)) {
        const clause = text.split(/[。；\n]/).find(value => /(?:另一|其他|其它)(?:个)?事务[^。；]{0,24}(?:看不到|看到|看见|可见)/.test(value) &&
          !/不能|无法|未说明|没有说明|不保证|是否|假设|假定/.test(value));
        if (clause) return [{ code: "transaction_context", field, requiresNewQuestion: field === "exercise.question", quote: clause,
          message: "原子性材料未说明其他事务的读取时点或隔离规则，不能补出其他事务看见或看不见修改的结论。改用事务全部生效或全部不生效判断是否等于硬件同时写入；不引入并发读可见性，同步调整题目和答案。" }];
      }
      if (!present(text) || /持久性|durability|synchronous|反例|说法.{0,6}(?:错误|成立)|是否可能|是否违反/.test(text)) return [];
      const match = /提交(?:成功|完成)?后[^。\n]*(?:崩溃|故障)[^。\n]*(?:消失|丢失|回滚)/.exec(text);
      if (!match) return [];
      return [{ code: "transaction_context", field, requiresNewQuestion: field === "exercise.question", quote: match[0],
        message: "材料只说明原子性，不提供成功提交后的持久性或故障恢复配置。“提交后”又丢失修改的情境缺少条件。改用一个明确的全有/全无表现判断是否等于硬件同时写入，移除无依据的提交后丢失情节；同步修改答案和解析。" }];
    });
  }
  function precisionIssues(candidate, context) {
    const source = (context.evidence || []).map(item => item.text || "").join("\n");
    const fields = { "card.summary": candidate.card?.summary, "card.example.text": candidate.card?.example?.text,
      "card.boundaries": candidate.card?.boundaries, "exercise.answer": candidate.exercise?.answer,
      "exercise.answerExplanation": candidate.exercise?.answerExplanation };
    (Array.isArray(candidate.exercise?.rubric) ? candidate.exercise.rubric : []).forEach((text, i) => { fields["exercise.rubric." + i] = text; });
    const issues = [];
    // These are specific observed conflations, not a general terminology judge.
    for (const [field, text] of Object.entries(fields)) {
      if (!present(text)) continue;
      for (const clause of text.split(/[。；\n]/)) {
        const term = /(?:检测)?准确率\s*[（(]\s*灵敏度\s*[）)]|灵敏度\s*(?:就是|即|等同于)\s*(?:检测)?准确率/.exec(clause);
        const iso = /曝光量由[^。；]{0,24}\bISO\b[^。；]{0,10}(?:共同)?决定/i.exec(clause);
        const approximation = /0\.693\d*[^。；]{0,35}(?:换算|转换)[^。；]{0,30}72/.exec(clause);
        const badApproximation = approximation && !/69\.3|经验|心算|调整|不能|不可|不应/.test(approximation[0]);
        const match = term || (/数字相机|数码|信号[^。]{0,8}放大/.test(source + text) && iso) || (badApproximation && approximation);
        if (!match) continue;
        const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length);
        if (/不能(?:说|认为)|错误(?:地认为|说法)|误以为|不要(?:写|说)|并非/.test(before) ||
          /^(?:的(?:说法|写法|表述))?(?:是)?(?:错误|不准确|不严谨)/.test(after)) continue;
        if (match === iso && /(?:这里|此处|本文|本题)[^。\n]{0,15}曝光量[^。\n]{0,10}(?:指|表示)[^。\n]{0,10}亮度/.test(source)) continue;
        issues.push({ code: match === approximation ? "approximation_derivation" : "term_conflation", field, quote: match[0], message: match === approximation ?
          "0.693换算成百分数得到69.3，不是72。72是另选的心算经验常数，不能由该换算直接推出。如果发现说明本身使用了这个错误推导，返回材料不足并指出缺失的经验近似依据；不可按错误来源照抄答案。" : term ?
          "灵敏度是真实阳性群体中的检出比例，不能把它与总体准确率当作同义词。保留本题实际使用的灵敏度、假阳性率和后验概率，删除错误的同义括注；不添加不需要的新指标。" :
          "这里混用了传感器接收的曝光量和成像亮度。明确光圈、快门控制进光，数字相机ISO涉及信号放大/亮度；不要说ISO直接增加进光量。原文若用词含糊，保留有依据的固定ISO补偿情景，不扩写错误定义。" });
        break;
      }
    }
    return issues;
  }
  function imageExerciseIssues(candidate, context) {
    const exercise = candidate.exercise || {}, question = exercise.question || "";
    const images = (context.evidence || []).filter(item => item.kind === "image");
    if (!images.length || exercise.type !== "recall" || /翻译|英语|英文词汇/.test(context.userGoal || "") ||
      /错误|是否|正确吗|调换|互换|纠正|对吗/.test(question)) return [];
    const observations = images.flatMap(item => item.observations || []).join("\n");
    const labels = new Set(Array.from(observations.matchAll(/[“"]([A-Za-z][A-Za-z0-9 _-]{2,40})[”"]/g), match => match[1]));
    const given = Array.from(labels).filter(label => question.includes(label));
    const fullMapping = given.length >= 3 && /从左到右|从上到下/.test(question) && /依次|分别/.test(question);
    const namedTarget = /标签(?:为|是)|标注为/.test(question) && /区域(?:对应|代表|是)/.test(question);
    if (!(fullMapping || namedTarget) || !given.some(label => String(exercise.answer || "").includes(label))) return [];
    return [{ code: "image_answer_leak", field: "exercise.question", requiresNewQuestion: true,
      message: "题干已经给出待识别区域的标签，答案主要是在复述。请只给观察中一个可见的位置/形状线索，要求回忆对应名称；题干不写这个名称，也不引入没有图例支持的功能或状态。例如问最右侧区域名称，只保留位置线索。材料只支持识别时保持识别目标。" }];
  }
  function conditionShifts(candidate, context) {
    const sources = (context.evidence || []).filter(function (source) { return source.kind !== "image" && present(source.text); }).map(function (source) { return source.text; });
    const card = candidate.card || {}, exercise = candidate.exercise || {};
    const fields = { "card.summary": card.summary, "card.example.text": card.example && card.example.text, "card.boundaries": card.boundaries,
      "exercise.answer": exercise.answer, "exercise.answerExplanation": exercise.answerExplanation };
    ["rubric", "misconceptions"].forEach(function (key) {
      (Array.isArray(exercise[key]) ? exercise[key] : []).forEach(function (value, index) { fields["exercise." + key + "." + index] = value; });
    });
    const issues = [], seen = new Set();
    sources.forEach(function (text) {
      for (const match of text.matchAll(/(通常(?:可以|可)?|可以|可能会|可能)([^，。；！？\n]{2,40})(?=[，。；！？\n]|$)/g)) {
        const stronger = match[1].startsWith("通常") ? ["总是", "必须", "不能", "不得", "不允许"] : match[1] === "可以" ? ["需要", "必须", "应该", "应当", "应"] : ["一定", "一定会", "必然", "必然会", "必定", "必定会"];
        const forms = [match[2]];
        // A bounded wording check: also recognize a two-character action when
        // a leading prepositional phrase is omitted. This is not a semantic parser.
        const shortened = match[2].match(/^(?:向|对|给|从|在|通过|使用|用)[\u4e00-\u9fffA-Za-z0-9_-]{1,12}([\u4e00-\u9fff]{2})$/);
        if (shortened) {
          forms.push(shortened[1]);
          const withoutPreposition = match[2].replace(/^(?:向|对|给|从|在)/, "");
          if (withoutPreposition !== match[2]) forms.push(withoutPreposition, "进行" + withoutPreposition, "进行" + shortened[1]);
        }
        stronger.forEach(function (word) {
          if (sources.some(function (source) { return source.includes(word + match[2]); })) return;
          forms.forEach(function (form) {
            const statement = word + form;
            if (sources.some(function (source) { return source.includes(statement); })) return;
            Object.entries(fields).forEach(function ([field, value]) {
              if (!present(value) || seen.has(field)) return;
              let position = value.indexOf(statement);
              while (position >= 0) {
                const before = value.slice(Math.max(0, position - 16), position).replace(/[“‘「"']/g, "");
                const after = value.slice(position + statement.length).split(/[，。；！？\n]/)[0];
                const negated = /(?:不|并非|不是|不代表|不意味着|不能认为|不能说|不要说|没有说明|不必|无需)$/.test(before)
                  || /(?:误以为|误认为|错误地认为)[^，。；！？\n]{0,12}$/.test(before)
                  || /^[”’」"']?(?:的(?:说法|观点))?(?:是|并)?(?:错误|不对|不成立|不准确)/.test(after);
                // A misconception can quote the learner's belief. Only skip
                // that clause; a later correction remains an asserted fact.
                const clausePrefix = value.slice(0, position).split(/[，。；！？\n]/).at(-1).trim().replace(/[“‘「"']/g, "");
                const reportedBelief = field.startsWith("exercise.misconceptions.") && /^(?:认为|以为)[^，。；！？\n]{0,24}$/.test(clausePrefix);
                const option = field.startsWith("exercise.misconceptions.") && exercise.options?.[Number(field.split(".").at(-1))];
                const quotedOption = present(option) && (value.startsWith(option + "：") || value.startsWith(option + ":")) && position < option.length;
                const nextCharacter = value.charAt(position + statement.length);
                const completeAction = form === match[2] || !nextCharacter || /[，。；！？、：\s”’」"']/.test(nextCharacter);
                const wordBoundary = word !== "应" || !/[响回反对适供感呼接顺相照因报效答支酬兑]/.test(value.charAt(position - 1));
                if (!negated && !reportedBelief && !quotedOption && completeAction && wordBoundary) {
                  seen.add(field);
                  issues.push({ code: "conditions_strengthened", field: field, sourcePhrase: match[0], outputPhrase: statement,
                    requiresNewQuestion: match[1].startsWith("通常") && ["不能", "不得", "不允许"].includes(word) && field.startsWith("exercise."),
                    matchKind: form === match[2] ? "literal" : "omitted_modifier",
                    message: field + " 将原文“" + match[0] + "”改成无依据的“" + statement + "”，请保留原文限定或给出明确支持该条件的依据。" +
                      (match[1].startsWith("通常") && ["不能", "不得", "不允许"].includes(word) ? "原文的限定许可不能推导出禁止；加上‘通常不能’仍未解决问题。请删除该禁止结论，原题依赖此条件时改问材料明确支持的判断，不补造规则。" : "") });
                  break;
                }
                position = value.indexOf(statement, position + statement.length);
              }
            });
          });
        });
      }
    });
    return issues;
  }
  function locate(ref, evidence) {
    const source = evidence.find(function (item) { return item.id === ref.evidenceId; });
    if (!source) return null;
    if (source.kind === "image") return present(ref.observation) && !ref.quote &&
      (!Array.isArray(source.observations) || source.observations.includes(ref.observation)) ? Object.assign({}, ref, { kind: "image", quote: "" }) : null;
    if (!present(ref.quote) || ref.quote !== ref.quote.trim() || ref.quote.length > 2000) return null;
    const occurrence = ref.occurrence === undefined ? 0 : ref.occurrence;
    if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence > 1000) return null;
    let index = -1;
    for (let i = 0; i <= occurrence; i += 1) {
      index = source.text.indexOf(ref.quote, index + 1);
      if (index < 0) return null;
    }
    return { evidenceId: source.id, kind: "text", claim: ref.claim, quote: ref.quote, occurrence: occurrence,
      startCharacter: (source.startCharacter || 0) + index, endCharacter: (source.startCharacter || 0) + index + ref.quote.length };
  }
  function imageClaimIssues(candidate, context) {
    const images = (context.evidence || []).filter(function (source) { return source.kind === "image" && Array.isArray(source.observations); });
    if (!images.length) return [];
    const support = (context.evidence || []).map(function (source) { return source.kind === "image" ? (source.observations || []).concat(source.legend || []).join("\n") : source.text || ""; }).join("\n");
    const captions = (context.evidence || []).filter(source => source.kind !== "image" && present(source.text)).map(source => source.text).join("\n");
    const card = candidate.card || {}, exercise = candidate.exercise || {};
    const fields = { "card.title": card.title, "card.learningObjective": card.learningObjective, "card.summary": card.summary, "card.example.text": card.example?.text, "card.boundaries": card.boundaries,
      "exercise.question": exercise.question, "exercise.answer": exercise.answer, "exercise.answerExplanation": exercise.answerExplanation };
    (Array.isArray(exercise.rubric) ? exercise.rubric : []).forEach(function (text, index) { fields["exercise.rubric." + index] = text; });
    const issues = [];
    Object.entries(fields).forEach(function ([field, text]) {
      if (!present(text)) return;
      const contentState = /(?:表示|说明|意味着)[^，。；\n]{0,12}(?:系统缓冲区|用户内存|数据库|磁盘|内存)(?:中|内)?(?:为空|有内容|没有内容|有数据|没有数据)/.exec(text);
      if (contentState && !/为空|有内容|没有内容|有数据|没有数据/.test(captions + "\n" + images.flatMap(source => source.legend || []).join("\n"))) {
        issues.push({ code: "image_claim_unverified", field, quote: contentState[0],
          message: "有无图形或白色矩形只能说明本图的可见形状，不能据此证明内存为空、缓冲区或磁盘中有内容。请将该字段改为标签、位置和形状的描述；识别目标仍可完成，不要因此拒绝整张图。" });
      }
      // An individual diagram cannot establish a habitual/general property.
      // Captions may state one explicitly; negative cautions are not assertions.
      const general = /通常|一般(?:来说|情况下|而言|(?=为|是|会|都|有|没|不|可以))|总是|始终|从来|永远/g;
      for (const match of text.matchAll(general)) {
        if (/通常|一般|总是|始终|从来|永远|\b(?:usually|generally|typically|normally|always|never)\b/i.test(support)) break;
        const before = text.slice(0, match.index).split(/[，,。；;！？\n]/).at(-1);
        const after = text.slice(match.index + match[0].length).split(/[，,。；;！？\n]/)[0];
        if (/(?:不能|无法|不足以|未能|没有依据|没有说明|不代表|不意味着|并非|不是)[^，,。；;！？\n]{0,24}$/.test(before) ||
          /^[^，,。；;！？\n]{0,30}(?:说法|结论|推断)[^，,。；;！？\n]{0,4}(?:不成立|无依据|错误)/.test(after)) continue;
        issues.push({ code: "image_scope_unverified", field, message: field + "把本图观察推广成“" + match[0] + "”的一般性质，但观察记录和附加文字没有给出该范围。请仅描述本图可见的事实，同步删除凭对象名称推断的功能；若目标依赖一般规则，需补充图注。" });
        break;
      }
      // A narrow grounding guard for the observed failures, not a general
      // visual truth detector. These states need visible text or a caption;
      // color/layout alone must not establish them, even after model review.
      for (const match of text.matchAll(/原始(?:数据|内容|页)|原数据|保持原样|(?:已|未|尚未|被|正在)?(?:修改|写入|回滚)|(?:已|未|尚未)提交|提交[后时]|保留区/g)) {
        if (support.includes(match[0])) continue;
        // This local guard checks for missing state evidence, not verbatim
        // sentence equality. Captions can support paraphrases or deductions;
        // the independent review still checks polarity, objects and inference.
        const state = /修改|写入|回滚|提交/.exec(match[0])?.[0];
        if (state && captions.includes(state)) continue;
        if (/原始|原数据|保持原样/.test(match[0]) && /原始(?:数据|内容|页)|原数据|保持原样/.test(captions)) continue;
        const clause = text.slice(0, match.index).split(/[，。；！？\n]/).at(-1);
        if (/(?:不能|无法|不足以|未能|没有依据|没有说明|并不代表)[^，。；！？\n]{0,24}$/.test(clause)) continue;
        issues.push({ code: "image_claim_unverified", field: field, message: field + "中的“" + match[0] + "”没有出现在独立图像观察或附加文字依据中。只凭颜色、布局不能建立该状态；请移除无依据结论，目标无法完成时返回insufficient_material并请求图注。" });
        break;
      }
    });
    return issues;
  }
  function timelineIssues(candidate, context) {
    const exercise = candidate.exercise || {}, question = exercise.question;
    const sources = (context.evidence || []).map(source => source.text || "").join("\n");
    if (!present(question) || !sources.includes("Promise.all")) return [];
    // Only an explicit Promise.all([names]) with one timed settlement per input.
    // No execution, inferred timings, overlapping start clocks or equal-time
    // ordering. Other question forms stay with the existing semantic review.
    const group = /Promise\.all\(\s*\[\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)+)\s*\]\s*\)/.exec(question);
    if (!group || /(?:不同时|分别|随后|延迟|先后)启动|启动时间|(?:在|到|第|截至)\s*[\d.]+\s*(?:ms|毫秒|s|秒)\s*时/.test(question)) return [];
    const names = group[1].split(/\s*,\s*/);
    if (names.length > 5 || new Set(names).size !== names.length) return [];
    const events = Array.from(question.matchAll(/\b([A-Za-z_$][\w$]*)\s*在\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)\s*后\s*(resolve|reject)\s*\(/g), match =>
      ({ name: match[1], time: Number(match[2]) * (match[3] === "s" || match[3] === "秒" ? 1000 : 1), type: match[4] }));
    if (events.length !== names.length || names.some(name => events.filter(event => event.name === name).length !== 1) || events.some(event => !Number.isFinite(event.time))) return [];
    const rejected = events.filter(event => event.type === "reject").sort((a, b) => a.time - b.time)[0];
    if (!rejected) return [];
    const completed = events.filter(event => event.time < rejected.time);
    if (!completed.length) return [];
    const fields = { "exercise.answer": exercise.answer, "exercise.answerExplanation": exercise.answerExplanation };
    (Array.isArray(exercise.rubric) ? exercise.rubric : []).forEach((value, index) => { fields["exercise.rubric." + index] = value; });
    const issues = [];
    for (const [field, text] of Object.entries(fields)) {
      if (!present(text) || /(?:拒绝|失败|完成)之前|(?:起初|最初|初始|开始)时|(?:在|到|第|截至)\s*[\d.]+\s*(?:ms|毫秒|s|秒)\s*时/.test(text)) continue;
      let previousNames = [];
      for (const clause of text.split(/[，,。；;！？\n]/)) {
        const mentions = names.filter(name => clause.split(/[^A-Za-z0-9_$]+/).includes(name));
        let subjects = mentions;
        if (!subjects.length && /它们|二者|两者|这些任务/.test(clause)) subjects = previousNames;
        if (!subjects.length && /其他(?:已经|已)?(?:启动的?)?(?:任务|Promise)|其余任务/.test(clause)) subjects = names.filter(name => name !== rejected.name);
        const match = /(?:仍(?:然)?(?:会)?(?:在)?(?:继续)?|还(?:会|在)?|继续)(?:执行|运行)/.exec(clause);
        const before = match ? clause.slice(0, match.index).replace(/[“‘"']/g, "") : "";
        const generic = /一般|通常|如果|假如|(?:尚未|未|没有)完成|未结束|仍在进行的/.test(clause);
        const negated = /(?:不|不会|不再|并非|不能|不代表|不等于)$/.test(before) || /(?:不能认为|不能说|不能推出|不能推断)[^，。]{0,16}$/.test(before) ||
          (match && /^[”’"']?(?:的(?:说法|结论))?(?:是)?(?:错误|不对|不成立)/.test(clause.slice(match.index + match[0].length)));
        const wrong = completed.filter(event => subjects.includes(event.name));
        if (match && !generic && !negated && wrong.length) {
          issues.push({ code: "timeline_state_mismatch", field, message: "题设中" + wrong.map(event => event.name + "在" + event.time + "ms已完成").join("、") + "，早于" + rejected.name + "在" + rejected.time + "ms拒绝。请直接写明这些任务已完成且未被取消，删除关于它们继续执行的句子，不再改写成不会继续执行；同步修正答案、解释与要点。" });
          break;
        }
        previousNames = generic ? [] : subjects;
      }
    }
    return issues;
  }
  function continuationIssues(candidate, context) {
    if (!(context.evidence || []).some(source => /Promise\.all/.test(source.text || ""))) return [];
    const text = candidate.card?.summary;
    if (!present(text)) return [];
    for (const match of text.matchAll(/其他(?:已经|已)?(?:启动的)?任务(?:仍然|仍|还|将|会)*继续(?:执行|运行)/g)) {
      const before = text.slice(0, match.index).split(/[。；\n]/).at(-1);
      const after = text.slice(match.index + match[0].length).split(/[。；\n]/)[0];
      if (/尚未完成|还未完成|未完成|未结束|不意味着|不代表|不能认为|不能说/.test(before) || /(?:说法|结论).{0,6}(?:不成立|错误)/.test(after)) continue;
      return [{ code: "task_continuation_scope", field: "card.summary", quote: match[0],
        message: "不会取消其他任务不等于所有其他任务仍在执行。摘要请写明只有尚未完成的任务会继续，已完成的任务不会重新运行；不要把本次时序判断扩大成无条件的继续执行。" }];
    }
    return [];
  }
  function exampleIssues(candidate, context) {
    const example = candidate.card?.example;
    const text = example?.text || "";
    const source = (context.evidence || []).map(item => item.text || "").join("\n");
    const issues = [];
    const exampleRefs = (candidate.evidence || []).filter(ref => ref && ref.claim === "example");
    if (example?.origin === "source" && exampleRefs.length && exampleRefs.every(ref =>
      (context.evidence || []).some(item => item.id === ref.evidenceId && item.origin === "discovery_outline"))) {
      issues.push({ code: "example_origin", field: "card.example", message: "示例引用的是 AI 生成提纲，不能标为原文示例；请按教学示例整理。" });
    }
    if (example?.origin === "source" && present(text) && !(context.evidence || []).some(item => item.kind === "image")) {
      const literalNumbers = value => Array.from(String(value || "").matchAll(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi), match => String(Number(match[0])));
      const observedSource = (context.evidence || []).map(item => item.kind === "image" ? (item.observations || []).join("\n") : item.text || "").join("\n");
      const known = new Set(literalNumbers(observedSource));
      if (literalNumbers(text).some(number => !known.has(number))) issues.push({ code: "example_origin", field: "card.example",
        message: "这个示例含有原文或图像观察未提供的新数字，不能标成原文示例。保留正确的教学应用并标为authored，或改为有原文依据的source示例；不得伪造出处。" });
    }
    // Only the observed ambiguous in-place/new-list contrast is checked here;
    // separate function definitions already make their independent state clear.
    const inPlace = /\b([A-Za-z_]\w*)\.sort\(/.exec(text);
    if (example?.type === "contrast" && inPlace && text.slice(inPlace.index).includes("sorted(" + inPlace[1] + ")") &&
      !/独立|重新初始化|重置|重新创建|分别从|分别以/.test(text)) {
      issues.push({ code: "example_context", field: "card.example.text", message: "有状态代码的对照示例没有说明独立初始状态。请明确各情景独立运行或重置变量，避免把已修改的输入当作原输入。" });
    }
    if (example?.origin === "authored" && /(?:先|首先)[^。\n]*(?:日志|写入|磁盘)[^。\n]*(?:再|然后|接着)/.test(text) &&
      !/(?:先|首先|之前|之后|然后|再)[^。\n]*(?:日志|写入|磁盘)/.test(source)) {
      issues.push({ code: "example_context", field: "card.example.text", message: "材料没有提供日志或磁盘的具体执行顺序，自拟示例却补写了先后步骤。请改为仅应用材料所述规则的假设情景，不补充内部实现流程。" });
    }
    const fields = { "card.example.text": text, "exercise.question": candidate.exercise?.question || "", "exercise.answerExplanation": candidate.exercise?.answerExplanation || "" };
    for (const [field, value] of Object.entries(fields)) {
      if (hasInlineCompound(value)) {
        issues.push({ code: "code_format", field, message: "Python函数体中的复合语句被压在def同一行，语法无效。请恢复真实换行及缩进，不能用分号拼接if、for、while、try或with语句。" });
      }
    }
    return issues;
  }
  function validate(candidate, context, task, requireSemantic) {
    const problems = [];
    function issue(code, message) { problems.push({ code: code, message: message }); }
    if (["needs_split", "insufficient_material"].includes(candidate.status)) {
      issue(candidate.status, (candidate.issues || []).join("；") || (candidate.status === "needs_split" ? "材料需要先拆分，请选一个目标或缩小范围" : "材料不足，请补充依据"));
      return { passed: false, issues: problems, evidence: [], checks: [] };
    }
    const card = candidate.card || {};
    const exercise = candidate.exercise || {};
    if (!present(card.title) || card.title.length > 80) issue("title", "标题须完整可读，长度为 1–80 字");
    if (!/^能(?:解释|区分|判断|完成|识别).+/.test(card.learningObjective || "")) issue("objective", "学习目标须以能解释、能区分、能判断、能完成或能识别开头");
    if (!present(card.summary) || generic(card.summary)) issue("explanation", "缺少有效的核心解释");
    if (!["concept", "mechanism", "procedure", "fact"].includes(card.knowledgeType)) issue("knowledge_type", "需要明确知识类型");
    if (card.knowledgeType !== "fact" && (!card.example || !present(card.example.text))) issue("example", "需要具体示例、对照或过程");
    if (card.example && present(card.example.text)) {
      if (!["authored", "source"].includes(card.example.origin)) problems.push({ code: "example_origin_missing", field: "card.example.origin", message: "示例来源标记无效：origin 必须为 authored 或 source。" });
      if (!["example", "contrast", "steps", "illustration"].includes(card.example.type)) problems.push({ code: "example_type", field: "card.example.type", message: "示例类型无效：type 必须为 example、contrast、steps 或 illustration。" });
    }
    if (!["choice", "recall"].includes(exercise.type) || !present(exercise.question) || generic(exercise.question)) issue("exercise", "需要有效的选择题或回忆题");
    if (!present(exercise.answer) || !present(exercise.answerExplanation) || !Array.isArray(exercise.rubric) || !exercise.rubric.length || !exercise.rubric.every(present)) issue("answer", "练习必须有正确答案、答案依据和评分要点");
    if (present(exercise.answerExplanation) && exercise.answerExplanation.length > 320) issue("answer_explanation_long", "答案依据超过320字，请只保留校对后的结论和必要中间结果，不保留试算草稿");
    if (exercise.type === "choice") {
      const options = exercise.options;
      if (!Array.isArray(options) || options.length < 2 || options.length > 5 || !options.every(present) || options.some(generic) || new Set(options.map(function (x) { return String(x).trim(); })).size !== options.length) issue("options", "选择题需要 2–5 个不重复的有效选项，不能使用通用占位选项");
      if (!Array.isArray(options) || !Number.isInteger(exercise.correctIndex) || exercise.correctIndex < 0 || exercise.correctIndex >= options.length || exercise.answer !== options[exercise.correctIndex]) issue("answer_consistency", "正确答案与选项索引不一致");
      if (!Array.isArray(options) || !Array.isArray(exercise.misconceptions) || exercise.misconceptions.length !== options.length || options.some(function (_, i) { return i !== exercise.correctIndex && !present(exercise.misconceptions[i]); })) issue("misconceptions", "每个干扰项须对应一个具体误区");
      if (Array.isArray(exercise.misconceptions) && present(exercise.misconceptions[exercise.correctIndex])) issue("correct_option_misconception", "正确选项不能同时标为错误误区，请核对答案与误区说明");
    }
    const refs = Array.isArray(candidate.evidence) ? candidate.evidence : [];
    const located = [];
    // The limit is eight source locations, each explicitly linked to up to
    // four content fields. Expansion must not count those links as new quotes.
    if (refs.length > 32) issue("evidence_links_limit", "每张卡最多 32 条引用关联（8 处依据各关联至多 4 个字段）");
    refs.slice(0, 32).forEach(function (ref) {
      const span = ref && ["summary", "exercise", "boundaries", "example"].includes(ref.claim) && locate(ref, context.evidence || []);
      if (!span) problems.push({ code: "evidence_location", claim: ref && ref.claim || null,
        message: ref && ref.invalidReference ? "引用关联失配：" + ref.invalidReference.code + "（" + (ref.claim || "未知字段") + "，" + (ref.invalidReference.referenceId || "无ID") + "）" : "引用不存在、原文不一致或位置无效" });
      else located.push(span);
    });
    const locations = new Set(located.map(function (span) {
      return JSON.stringify(span.kind === "image" ? [span.evidenceId, span.observation] : [span.evidenceId, span.startCharacter, span.endCharacter]);
    }));
    if (locations.size > 8) issue("evidence_limit", "每张卡最多使用 8 处不同依据，同一处可支持多个字段");
    problems.push(...conditionShifts(candidate, context));
    problems.push(...boundaryIssues(candidate, context));
    problems.push(...imageClaimIssues(candidate, context));
    problems.push(...timelineIssues(candidate, context));
    problems.push(...continuationIssues(candidate, context));
    problems.push(...exampleIssues(candidate, context));
    problems.push(...sortingIssues(candidate, context));
    problems.push(...sortingPriorityIssues(candidate, context));
    problems.push(...applicationConditionIssues(candidate, context));
    problems.push(...transactionIssues(candidate, context));
    problems.push(...precisionIssues(candidate, context));
    problems.push(...imageExerciseIssues(candidate, context));
    problems.push(...iscloseIssues(candidate));
    problems.push(...numericAnswerIssue(exercise, exercise.answerExplanation));
    problems.push(...calculationIssues(candidate));
    ["summary", "exercise"].concat(present(card.boundaries) ? ["boundaries"] : [], card.example && card.example.origin === "source" && present(card.example.text) ? ["example"] : []).forEach(function (claim) {
      if (!located.some(function (span) { return span.claim === claim; })) issue("evidence_" + claim, { summary: "核心解释", exercise: "答案", boundaries: "适用边界", example: "原文示例" }[claim] + "缺少可定位依据");
    });
    const checks = Array.isArray(candidate.checks) ? candidate.checks : [];
    if (requireSemantic) task.semanticRules.forEach(function (rule) {
      const matches = checks.filter(function (item) { return item && item.rule === rule; });
      const check = matches[0];
      if (matches.length !== 1 || typeof check?.passed !== "boolean" || !present(check.reason)) {
        issue("semantic_" + rule, matches.length > 1 ? "语义检查重复或冲突：" + rule : "核验结构无效：" + rule + "须有布尔值passed和具体reason，不能使用字符串代替布尔值");
      } else if (!check.passed) {
        const field = /^(?:card\.(?:summary|example(?:\.text)?|boundaries|learningObjective)|exercise\.(?:question|options|correctIndex|answer|answerExplanation|rubric(?:\.\d+)?|misconceptions(?:\.\d+)?))$/.test(check.field || "") ? check.field : undefined;
        problems.push({ code: "semantic_" + rule, ...(field ? { field: field } : {}), message: check.reason });
      }
    });
    if (requireSemantic && task.choiceReview === "per-option-v1" && exercise.type === "choice" && Array.isArray(exercise.options)) {
      const check = checks.find(function (item) { return item && item.rule === "answerCorrectness"; });
      const items = check && check.optionChecks;
      const count = exercise.options.length;
      // A summary boolean cannot stand in for the option-by-option verdicts.
      // These checks enforce coverage and consistency, not semantic truth.
      const complete = Array.isArray(items) && items.length === count && items.every(function (item) {
        return item && Number.isInteger(item.index) && item.index >= 0 && item.index < count &&
          typeof item.validAnswer === "boolean" && typeof item.misconceptionCorrect === "boolean" && present(item.reason);
      }) && new Set(items.map(function (item) { return item.index; })).size === count;
      if (!complete) issue("semantic_answerCorrectness", "选择题逐项核验缺失或无效：每个选项须有唯一索引、答案判断、误区判断和具体结论");
      else items.forEach(function (item) {
        if (item.validAnswer !== (item.index === exercise.correctIndex)) problems.push({ code: "semantic_answerCorrectness", field: "exercise.options",
          message: "选项 " + (item.index + 1) + " 的有效性与所选答案冲突：" + item.reason });
        if (!item.misconceptionCorrect) problems.push({ code: "semantic_answerCorrectness", field: "exercise.misconceptions." + item.index,
          message: "选项 " + (item.index + 1) + " 的误区说明不成立：" + item.reason });
      });
    }
    if (requireSemantic && task.recallReview === "compared-v1" && exercise.type === "recall") {
      const comparison = checks.find(item => item && item.rule === "answerCorrectness")?.comparison;
      if (!comparison || typeof comparison.equivalent !== "boolean" || typeof comparison.followsQuestion !== "boolean" || !present(comparison.reason)) {
        problems.push({ code: "recall_comparison_invalid", field: "exercise.answer", message: "回忆题缺少有效的独立答案比对及题设约束核对；不能仅用总评通过代替。" });
      } else if (!comparison.equivalent || !comparison.followsQuestion) {
        problems.push({ code: "independent_answer_mismatch", field: "exercise.answer", message: "回忆题答案与独立解题或题设约束冲突：" + comparison.reason });
      }
    }
    return { passed: !problems.length, issues: problems, evidence: located, checks: checks };
  }
  function createQualityService(options) {
    const task = options.task;
    async function run(context, initial, action, execution) {
      context = Object.assign({}, context, { evidence: (context.evidence || []).map(function (source) { return Object.assign({}, source); }) });
      const transport = execution && execution.transport || options.transport;
      const calls = [];
      const rounds = [];
      const started = Date.now();
      // Review and repair must not mutate the caller's saved or historical card.
      initial = initial ? JSON.parse(JSON.stringify(initial)) : initial;
      let candidate = initial;
      const resume = action === "resume" && initial && initial.generation && initial.generation.resume;
      let repairUsed = Boolean(resume && resume.repairUsed);
      let reviewed = Boolean(resume && resume.reviewed);
      let reviewIssues = resume && resume.reviewIssues || [];
      // Edits/reviews operate on the same draft material. Keep its independent
      // source transcript stable, so a new wording cannot invalidate old quotes.
      // Fresh generation and retry still observe their input image anew.
      const savedObservation = ["review", "summary", "example", "exercise"].includes(action) && initial?.generation?.imageObservation;
      let imageObservation = resume && resume.imageObservation || (Array.isArray(savedObservation?.observations) && savedObservation.observations.every(present) &&
        Array.isArray(savedObservation.legend) && savedObservation.legend.every(present) ? savedObservation : null);
      let solutionCache = resume && resume.solutionCache || null;
      if (resume) candidate = { status: "ready", card: initial.card, exercise: initial.exercise, evidence: initial.evidence, checks: initial.checks, issues: initial.issues };
      async function request(operation, extra) {
        const directions = { summary: "讲清楚一点：补清因果、机制或步骤，保留关键条件，让读者能独立理解；只修改核心解释。",
          example: "换个例子：使用与当前不同的具体场景或过程，保持学习目标和机制不变；只修改示例。",
          exercise: "题目太简单：改用新的应用或对比情景考查同一目标，增加推理而不是生僻词；给出答案依据和具体误区。" };
        const payload = Object.assign(operation === "observe_image" ? { operation: operation } :
          operation === "solve" || (operation === "review" && task.reviewFindings) ? { operation: operation, sources: context.evidence } :
            { operation: operation, userGoal: context.userGoal || "", sources: context.evidence }, extra || {});
        if (operation === "generate" || operation === "revise") {
          payload.relatedCards = context.relatedCards || [];
          payload.learningContext = context.learningContext || { explicitPreferences: [], recentFacts: [], learnedUnits: [], appliedPreferenceIds: [] };
          payload.request = directions[action] || (action === "resume" ? "生成一张卡" : action) || "生成一张卡";
        }
        if (payload.candidate) {
          // Do not send self-grades, earlier verdicts, call history or session
          // metadata back to the verifier or echo them into repair prompts.
          payload.candidate = candidateForRequest(payload.candidate);
          if (operation === "review" && task.reviewFindings) delete payload.candidate.status;
        }
        const content = [{ type: "text", text: JSON.stringify(payload) }];
        if (context.image && context.image.dataUrl && (task.imageReview !== "observations-v1" || operation === "observe_image")) content.push({ type: "image_url", image_url: { url: context.image.dataUrl } });
        const stamp = Date.now();
        const config = options.getModelConfig() || {};
        const requestOptions = task.requestOptions ? task.requestOptions(config.model, operation) : {};
        let result;
        try {
          result = await transport.complete(config, Object.assign({ messages: [{ role: "system", content: task.instructionsFor ? task.instructionsFor(operation, partial ? action : undefined, payload.issues) : task.instructions }, { role: "user", content: content.length === 1 ? content[0].text : content }],
            temperature: ["observe_image", "solve", "review"].includes(operation) ? 0 : Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.3, response_format: { type: "json_object" } }, requestOptions));
        } catch (error) {
          calls.push({ operation: operation, model: (options.getModelConfig() || {}).model || "", latencyMs: error.provider?.latencyMs ?? Date.now() - stamp, usage: error.provider?.usage || null,
            error: error.code || "request_failed", sent: error.sent !== false && error.code !== "EVAL_BUDGET_REACHED", httpStatus: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : null });
          throw error;
        }
        const call = { operation: operation, model: result.provider.model, latencyMs: result.provider.latencyMs, usage: result.provider.usage || null,
          finishReason: result.finishReason || null, requestOptions: requestOptions, thinkingPolicy: result.provider.thinkingPolicy || null };
        calls.push(call);
        if (result.finishReason === "length") {
          call.error = "MODEL_OUTPUT_LIMIT";
          let completeJson = false;
          try { JSON.parse(result.content); completeJson = true; } catch { /* Truncated output is never accepted. */ }
          const output = typeof result.content === "string" ? result.content : "";
          // Provider has already rejected thinking content. Keep a bounded part
          // of the answer for diagnosis, never the request, config, or HTTP error.
          call.outputDiagnostics = { characters: output.length, completeJson: completeJson,
            head: output.slice(0, 800), tail: output.slice(Math.max(800, output.length - 1200)), omittedCharacters: Math.max(0, output.length - 2000) };
          throw Object.assign(new Error("模型回复达到输出上限，已停止处理"), { code: "MODEL_OUTPUT_LIMIT" });
        }
        return result.content;
      }
      let quality;
      const partial = ["summary", "example", "exercise"].includes(action);
      let independentReview = task.reviewPolicy === "independent" || Boolean(resume && resume.independentReview) || action === "review" || partial || Boolean(context.image) || (context.materialLength || 0) > task.combinedReviewMaxCharacters;
      function applyPartial(next) {
        const merged = JSON.parse(JSON.stringify(initial));
        if (action === "exercise") merged.exercise = next.exercise;
        else merged.card[action] = next.card && next.card[action];
        merged.evidence = (initial.evidence || []).filter(function (r) { return r.claim !== action; }).concat((next.evidence || []).filter(function (r) { return r.claim === action; }));
        merged.checks = [];
        merged.status = "ready";
        return merged;
      }
      async function solveExercise() {
        const exercise = candidate.exercise;
        const problem = { type: exercise.type, question: exercise.question, options: exercise.type === "choice" ? exercise.options : [] };
        const key = JSON.stringify(problem);
        if (!solutionCache || solutionCache.key !== key) {
          const solved = domain.extractJson(await request("solve", problem));
          const judgments = solved.optionJudgments;
          if (typeof solved.answerable !== "boolean" || !present(solved.answer) || !present(solved.basis) || !Array.isArray(judgments) || judgments.length !== problem.options.length ||
            judgments.some(function (item) { return !item || !Number.isInteger(item.index) || item.index < 0 || item.index >= problem.options.length || item.option !== problem.options[item.index] || typeof item.valid !== "boolean"; }) ||
            new Set(judgments.map(function (item) { return item.index; })).size !== judgments.length) {
            throw Object.assign(new Error("独立解题未返回有效的布尔值、答案及选项索引"), { code: "ANSWER_REVIEW_INVALID" });
          }
          solutionCache = { key: key, value: { ...pick(solved, ["answerable", "answer", "basis"]), validOptionIndices: judgments.filter(function (item) { return item.valid; }).map(function (item) { return item.index; }) } };
        }
        const solved = solutionCache.value;
        const numberIssues = numericAnswerIssue(exercise, solved.answer + "\n" + solved.basis);
        if (numberIssues.length) return numberIssues;
        if (!solved.answerable) return [{ code: "independent_answer_unavailable", message: "独立解题认为题目缺少依据：" + solved.answer + "；" + solved.basis }];
        if (exercise.type === "choice" && (solved.validOptionIndices.length !== 1 || solved.validOptionIndices[0] !== exercise.correctIndex)) {
          return [{ code: "independent_answer_mismatch", message: "独立解题得到有效选项索引[" + solved.validOptionIndices.join(",") + "]，与单选答案索引" + exercise.correctIndex + "不符。" + solved.answer + "；" + solved.basis + "。请重写题目及选项，确保唯一答案；不能把有效解法判错。" }];
        }
        return [];
      }
      try {
        let imageUnavailable = false;
        if (task.imageReview === "observations-v1" && context.image?.dataUrl) {
          if (!imageObservation) {
            const observed = domain.extractJson(await request("observe_image"));
            if (!Array.isArray(observed.observations) || !observed.observations.every(present) || !Array.isArray(observed.legend) || !observed.legend.every(present)) {
              throw Object.assign(new Error("图片未返回可核对的观察记录"), { code: "IMAGE_OBSERVATION_INVALID" });
            }
            imageObservation = { observations: Array.from(new Set(observed.observations)).slice(0, 64), legend: observed.legend.slice(0, 32) };
          }
          context.evidence.forEach(function (source) {
            if (source.kind === "image") Object.assign(source, imageObservation);
          });
          const missingGoal = imageClaimIssues({ card: { learningObjective: context.userGoal } }, context);
          if (!imageObservation.observations.length || missingGoal.length) {
            imageUnavailable = true;
            candidate = { status: "insufficient_material", card: null, exercise: null, evidence: [], issues: [missingGoal.length ? "目标要求判断图片中的数据状态，但可见证据没有说明该状态。请补充图例或相邻段落，不能仅凭颜色判断，也不能把目标改为位置识别。" : "图片没有可独立核对的文字或图示依据，请补充图注或相关段落"] };
          }
        }
        if (action !== "review" && (!resume || resume.pendingGeneration) && !imageUnavailable) {
          try { const next = parse(await request(partial ? "revise" : "generate", initial ? { candidate: initial, part: action } : {})); candidate = partial ? applyPartial(next) : next; }
          catch (error) { if (calls.at(-1) && calls.at(-1).error) throw error; candidate = initial || { card: null, exercise: null, evidence: [], issues: ["模型返回不是有效卡片 JSON"] }; }
        }
        const maxRounds = action === "review" || repairUsed ? 1 : 2;
        for (let attempt = 0; attempt < maxRounds; attempt += 1) {
          quality = validate(candidate, context, task, reviewed || !independentReview);
          if (reviewed && reviewIssues.length) quality = Object.assign({}, quality, { passed: false, issues: quality.issues.concat(reviewIssues) });
          if (independentReview && !reviewed && validate(candidate, context, task, false).passed) {
            const answerIssues = task.answerReview === "blind-v1" ? await solveExercise() : [];
            if (answerIssues.length) {
              quality = { passed: false, evidence: quality.evidence, checks: [], issues: answerIssues };
            } else {
            const verdict = domain.extractJson(await request("review", Object.assign({ candidate: candidate }, solutionCache ? { independentAnswer: solutionCache.value } : {})));
            reviewIssues = task.reviewFindings ? findingIssues(verdict, candidate) : [];
            candidate.checks = verdict.checks;
            // Contradictory free-form problems must not be ignored just because
            // the five booleans are true. Require the reviewer to resolve them.
            if (Array.isArray(verdict.issues) && verdict.issues.length) candidate.checks = (Array.isArray(candidate.checks) ? candidate.checks : []).concat({ rule: "coherence", passed: false, reason: "核验结果仍列出未解决问题" });
            reviewed = true;
            quality = validate(candidate, context, task, true);
            if (reviewIssues.length) quality = Object.assign({}, quality, { passed: false, issues: quality.issues.concat(reviewIssues) });
            }
          }
          rounds.push({ attempt: attempt + 1, issues: quality.issues, checks: quality.checks });
          if (quality.passed || ["needs_split", "insufficient_material"].includes(candidate.status) || attempt === maxRounds - 1) break;
          const repaired = parse(await request("repair", { candidate: candidate, issues: quality.issues, part: partial ? action : "all" }), candidateForRequest(candidate).evidence);
          repairUsed = true;
          reviewed = false;
          reviewIssues = [];
          const merged = mergeRepair(candidate, repaired);
          candidate = partial && !["needs_split", "insufficient_material"].includes(merged.status) ? applyPartial(merged) : merged;
          // Review a merged patch once if it omitted fresh checks; never reuse
          // semantic verdicts for content that has since been changed.
          const repairChecks = Array.isArray(candidate.checks) ? candidate.checks : [];
          if (!task.semanticRules.every(function (rule) {
            return repairChecks.some(function (check) { return check && check.rule === rule && typeof check.passed === "boolean" && present(check.reason); });
          })) independentReview = true;
        }
      } catch (error) {
        const messages = { MODEL_OUTPUT_LIMIT: "模型回复达到输出上限，未完成质量核验；已有草稿已保留",
          ANSWER_REVIEW_INVALID: "独立解题未返回有效结果；已有草稿已保留",
          IMAGE_OBSERVATION_INVALID: "图片观察未完成，请补充图注或重试；已有素材已保留",
          SEMANTIC_REVIEW_INVALID: "事实审校未返回可定位的结论；已有草稿已保留，可重新核验",
          MODEL_NON_THINKING_UNSUPPORTED: "该型号不支持关闭思考或尚未适配非思考模式，已阻止调用，请更换型号",
          MODEL_THINKING_NOT_DISABLED: "模型服务仍返回思考内容或思考用量，已停止处理；请确认服务支持关闭思考" };
        quality = { passed: false, evidence: [], checks: [], issues: [{ code: error.code || "generation_failed", message: messages[error.code] || "生成或核验未完成，请重试；已有草稿已保留" }] };
      }
      candidate = candidate || { card: null, exercise: null, evidence: [] };
      quality = quality || validate(candidate, context, task, true);
      const lastCall = calls.at(-1);
      const continuation = lastCall && lastCall.error === "EVAL_BUDGET_REACHED" && ["generate", "repair", "review", "solve"].includes(lastCall.operation) && (candidate.card || imageObservation)
        ? { independentReview: independentReview, repairUsed: repairUsed, reviewed: reviewed, reviewIssues: reviewIssues, imageObservation: imageObservation, solutionCache: solutionCache, pendingGeneration: !candidate.card } : null;
      return Object.assign({}, candidate, { status: quality.passed ? "ready" : ["needs_split", "insufficient_material"].includes(candidate.status) ? candidate.status : "needs_revision", quality: quality,
        generation: { promptVersion: task.version, requestProfile: task.requestProfile || "provider-default", model: calls.length ? calls[calls.length - 1].model : (options.getModelConfig() || {}).model || "", materialLength: context.materialLength || 0,
          elapsedMs: Date.now() - started, calls: calls, rounds: rounds, resume: continuation, reviewMode: independentReview ? "separate" : "combined",
          imageObservation: imageObservation, answerVerification: solutionCache && solutionCache.value } });
    }
    return { run: run };
  }
  return { CARD_FIELDS: CARD_FIELDS, EXERCISE_FIELDS: EXERCISE_FIELDS, pick: pick, parse: parse, locate: locate, validate: validate, createQualityService: createQualityService };
});
