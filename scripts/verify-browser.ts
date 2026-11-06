import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.VERIFY_BASE_URL;
const executablePath = process.env.VERIFY_CHROME_PATH;
const passwordFile = process.env.VERIFY_ADMIN_PASSWORD_FILE;
if (
  !base ||
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base) ||
  process.env.VERIFY_ALLOW_MUTATION !== "1" ||
  !executablePath ||
  !passwordFile
) {
  throw new Error(
    "Requires explicit local VERIFY_BASE_URL, VERIFY_ALLOW_MUTATION=1, VERIFY_CHROME_PATH and VERIFY_ADMIN_PASSWORD_FILE. Use only a disposable development database.",
  );
}
const out = ".scratch/sponsorship-delivery/shots/functional";
await mkdir(out, { recursive: true });
const password = (await readFile(passwordFile, "utf8")).trim();
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-mock-keychain", "--password-store=basic"],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  acceptDownloads: true,
});
const page = await context.newPage();
let recordId: string | undefined;
async function settle() {
  await page.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
  });
}
try {
  const otherTab = await context.newPage();
  let activeInitializations = 0;
  let maximumInitializations = 0;
  await context.route("**/api/unlock", async (route) => {
    activeInitializations++;
    maximumInitializations = Math.max(
      maximumInitializations,
      activeInitializations,
    );
    try {
      const response = await route.fetch();
      // Deliberately delay network delivery to expose cookie-overwrite races.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ response });
    } finally {
      activeInitializations--;
    }
  });
  await Promise.all([page.goto(base), otherTab.goto(base)]);
  await Promise.all(
    [page, otherTab].map((tab) =>
      tab.waitForFunction(
        () =>
          !(document.querySelector(".confirm-button") as HTMLButtonElement)
            ?.disabled,
      ),
    ),
  );
  assert.equal(maximumInitializations, 1);
  await context.unrouteAll({ behavior: "wait" });
  console.log(
    "PASS browser: concurrent first-load tabs serialize delayed cookie initialization",
  );
  await page
    .getByRole("button", { name: "我已付款，确认赞助", exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      !(document.querySelector(".confirm-button") as HTMLButtonElement)
        ?.disabled,
  );
  await page.getByRole("button", { name: "自定义金额 ＋" }).click();
  await page.locator("#custom-amount").fill("12.34");
  await page.locator(".qq-field > summary").click();
  await page.locator("#qq").fill("123456789");
  await page.reload();
  await page.locator("#custom-amount").waitFor();
  assert.equal(await page.locator("#custom-amount").inputValue(), "12.34");
  assert.equal(await page.locator("#qq").inputValue(), "123456789");
  console.log("PASS browser: draft survives reload");

  await page.route(
    "**/api/confirm",
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "记录未能保存，请重试。" }),
      }),
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "我已付款，确认赞助", exact: true })
    .click();
  await page.locator(".form-error[role=alert]").waitFor();
  assert.equal(await page.getByRole("link", { name: /打开下载/ }).count(), 0);
  assert.equal(await page.locator("#custom-amount").inputValue(), "12.34");
  assert.equal(await page.locator("#qq").inputValue(), "123456789");
  await settle();
  await page.screenshot({
    path: `${out}/save-failure-phone.png`,
    fullPage: true,
  });
  console.log("PASS browser: failure retains inputs, no download delivered");

  let committedKey = "";
  await page.route(
    "**/api/confirm",
    async (route) => {
      committedKey = route.request().postDataJSON().idempotencyKey;
      const response = await route.fetch();
      const data = await response.json();
      assert.equal(response.status(), 200);
      recordId = data.recordId;
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "我已付款，确认赞助", exact: true })
    .click();
  await page.locator(".form-error[role=alert]").waitFor();
  const retryRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/confirm") && request.method() === "POST",
  );
  await page
    .getByRole("button", { name: "我已付款，确认赞助", exact: true })
    .click();
  assert.equal(
    (await retryRequest).postDataJSON().idempotencyKey,
    committedKey,
  );
  await page.getByRole("link", { name: /打开下载/ }).waitFor();
  assert.equal(await page.locator(".qr-frame").count(), 0);
  await otherTab.reload();
  await otherTab.getByRole("link", { name: /打开下载/ }).waitFor();
  await otherTab.close();
  console.log(
    "PASS browser: the other initial tab recovers the same confirmation",
  );
  await settle();
  await page.screenshot({ path: `${out}/unlocked-phone.png`, fullPage: true });
  await page.reload();
  await page.getByRole("link", { name: /打开下载/ }).waitFor();
  console.log(
    "PASS browser: lost response retried same key, unlock restores after reload",
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await settle();
  await page.screenshot({
    path: `${out}/unlocked-desktop.png`,
    fullPage: true,
  });
  await page.goto(`${base}/akak`);
  await page
    .locator("#admin-username")
    .fill(process.env.VERIFY_ADMIN_USERNAME || "admin");
  await page.locator("#admin-password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "赞助确认记录" }).waitFor();
  await page.locator(".admin-table").waitFor();
  await settle();
  await page.screenshot({ path: `${out}/admin-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await page.locator("#admin-export-password").fill("wrong-password");
  await page.getByRole("button", { name: "验证并导出", exact: true }).click();
  await page.locator("dialog [role=alert]").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  await page.screenshot({
    path: `${out}/export-error-phone.png`,
    fullPage: true,
  });
  await page.locator("#admin-export-password").fill(password);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "验证并导出", exact: true }).click();
  const download = await downloadEvent;
  await download.delete();
  console.log(
    "PASS browser: admin login, CSV wrong-password failure and authorized download",
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(overflow, false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(base);
  await page.getByRole("link", { name: /打开下载/ }).waitFor();
  assert.equal(
    await page
      .locator(".workspace")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await page.screenshot({
    path: `${out}/zoom-200-reduced-motion.png`,
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  );
  console.log("PASS browser: reduced motion and 200% reflow");
} finally {
  if (recordId) {
    // This context has already authenticated; clean up only the record this run created.
    await context.request.delete(`${base}/api/admin/records/${recordId}`, {
      headers: { Origin: base, "Content-Type": "application/json" },
      data: {},
    });
  }
  await context.unrouteAll({ behavior: "wait" });
  await browser.close();
}
console.log(`Browser verification complete. Evidence: ${out}`);
