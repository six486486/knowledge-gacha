# 制卡质量评测

本目录提供固定公开素材与评测程序，检验材料充分性、解释、练习答案和引用。评测输入固定于 `cases.json`，公开来源和素材改写说明逐项保留；SQLite 图示位于 `materials/`。

## 使用

真实模型配置放在仓库外的 JSON 文件中，包含 `baseUrl`、`apiKey`、`model`。不要提交该文件或在 Issue 中粘贴密钥。

```bash
npm run eval:card-quality -- --prepare --case short-05 --out test-results/quality-prepare-NEW
npm run eval:card-quality -- --config /path/outside/repo/provider.local.json --case short-05 --out test-results/quality-NEW
```

`--prepare` 仅准备记录，不调用模型。输出目录必须不存在；恢复时明确指定 `--resume`，沿用原版本、模型、样本与累计预算。

`--case` 选择一个样本，默认 7 次请求和 18,000 Token 预算。`--mode` 支持 targeted、quick、current 和 paired；未指定样本或模式时默认为 quick。完整配对需要显式选择 paired，真实调用费用由所配置服务收取。

## 判定与记录

- 检查事实、解释、目标、练习、依据与必要条件；错误答案和严重事实错误单独记录。
- 待拆分、材料不足、拒绝和失败计入总样本，不仅统计成功生成的卡片。
- 保留原始输出、失败、修复次数和实际用量；缺失用量不伪造为零。
- 程序通过只证明所检查的契约，模型自评不能作为唯一正确性依据。
- 固定响应测试使用 `extension/tests/fixtures/regressions/` 中经过筛选的回归夹具，不依赖私人运行报告。

输出可能包含材料正文与模型回复，默认属于本地工作文件。公开分享前应检查并移除私人材料、配置、路径和身份信息。该评测不写入日常卡册，不能代替真人长期学习效果验证。
