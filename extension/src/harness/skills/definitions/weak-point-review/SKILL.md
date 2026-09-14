---
name: weak-point-review
description: 在保留的助手原型中解释复习情况或请求调整已有卡片的到期时间。实际薄弱点排序和答题记录由复习页面处理。
compatibility: Requires the Knowledge Gacha MV3 host; task resources use JavaScript and the host provides storage and model transport.
metadata: {"version":"1.0.0","mode":"assistant-prototype","harness-tools":"get_learning_context search_knowledge schedule_review"}
---

# 复习辅助

可读取 get_learning_context 或 search_knowledge。上下文区分显式偏好、近期行为和实际复习证据；只能按返回的证据说明正确率、错误原因和掌握状态。旧卡历史分数以及用户自述不能替代答题记录。完整的复习计划和练习尝试由产品复习页面完成。

用户明确要调整已知卡片的到期时间时可以请求 schedule_review；宿主等待确认后才写入。当前每次运行只执行一个工具，后续必须完成回答，不能假装自动连续规划。

不要调用不存在的 plan_weak_point_review、list_due_reviews 或 record_review_result，也不把点击、收藏或自述当成客观掌握记录。
