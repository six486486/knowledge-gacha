---
name: knowledge-plan
description: 将长材料或多主题材料规划为带原文依据和覆盖关系的学习清单。用于批量制卡之前的目标拆分、合并与去重。
compatibility: Requires the Knowledge Gacha MV3 host; task resources use JavaScript and the host provides storage and model transport.
metadata: {"version":"1.0.0","mode":"task","asset-version":"knowledge-plan-v1.0.1"}
---

# 材料学习清单

按具体能力拆分目标，保留跨段的条件和例外。登记每个输入块的覆盖关系；不能制卡的块写明原因。旧卡仅用于比较目标，不作为事实依据。

只选择输入中已有的块和候选 ID，不生成位置。只有 allowSupplemental 为 true 时才能选择提供的保留原文补充候选。用户决定学习目标的选择和顺序，程序负责保存。

[task.js](task.js) 给出 KnowledgePlan JSON 契约、覆盖检查和一次格式修复的操作指令。输出只包含当前操作要求的 JSON，不请求工具。
