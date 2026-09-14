# 第三方组件与资料

Knowledge Gacha 自身代码使用 MIT 协议。以下组件和资料按各自许可证提供，版权仍属于原作者；项目 MIT 协议不替换这些授权。

| 组件 | 用途 | 许可证与随包文件 |
| --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js) | 本地 PDF 解析、字体及 WASM | Apache-2.0；`extension/vendor/pdfjs/LICENSE`，字体与映射目录内保留各自 LICENSE |
| [Mammoth](https://github.com/mwilliamson/mammoth.js) | 本地 DOCX 解析 | BSD-2-Clause；`extension/vendor/mammoth/LICENSE` |
| [Transformers.js](https://github.com/huggingface/transformers.js) | 浏览器端语义检索运行时 | Apache-2.0；`extension/vendor/embedding/LICENSE-transformers.txt` |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | 本地 WASM 推理 | MIT；`extension/vendor/embedding/LICENSE-onnxruntime.txt` |
| [BGE / FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding) | 中文向量模型 | MIT；`extension/vendor/embedding/LICENSE-bge.txt` |
| [Xenova/bge-small-zh-v1.5](https://huggingface.co/Xenova/bge-small-zh-v1.5) | BGE 的 Q8 ONNX 转换 | 固定版本、来源与散列见 `extension/vendor/embedding/versions.json` |

开发工具和间接依赖的版本固定于 `package-lock.json`，许可证随各 npm 包提供；`node_modules` 不进入扩展发行包。

## 测试资料

- 检索对照使用 FastAPI 官方中文文档的固定快照，MIT 许可和来源保留在 `extension/evals/rag/real-sources/`。
- 制卡评测素材在 `extension/evals/card-quality/cases.json` 中逐项记录公开来源、改写说明和预期行为。SQLite GIF 取自其公有领域文档；MDN 等资料的原始权利按来源页面的说明保留，项目测试摘要不冒充原文。
- README 中的界面截图来自隔离演示档案和固定模拟数据，不包含真实用户资料。Logo 与说明图沿用本项目的视觉设计。
