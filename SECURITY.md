# 安全与隐私

请通过仓库的 **Security → Report a vulnerability** 提交安全问题，避免在公开 Issue 中附上有效凭据或可识别的私人资料。普通功能问题可使用 Issues。

描述受影响版本、复现步骤和可能影响即可；示例使用虚构数据。不要发送真实 API Key、Cookie 或完整浏览器数据库。

扩展的网络与本地存储边界见 [隐私说明](docs/public/privacy.md)。使用自行修改或第三方分发的扩展前，应自行核对来源。

开发依赖提示：1.0.0 的 npm 依赖检查仍会报告 `@huggingface/transformers → onnxruntime-node → adm-zip` 链路的 ZIP 解压符号链接问题（[上游公告](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)）。此链路用于 Node 开发环境；发布的浏览器扩展只包含 Web / WASM 推理运行时，不含 `onnxruntime-node`、`adm-zip` 或 `node_modules`。请勿使用受影响的 Node 解压工具处理不可信压缩包；跟进上游兼容版本后再更新锁文件。
