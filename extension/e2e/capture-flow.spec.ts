import { chromium, expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

async function openCapture(page: Page, html = "<main><h1>学习文章</h1><p>值得记住的正文。</p></main>") {
  await page.addInitScript(({ article }) => {
    const tab = { id: 7, windowId: 3, title: "学习文章", url: "https://example.com/article" };
    Object.assign(window.chrome, {
      tabs: { query: async () => [tab] },
      permissions: { request: async () => true },
      scripting: { executeScript: async ({ func, args }: { func: Function; args: unknown[] }) => {
        // Exercise the production extractor against real DOM/layout, isolated from the sidebar.
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;left:-10000px;width:1000px;height:800px";
        document.body.append(frame);
        try {
          frame.contentDocument!.open();
          frame.contentDocument!.write(article);
          frame.contentDocument!.close();
          const read = (frame.contentWindow as any).eval("(" + func.toString() + ")");
          return [{ result: { ...read(...args), url: tab.url, title: tab.title } }];
        } finally { frame.remove(); }
      } }
    });
  }, { article: html });
  await page.goto("/");
  await page.getByRole("button", { name: "制卡", exact: true }).click();
}

test("正文入口独立展示，提取文章并过滤导航、隐藏内容和表单", async ({ page }) => {
  await openCapture(page, `<header>站点菜单</header><nav>导航广告</nav><main>
    <article><h1>真正的文章</h1><p>第一段 <b>关键知识</b>。</p><p>第二段正文。</p>
    <aside>相关推荐</aside><div style="display:none">隐藏文字</div><button>分享</button>
    <form><input value="私密输入">表单文字</form></article><footer>版权信息</footer></main>`);
  await expect(page.locator(".capture-method")).toHaveCount(6);
  await page.getByRole("button", { name: /读取正文/ }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toHaveValue("真正的文章\n\n第一段 关键知识。\n\n第二段正文。");
  await expect(page.locator(".capture-reading-note")).toContainText("已提取文章正文");
  await expect(page.locator(".capture-source-url")).toHaveText("https://example.com/article");
  await expect(page.getByRole("switch")).toBeEnabled();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("编辑后的正文，保留自己真正需要的知识。");
  await expect(page.locator("#feed-count")).toContainText("19 / 1000000");
});

test("超过 12000 字的正文完整进入材料，普通页面说明提取方式", async ({ page }) => {
  await openCapture(page, "<div>" + "知识".repeat(6100) + "</div><nav>不要读取菜单</nav>");
  await page.getByRole("button", { name: /读取正文/ }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toHaveValue("知识".repeat(6100));
  await expect(page.locator(".capture-reading-note")).toContainText("未识别到独立文章");
  await expect(page.locator(".capture-reading-note")).not.toContainText("仅读取前");
  await expect(page.locator('#generate-card')).toContainText('整理学习清单');
});

test("切换选区和正文收起手动输入，读取失败仍可恢复原素材", async ({ page }) => {
  await openCapture(page, "<nav>只有导航</nav>");
  await page.getByRole("button", { name: /手动输入/ }).click();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("这是之前输入的素材，失败时应该保留。");
  await page.getByRole("button", { name: /选中文字/ }).click();
  await expect(page.getByRole("alert")).toContainText("没有选中文字");
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toBeHidden();
  await expect(page.locator("#capture-manual")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "凝练成卡" })).toBeDisabled();
  await page.getByRole("button", { name: /读取正文/ }).click();
  await expect(page.getByRole("alert")).toContainText("没有可读取的正文");
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toBeHidden();
  await page.getByRole("button", { name: /手动输入/ }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toHaveValue("这是之前输入的素材，失败时应该保留。");
  await expect(page.locator("#capture-manual")).toHaveAttribute("aria-expanded", "true");
});

test("重复点击手动输入保留文字，制卡页只保留一个图片上传入口", async ({ page }, testInfo) => {
  await openCapture(page);
  await expect(page.getByText("上传本地图片", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续处理历史材料" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("feed-empty-480.png"), fullPage: true });
  await page.getByRole("button", { name: /手动输入/ }).click();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("反复点击手动输入不能清掉已经写好的笔记。");
  await page.getByRole("button", { name: /手动输入/ }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toHaveValue("反复点击手动输入不能清掉已经写好的笔记。");
  await expect(page.getByText("改用本地图片", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存当前材料草稿" })).toHaveCount(0);
  await expect(page.locator("#image-input")).toHaveCount(1);
  for (const width of [480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`feed-manual-${width}.png`), fullPage: true });
  }
});

test("选择图片或文件先收起手动输入，取消选择后可继续原来的编辑", async ({ page }) => {
  await openCapture(page);
  await page.getByRole("button", { name: /手动输入/ }).click();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("选择文件前的笔记应当保留。");
  await page.locator("#feed-goal").fill("保留学习目标");
  await page.getByRole("switch").click();
  for (const name of [/上传图片/, /导入文件/]) {
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("button", { name }).click();
    const chooser = await choosing;
    await expect(page.getByRole("textbox", { name: "制卡素材" })).toBeHidden();
    await expect(page.locator("#feed-goal")).toBeHidden();
    await expect(page.getByRole("button", { name: "凝练成卡" })).toBeDisabled();
    await chooser.setFiles([]);
    await page.getByRole("button", { name: /手动输入/ }).click();
    await expect(page.getByRole("textbox", { name: "制卡素材" })).toHaveValue("选择文件前的笔记应当保留。");
    await expect(page.locator("#feed-goal")).toHaveValue("保留学习目标");
    await expect(page.getByRole("switch")).toBeChecked();
  }
  const choosing = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /上传图片/ }).click();
  await (await choosing).setFiles({ name: "笔记.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64") });
  await expect(page.getByRole("img", { name: "已捕获的知识素材" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "图注或补充说明" })).toHaveValue("");
  await expect(page.locator(".capture-source-head")).toContainText("笔记.png");
});

test("开关在输入后可用，支持键盘且新素材重置保存选择，320px 不溢出", async ({ page }) => {
  await openCapture(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: /手动输入/ }).click();
  const toggle = page.getByRole("switch", { name: "随卡片保留原文" });
  await expect(toggle).toBeDisabled();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("输入一段需要保存的原文，开关应该立即可用。");
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveText("已关闭");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveText("已开启");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.getByRole("button", { name: /读取正文/ }).click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await toggle.click();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("");
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
});

test("截图选择期间禁止重复操作，取消后保留素材和开关选择", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: () => new Promise((_resolve, reject) => {
      (window as any).cancelCapture = () => reject(new DOMException("Cancelled", "NotAllowedError"));
    }) });
  });
  await openCapture(page);
  await page.getByRole("button", { name: /手动输入/ }).click();
  await page.getByRole("textbox", { name: "制卡素材" }).fill("取消截图时，保留这份素材。");
  await page.getByRole("switch").click();
  await page.getByRole("button", { name: /截取屏幕/ }).click();
  await expect(page.locator(".capture-feedback")).toContainText("选择画面");
  await expect(page.getByRole("button", { name: /截取屏幕/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "凝练成卡" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toBeHidden();
  await page.evaluate(() => (window as any).cancelCapture());
  await expect(page.getByRole("alert")).toContainText("原素材已保留");
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toBeHidden();
  await page.getByRole("button", { name: /手动输入/ }).click();
  await expect(page.getByRole("textbox", { name: "制卡素材" })).toHaveValue("取消截图时，保留这份素材。");
  await expect(page.getByRole("switch")).toBeChecked();
  await expect(page.getByRole("button", { name: /截取屏幕/ })).toBeEnabled();
});

test("屏幕取帧生成真实 PNG 并在进入框选前停止共享", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#63d8ad";
      context.fillRect(0, 0, 640, 360);
      const stream = canvas.captureStream(10);
      (window as any).captureStream = stream;
      return stream;
    } });
  });
  await openCapture(page);
  const result = await page.evaluate(async () => (window as any).KnowledgeGachaBrowserCapture.createBrowserCapture(window.chrome).captureScreenshot());
  expect(result.image.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(result.url).toBe("");
  await expect.poll(() => page.evaluate(() => (window as any).captureStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);
});

