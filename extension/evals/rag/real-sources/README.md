# 官方文档检索对照实验 v1

本目录保存评测输入，不会向用户知识库导入测试内容。

## 来源与标注

- 来源：[FastAPI 官方仓库](https://github.com/fastapi/fastapi)，0.115.0 提交 `40e33e492dbf4af6172997f4e3238a32e56cbe26` 的 20 篇中文文档。版权属于 Sebastián Ramírez 及贡献者，原 [MIT 许可](LICENSE.fastapi.txt) 随快照保存。
- [manifest.json](manifest.json) 保存每个原始 Markdown 文件的固定 URL、字节数和校验值；[queries.json](queries.json) 保存问题、答案所在文档和逐字片段。
- 直接使用原始 Markdown 快照及产品的结构分块/360 字符窗口规则。文档中的外部代码包含指令未展开；没有运行外链脚本，也没有人工摘去难检索的部分。语料仅用作固定检索数据，不代表 FastAPI 当前行为。
- 48 道中文问题及标注由本项目编写，在首次有效排序运行前固定；不是用户日志或公开排行榜测试集。开发集 12 正例 + 4 负例，测试集 24 正例 + 8 负例。两组答案所在文档不交叉，检索候选均为全部 20 篇文档。
- 每题标注一个关键证据片段；按指定原文位置计分，不穷尽其它等价回答。近领域无答案项要求源文档没有问题所需的具体参数、性能数字或浏览器差异，不能因主题相似就计为正确。
- 另保留旧 10 文档的小型回归集，不能把新旧语料的百分比直接相减当作提升。

## 策略与约束

所有策略共用候选窗口、BGE Q8 模型、中文 query 前缀、dense 0.44 阈值、RRF k=60 与 1.25:1 权重。比较原词项重合、BM25、仅向量、两种混合检索、保留旧词法准入门槛的 BM25 混合，以及两种混合各自加交叉编码器，共 8 组。

BM25 用保留频率的中文词/二元组与英文标识符分析器，k1=1.2、b=0.75，IDF 为 `log(1 + (N-df+0.5)/(df+0.5))`。词频和长度先索引，查询阶段扫描统计表。没有倒排索引或 ANN；BM25 的未归一化分数不当作概率。默认 BM25 对照接纳分数大于 0 的候选；gated 对照仍要求旧重合分数至少 0.18。

重排器为 [cross-encoder/mmarco-mMiniLMv2-L12-H384-v1](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)，Apache-2.0，固定提交和模型散列见 [reranker-model.json](../reranker-model.json)。官方 int8 ONNX 在隔离 MV3 扩展的本地 WASM Worker 执行。query/候选成对分词，最多 512 tokens；对融合前 10 名逐对打原始 logit 分数，然后排序、每份文档最多取两段、最终取三段。没有拿 logit 当答案置信度，没有阈值调优。Reranker 模型仅缓存于 Git 忽略的 `.tmp-browser-qa/`，不改变产品发行包。

在开发集运行前确定的默认采用条件：Hit@1、Recall@3、MRR@3、负例返回空比例均不能退步，Hit@1 或 MRR 必须提高；预索引核心检索 P95 不超过 200 ms，额外模型资产不超过 50 MB。开发集与测试集都要通过，不能仅挑测试集结果。`--require-candidate` 可让未达标候选以非零退出码阻止采用；实验本身允许得出“拒绝替换”的有效结果。

## 复现

在仓库根目录运行，需要已安装 Edge、Node 22.18+（下载命令的 `--use-env-proxy` 需支持该参数的 Node，如本轮的 Node 24.15）：

```powershell
# 首次显式下载实验权重；不使用任何用户 API Key
npm run eval:rag:prepare-reranker
npm run eval:rag:ablation -- --split dev --out test-results/rag-ablation/dev.json
npm run eval:rag:ablation -- --split test --out test-results/rag-ablation/test.json
# 可选：候选没有通过门槛则失败退出
npm run eval:rag:ablation -- --split test --require-candidate bm25-rrf --out test-results/rag-ablation/candidate.json
```

模型下载需要网络；推理阶段只读包内文件，会记录外网请求并在发现请求时判失败。开发/测试均用临时浏览器档案。语料已随仓库保存；重建来源快照可运行 `node --use-env-proxy extension/evals/rag/prepare-real-corpus.mjs`，提交版本固定，不自动更新到最新文档。

指标包括 Hit@1、答案片段 Recall@3、MRR@3、二元 nDCG@3、重排候选 Recall@10、两类无答案查询的空结果比例，以及本地模型冷启动/首次索引、核心检索 warm P50/P95。重叠窗口对同一个答案只计一次。计时是单台机器每题一次，不包含产品的 IndexedDB 提交、整库重建及 UI 渲染；BM25 索引耗时单列。需要分别看开发集和测试集，不能只报告更高的一组。

本实验未评生成正确率、最终拒答率、多领域用户知识库、千文档吞吐或跨设备内存峰值。初次索引不是免费操作；召回到了相似文段，也不能证明文段足够回答问题。
