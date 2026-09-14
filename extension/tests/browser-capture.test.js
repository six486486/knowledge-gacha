const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_TEXT_LENGTH, createBrowserCapture } = require("../src/frontend/browser/browser-capture.js");

function fakeChrome(options = {}) {
  const calls = { query: [], executeScript: [], captureVisibleTab: [], permissionRequests: [], order: [] };
  const tab = options.tab || { id: 7, windowId: 3, title: "RAG 入门", url: "https://example.com/rag" };
  return {
    calls,
    api: {
      tabs: {
        async query(query) {
          calls.query.push(query);
          calls.order.push("query");
          const index = calls.query.length - 1;
          return [(options.queryTabs && options.queryTabs[index]) || tab];
        },
        async captureVisibleTab(windowId, captureOptions) {
          calls.captureVisibleTab.push([windowId, captureOptions]);
          if (options.captureError) throw options.captureError;
          return options.dataUrl || "data:image/png;base64,QUJD";
        }
      },
      scripting: {
        async executeScript(details) {
          calls.executeScript.push(details);
          if (options.scriptError) throw options.scriptError;
          return [{ result: options.snapshot || {
            selectedText: "  检索   增强\n\n\n生成  ",
            pageText: "页面正文",
            title: "RAG 入门",
            url: "https://example.com/rag"
          } }];
        }
      },
      permissions: {
        async request(request) {
          calls.permissionRequests.push(request);
          calls.order.push("permission");
          if (options.permissionError) throw options.permissionError;
          return options.permissionGranted !== false;
        }
      }
    }
  };
}

function fakeDisplay(options = {}) {
  const calls = { choices: [], stopped: 0, paused: 0, drawn: 0 };
  const stream = { getTracks: () => [{ stop() { calls.stopped += 1; } }] };
  const video = {
    videoWidth: 1280, videoHeight: 720, srcObject: null,
    async play() { if (options.frameError) throw options.frameError; },
    pause() { calls.paused += 1; }
  };
  return {
    calls, video,
    environment: {
      navigator: { mediaDevices: { async getDisplayMedia(choice) {
        calls.choices.push(choice);
        if (options.chooserError) throw options.chooserError;
        return stream;
      } } },
      document: { createElement(tag) {
        return tag === "video" ? video : {
          getContext: () => ({ drawImage() { calls.drawn += 1; } }),
          toDataURL: () => options.dataUrl || "data:image/png;base64,QUJD"
        };
      } }
    }
  };
}

test("预缓存当前标签页，并在用户点击后先申请精确 Origin 再读取选区", async () => {
  const fake = fakeChrome();
  const capture = createBrowserCapture(fake.api);
  assert.equal(fake.calls.query.length, 1);
  assert.equal(fake.calls.permissionRequests.length, 0);
  await capture.ready;

  const result = await capture.captureSelection();

  assert.equal(result.type, "selection");
  assert.equal(result.text, "检索 增强\n\n生成");
  assert.equal(result.title, "RAG 入门");
  assert.equal(result.url, "https://example.com/rag");
  assert.deepEqual(fake.calls.query[0], { active: true, lastFocusedWindow: true });
  assert.deepEqual(fake.calls.order.slice(0, 3), ["query", "permission", "query"]);
  assert.deepEqual(fake.calls.permissionRequests[0], { origins: ["https://example.com/*"] });
  assert.deepEqual(fake.calls.executeScript[0].target, { tabId: 7 });
});

test("没有选区时明确提示用户先框选，不偷偷回退为整页", async () => {
  const fake = fakeChrome({ snapshot: { selectedText: "", pageText: "整页正文", title: "标题", url: "https://example.com" } });
  await assert.rejects(createBrowserCapture(fake.api).captureSelection(), (error) => error.code === "no_selection");
});

test("当前页面正文保留统一材料接口的 256K 字符，超出范围明确截断", async () => {
  const fake = fakeChrome({ snapshot: { selectedText: "", pageText: "甲".repeat(MAX_TEXT_LENGTH + 50), title: "长文", url: "https://example.com/long" } });
  const result = await createBrowserCapture(fake.api).capturePage();
  assert.equal(result.text.length, MAX_TEXT_LENGTH);
  assert.equal(result.type, "page");
  assert.equal(result.truncated, true);
});

