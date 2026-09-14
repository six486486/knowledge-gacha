import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function openEvaluation(page: Page) {
  const requests: any[] = [];
  await page.addInitScript(() => {
    if (sessionStorage.getItem("single-eval-seeded")) return;
    localStorage.clear();
    localStorage.setItem("kg_web_settings", JSON.stringify({ baseUrl: "http://127.0.0.1:8790/v1", model: "deepseek-v4-flash-vision-exp", temperature: 0.3 }));
    sessionStorage.setItem("kg_web_api_key", "single-eval-local-fixture");
    sessionStorage.setItem("single-eval-seeded", "true");
  });
  page.on("request", request => {
    if (request.url() === "http://127.0.0.1:8790/v1/chat/completions" && request.method() === "POST") requests.push(request.postDataJSON());
  });
  await page.goto("/evals/card-quality/browser.html");
  await expect(page.locator("#start")).toBeEnabled();
  return requests;
}

test("单样本页面：默认一份、预算续跑恢复所选图片、导出后换样本", async ({ page }, testInfo) => {
  const requests = await openEvaluation(page);
  await expect(page.locator("#mode")).toHaveValue("single");
  await expect(page.locator("#sample")).toHaveValue("short-05");
  await expect(page.locator("#max-requests")).toHaveValue("7");
  await expect(page.locator("#max-tokens")).toHaveValue("18000");
  await expect(page.locator("#cases li")).toHaveCount(1);
  await page.locator("#max-requests").fill("1");
  await page.locator("#sample").selectOption("image-02");
  await expect(page.locator("#max-requests")).toHaveValue("1");
  await expect(page.locator("#cases li")).toContainText("image-02");
  await page.locator("#start").click();
  await expect(page.locator("#status")).toContainText("已达到预算");
  await expect(page.locator("#sample")).toBeDisabled();
  await expect(page.locator("#mode")).toBeDisabled();
  expect(requests).toHaveLength(1);
  await page.reload();
  await expect(page.locator("#sample")).toHaveValue("image-02");
  await expect(page.locator("#max-requests")).toHaveValue("1");
  await expect(page.locator("#usage")).toContainText("已尝试 1 次请求");
  await page.locator("#max-requests").fill("4");
  await page.locator("#start").click();
  await expect(page.locator("#status")).toContainText("已处理 1/1 份");
  await expect(page.locator("#start")).toBeDisabled();
  expect(requests).toHaveLength(4);
  expect(requests.every(body => body.thinking.type === "disabled")).toBe(true);
  expect(requests[0].messages.at(-1).content.some((part: any) => part.type === "image_url" && part.image_url.url.startsWith("data:image/gif;base64,"))).toBe(true);
  expect(requests.slice(1).every(body => typeof body.messages.at(-1).content === "string")).toBe(true);
  const downloadPending = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPending;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.outputs.evaluationMode).toBe("single");
  expect(exported.outputs.cases.map((item: any) => item.id)).toEqual(["image-02"]);
  expect(exported.outputs.budget.requestsUsed).toBe(4);
  expect(exported.outputs.budget.knownTokens).toBe(72);
  expect(exported.blindReview).toHaveLength(1);
  expect(exported.blindReview[0].scores.accuracy).toBeNull();
  expect(JSON.stringify(exported)).not.toContain("single-eval-local-fixture");
  await page.getByText("使用说明与评审方式", { exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#reset").click();
  await expect(page.locator("#sample")).toBeEnabled();
  await page.locator("#sample").selectOption("short-01");
  await expect(page.locator("#usage")).toHaveText("尚未发送请求。");
  await expect(page.locator("#cases li")).toHaveCount(1);
  await expect(page.locator("#cases li")).toContainText("short-01");
  expect(requests).toHaveLength(4);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.locator("#sample")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("single-sample-320.png"), fullPage: true });
});

test("已有批量评测恢复原范围、预算和导出，单样本选择保持隐藏", async ({ page }) => {
  await openEvaluation(page);
  await page.locator("#mode").selectOption("quick");
  await expect(page.locator("#sample-field")).toBeHidden();
  await expect(page.locator("#cases li")).toHaveCount(8);
  await page.locator("#max-requests").fill("1");
  await page.locator("#start").click();
  await expect(page.locator("#status")).toContainText("已达到预算");
  await page.reload();
  await expect(page.locator("#mode")).toHaveValue("quick");
  await expect(page.locator("#sample-field")).toBeHidden();
  await expect(page.locator("#cases li")).toHaveCount(8);
  await expect(page.locator("#usage")).toContainText("已尝试 1 次请求");
  await expect(page.locator("#max-requests")).toHaveValue("1");
  await expect(page.locator("#export")).toBeEnabled();
});
