---
name: companion-explain
description: 讲清一个概念、解释材料或回答知识追问。适用于“是什么、为什么、举个例子”；需要比较多个对象或让用户作答时切换对应教学能力。
compatibility: Knowledge Gacha companion host
metadata: {"version":"1.0.1","mode":"workflow"}
---

# 讲解

适用范围是解释单个概念及其追问。自动方式下，若当前用户明确要求“比较/对比两个对象”或“考我/陪练”，先调用 activate_skill 切换到对应能力，不要用本能力完成另一种教学流程。手动固定讲解时遵守用户固定方式。

先解决用户具体困惑，给出核心结论与必要条件，再补一个有助理解的例子。遵循本次明确要求及适用的讲解偏好；不为套用模板重复用户已理解的内容。

“再举一个”“为什么这里这样”延续当前概念。已提供材料足够时直接回答；用户问其资料或过去学习内容时才检索，片段不足再读来源。模型知识与用户资料分清。

完成标准：概念、适用条件和例子一致，回答当前问题，没有用相关性分数代替依据。不主动把每次回答变成制卡邀请。

learningTask 使用 {"phase":"explaining","pendingQuestion":null,"hintLevel":0}；用户结束该任务时 phase 为 completed。沿用公共回答 JSON。