test("Edge 真实截图支持反向框选并仅回填所选区域的原始像素", async ({}, testInfo) => {
  test.setTimeout(40_000);
  const extensionPath = resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "msedge", headless: true, viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      // Select only this disposable fixture, never the user's screen or browser profile.
      "--auto-select-tab-capture-source-by-title=Knowledge Gacha Capture Fixture"
    ]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const target = await context.newPage();
    await target.setContent('<title>Knowledge Gacha Capture Fixture</title><body style="margin:0;background:#ff6f61"><div style="position:absolute;left:25vw;top:25vh;width:50vw;height:50vh;background:#63d8ad"></div></body>');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/index.html`);
    await panel.getByRole("button", { name: "制卡", exact: true }).click();
    const opened = context.waitForEvent("page");
    await panel.getByRole("button", { name: /截取屏幕/ }).click();
    const editor = await opened;
    await editor.waitForURL(/screenshot\.html/);
    const stage = editor.getByRole("group", { name: "截图框选画布" });
    await expect(stage).toBeVisible();
    await expect(editor.getByRole("button", { name: /确认截图/ })).toBeDisabled();
    const bounds = (await stage.boundingBox())!;
    await editor.mouse.move(bounds.x + bounds.width * .75, bounds.y + bounds.height * .75);
    await editor.mouse.down();
    await editor.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .25, { steps: 8 });
    await editor.mouse.up();
    await expect(editor.locator("#selection-size")).toHaveText("640 × 360 像素");
    await editor.screenshot({ path: testInfo.outputPath("region-selection.png") });
    const expectedCorner = await editor.locator("#capture-image").evaluate((image: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(325, 185, 1, 1).data);
    });
    await editor.keyboard.press("Enter").catch((error) => {
      // Confirmation closes the popup on keydown, sometimes before keyup is sent.
      // The assertions below still require the correctly cropped image in the panel.
      if (!editor.isClosed()) throw error;
    });
    const preview = panel.getByRole("img", { name: "已捕获的知识素材" });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([640, 360]);
    const corner = await preview.evaluate((image: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(5, 5, 1, 1).data);
    });
    expect(corner).toEqual(expectedCorner);
    await expect(panel.locator(".capture-source-url")).toHaveText("来自你选择的画面");
    await expect(panel.getByRole("switch")).toBeDisabled();
    const original = await preview.getAttribute("src");
    for (const action of ["Escape", "close"]) {
      const openedAgain = context.waitForEvent("page");
      await panel.getByRole("button", { name: /截取屏幕/ }).click();
      const cancelledEditor = await openedAgain;
      await expect(cancelledEditor.getByRole("group", { name: "截图框选画布" })).toBeVisible();
      if (action === "close") await cancelledEditor.close();
      else await cancelledEditor.keyboard.press("Escape").catch((error) => {
        // Escape closes the popup on keydown, sometimes before Playwright sends keyup.
        if (!cancelledEditor.isClosed()) throw error;
      });
      await expect(panel.getByRole("alert")).toContainText("原素材已保留");
      await expect(preview).toHaveAttribute("src", original!);
      await expect(panel.getByRole("button", { name: /截取屏幕/ })).toBeEnabled();
    }
  } finally { await context.close(); }
});
