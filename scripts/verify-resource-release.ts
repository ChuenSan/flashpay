// Browser fixtures intercept every API call; this script never changes site data.
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

const out =
  process.env.VERIFY_SHOTS_DIR || ".scratch/resource-release-notes/shots/admin";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-mock-keychain", "--password-store=basic"],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  let settings = { ...defaultReleaseSettings };
  let failSave = false;
  let failLoad = false;
  let saveCount = 0;
  await context.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/admin/session")
      return route.fulfill({
        json: { authenticated: true, username: "admin" },
      });
    if (pathname === "/api/admin/settings")
      return route.fulfill({
        json: {
          downloadUrl: "https://downloads.example.test/resource",
          archivePassword: "",
        },
      });
    if (pathname === "/api/admin/records")
      return route.fulfill({
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
      });
    if (pathname === "/api/admin/resource-release") {
      if (route.request().method() === "PUT") {
        saveCount++;
        if (failSave)
          return route.fulfill({
            status: 500,
            json: { error: "保存失败，请重试。" },
          });
        const body = route.request().postDataJSON();
        settings = {
          version: body.version.trim(),
          publishedAt: body.publishedAt,
          changes: body.changes.trim(),
          knownIssues: body.knownIssues.trim(),
        };
      } else if (failLoad)
        return route.fulfill({
          status: 503,
          json: { error: "更新日志暂时无法加载。" },
        });
      return route.fulfill({ json: settings });
    }
    return route.fulfill({
      status: 404,
      json: { error: "Fixture: unexpected API call" },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`${base}/akak`);
  const section = page.locator(".admin-release-settings");
  const date = page.getByLabel("发布日期", { exact: true });
  const version = page.getByLabel("版本名称", { exact: true });
  const changes = page.getByLabel("更新内容（每行一条）", { exact: true });
  const issues = page.getByLabel("已知问题（选填，每行一条）", { exact: true });
  const save = page.getByRole("button", { name: "保存更新日志", exact: true });
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>(
      "#admin-release-date",
    );
    return input && !input.matches(":disabled");
  });
  assert.equal(await date.inputValue(), defaultReleaseSettings.publishedAt);
  assert.equal(await version.inputValue(), defaultReleaseSettings.version);
  assert.match(await issues.inputValue(), /相机目前仍无法识别/);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await section.screenshot({ path: `${out}/settings-${width}.png` });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await section.screenshot({ path: `${out}/settings-zoom-2.png` });
  // Only the changed settings panel is in scope for CSS zoom inspection.
  assert(
    await section.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await date.fill("2026-11-05");
  await changes.fill(
    "支持在 Windows 下一键启动。\n新增充电功能。\n新增亮度调节功能。\n新增相机入口。",
  );
  failSave = true;
  await save.click();
  await section.getByRole("alert").waitFor();
  assert.equal(await date.inputValue(), "2026-11-05");
  assert.match(await changes.inputValue(), /新增亮度调节功能/);
  assert.equal(await section.locator(".admin-notice").count(), 0);
  await section.screenshot({ path: `${out}/save-error.png` });
  failSave = false;
  await save.click();
  await section.locator(".admin-notice").waitFor();
  assert.equal(saveCount, 2);
  await page.reload();
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>(
      "#admin-release-date",
    );
    return input?.value === "2026-11-05" && !input.matches(":disabled");
  });
  assert.equal(await date.inputValue(), settings.publishedAt);
  assert.equal(await changes.inputValue(), settings.changes);
  await issues.fill("");
  await save.click();
  await section.locator(".admin-notice").waitFor();
  assert.equal(settings.knownIssues, "");
  failLoad = true;
  await page.reload();
  await section.getByRole("button", { name: "重试加载日志" }).waitFor();
  assert.equal(await date.isDisabled(), true);
  failLoad = false;
  await section.getByRole("button", { name: "重试加载日志" }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>(
      "#admin-release-date",
    );
    return input && !input.matches(":disabled");
  });
  assert.equal(await date.inputValue(), settings.publishedAt);
  await context.close();
  console.log(
    "PASS release form: load, dated save, reload readback, failed-save input retention and retry, clear issues, failed-load retry, 320/390/1440px and 200% page zoom (intercepted API fixtures; no site mutations)",
  );
} finally {
  await browser.close();
}
