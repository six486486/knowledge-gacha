// Authored discovery fixtures exercise product contracts; they are not model-quality evidence.
function clean(value, fallback) {
  return String(value || fallback || "").replace(/\s+/g, " ").trim();
}

const exploration = [
  {
    topic: "缓存失效后旧数据为什么仍可能出现",
    objective: "能区分缓存过期、主动失效与回源更新失败",
    novelty: "新增对过期时间、删除动作和并发回源三个时序条件的判断",
    key: "cache-expiry-stale-data"
  },
  {
    topic: "相关性为什么不能直接证明因果关系",
    objective: "能识别共同原因、反向因果与随机巧合",
    novelty: "新增用对照、时间顺序和替代解释检查因果主张的方法",
    key: "correlation-causation-check"
  },
  {
    topic: "低概率检测为什么会产生大量误报",
    objective: "能判断基准率如何改变阳性结果的可信度",
    novelty: "新增把先验比例与检测准确率一起换算为后验概率的方法",
    key: "base-rate-false-positive"
  },
  {
    topic: "网络重试怎样避免把同一笔操作执行两次",
    objective: "能解释幂等键如何区分重试与新的业务请求",
    novelty: "新增对超时、重复提交和服务端结果缓存三种边界的判断",
    key: "retry-idempotency-key"
  },
  {
    topic: "抽样结果为什么会偏离真实总体",
    objective: "能区分随机误差、选择偏差与幸存者偏差",
    novelty: "新增从样本进入机制检查结论能否推广到总体的方法",
    key: "sampling-bias-generalization"
  },
  {
    topic: "平均数相同为什么分布可能完全不同",
    objective: "能判断方差、偏度与极端值怎样改变平均数的含义",
    novelty: "新增用分位数和分布形状补充单一平均值的方法",
    key: "mean-distribution-shape"
  },
  {
    topic: "异步任务为什么会以错误顺序完成",
    objective: "能识别竞态条件并选择版本号或取消策略",
    novelty: "新增对响应乱序、陈旧写入和重复回调的处理边界",
    key: "async-race-order"
  },
  {
    topic: "压缩为什么能减少文件却不能凭空保留全部细节",
    objective: "能区分无损压缩、感知编码与信息丢失",
    novelty: "新增从冗余、容许误差和还原要求选择压缩方式的方法",
    key: "compression-loss-boundary"
  },
  {
    topic: "索引为什么会加快查询却拖慢写入",
    objective: "能判断索引维护成本何时超过查询收益",
    novelty: "新增用选择性、写入频率和存储开销评估索引的方法",
    key: "database-index-tradeoff"
  }
];

function interestOutline(seed, ordinal) {
  const anchor = clean(seed.anchor, "所选主题");
  const variants = [
    ["中的条件与反例", "能解释" + anchor + "中结论成立的条件与一个反例", "新增对关键条件、因果链和失效边界的系统判断", "conditions-counterexample"],
    ["如何从现象追到机制", "能区分" + anchor + "中的表面现象与底层机制", "新增从可观察现象反推机制并用反例校验的方法", "phenomenon-mechanism"],
    ["怎样用于真实决策", "能判断" + anchor + "在两个现实场景中的适用方式", "新增把概念转换为决策步骤并检查限制条件的方法", "decision-boundary"]
  ];
  const item = variants[ordinal % variants.length];
  return {
    seedId: seed.id,
    conceptKey: "interest:" + anchor.toLocaleLowerCase() + ":" + item[3],
    topic: anchor + item[0],
    learningObjective: item[1],
    newKnowledge: item[2] + "，内容围绕“" + anchor + "”展开",
    difficulty: ordinal % 3 === 2 ? "challenge" : "standard"
  };
}

function relatedOutline(seed, ordinal) {
  const anchor = clean(seed.anchor, "已有知识");
  const variants = [
    ["的异常路径与恢复边界", "能区分" + anchor + "在正常路径和异常路径中的表现", "新增异常恢复、时序竞争和失败边界的判断方法", "failure-recovery"],
    ["在相似场景中的关键对比", "能判断" + anchor + "与相似机制分别适用于什么条件", "新增两个相似机制的判断线索、反例与适用边界", "comparison-boundary"],
    ["从原理到诊断步骤", "能完成" + anchor + "出现异常时的三步诊断", "新增从现象定位条件、验证假设并选择处理动作的步骤", "diagnostic-steps"]
  ];
  const item = variants[ordinal % variants.length];
  return {
    seedId: seed.id,
    conceptKey: "extension:" + clean(seed.id).toLocaleLowerCase() + ":" + item[3],
    topic: anchor + item[0],
    learningObjective: item[1],
    newKnowledge: item[2],
    difficulty: seed.mode === "weak_extension" ? "foundation" : ordinal % 2 ? "challenge" : "standard"
  };
}

