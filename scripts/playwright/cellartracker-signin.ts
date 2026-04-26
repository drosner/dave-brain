/**
 * cellartracker-signin.ts
 * Connects to a running Chromium instance via CDP, loads the CellarTracker
 * home page, navigates to login, and signs in using credentials from .env.
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

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from repo root (two levels up from scripts/playwright/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const CDP_URL = process.env.CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";
const HOME_URL = "https://www.cellartracker.com";
const LOGIN_URL = "https://www.cellartracker.com/password.asp";

const CT_USER = process.env.CT_USER;
const CT_PASSWORD = process.env.CT_PASSWORD;

if (!CT_USER || !CT_PASSWORD) {
  console.error("Missing CT_USER or CT_PASSWORD in .env");
  process.exit(1);
}

/** Random pause between min and max ms — looks more human */
function sleep(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((res) => setTimeout(res, ms));
}

async function run() {
  console.log(`Connecting to Chromium at ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  console.log("Connected.");

  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  // Step 1 — land on home page like a normal visitor
  console.log(`Loading home page: ${HOME_URL} ...`);
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  console.log("Home page loaded:", await page.title());
  await sleep(1500, 3000);

  // Step 2 — navigate to login page
  console.log(`Navigating to login: ${LOGIN_URL} ...`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log("Login page loaded:", await page.title());

  // Step 3 — fill in credentials
  const userField = page.locator('input[name="szUser"]').first();
  const passField = page.locator('input[name="szPassword"]').first();

  await userField.waitFor({ timeout: 10_000 });
  console.log("Login form found — filling credentials ...");

  await userField.fill(CT_USER);
  await sleep(500, 1200);
  await passField.fill(CT_PASSWORD);
  await sleep(500, 1000);

  // Step 4 — submit the form
  console.log("Submitting login form ...");
  await page.locator('input[type="submit"], button[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");

  // Navigate to cellar after login rather than trusting the default redirect
  await page.goto("https://www.cellartracker.com/list.asp?Table=Inventory", { waitUntil: "networkidle" });

  const finalUrl = page.url();
  const finalTitle = await page.title();
  console.log("Post-login URL:  ", finalUrl);
  console.log("Post-login title:", finalTitle);

  if (finalUrl.includes("password.asp")) {
    console.error("Still on login page — credentials may be wrong or form selectors need updating.");
  } else {
    console.log("Login successful — cellar page loaded.");
  }

  // Leave browser open for inspection
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
