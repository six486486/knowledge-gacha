import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DEFAULT_EXTENSION = join(ROOT, "extension");

export function validateExtensionPackage(extensionPath = DEFAULT_EXTENSION) {
  const root = resolve(extensionPath);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`缺少扩展清单：${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const extensionId = extensionIdFromManifestKey(manifest.key);
  const requiredFiles = [
    "index.html", "screenshot.html", "src/frontend/browser/screenshot-region.js", "src/frontend/browser/screenshot-editor.js", "src/frontend/browser/screenshot-editor.css", "src/frontend/app.js", "src/frontend/styles.css", "src/backend/provider/provider-transport.js",
    "src/backend/application/extension-service.js", "src/harness/core/agent-harness.js", manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);
  const missingFiles = [...new Set(requiredFiles)].filter((file) => !existsSync(join(root, file)));
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  const optionalHosts = Array.isArray(manifest.optional_host_permissions) ? manifest.optional_host_permissions : [];
  const errors = [];
  if (manifest.manifest_version !== 3) errors.push("必须使用 Manifest V3");
  if (!extensionId) errors.push("缺少可计算固定扩展 ID 的 manifest key");
  if (!manifest.side_panel?.default_path) errors.push("缺少 side_panel.default_path");
  if (!permissions.includes("sidePanel") || !permissions.includes("activeTab") || !permissions.includes("scripting") || !permissions.includes("storage") || !permissions.includes("tabs")) errors.push("缺少侧边栏捕获所需最小权限");
  if (hosts.length) errors.push("纯扩展不得声明常驻 host_permissions");
  if (!optionalHosts.includes("https://*/*")) errors.push("缺少用户触发的 Provider HTTPS 可选权限");
  if (!optionalHosts.includes("http://*/*")) errors.push("缺少用户触发的普通 HTTP 网页可选权限");
  if (missingFiles.length) errors.push(`缺少资源：${missingFiles.join(", ")}`);
  return {
    extensionPath: root,
    name: String(manifest.name || ""),
    version: String(manifest.version || ""),
    minimumChromeVersion: String(manifest.minimum_chrome_version || ""),
    extensionId,
    permissions,
    hostPermissions: hosts,
    optionalHostPermissions: optionalHosts,
    requiredFileCount: new Set(requiredFiles).size,
    errors,
    passed: errors.length === 0
  };
}

export function findInstalledBrowsers(env = process.env) {
  const configured = [
    env.KG_RELEASE_CHROME_PATH ? { name: "Chrome", executablePath: env.KG_RELEASE_CHROME_PATH } : null,
    env.KG_RELEASE_EDGE_PATH ? { name: "Edge", executablePath: env.KG_RELEASE_EDGE_PATH } : null
  ].filter(Boolean);
  if (configured.length) return configured.filter((item) => existsSync(item.executablePath)).map(withVersion);
  const candidates = process.platform === "win32" ? [
    { name: "Chrome", executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
    { name: "Chrome", executablePath: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
    { name: "Edge", executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
    { name: "Edge", executablePath: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" }
  ] : process.platform === "darwin" ? [
    { name: "Chrome", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    { name: "Edge", executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }
  ] : [
    { name: "Chrome", executablePath: "/usr/bin/google-chrome" },
    { name: "Edge", executablePath: "/usr/bin/microsoft-edge" }
  ];
  const seen = new Set();
  return candidates.filter((item) => existsSync(item.executablePath) && !seen.has(item.name) && seen.add(item.name)).map(withVersion);
}

export async function runExtensionBrowserSmoke(options = {}) {
  const packageCheck = validateExtensionPackage(options.extensionPath || DEFAULT_EXTENSION);
  const requiredBrowsers = ["Edge"];
  const browsers = (options.browsers || findInstalledBrowsers()).filter((browser) => requiredBrowsers.includes(browser.name));
  const results = [];
  if (packageCheck.passed) {
    for (const browser of browsers) results.push(await smokeBrowser(browser, packageCheck.extensionPath, options));
  }
  return {
    executedAt: new Date().toISOString(),
    package: packageCheck,
    requiredBrowsers,
    browsers: results,
    passed: browserGatePassed(packageCheck.passed, requiredBrowsers, results)
  };
}

export function browserGatePassed(packagePassed, requiredBrowsers, results) {
  return packagePassed && requiredBrowsers.every((name) => results.some((item) => item.name === name && item.passed));
}

export function formatExtensionBrowserReport(result) {
  return [
    "# 解压扩展浏览器验收",
    "",
    `> 执行时间：${result.executedAt}  `,
    `> 结论：**${result.passed ? "通过" : "未通过"} Edge 自动化门槛**`,
    "",
    `- 扩展：${result.package.name} ${result.package.version}`,
    `- 清单与资源：${result.package.passed ? "通过" : `失败（${result.package.errors.join("；")}）`}`,
    "",
    "| 浏览器 | 版本 | 扩展页 | Provider 权限模型 | 控制台 | 结果 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.browsers.map((item) => `| ${item.name} | ${item.version} | ${item.manualRequired ? "需人工" : item.extensionPageReady ? "通过" : "失败"} | ${item.manualRequired ? "需人工" : item.exactCors ? "通过" : "失败"} | ${item.actionableConsoleErrors.length ? `${item.actionableConsoleErrors.length} 条错误` : item.optionalCapabilitySignals.length ? `${item.optionalCapabilitySignals.length} 条可选能力未配置` : "无错误"} | ${item.manualRequired ? "待人工验收" : item.passed ? "通过" : "失败"} |`),
    "",
    ...result.requiredBrowsers.filter((name) => !result.browsers.some((item) => item.name === name)).map((name) => `- 未找到目标浏览器 ${name}，发布门槛未满足。`),
    ...result.browsers.filter((item) => item.manualRequired).map((item) => `- ${item.name}: ${item.manualReason}`),
    ...result.browsers.flatMap((item) => item.errors.map((error) => `- ${item.name}: ${error}`)),
    "",
    "浏览器使用系统临时目录作为全新用户档案，验收结束后删除；不会安装到用户日常浏览器。本项证明解压扩展可启动、未声明常驻 host 权限、Provider 与当前网页 Origin 只在用户操作后按需申请，且页面无未处理错误；选区、整页、截图和失败关闭由捕获适配器与产品 E2E 固定回归。",
    ""
  ].join("\n");
}

async function smokeBrowser(browser, extensionPath, options) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), `knowledge-gacha-${browser.name.toLowerCase()}-`));
  const profileDirectory = join(temporaryDirectory, "profile");
  let context;
  const errors = [];
  const consoleErrors = [];
  const httpErrors = [];
  let actionableConsoleErrors = [];
  let optionalCapabilitySignals = [];
  let manualRequired = false;
  let manualReason = "";
  let extensionId = options.extensionId || validateExtensionPackage(extensionPath).extensionId;
  let extensionPageReady = false;
  let exactCors = false;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: browser.executablePath,
      headless: options.headless ?? true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const origin = `chrome-extension://${extensionId}`;
    const page = await context.newPage();
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", (response) => {
      if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() });
    });
    await page.goto(`${origin}/index.html`);
    await page.getByRole("heading", { name: "知识扭蛋机" }).waitFor({ timeout: 10_000 });
    const capabilities = await page.evaluate(async () => ({
      runtimeId: chrome.runtime.id,
      hasSidePanel: Boolean(chrome.sidePanel),
      hasStorage: Boolean(chrome.storage?.local),
      hasTabs: Boolean(chrome.tabs?.query),
      hasScripting: Boolean(chrome.scripting),
      hasPermissions: Boolean(chrome.permissions?.request)
    }));
    extensionPageReady = capabilities.runtimeId === extensionId
      && capabilities.hasSidePanel && capabilities.hasStorage && capabilities.hasTabs && capabilities.hasScripting && capabilities.hasPermissions;
    exactCors = validateExtensionPackage(extensionPath).hostPermissions.length === 0
      && validateExtensionPackage(extensionPath).optionalHostPermissions.includes("https://*/*")
      && validateExtensionPackage(extensionPath).optionalHostPermissions.includes("http://*/*");
    actionableConsoleErrors = consoleErrors;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
  } finally {
    if (context) await context.close().catch(() => {});
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
  return {
    name: browser.name,
    version: browser.version,
    executablePath: browser.executablePath,
    extensionId,
    extensionPageReady,
    exactCors,
    consoleErrors,
    actionableConsoleErrors,
    httpErrors,
    optionalCapabilitySignals,
    manualRequired,
    manualReason,
    errors,
    passed: extensionPageReady && exactCors && actionableConsoleErrors.length === 0 && errors.length === 0
  };
}

function extensionIdFromManifestKey(key) {
  if (typeof key !== "string" || !key.trim()) return "";
  try {
    const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
    return digest.replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
  } catch {
    return "";
  }
}

function withVersion(browser) {
  const fileVersion = process.platform === "win32" ? readWindowsFileVersion(browser.executablePath) : "";
  const result = fileVersion ? null : spawnSync(browser.executablePath, ["--version"], { encoding: "utf8", windowsHide: true });
  const version = extractVersion(fileVersion || result?.stdout || result?.stderr || "");
  return { ...browser, version: version || "unknown" };
}

function readWindowsFileVersion(executablePath) {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const escapedPath = executablePath.replaceAll("'", "''");
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Item -LiteralPath '${escapedPath}').VersionInfo.ProductVersion`
  ], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function extractVersion(value) {
  return String(value).match(/\d+(?:\.\d+){1,3}/)?.[0] || "";
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`本地运行时未就绪：${url}`);
}

async function main() {
  const result = await runExtensionBrowserSmoke({ headless: !process.argv.includes("--headed") });
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : formatExtensionBrowserReport(result));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