function exploreOutlines(seed, refreshIndex, count) {
  const start = ((Math.max(1, Number(refreshIndex) || 1) - 1) * 3) % exploration.length;
  return Array.from({ length: count }, function (_, index) {
    const item = exploration[(start + index) % exploration.length];
    return {
      seedId: seed.id,
      conceptKey: item.key,
      topic: item.topic,
      learningObjective: item.objective,
      newKnowledge: item.novelty,
      difficulty: index === 2 ? "challenge" : "standard"
    };
  });
}

function candidateOutlines(input) {
  const payload = input || {};
  const seeds = Array.isArray(payload.seeds) ? payload.seeds : [];
  const refreshIndex = Math.max(1, Number(payload.refreshIndex) || 1);
  const candidates = [];
  seeds.filter(function (seed) { return seed.mode !== "controlled_exploration"; }).slice(0, 4).forEach(function (seed, index) {
    candidates.push(seed.mode === "explicit_interest" ? interestOutline(seed, refreshIndex + index - 1) : relatedOutline(seed, refreshIndex + index - 1));
  });
  const explore = seeds.find(function (seed) { return seed.mode === "controlled_exploration"; });
  if (explore) candidates.push(...exploreOutlines(explore, refreshIndex, Math.max(1, Math.min(3, 6 - candidates.length))));
  return { candidates: candidates.slice(0, 6).map(candidate => ({ ...candidate,
    knowledgeText: candidate.newKnowledge + "。这个测试知识说明仅用于验证产品流程，不代表真实模型内容质量。判断新场景时要先列出成立条件、预期结果以及反例，再检查条件变化是否影响结论。" })) };
}

function line(text, label) {
  const match = String(text || "").split(/\r?\n/).find(function (item) { return item.startsWith(label); });
  return clean(match ? match.slice(label.length) : "");
}

function discoveryQualityOutput(payload) {
  const verification = require("./quality-output.js").verificationOutput(payload);
  if (verification) return verification;
  if (payload.operation === "review") return null;
  const sources = payload.sources || payload.evidence || [];
  const outline = sources.find(function (source) { return source.id === "discovery_outline"; }) || sources[0];
  if (!outline || !outline.text) return { status: "insufficient_material", issues: ["发现候选缺少结构化提纲"], card: null };
  const topic = line(outline.text, "主题：") || "发现知识";
  const objective = line(outline.text, "学习目标：") || "能解释这个知识方向的关键机制";
  const novelty = line(outline.text, "必须新增：") || "新增一个可检查的机制与适用边界";
  const quote = ["主题：" + topic, "学习目标：" + objective, "必须新增：" + novelty].join("\n");
  const ref = function (claim) { return { claim: claim, evidenceId: outline.id, quote: quote }; };
  return {
    status: "ready",
    card: {
      title: topic,
      learningObjective: objective,
      knowledgeType: "mechanism",
      summary: novelty + "。先识别触发条件，再沿因果链检查结果，最后用反例确认这条解释的适用边界。",
      example: { type: "example", text: "面对一个新场景，先列出条件和可能结果，再改变其中一个条件观察解释是否仍成立。", origin: "authored" },
      boundaries: "",
      analogy: "像先看地图上的目的地，再逐段核对实际路线。",
      mantra: "条件、因果、反例"
    },
    exercise: {
      type: "recall",
      question: "这个方向相比已有内容新增了什么？",
      answer: novelty,
      answerExplanation: "回答应说明新增机制、条件或边界，不能只复述关联卡片。",
      rubric: ["说出新增内容", "指出至少一个条件或边界"]
    },
    evidence: [ref("summary"), ref("exercise")]
  };
}

module.exports = { candidateOutlines, discoveryQualityOutput, exploration };
