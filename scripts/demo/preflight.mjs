import { statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const required = [
  "extension/manifest.json",
  "extension/src/frontend/app.js",
  "extension/src/backend/background.js",
  "extension/src/backend/application/extension-service.js",
  "extension/src/harness/core/agent-harness.js"
];
const failures = [];

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) failures.push(`Node.js ${process.versions.node} 低于 22.18`);

for (const path of required) {
  try {
    statSync(join(root, path));
  } catch {
    failures.push(`缺少演示依赖：${path}`);
  }
}

for (const port of [5173]) {
  if (!(await canListen(port))) failures.push(`端口 ${port} 已被占用`);
}

const result = {
  ok: failures.length === 0,
  node: process.versions.node,
  extensionPath: join(root, "extension"),
  previewPort: { port: 5173, available: failures.every((item) => !item.startsWith("端口")) },
  modelConfiguration: "由用户在扩展内提供，不读取进程环境变量",
  failures
};

console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;

function canListen(port) {
  return new Promise((resolveListen) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveListen(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolveListen(true)));
  });
}
