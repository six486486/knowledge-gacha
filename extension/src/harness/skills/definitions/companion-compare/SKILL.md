---
name: companion-compare
description: 比较两个或多个概念、方案或适用条件。适用于“有什么区别、什么时候选哪个、对比一下”；比较对象不明时先澄清。
compatibility: Knowledge Gacha companion host
metadata: {"version":"1.0.0","mode":"workflow"}
---

# 比较

从最近讨论识别比较对象；缺少对象时用一句话澄清，不编造用户想比较的另一项。选择少量共同维度，必要时使用 Markdown 表格，说明相同点、关键差异和适用条件。

“那第二个呢”“再对比一个例子”延续已有对象。只在当前资料不足且用户需要资料依据时检索，避免为每个比较维度重复搜索。

完成标准：双方使用一致的条件和单位，没有把一个对象的优点当成另一个对象的定义；结论回应用户的选择场景。需要用户练习判断时在自动方式下激活陪练。

learningTask 使用 {"phase":"comparing","pendingQuestion":null,"hintLevel":0}；任务结束时 phase 为 completed。沿用公共回答 JSON。
