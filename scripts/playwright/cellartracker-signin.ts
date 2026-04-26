/**
 * cellartracker-signin.ts
 * Connects to a running Chromium instance via CDP and navigates
 * directly to the CellarTracker login page.
 *
 * Usage:
 *   npx tsx cellartracker-signin.ts
 */

import { chromium } from "playwright";

const CDP_URL = process.env.CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";
const LOGIN_URL = "https://www.cellartracker.com/password.asp";

async function run() {
  console.log(`Connecting to Chromium at ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  console.log("Connected.");

  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  console.log(`Navigating to ${LOGIN_URL} ...`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log("Page loaded:", await page.title());
  console.log("Current URL:", page.url());

  // Confirm the username field is present
  const userField = page.locator('input[name="szUser"], input[type="text"]').first();
  await userField.waitFor({ timeout: 10_000 });
  console.log("Login form is visible — stopping here.");

  // Leave browser open for inspection
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
