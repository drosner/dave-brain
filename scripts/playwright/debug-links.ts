/**
 * debug-inventory.ts
 * Logs in and dumps the full page text of the inventory page for debugging.
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

function sleep(minMs: number, maxMs: number) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((res) => setTimeout(res, ms));
}

async function run() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto("https://www.cellartracker.com", { waitUntil: "domcontentloaded" });
  await sleep(1500, 3000);

  await page.goto("https://www.cellartracker.com/password.asp", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="szUser"]').fill(CT_USER);
  await sleep(500, 1000);
  await page.locator('input[name="szPassword"]').fill(CT_PASSWORD);
  await sleep(500, 1000);
  await page.locator('input[type="submit"], button[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded");

  await page.goto("https://www.cellartracker.com/list.asp?Table=Inventory", { waitUntil: "networkidle", timeout: 30_000 });

  console.log("URL:  ", page.url());
  console.log("Title:", await page.title());
  console.log("--- PAGE TEXT (first 2000 chars) ---");
  const text = await page.locator("body").innerText();
  console.log(text.slice(0, 2000));
}

run().catch(console.error);