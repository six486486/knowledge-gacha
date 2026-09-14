(function () {
  const region = window.KnowledgeGachaScreenshotRegion;
  const workspace = document.getElementById("workspace");
  const stage = document.getElementById("capture-canvas");
  const source = document.getElementById("capture-image");
  const selection = document.getElementById("selection");
  const status = document.getElementById("editor-status");
  const size = document.getElementById("selection-size");
  const confirm = document.getElementById("confirm-region");
  const reset = document.getElementById("reset-region");
  const selectAll = document.getElementById("select-all");
  const session = new URLSearchParams(location.search).get("session");
  let port = null;
  let rect = null;
  let drag = null;
  let ready = false;
  let submitted = false;

  function render() {
    const pixels = region.toPixels(rect, source.naturalWidth, source.naturalHeight);
    selection.hidden = !pixels;
    stage.classList.toggle("has-selection", Boolean(pixels));
    confirm.disabled = !pixels || submitted;
    reset.disabled = !pixels || submitted;
    selectAll.disabled = !ready || submitted;
    size.textContent = pixels ? pixels.width + " × " + pixels.height + " 像素" : "尚未选择区域";
    if (rect) {
      selection.style.left = rect.x * 100 + "%";
      selection.style.top = rect.y * 100 + "%";
      selection.style.width = rect.width * 100 + "%";
      selection.style.height = rect.height * 100 + "%";
    }
  }

  function fitImage() {
    if (!ready) return;
    const style = getComputedStyle(workspace);
    const width = workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = workspace.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const scale = Math.min(width / source.naturalWidth, height / source.naturalHeight, 1);
    stage.style.width = Math.max(1, source.naturalWidth * scale) + "px";
    stage.style.height = Math.max(1, source.naturalHeight * scale) + "px";
  }

  function point(event) {
    const bounds = stage.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }

  stage.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 || !ready || submitted || drag) return;
    event.preventDefault();
    stage.focus({ preventScroll: true });
    const handle = event.target.dataset.handle;
    drag = { id: event.pointerId, start: point(event), rect: rect, mode: handle || (selection.contains(event.target) ? "move" : "draw") };
    stage.setPointerCapture(event.pointerId);
    if (drag.mode === "draw") rect = null;
    render();
  });

  function updateDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const current = point(event);
    const dx = current.x - drag.start.x;
    const dy = current.y - drag.start.y;
    rect = drag.mode === "draw" ? region.rectangle(drag.start, current)
      : drag.mode === "move" ? region.moveRectangle(drag.rect, dx, dy)
        : region.resizeRectangle(drag.rect, drag.mode, dx, dy);
    render();
  }

  stage.addEventListener("pointermove", updateDrag);
  stage.addEventListener("pointerup", function (event) {
    if (!drag || drag.id !== event.pointerId) return;
    updateDrag(event);
    drag = null;
    stage.releasePointerCapture(event.pointerId);
    render();
  });
  stage.addEventListener("pointercancel", function () {
    if (!drag) return;
    rect = drag.rect;
    drag = null;
    render();
  });

  function send(type) {
    if (submitted || !port || (type === "confirm" && confirm.disabled)) return;
    submitted = true;
    render();
    try { port.postMessage({ type: type, rect: rect }); }
    catch { showError("截图会话已结束，请关闭窗口后重新截图。"); }
  }

  function chooseAll() {
    if (!ready || submitted) return;
    rect = { x: 0, y: 0, width: 1, height: 1 };
    render();
    stage.focus();
  }

  function showError(message) {
    ready = false;
    rect = null;
    render();
    stage.hidden = true;
    status.hidden = false;
    status.textContent = message;
  }

  confirm.addEventListener("click", function () { send("confirm"); });
  document.getElementById("cancel-region").addEventListener("click", function () {
    if (port && !submitted) send("cancel"); else window.close();
  });
  selectAll.addEventListener("click", chooseAll);
  reset.addEventListener("click", function () { rect = null; render(); stage.focus(); });
  stage.addEventListener("dblclick", function (event) {
    if (selection.contains(event.target)) send("confirm");
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (port && !submitted) send("cancel"); else window.close();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      chooseAll();
    } else if (event.key === "Enter" && event.target.tagName !== "BUTTON") {
      event.preventDefault();
      send("confirm");
    } else if (rect && !submitted && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      rect = region.moveRectangle(rect, (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0) / source.naturalWidth,
        (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) / source.naturalHeight);
      render();
    }
  });
  new ResizeObserver(fitImage).observe(workspace);

  if (!session || !window.chrome || !chrome.runtime || !chrome.runtime.connect) {
    showError("请从制卡侧边栏点击“截取屏幕”打开框选窗口。");
    return;
  }
  port = chrome.runtime.connect({ name: region.PORT_PREFIX + session });
  port.onMessage.addListener(function (message) {
    if (!message || message.type !== "image" || ready) return;
    source.onload = function () {
      ready = true;
      status.hidden = true;
      stage.hidden = false;
      fitImage();
      render();
      stage.focus();
    };
    source.onerror = function () { showError("截图无法加载，请取消后重新截图。"); };
    source.src = message.image.dataUrl;
  });
  port.onDisconnect.addListener(function () {
    // Read lastError so an unavailable originating sidebar does not become an uncaught error.
    void chrome.runtime.lastError;
    if (!submitted) showError("截图会话已结束，请关闭窗口后重新截图。");
  });
})();
