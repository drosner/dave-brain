/**
 * debug-inventory-links.ts
 * Logs in, navigates to inventory, and dumps all links on the page.
 *
 * Usage:
 *   npx tsx debug-inventory-links.ts
 */

import { chromium } from "playwright";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const CDP_URL = process.env.CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";
const CT_USER = process.env.CT_USER!;
const CT_PASSWORD = process.env.CT_PASSWORD!;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function sleep(minMs: number, maxMs: number) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((res) => setTimeout(res, ms));
}

async function run() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  await page.goto("https://www.cellartracker.com", { waitUntil: "domcontentloaded" });
  await sleep(1500, 3000);
  await page.goto("https://www.cellartracker.com/password.asp", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="szUser"]').fill(CT_USER);
  await sleep(500, 1200);
  await page.locator('input[name="szPassword"]').fill(CT_PASSWORD);
  await sleep(500, 1000);
  await page.locator('input[type="submit"], button[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000, 2000);

  await page.goto("https://www.cellartracker.com/list.asp?Table=Inventory", {
    waitUntil: "networkidle",
    timeout: 30_000,
  });

  console.log("Page title:", await page.title());
  console.log("--- ALL LINKS ---");
  const links = await page.locator("a").all();
  for (const l of links) {
    const text = (await l.textContent())?.trim();
    const href = await l.getAttribute("href");
    if (text) console.log(JSON.stringify({ text, href }));
  }
}

run().catch(console.error);