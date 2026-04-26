/**
 * cellartracker-signin.ts
 * Connects to a running Chromium instance via CDP, loads the CellarTracker
 * home page first (bot-detection friendliness), then navigates to login.
 *
 * Usage:
 *   npx tsx cellartracker-signin.ts
 */

import { chromium } from "playwright";

const CDP_URL = process.env.CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";
const HOME_URL = "https://www.cellartracker.com";
const LOGIN_URL = "https://www.cellartracker.com/password.asp";

/** Random pause between min and max milliseconds — looks more human */
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

  // Brief human-like pause before navigating (1.5 – 3 seconds)
  await sleep(1500, 3000);

  // Step 2 — navigate to login
  console.log(`Navigating to login: ${LOGIN_URL} ...`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log("Login page loaded:", await page.title());
  console.log("Current URL:", page.url());

  // Confirm login form is present
  const userField = page.locator('input[name="szUser"], input[type="text"]').first();
  await userField.waitFor({ timeout: 10_000 });
  console.log("Login form is visible — stopping here.");

  // Leave browser open for inspection
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
