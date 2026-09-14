import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const children = [];

try {
  children.push(spawn(process.execPath, [join(root, "extension", "e2e", "mock-provider.mjs")], {
    cwd: root,
    env: { ...process.env, KG_E2E_PROVIDER_PORT: "8790" },
    stdio: "inherit"
  }));
  children.push(spawn(process.execPath, [join(root, "extension", "tooling", "dev-server.js")], {
    cwd: root,
    env: { ...process.env, WEB_HOST: "127.0.0.1", PORT: "5173" },
    stdio: "inherit"
  }));
  await Promise.all([
    waitFor("http://127.0.0.1:8790/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    waitFor("http://127.0.0.1:5173/")
  ]);
  const code = await run(process.execPath, [
    join(root, "node_modules", "@playwright", "test", "cli.js"),
    "test", "--config", join(root, "extension", "playwright.config.ts"), ...process.argv.slice(2)
  ], false);
  if (code !== 0) process.exitCode = code;
} finally {
  for (const child of children.reverse()) child.kill();
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
}

function run(command, args, failOnError = true) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      const exitCode = code ?? 1;
      if (failOnError && exitCode !== 0) rejectRun(new Error(`命令退出码 ${exitCode}: ${command}`));
      else resolveRun(exitCode);
    });
  });
}

async function waitFor(url, init) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`本地服务未就绪：${url}`);
}
