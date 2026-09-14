---
name: gacha-discovery
description: 根据显式兴趣、已保存卡片和实际复习证据提出具体的新学习方向。用于发现页面生成候选，不用于自由对话内保存卡片。
compatibility: Requires the Knowledge Gacha MV3 host; task resources use JavaScript and the host provides storage and model transport.
metadata: {"version":"1.0.0","mode":"workflow","harness-tools":""}
---

# 发现新知识

宿主提供当前档案的有限 seeds 和 exclusions。返回 1–6 个候选，每个候选引用给定 seedId，说明具体目标、新增知识、成立条件和难度。不得编造兴趣、薄弱点或已保存来源，不用新标题重复旧卡。

候选没有已验证原文支持时保留 model_suggestion 身份。推荐理由解释为什么选择方向，不能代替卡片事实的证据。最终筛选、排序、去重、缓存、打开和保存由业务程序负责；打开不等于学会。

发现页面的宿主另行提供 JSON 契约并最多修复一次格式错误。自由对话入口不提供本 Skill 的工具；没有 seeds 时说明应从发现页面开始，不伪造个性化结果。
