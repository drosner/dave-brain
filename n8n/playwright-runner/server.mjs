import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { chromium } from "playwright-core";

const app = express();
const PORT = Number(process.env.PORT || 3001);
const OUTPUT_DIR = process.env.PLAYWRIGHT_OUTPUT_DIR || "/data";
const API_TOKEN = process.env.PLAYWRIGHT_API_TOKEN || "";
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/usr/bin/chromium";

app.use(express.json({ limit: "1mb" }));

function requireApiToken(req, res, next) {
  if (!API_TOKEN) return next();

  const token = req.get("x-api-key");
  if (token !== API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

async function runSommSelectLoginTest() {
  const { SS_EMAIL, SS_PASSWORD } = process.env;
  if (!SS_EMAIL || !SS_PASSWORD) {
    throw new Error("Missing SS_EMAIL or SS_PASSWORD in environment.");
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const screenshotPath = path.join(OUTPUT_DIR, "sommselect-login-test.png");
  const storageStatePath = path.join(OUTPUT_DIR, "sommselect-storage-state.json");

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 },
    });

    await page.goto("https://sommselect.com/account/login", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.locator("#customer_email").fill(SS_EMAIL);
    await page.locator("#customer_password").fill(SS_PASSWORD);
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60000 }),
      page.locator("button[type='submit'], input[type='submit']").first().click(),
    ]);

    const loginFailed = await page
      .locator("text=/invalid|incorrect|try again/i")
      .first()
      .isVisible()
      .catch(() => false);

    const isLoggedIn = await page
      .locator("a[href*='/account/logout'], a[href='/account']")
      .first()
      .isVisible()
      .catch(() => false);

    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });

    if (!isLoggedIn || loginFailed || page.url().includes("/account/login")) {
      throw new Error(`SommSelect login test failed at ${page.url()}`);
    }

    await page.context().storageState({ path: storageStatePath });

    return {
      ok: true,
      url: page.url(),
      title: await page.title(),
      screenshotPath,
      storageStatePath,
    };
  } finally {
    await browser.close();
  }
}

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/api/sommselect/login-test", requireApiToken, async (_, res) => {
  try {
    const result = await runSommSelectLoginTest();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Playwright runner listening on port ${PORT}`);
});
