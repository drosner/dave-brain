/**
 * cellartracker-signin.ts
 * Connects to a running Chromium instance via CDP, loads the CellarTracker
 * home page, navigates to login, signs in, then loads the inventory page.
 *
 * Required .env vars:
 *   CT_USER      — CellarTracker username
 *   CT_PASSWORD  — CellarTracker password
 *
 * Usage:
 *   npx tsx cellartracker-signin.ts
 */

import { chromium } from "playwright";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const CDP_URL = process.env.CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";
const CT_USER = process.env.CT_USER;
const CT_PASSWORD = process.env.CT_PASSWORD;

if (!CT_USER || !CT_PASSWORD) {
  console.error("Missing CT_USER or CT_PASSWORD in .env");
  process.exit(1);
}

// Match the actual Chromium version on the Pi (147)
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function sleep(minMs: number, maxMs: number) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((res) => setTimeout(res, ms));
}

async function run() {
  console.log(`Connecting to Chromium at ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  console.log("Connected.");

  // Create a fresh context with realistic browser headers
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();

  // Remove the headless flag that Playwright exposes via JS
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Step 1 — home page first
  console.log("Loading home page ...");
  await page.goto("https://www.cellartracker.com", { waitUntil: "domcontentloaded" });
  console.log("Home page loaded:", await page.title());
  await sleep(1500, 3000);

  // Step 2 — login page
  console.log("Navigating to login ...");
  await page.goto("https://www.cellartracker.com/password.asp", { waitUntil: "domcontentloaded" });
  console.log("Login page loaded:", await page.title());

  // Step 3 — fill credentials
  await page.locator('input[name="szUser"]').waitFor({ timeout: 10_000 });
  console.log("Filling credentials ...");
  await page.locator('input[name="szUser"]').fill(CT_USER);
  await sleep(500, 1200);
  await page.locator('input[name="szPassword"]').fill(CT_PASSWORD);
  await sleep(500, 1000);

  // Step 4 — submit
  console.log("Submitting ...");
  await page.locator('input[type="submit"], button[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000, 2000);

  // Step 5 — inventory page
  console.log("Navigating to inventory ...");
  await page.goto("https://www.cellartracker.com/list.asp?Table=Inventory", {
    waitUntil: "networkidle",
    timeout: 30_000,
  });

  const finalUrl = page.url();
  const finalTitle = await page.title();
  console.log("URL:  ", finalUrl);
  console.log("Title:", finalTitle);

  if (finalTitle.includes("ERROR")) {
    console.error("CloudFront still blocking — may need additional stealth measures.");
    const text = await page.locator("body").innerText();
    console.log(text.slice(0, 500));
  } else {
    console.log("Inventory page loaded successfully.");
  }

  // Leave context open for inspection
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