test("截图直接打开浏览器选择器，不依赖当前网页权限，并在得到 PNG 后停止共享", async () => {
  const fake = fakeChrome();
  const display = fakeDisplay();
  const resultPromise = createBrowserCapture(fake.api, display.environment).captureScreenshot();
  assert.equal(display.calls.choices.length, 1);
  const result = await resultPromise;
  assert.equal(result.type, "screenshot");
  assert.equal(result.image.mime, "image/png");
  assert.equal(result.url, "");
  assert.equal(result.title, "屏幕截图");
  assert.deepEqual(display.calls.choices[0], { video: { displaySurface: "browser" }, audio: false });
  assert.equal(fake.calls.permissionRequests.length, 0);
  assert.equal(fake.calls.captureVisibleTab.length, 0);
  assert.equal(display.calls.stopped, 1);
  assert.equal(display.calls.paused, 1);
  assert.equal(display.video.srcObject, null);
});

test("用户取消截图时给出可恢复提示，不尝试读取其他网页", async () => {
  const display = fakeDisplay({ chooserError: { name: "NotAllowedError" } });
  await assert.rejects(createBrowserCapture(undefined, display.environment).captureScreenshot(), (error) => error.code === "capture_cancelled");
  assert.equal(display.calls.drawn, 0);
});

test("读取画面失败时也停止所有共享轨道", async () => {
  const display = fakeDisplay({ frameError: new Error("frame failed") });
  await assert.rejects(createBrowserCapture(undefined, display.environment).captureScreenshot(), (error) => error.code === "capture_failed");
  assert.equal(display.calls.stopped, 1);
  assert.equal(display.video.srcObject, null);
});

test("无效或过大的截图均会停止共享并提示重试", async () => {
  for (const [dataUrl, code] of [["data:image/jpeg;base64,QUJD", "invalid_screenshot"], ["data:image/png;base64," + "A".repeat(11_500_000), "image_too_large"]]) {
    const display = fakeDisplay({ dataUrl });
    await assert.rejects(createBrowserCapture(undefined, display.environment).captureScreenshot(), (error) => error.code === code);
    assert.equal(display.calls.stopped, 1);
  }
});

test("普通 HTTP 网页只申请当前 Origin，授权后可以捕获", async () => {
  const fake = fakeChrome({
    tab: { id: 8, windowId: 4, title: "本地文章", url: "http://news.example.test:8080/post/1" },
    snapshot: { selectedText: "已选内容", pageText: "正文", title: "本地文章", url: "http://news.example.test:8080/post/1" }
  });
  const result = await createBrowserCapture(fake.api).captureSelection();
  assert.equal(result.text, "已选内容");
  assert.deepEqual(fake.calls.permissionRequests[0], { origins: ["http://news.example.test:8080/*"] });
});

test("用户拒绝当前网站权限时不注入脚本", async () => {
  const fake = fakeChrome({ permissionGranted: false });
  await assert.rejects(createBrowserCapture(fake.api).captureSelection(), (error) => error.code === "permission_denied");
  await assert.rejects(createBrowserCapture(fake.api).capturePage(), (error) => error.code === "permission_denied");
  assert.equal(fake.calls.executeScript.length, 0);
  assert.equal(fake.calls.captureVisibleTab.length, 0);
});

test("授权期间切换标签页时失败关闭，不把权限用于另一个页面", async () => {
  const first = { id: 7, windowId: 3, title: "第一页", url: "https://example.com/one" };
  const second = { id: 8, windowId: 3, title: "第二页", url: "https://example.com/two" };
  const fake = fakeChrome({ tab: first, queryTabs: [first, second] });
  const capture = createBrowserCapture(fake.api);
  await capture.ready;
  await assert.rejects(capture.captureSelection(), (error) => error.code === "tab_changed");
  assert.equal(fake.calls.executeScript.length, 0);
});

test("拒绝浏览器内部页且不会尝试注入脚本", async () => {
  const fake = fakeChrome({ tab: { id: 9, windowId: 3, title: "扩展", url: "chrome://extensions" } });
  await assert.rejects(createBrowserCapture(fake.api).capturePage(), (error) => error.code === "restricted_page");
  assert.equal(fake.calls.executeScript.length, 0);
  assert.equal(fake.calls.permissionRequests.length, 0);
});

test("普通网页预览环境明确报告浏览器能力不可用", async () => {
  await assert.rejects(createBrowserCapture(undefined).captureSelection(), (error) => error.code === "unavailable");
  await assert.rejects(createBrowserCapture(undefined, {}).captureScreenshot(), (error) => error.code === "unavailable");
});
