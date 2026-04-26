/**
 * cellartracker-signin.ts
 * Connects to a running Chromium instance via CDP, navigates to
 * CellarTracker, and clicks the Sign In link.
 *
 * Usage:
 *   npx tsx scripts/playwright/cellartracker-signin.ts
 *
 * Prerequisites:
 *   chromium-browser \
 *     --remote-debugging-port=9222 \
 *     --remote-debugging-address=127.0.0.1 \
 *     --no-first-run \
 *     --no-default-browser-check
 */

import { chromium } from "playwright";

const CDP_URL = process.env.CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";
const TARGET_URL = "https://www.cellartracker.com";

async function run() {
  console.log(`Connecting to Chromium at ${CDP_URL} ...`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  console.log("Connected.");

  // Use the first existing page, or open a new one
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  console.log(`Navigating to ${TARGET_URL} ...`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
  console.log("Page loaded:", await page.title());

  // Click the Sign In link in the upper-right nav
  // CellarTracker uses a top-nav link with text "Sign In"
  const signInLocator = page.getByRole("link", { name: /sign in/i });
  await signInLocator.waitFor({ timeout: 10_000 });
  console.log("Found Sign In link — clicking...");
  await signInLocator.click();

  console.log("Clicked. Now at:", page.url());
  console.log("Done — browser left open for inspection.");

  // NOTE: We intentionally do NOT call browser.close() here
  // so you can inspect the page state manually.
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
