import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";

import {
  browserGatePassed,
  findInstalledBrowsers,
  formatExtensionBrowserReport,
  validateExtensionPackage
} from "../extension-browser-smoke.mjs";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("发布扩展只用 tabs 读取当前页元数据，网页与 Provider 均按需授权", () => {
  const result = validateExtensionPackage(join(root, "extension"));
  assert.equal(result.passed, true);
  assert.equal(result.permissions.includes("tabs"), true);
  assert.equal(result.hostPermissions.some((host) => host.includes("*://") || host.includes("<all_urls>")), false);
  assert.equal(result.hostPermissions.length, 0);
  assert.equal(result.optionalHostPermissions.includes("https://*/*"), true);
  assert.equal(result.optionalHostPermissions.includes("http://*/*"), true);
  assert.equal(result.requiredFileCount >= 8, true);
  assert.match(result.extensionId, /^[a-p]{32}$/);
});

test("浏览器发现结果去重并记录版本", () => {
  const browsers = findInstalledBrowsers();
  assert.equal(new Set(browsers.map((item) => item.name)).size, browsers.length);
  for (const browser of browsers) {
    assert.match(browser.name, /^(Chrome|Edge)$/);
    assert.match(browser.version, /^\d/);
  }
});

test("Edge 是唯一发布浏览器且 Chrome 结果不再影响门槛", () => {
  assert.equal(browserGatePassed(true, ["Edge"], [{ name: "Edge", passed: true }, { name: "Chrome", passed: false }]), true);
  assert.equal(browserGatePassed(true, ["Edge"], [{ name: "Chrome", passed: true }]), false);
  assert.equal(browserGatePassed(false, ["Edge"], [{ name: "Edge", passed: true }]), false);
});

test("Edge 浏览器报告明确区分启动冒烟与网页捕获产品回归", () => {
  const report = formatExtensionBrowserReport({
    executedAt: "2026-08-27T00:00:00.000Z",
    package: { name: "知识扭蛋机", version: "1.0.0", passed: true, errors: [] },
    requiredBrowsers: ["Edge"],
    browsers: [{ name: "Chrome", version: "151", extensionPageReady: true, exactCors: true, consoleErrors: [], actionableConsoleErrors: [], optionalCapabilitySignals: [], manualRequired: false, errors: [], passed: true }],
    passed: false
  });
  assert.match(report, /未找到目标浏览器 Edge/);
  assert.match(report, /选区、整页、截图和失败关闭由捕获适配器与产品 E2E 固定回归/);
});
