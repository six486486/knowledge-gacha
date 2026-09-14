# 开发、测试与打包

需要 Node.js 22.18 或更新版本、npm，以及用于浏览器验收的 Chrome / Edge。生产扩展本身不需要 Node.js。

```bash
git clone https://github.com/six486486/knowledge-gacha.git
cd knowledge-gacha
npm ci
npm start
```

本地预览地址是 `http://127.0.0.1:5173`。捕获网页、侧边栏及站点授权应在加载解压扩展后验证。仓库包含固定版本的本地检索模型与许可证，安装脚本从锁定依赖重新准备解析和推理运行时。

## 验证

```bash
npm run check
npm run test:e2e
npm run release:browsers
```

`check` 执行文档、Skill、源码、单元与发布契约检查。E2E 使用隔离浏览器档案和 Mock Provider，无需真实 API Key；默认使用系统 Chrome。`release:browsers` 使用隔离 Edge 验证真实 MV3 扩展。

完整工程回归与本地检索评测：

```bash
npm run test:project -- --out test-results/project-NEW
```

输出目录必须不存在。测试可创建卡片和修改到期时间作为前置，但作答、保存、更新和恢复必须通过生产 API / UI 验证。真实模型评测需要仓库外配置，与工程测试分别记录；见 [制卡评测](../../extension/evals/card-quality/README.md)。

## 可复现发布

```bash
npm run package:release -- --out dist/release-NEW
```

命令创建经过白名单筛选的 `source/`、可加载的 `extension/`、扩展 ZIP 和文件清单。只收录版本化代码、公开文档、测试夹具和固定运行资产；不复制 Git 历史、node_modules、临时配置或测试报告。源码归档可在公开源码目录提交后使用 `git archive` 生成。

真实模型配置必须放在仓库外，`*.local.json`、`.env`、私钥和私人报告属于忽略项。发布前可运行 `node scripts/release/audit-public.mjs <目录或 ZIP>` 检查已准备的实际产物。

## 模型资产

版本见 `extension/vendor/embedding/versions.json`。重新下载固定模型时使用 `npm run package:embedding -- --download`；构建会验证预定 SHA-256。更换模型、解析器或任务定义后应重新运行相应测试并更新第三方说明。
