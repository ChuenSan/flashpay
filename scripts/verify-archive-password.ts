import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { defaultReleaseSettings } from "../src/lib/resource-releases";

const base = process.env.VERIFY_BASE_URL;
const executablePath = process.env.VERIFY_CHROME_PATH;
if (
  !base ||
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base) ||
  !executablePath
)
  throw new Error("Requires local VERIFY_BASE_URL and VERIFY_CHROME_PATH.");

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-mock-keychain", "--password-store=basic"],
});
const out = process.env.VERIFY_SHOTS_DIR || ".scratch/archive-password/shots";
await mkdir(out, { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const archivePassword = "fixture-archive-password<&>";
  const payload = {
    unlocked: true,
    downloadUrl: "https://downloads.example.test/resource",
    archivePassword,
    confirmedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    recordId: "fixture-record",
  };
  let recovered = false;
  await context.route("**/api/unlock", (route) =>
    route.fulfill({ json: recovered ? payload : { unlocked: false } }),
  );
  await context.route("**/api/sponsors", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await context.route("**/api/confirm", (route) =>
    route.fulfill({ json: payload }),
  );
  await page.goto(base);
  assert.equal(
    await page.getByText(archivePassword, { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "我已付款，确认赞助", exact: true })
    .click();
  await page.getByRole("link", { name: /打开下载/ }).waitFor();
  assert.ok(
    (await page.locator(".unlock-panel").innerText()).includes(archivePassword),
    "Confirmation card must display the configured archive password",
  );
  await page.locator(".unlock-panel").screenshot({
    path: `${out}/confirmation-phone.png`,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "复制压缩包密码", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    archivePassword,
  );
  await page.getByRole("button", { name: "复制资源链接", exact: true }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    payload.downloadUrl,
  );
  recovered = true;
  await page.reload();
  await page.getByText(archivePassword, { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".unlock-panel").screenshot({
    path: `${out}/confirmation-desktop.png`,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  );
  payload.archivePassword = "";
  await page.reload();
  await page.getByRole("link", { name: /打开下载/ }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "复制压缩包密码", exact: true })
      .count(),
    0,
  );
  let settings = { downloadUrl: payload.downloadUrl, archivePassword };
  await context.route("**/api/admin/session", (route) =>
    route.fulfill({ json: { authenticated: true, username: "admin" } }),
  );
  await context.route("**/api/admin/records?**", (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 0,
        page: 1,
        pageSize: 50,
        stats: {
          totalCount: 0,
          todayCount: 0,
          totalAmountCents: 0,
          uniqueIps90d: 0,
        },
      },
    }),
  );
  await context.route("**/api/admin/resource-release", (route) =>
    route.fulfill({ json: defaultReleaseSettings }),
  );
  await context.route("**/api/admin/settings", (route) => {
    if (route.request().method() === "PUT")
      settings = route.request().postDataJSON();
    return route.fulfill({ json: settings });
  });
  await page.goto(`${base}/akak`);
  const passwordInput = page.getByLabel("压缩包密码（选填）", { exact: true });
  await passwordInput.waitFor();
  await page.waitForFunction(
    () =>
      (document.querySelector("#admin-archive-password") as HTMLInputElement)
        ?.disabled === false,
  );
  assert.equal(await passwordInput.inputValue(), archivePassword);
  const replacement = "  replacement<&>密碼  ";
  await passwordInput.fill(replacement);
  await page.getByRole("button", { name: "保存下载设置", exact: true }).click();
  await page.locator(".admin-notice").waitFor();
  assert.equal(settings.archivePassword, replacement);
  await page.reload();
  await page.waitForFunction(
    () =>
      (document.querySelector("#admin-archive-password") as HTMLInputElement)
        ?.disabled === false,
  );
  assert.equal(await passwordInput.inputValue(), replacement);
  for (const width of [390, 701, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator(".admin-download-settings").screenshot({
      path: `${out}/admin-${width}.png`,
      animations: "disabled",
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
  }
  await passwordInput.fill("");
  await page.getByRole("button", { name: "保存下载设置", exact: true }).click();
  await page.locator(".admin-notice").waitFor();
  assert.equal(settings.archivePassword, "");
  console.log(
    "PASS admin password: load, exact save, reload, clear and responsive form",
  );
  console.log(
    "PASS archive password: confirmation display, exact copying, reload recovery, mobile reflow and empty setting",
  );
} finally {
  await browser.close();
}
