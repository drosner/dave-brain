import { chromium } from "playwright";

async function run() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.goto("https://www.cellartracker.com", { waitUntil: "domcontentloaded" });

  const links = await page.locator("a").all();
  for (const l of links) {
    const text = (await l.textContent())?.trim();
    const href = await l.getAttribute("href");
    if (text) console.log(JSON.stringify({ text, href }));
  }

  // Don't close — leave browser open
}

run().catch(console.error);
