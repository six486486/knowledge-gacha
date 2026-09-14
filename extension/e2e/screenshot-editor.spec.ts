import { expect, test, type Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#63d8ad";
    context.fillRect(0, 0, 800, 600);
    context.fillStyle = "#18222d";
    context.font = "28px sans-serif";
    context.fillText("Screenshot region test", 80, 120);
    Object.assign(window.chrome, { runtime: {
      connect: () => ({
        onMessage: { addListener: (listener: Function) => queueMicrotask(() => listener({ type: "image", image: { dataUrl: canvas.toDataURL("image/png") } })) },
        onDisconnect: { addListener() {} },
        postMessage: (message: unknown) => { (window as any).cropMessage = message; }
      })
    } });
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/screenshot.html?session=editor-test");
  await expect(page.getByRole("group", { name: "截图框选画布" })).toBeVisible();
}

async function drag(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

test("选框可移动、边角缩放及键盘微调，窗口缩放不改变原图裁剪范围", async ({ page }) => {
  await openEditor(page);
  const bounds = (await page.locator("#capture-canvas").boundingBox())!;
  const at = (x: number, y: number) => ({ x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y });
  await drag(page, at(.1, .1), at(.5, .5));
  await expect(page.locator("#selection-size")).toHaveText("320 × 240 像素");
  await drag(page, at(.3, .3), at(.5, .4));
  await expect(page.locator("#selection-size")).toHaveText("320 × 240 像素");
  const handle = (await page.locator('[data-handle="se"]').boundingBox())!;
  await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + bounds.width * .1, y: handle.y + handle.height / 2 + bounds.height * .1 });
  await expect(page.locator("#selection-size")).toHaveText("400 × 300 像素");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.setViewportSize({ width: 720, height: 600 });
  await expect(page.locator("#selection-size")).toHaveText("400 × 300 像素");
  await page.keyboard.press("Enter");
  const message = await page.evaluate(() => (window as any).cropMessage);
  expect(message.type).toBe("confirm");
  expect(message.rect.x * 800).toBeCloseTo(241);
  expect(message.rect.y * 600).toBeCloseTo(130);
  expect(message.rect.width * 800).toBeCloseTo(400);
  expect(message.rect.height * 600).toBeCloseTo(300);
});

test("空选区不能确认，全选与重选可用，Esc 取消", async ({ page }) => {
  await openEditor(page);
  await page.locator("#capture-canvas").click({ position: { x: 40, y: 40 } });
  await expect(page.getByRole("button", { name: /确认截图/ })).toBeDisabled();
  await page.keyboard.press("Control+a");
  await expect(page.locator("#selection-size")).toHaveText("800 × 600 像素");
  await page.getByRole("button", { name: "重新框选" }).click();
  await expect(page.locator("#selection-size")).toHaveText("尚未选择区域");
  await expect(page.getByRole("button", { name: /确认截图/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).cropMessage.type)).toBe("cancel");
});

test("拖出图片边界仍完成框选，裁剪范围限制在图片内", async ({ page }) => {
  await openEditor(page);
  const bounds = (await page.locator("#capture-canvas").boundingBox())!;
  await drag(page, { x: bounds.x + bounds.width * .5, y: bounds.y + bounds.height * .5 }, { x: bounds.x - 10, y: bounds.y - 10 });
  await expect(page.locator("#selection-size")).toHaveText("400 × 300 像素");
  await page.getByRole("button", { name: /确认截图/ }).click();
  const message = await page.evaluate(() => (window as any).cropMessage);
  expect(message.rect).toEqual({ x: 0, y: 0, width: .5, height: .5 });
});
