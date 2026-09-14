# 产品能力自动测试

本目录用于开发测试，不在侧边栏展示评测入口。运行方式见 [开发与测试](../../docs/public/development.md)。测试报告保存在本机，不随公开源码分发。

工程总入口为 `npm run test:project -- --out <新目录>`，覆盖模块回归、隔离数据、时间推进、浏览器流程和本地检索。真实伴学脚本为 `node scripts/acceptance/companion-quality.mjs --config <本机JSON> --out <新目录>`。结果分别记录工程状态和模型内容质量，不把命令结束视为质量通过。

## 运行顺序

1. `npm run check`：文档、源码、发布脚本和扩展逻辑。
2. `npm run test:e2e`：测试Provider的浏览器流程及隔离Edge扩展捕获/解析。
3. `npm run release:browsers`：全新临时档案中的Edge扩展冒烟。
4. `node extension/evals/card-quality/run.mjs --config <本机JSON> --mode current --max-requests 72 --max-tokens 180000 --out <新目录>`：冻结24份素材，真实生产制卡服务。
5. `node scripts/acceptance/product-capabilities.mjs --config <本机JSON> --out <新目录>`：真实模型的拆分、多卡、发现、新情景题、OCR及不可信材料测试。
6. 按固定素材对照最终内容、答案和来源，单独保存AI评审；有具体运行语义争议时用手写对照代码核查。问题草稿和未完成场景保留。

配置为用户显式提供的本地 `baseUrl`、`apiKey`、`model`，不得提交仓库。脚本不从日常浏览器配置文件提取密钥；仅使用公开或手写测试材料与隔离学习档案。实际请求会消耗Provider用量，沿用项目关闭思考的统一规则。

## 能力脚本

默认预算110次请求、280,000 token；`--max-requests`、`--max-tokens` 可覆盖。最后一个响应可能越过累计token预算；缺失用量单独记录。输出目录中已有 `results.json` 时拒绝覆盖。

| 场景ID | 测试内容 |
| --- | --- |
| `plan-multi-01`至`plan-multi-06` | 分析3个目标、选择前2个、分两次生成、确认ready卡及重复确认 |
| `discovery-<profile>-1/2/3` | 6类档案的候选尝试，成功后才能检查打开、保存和后续批次 |
| `review-new-scenario` | 人工金标准卡与版本化依据下的新题生成 |
| `untrusted-material-instructions` | 正式规则与恶意留言分离、未确认不能保存 |
| `ocr-scanned.pdf`、`ocr-mixed.pdf` | 生产PDF解析与OCR、识别缓存、校对确认和范围选择 |
| `ocr-numeric-negation.pdf` | 自动创建纯图片PDF，识别中文、数字、负号、小数与否定条件 |

支持 `--only <场景ID正则>` 定向执行；需要诊断响应时加 `--capture-responses`。OCR使用本地静态预览端口5174及隔离Chrome页面，完成后关闭。所有业务模型请求仍使用生产模块，未使用用户日常浏览器档案。

脚本分别记录执行状态、业务结果和错误；`completed` 只表示场景执行完，不代表每张草稿或内容质量通过。发现上游失败时，后续候选质量与漏斗记为阻塞，不能用模拟数据补齐。

## 固定案例辅助工具

`python scripts/acceptance/content-oracles.py` 运行手写排序与默认参数对照，不执行模型生成的任意代码。

`node scripts/acceptance/summarize-results.mjs <记录目录>` 根据既有记录及 `ai-review.json` 重建 `metrics.json` 和逐样本 CSV，不联网、不重新评分。它依赖固定的历史记录结构；输入记录未随仓库分发，不属于通用工程验收入口。
