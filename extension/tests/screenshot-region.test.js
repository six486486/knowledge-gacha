const test = require("node:test");
const assert = require("node:assert/strict");
const { rectangle, moveRectangle, resizeRectangle, toPixels, selectScreenshotRegion, PORT_PREFIX } = require("../src/frontend/browser/screenshot-region.js");

test("正向和反向拖拽得到相同区域，越界拖拽限制在图片内", () => {
  assert.deepEqual(rectangle({ x: .1, y: .2 }, { x: .8, y: .9 }), rectangle({ x: .8, y: .9 }, { x: .1, y: .2 }));
  assert.deepEqual(rectangle({ x: -.5, y: .25 }, { x: 2, y: 2 }), { x: 0, y: .25, width: 1, height: .75 });
});

test("缩放显示的选区映射到原图像素，裁剪不受屏幕缩放影响", () => {
  const region = rectangle({ x: .25, y: .25 }, { x: .75, y: .75 });
  assert.deepEqual(toPixels(region, 3840, 2160), { x: 960, y: 540, width: 1920, height: 1080 });
  assert.deepEqual(toPixels(region, 640, 360), { x: 160, y: 90, width: 320, height: 180 });
  assert.deepEqual(toPixels({ x: .9, y: .9, width: .3, height: .3 }, 100, 100), { x: 90, y: 90, width: 10, height: 10 });
});

test("移动选框保持大小并停在画面边缘", () => {
  const region = { x: .25, y: .25, width: .5, height: .5 };
  assert.deepEqual(moveRectangle(region, 10, -10), { x: .5, y: 0, width: .5, height: .5 });
});

test("边角调整可越过对角，仍生成有效范围", () => {
  const region = { x: .25, y: .25, width: .5, height: .5 };
  assert.deepEqual(resizeRectangle(region, "se", -.75, -.75), { x: 0, y: 0, width: .25, height: .25 });
  assert.deepEqual(resizeRectangle(region, "nw", -1, -1), { x: 0, y: 0, width: .75, height: .75 });
  assert.deepEqual(resizeRectangle(region, "e", 1, 0), { x: .25, y: .25, width: .75, height: .5 });
});

test("空选区、非有限数值和图片边界外的选区不能生成截图", () => {
  for (const rect of [null, { x: 0, y: 0, width: 0, height: .5 }, { x: NaN, y: 0, width: .5, height: .5 }, { x: 2, y: 2, width: .2, height: .2 }]) {
    assert.equal(toPixels(rect, 100, 100), null);
  }
});

function event() {
  const listeners = new Set();
  return { listeners, addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => [...listeners].forEach((fn) => fn(...args)) };
}

function fakeEditor(failCreate = false) {
  const calls = { created: [], removed: [], sent: [] };
  const pagehide = new Set();
  const api = {
    runtime: { id: "test-extension", getURL: (path) => "chrome-extension://test-extension/" + path, onConnect: event() },
    windows: {
      onRemoved: event(),
      async create(options) { calls.created.push(options); if (failCreate) throw new Error("failed"); return { id: 44 }; },
      async remove(id) { calls.removed.push(id); }
    }
  };
  const port = {
    name: PORT_PREFIX + "test-session", sender: { id: api.runtime.id, url: api.runtime.getURL("screenshot.html") + "?session=test-session" },
    onMessage: event(), onDisconnect: event(), postMessage: (message) => calls.sent.push(message), disconnect() {}
  };
  return { calls, api, port, pagehide, environment: { crypto: { randomUUID: () => "test-session" }, addEventListener: (_name, fn) => pagehide.add(fn), removeEventListener: (_name, fn) => pagehide.delete(fn) } };
}

test("原始截图只交给匹配的扩展框选窗口，取消后清理会话", async () => {
  const fake = fakeEditor();
  const image = { mime: "image/png", dataUrl: "data:image/png;base64,QUJD" };
  const promise = selectScreenshotRegion(image, fake.api, fake.environment);
  await Promise.resolve();
  fake.api.runtime.onConnect.emit({ ...fake.port, sender: { id: "other", url: fake.port.sender.url } });
  fake.api.runtime.onConnect.emit({ ...fake.port, name: PORT_PREFIX + "another-session" });
  assert.equal(fake.calls.sent.length, 0);
  fake.api.runtime.onConnect.emit(fake.port);
  assert.deepEqual(fake.calls.sent, [{ type: "image", image }]);
  assert.equal(fake.calls.created[0].state, "maximized");
  fake.port.onMessage.emit({ type: "cancel" });
  await assert.rejects(promise, (error) => error.code === "capture_cancelled");
  assert.deepEqual(fake.calls.removed, [44]);
  assert.equal(fake.api.runtime.onConnect.listeners.size, 0);
  assert.equal(fake.api.windows.onRemoved.listeners.size, 0);
  assert.equal(fake.pagehide.size, 0);
});

test("关闭框选窗口等同取消，创建窗口失败也清理监听", async () => {
  const fake = fakeEditor();
  const promise = selectScreenshotRegion({}, fake.api, fake.environment);
  await Promise.resolve();
  fake.api.windows.onRemoved.emit(44);
  await assert.rejects(promise, (error) => error.code === "capture_cancelled");
  const failed = fakeEditor(true);
  await assert.rejects(selectScreenshotRegion({}, failed.api, failed.environment), (error) => error.code === "crop_window_failed");
  assert.equal(failed.api.runtime.onConnect.listeners.size, 0);
  assert.equal(failed.api.windows.onRemoved.listeners.size, 0);
});
