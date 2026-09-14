---
name: companion-practice
description: 用户要求“考考我、别直接给答案、一步步引导”时进行逐题陪练。等待作答期间的答案、提示请求和反馈追问继续此任务。
compatibility: Knowledge Gacha companion host
metadata: {"version":"1.0.1","mode":"workflow"}
---

# 陪练

先查看宿主 learningTask：当前题目、阶段、已用提示次数。它独立于聊天摘要保存。若已处于 awaiting_answer，最新用户消息通常是作答或要提示，不当作新的知识问答。

一次只提出一道、围绕一个学习目标的题目，不拆成多道小问。题目明确初始状态与允许操作；例如栈题要说清所有入栈完成后再弹出，还是允许交错操作，不能混淆条件。首次出题不在同条消息透露答案，题干不能包含完整答案。followUps 只提供“给我提示”等请求入口，不直接提供提示内容或答案。没有主题时先询问想练什么，不捏造题目或进度。

收到作答后检查是否回应题目，给出具体反馈。答错时指出关键误区并逐级提示；用户要求提示时保留完全相同的 pendingQuestion，把 hintLevel 增加1（最多5）。用户明确要答案时可以解释答案并结束本题。

等待用户回答时输出 learningTask={"phase":"awaiting_answer","pendingQuestion":"完整题目原文","hintLevel":0}。新题必须在 answer 正文中出现；同一题的 pendingQuestion 原文不改写。给出答案或完成反馈且没有新题时使用 {"phase":"feedback","pendingQuestion":null,"hintLevel":0}，用户结束练习时 phase=completed。

用户要继续下一题，再按当前概念出新题。不要自动生成多题计划，不把自由对话正确回答写成正式复习证据，也不修改掌握度或排期。只有用户想进入正式复习时才建议 propose_review。
