(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.KnowledgeGachaScreenshotRegion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PORT_PREFIX = "knowledge-gacha-screenshot:";

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function rectangle(start, end) {
    const left = clamp(Math.min(start.x, end.x), 0, 1);
    const top = clamp(Math.min(start.y, end.y), 0, 1);
    return { x: left, y: top, width: clamp(Math.max(start.x, end.x), 0, 1) - left, height: clamp(Math.max(start.y, end.y), 0, 1) - top };
  }

  function moveRectangle(rect, dx, dy) {
    return { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.width), y: clamp(rect.y + dy, 0, 1 - rect.height) };
  }

  function resizeRectangle(rect, handle, dx, dy) {
    const start = { x: rect.x, y: rect.y };
    const end = { x: rect.x + rect.width, y: rect.y + rect.height };
    if (handle.includes("w")) start.x += dx;
    if (handle.includes("e")) end.x += dx;
    if (handle.includes("n")) start.y += dy;
    if (handle.includes("s")) end.y += dy;
    return rectangle(start, end);
  }

  function toPixels(rect, width, height) {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height, width, height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return null;
    const left = clamp(Math.round(rect.x * width), 0, width);
    const top = clamp(Math.round(rect.y * height), 0, height);
    const right = clamp(Math.round((rect.x + rect.width) * width), 0, width);
    const bottom = clamp(Math.round((rect.y + rect.height) * height), 0, height);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function regionError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async function cropImage(image, rect, documentApi) {
    const source = documentApi.createElement("img");
    await new Promise(function (resolve, reject) {
      source.onload = resolve;
      source.onerror = function () { reject(regionError("invalid_screenshot", "截图无法加载，请重新截取")); };
      source.src = image.dataUrl;
    });
    const pixels = toPixels(rect, source.naturalWidth, source.naturalHeight);
    if (!pixels) throw regionError("empty_region", "请先框选一个有效区域");
    const canvas = documentApi.createElement("canvas");
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const context = canvas.getContext("2d");
    if (!context) throw regionError("crop_failed", "无法生成区域截图，请重试");
    context.drawImage(source, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height);
    return { name: "region-screenshot-" + Date.now() + ".png", mime: "image/png", dataUrl: canvas.toDataURL("image/png") };
  }

  function selectScreenshotRegion(image, chromeApi, environment = globalThis) {
    const api = chromeApi;
    if (!api || !api.windows || !api.runtime || !api.runtime.onConnect) {
      return Promise.reject(regionError("unavailable", "请在扩展侧边栏中使用区域截图"));
    }
    const session = environment.crypto.randomUUID();
    const url = api.runtime.getURL("screenshot.html") + "?session=" + session;
    return new Promise(function (resolve, reject) {
      let popupId = null;
      let port = null;
      let settled = false;
      let cropping = false;

      function finish(error, result) {
        if (settled) return;
        settled = true;
        api.runtime.onConnect.removeListener(onConnect);
        api.windows.onRemoved.removeListener(onRemoved);
        environment.removeEventListener("pagehide", cancel);
        if (port) {
          port.onDisconnect.removeListener(cancel);
          port.onMessage.removeListener(onMessage);
          port.disconnect();
        }
        if (popupId !== null) void api.windows.remove(popupId).catch(function () {});
        if (error) reject(error); else resolve(result);
      }

      function cancel() {
        if (!cropping) finish(regionError("capture_cancelled", "已取消区域截图，原素材已保留"));
      }

      function onRemoved(windowId) {
        if (windowId === popupId) cancel();
      }

      function onMessage(message) {
        if (!message || cropping || settled) return;
        if (message.type === "cancel") return cancel();
        if (message.type !== "confirm") return;
        cropping = true;
        cropImage(image, message.rect, environment.document).then(function (result) {
          finish(null, result);
        }, function (error) { finish(error); });
      }

      function onConnect(candidate) {
        if (port || candidate.name !== PORT_PREFIX + session || !candidate.sender
          || candidate.sender.id !== api.runtime.id || candidate.sender.url !== url) return;
        port = candidate;
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(cancel);
        port.postMessage({ type: "image", image: image });
      }

      api.runtime.onConnect.addListener(onConnect);
      api.windows.onRemoved.addListener(onRemoved);
      environment.addEventListener("pagehide", cancel);
      api.windows.create({ url: url, type: "popup", state: "maximized", focused: true }).then(function (popup) {
        if (!popup || !Number.isInteger(popup.id)) {
          finish(regionError("crop_window_failed", "无法打开截图框选窗口，请重试"));
          return;
        }
        popupId = popup.id;
        if (settled) void api.windows.remove(popupId).catch(function () {});
      }, function () { finish(regionError("crop_window_failed", "无法打开截图框选窗口，请重试")); });
    });
  }

  return { PORT_PREFIX: PORT_PREFIX, rectangle: rectangle, moveRectangle: moveRectangle, resizeRectangle: resizeRectangle, toPixels: toPixels, cropImage: cropImage, selectScreenshotRegion: selectScreenshotRegion };
});
