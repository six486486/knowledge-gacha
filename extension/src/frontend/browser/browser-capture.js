(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.KnowledgeGachaBrowserCapture = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_TEXT_LENGTH = 262_144;
  const MAX_IMAGE_DATA_URL_LENGTH = 11_500_000;

  function createBrowserCapture(chromeApi, environment = globalThis) {
    const api = chromeApi;
    let cachedActiveTab = null;
    const ready = refreshActiveTabCache();
    bindActiveTabCache();

    async function captureSelection() {
      const snapshot = await captureDocumentSnapshot(api, prepareCaptureTab, "selection");
      if (!snapshot.selectedText) {
        throw captureError("no_selection", "当前网页没有选中文字，请先在网页中框选一段内容");
      }
      return toCaptureResult("selection", snapshot.selectedText, snapshot);
    }

    async function capturePage() {
      const snapshot = await captureDocumentSnapshot(api, prepareCaptureTab, "page");
      if (!snapshot.pageText) {
        throw captureError("empty_page", "当前网页没有可读取的正文，请选中文字或手动粘贴");
      }
      return toCaptureResult("page", snapshot.pageText, snapshot);
    }

    async function captureScreenshot() {
      const mediaDevices = environment.navigator && environment.navigator.mediaDevices;
      if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== "function") {
        throw captureError("unavailable", "当前环境不支持选择屏幕截图，请上传本地图片");
      }
      let stream;
      let dataUrl;
      try {
        // Invoke the chooser before any await to retain the button's user activation.
        // Site access alone does not grant captureVisibleTab's activeTab permission.
        stream = await mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false });
        dataUrl = await captureDisplayFrame(stream, environment.document);
      } catch (error) {
        if (error && error.code && typeof error.code === "string") throw error;
        if (error && error.name === "NotAllowedError") {
          throw captureError("capture_cancelled", "未获得截图授权，原素材已保留；可重新选择并允许共享，或上传本地图片");
        }
        if (error && error.name === "InvalidStateError") {
          throw captureError("capture_focus_required", "请回到侧边栏，再次点击截取屏幕");
        }
        throw captureError("capture_failed", "无法读取所选画面，请重新选择标签页或窗口，也可以上传本地图片");
      } finally {
        if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      }
      if (typeof dataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl)) {
        throw captureError("invalid_screenshot", "浏览器返回了无效截图");
      }
      if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
        throw captureError("image_too_large", "截图超过 8MB，请选择较小的窗口后重试");
      }
      return {
        type: "screenshot",
        text: "",
        title: "屏幕截图",
        // The chosen surface may be a different tab or app; never attribute it to the active tab.
        url: "",
        image: { name: "page-screenshot-" + Date.now() + ".png", mime: "image/png", dataUrl: dataUrl },
        capturedAt: Date.now()
      };
    }

    return {
      ready: ready,
      captureSelection: captureSelection,
      capturePage: capturePage,
      captureScreenshot: captureScreenshot
    };

    async function prepareCaptureTab() {
      const preparedTab = validCachedTab(cachedActiveTab) ? cachedActiveTab : null;
      if (preparedTab) {
        rejectRestrictedPage(preparedTab.url);
        const accessRequest = ensurePageAccess(api, preparedTab.url);
        await accessRequest;
        const currentTab = await getActiveTab(api);
        cachedActiveTab = currentTab;
        assertSameCaptureTarget(preparedTab, currentTab);
        return currentTab;
      }
      const currentTab = await getActiveTab(api);
      rejectRestrictedPage(currentTab.url);
      await ensurePageAccess(api, currentTab.url);
      cachedActiveTab = currentTab;
      return currentTab;
    }

    async function refreshActiveTabCache() {
      if (!api || !api.tabs || typeof api.tabs.query !== "function") return null;
      try {
        const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
        cachedActiveTab = validCachedTab(tabs && tabs[0]) ? tabs[0] : null;
      } catch {
        cachedActiveTab = null;
      }
      return cachedActiveTab;
    }

    function bindActiveTabCache() {
      if (!api || !api.tabs) return;
      if (api.tabs.onActivated && typeof api.tabs.onActivated.addListener === "function") {
        api.tabs.onActivated.addListener(function () { void refreshActiveTabCache(); });
      }
      if (api.tabs.onUpdated && typeof api.tabs.onUpdated.addListener === "function") {
        api.tabs.onUpdated.addListener(function (_tabId, _changeInfo, tab) {
          if (tab && tab.active && validCachedTab(tab)) cachedActiveTab = tab;
        });
      }
      if (api.windows && api.windows.onFocusChanged && typeof api.windows.onFocusChanged.addListener === "function") {
        api.windows.onFocusChanged.addListener(function () { void refreshActiveTabCache(); });
      }
    }

    function assertSameCaptureTarget(preparedTab, currentTab) {
      if (preparedTab.id !== currentTab.id || pagePermissionPattern(preparedTab.url) !== pagePermissionPattern(currentTab.url)) {
        throw captureError("tab_changed", "当前网页已切换，请再次点击捕获");
      }
    }
  }

  async function captureDisplayFrame(stream, documentApi) {
    const video = documentApi.createElement("video");
    video.muted = true;
    video.playsInline = true;
    let timeout;
    try {
      video.srcObject = stream;
      await Promise.race([
        video.play(),
        new Promise(function (_resolve, reject) {
          timeout = setTimeout(function () { reject(captureError("capture_timeout", "截图等待超时，请重新选择画面")); }, 10_000);
        })
      ]);
      if (!video.videoWidth || !video.videoHeight) throw captureError("empty_screenshot", "没有读取到画面，请重新选择标签页或窗口");
      const canvas = documentApi.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw captureError("unavailable", "无法生成截图，请上传本地图片");
      context.drawImage(video, 0, 0);
      return canvas.toDataURL("image/png");
    } finally {
      clearTimeout(timeout);
      video.pause();
      video.srcObject = null;
    }
  }

  async function captureDocumentSnapshot(api, prepareCaptureTab, type) {
    ensureApi(api, ["tabs", "scripting"]);
    const tab = await prepareCaptureTab();
    if (typeof api.scripting.executeScript !== "function") {
      throw captureError("unavailable", "当前环境不支持读取网页内容");
    }
    let injections;
    try {
      injections = await api.scripting.executeScript({
        target: { tabId: tab.id },
        func: readVisibleDocument,
        args: [MAX_TEXT_LENGTH, type]
      });
    } catch (error) {
      throw mapChromeError(error, "无法读取当前网页，请重新打开扩展后再试");
    }
    const snapshot = injections && injections[0] && injections[0].result;
    if (!snapshot || typeof snapshot !== "object") {
      throw captureError("empty_result", "没有从当前网页读取到内容");
    }
    rejectRestrictedPage(snapshot.url || tab.url);
    return {
      selectedText: normalizeText(snapshot.selectedText, MAX_TEXT_LENGTH),
      pageText: normalizeText(snapshot.pageText, MAX_TEXT_LENGTH),
      pageTruncated: Boolean(snapshot.pageTruncated || String(snapshot.pageText || "").length > MAX_TEXT_LENGTH),
      extractionMethod: snapshot.extractionMethod === "article" ? "article" : "page",
      title: normalizeLine(snapshot.title || tab.title) || "当前网页",
      url: normalizeUrl(snapshot.url || tab.url)
    };
  }

  function validCachedTab(tab) {
    return Boolean(tab && Number.isInteger(tab.id) && typeof tab.url === "string" && tab.url);
  }

  async function getActiveTab(api) {
    if (typeof api.tabs.query !== "function") throw captureError("unavailable", "当前环境不支持读取浏览器标签页");
    let tabs;
    try {
      tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
    } catch (error) {
      throw mapChromeError(error, "无法获取当前网页");
    }
    const tab = tabs && tabs[0];
    if (!tab || !Number.isInteger(tab.id)) throw captureError("no_active_tab", "没有找到可捕获的当前网页");
    return tab;
  }

  async function ensurePageAccess(api, url) {
    const pattern = pagePermissionPattern(url);
    if (!api.permissions || typeof api.permissions.request !== "function") return pattern;
    let granted;
    try {
      granted = await api.permissions.request({ origins: [pattern] });
    } catch (error) {
      const detail = error && error.message ? String(error.message) : "";
      if (/user gesture/i.test(detail)) {
        throw captureError("permission_gesture_required", "请再次点击捕获按钮，并允许访问当前网站");
      }
      throw captureError("permission_request_failed", detail || "无法申请当前网站访问权限");
    }
    if (!granted) {
      throw captureError("permission_denied", "需要允许访问当前网站，才能读取选中文字或正文");
    }
    return pattern;
  }

  function pagePermissionPattern(url) {
    let parsed;
    try { parsed = new URL(String(url || "")); } catch { throw captureError("restricted_page", "当前页面不支持捕获"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw captureError("restricted_page", "浏览器内部页和扩展页不支持捕获，请切换到普通网页");
    }
    return parsed.protocol + "//" + parsed.host + "/*";
  }

  function readVisibleDocument(maxLength, type) {
    function compact(value) {
      return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    const ignored = "script, style, noscript, template, nav, aside, body > header, footer, form, button, input, select, textarea, [role=navigation], [role=complementary], [role=banner], [role=contentinfo], [role=dialog], [aria-modal=true], [hidden], [aria-hidden=true]";
    function visible(element) {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
    }
    function readText(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 || node.matches(ignored) || !visible(node)) return "";
      if (node.tagName === "BR") return "\n";
      const text = Array.from(node.childNodes).map(readText).join("");
      return /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|TR)$/.test(node.tagName) ? "\n" + text + "\n" : text;
    }
    let pageText = "";
    let extractionMethod = "page";
    if (type === "page") {
      // Prefer the largest article, then the main region; remove page chrome in either case.
      for (const selector of ["article, [role=article], [itemprop=articleBody]", "main, [role=main]"]) {
        const candidates = Array.from(document.querySelectorAll(selector))
          .filter(function (element) { return element.getClientRects().length && !element.closest(ignored); })
          .map(function (element) { return compact(readText(element)); })
          .sort(function (a, b) { return b.length - a.length; });
        if (candidates[0]) {
          pageText = candidates[0];
          extractionMethod = "article";
          break;
        }
      }
      if (!pageText && document.body) pageText = compact(readText(document.body));
    }
    return {
      selectedText: compact(window.getSelection ? window.getSelection().toString() : "").slice(0, maxLength),
      pageText: pageText.slice(0, maxLength),
      pageTruncated: pageText.length > maxLength,
      extractionMethod: extractionMethod,
      title: document.title || "",
      url: location.href
    };
  }

  function toCaptureResult(type, text, snapshot) {
    return {
      type: type,
      text: normalizeText(text, MAX_TEXT_LENGTH),
      title: snapshot.title,
      url: snapshot.url,
      image: null,
      truncated: type === "page" && snapshot.pageTruncated,
      extractionMethod: type === "page" ? snapshot.extractionMethod : null,
      capturedAt: Date.now()
    };
  }

  function ensureApi(api, parts) {
    if (!api || parts.some(function (part) { return !api[part]; })) {
      throw captureError("unavailable", "请在浏览器扩展侧边栏中使用此功能");
    }
  }

  function rejectRestrictedPage(url) {
    if (!url) return;
    let parsed;
    try { parsed = new URL(url); } catch { throw captureError("restricted_page", "当前页面不支持捕获"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw captureError("restricted_page", "浏览器内部页和扩展页不支持捕获，请切换到普通网页");
    }
  }

  function normalizeText(value, maxLength) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxLength);
  }

  function normalizeLine(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 256);
  }

  function normalizeUrl(value) {
    const url = String(value || "").trim();
    return url.length <= 2048 ? url : url.slice(0, 2048);
  }

  function captureError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function mapChromeError(error, fallbackMessage) {
    const detail = error && error.message ? String(error.message) : "";
    if (/cannot access|permission|not allowed/i.test(detail)) {
      return captureError("permission_denied", "当前网站访问权限未生效，请允许扩展访问此网站后重试");
    }
    if (/chrome:\/\/|edge:\/\//i.test(detail)) {
      return captureError("restricted_page", "浏览器内部页和扩展页不支持捕获，请切换到普通网页");
    }
    return captureError("capture_failed", detail || fallbackMessage);
  }

  return {
    MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
    createBrowserCapture: createBrowserCapture
  };
});
