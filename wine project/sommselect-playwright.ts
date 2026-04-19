#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run --env-file=.env

// =============================================================================
// sommselect-playwright.ts
// Fallback: authenticated Shopify scraper for wines where public URLs 404'd.
// Reads not_found wines from wine_inventory, logs into SommSelect,
// scrapes order history pages to find product URLs, extracts narratives.
//
// Run AFTER sommselect-scrape.ts (handles not_found wines only).
//
// Prerequisites on Pi:
//   deno run --allow-net --allow-run https://deno.land/x/puppeteer@16.2.0/install.ts
// Or use system Chromium:
//   sudo apt install chromium-browser
//
// Run:
//   deno run --allow-net --allow-env --allow-read --allow-write --allow-run --env-file=.env sommselect-playwright.ts
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import puppeteer from "https://deno.land/x/puppeteer@16.2.0/mod.ts";

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY   = Deno.env.get("OPENROUTER_API_KEY")!;
const SS_EMAIL             = Deno.env.get("SS_EMAIL")!;      // your SommSelect login email
const SS_PASSWORD          = Deno.env.get("SS_PASSWORD")!;   // your SommSelect password
const REPORT_FILE          = "./scrape-report-playwright.md";
const LOG_FILE             = "./scrape-log-playwright.jsonl";
const DELAY_MS             = 1500;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Get not_found wines from Supabase ────────────────────────────────────────
async function getNotFoundWines() {
  const { data, error } = await supabase
    .from("wine_inventory")
    .select("id,ct_ibottle,ct_iwine,wine,vintage,producer,varietal,region,country,location,my_notes,ct_score,sommselect_order_number")
    .eq("narrative_status", "not_found")
    .is("removed_at", null)
    .order("ct_iwine");

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  // Deduplicate by ct_iwine
  const seen = new Set<number>();
  return (data || []).filter(r => {
    if (seen.has(r.ct_iwine)) return false;
    seen.add(r.ct_iwine);
    return true;
  });
}

// ── Embedding ─────────────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-large", input: text, dimensions: 1536 }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  const d = await res.json();
  return d.data[0].embedding;
}

// ── HTML cleaner ──────────────────────────────────────────────────────────────
function cleanHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ").trim();
}

// ── Write to Supabase ─────────────────────────────────────────────────────────
async function updateWine(ctIwine: number, narrative: string, url: string, embedding: number[]) {
  const { error } = await supabase
    .from("wine_inventory")
    .update({
      sommselect_narrative:   narrative,
      sommselect_product_url: url,
      narrative_status:       "found",
      embedding:              `[${embedding.join(",")}]`,
      last_synced_at:         new Date().toISOString(),
    })
    .eq("ct_iwine", ctIwine);
  if (error) throw new Error(`Update failed: ${error.message}`);
}

// ── Normalize wine name for fuzzy matching ────────────────────────────────────
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function nameMatches(wineRow: { wine: string; vintage: number | null }, pageTitle: string): boolean {
  const norm = normalize(pageTitle);
  const wineNorm = normalize(wineRow.wine);
  const vtg = wineRow.vintage ? String(wineRow.vintage) : "";

  // Must contain vintage (if known) and at least the first significant word of wine name
  const wineWords = wineNorm.split(" ").filter(w => w.length > 3);
  const matchesWords = wineWords.slice(0, 3).every(w => norm.includes(w));
  const matchesVintage = !vtg || norm.includes(vtg);

  return matchesWords && matchesVintage;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  SommSelect Playwright Fallback Scraper");
  console.log("═══════════════════════════════════════════════════\n");

  const wines = await getNotFoundWines();
  console.log(`  ${wines.length} wines need authenticated scraping\n`);

  if (wines.length === 0) {
    console.log("  Nothing to do — all wines already found or no not_found wines.");
    Deno.exit(0);
  }

  const stats = { found: 0, not_found: 0, errors: 0 };
  const stillMissing: string[] = [];

  // ── Launch browser ──────────────────────────────────────────────────────
  console.log("  Launching headless Chromium...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    // On Pi, specify explicit path if needed:
    // executablePath: "/usr/bin/chromium-browser",
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 800 });

  // ── Log in ──────────────────────────────────────────────────────────────
  console.log("  Logging into SommSelect...");
  await page.goto("https://sommselect.com/account/login", { waitUntil: "networkidle2" });

  // Shopify login form — standard field IDs
  await page.type("#customer_email", SS_EMAIL, { delay: 50 });
  await page.type("#customer_password", SS_PASSWORD, { delay: 50 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click('[type="submit"]'),
  ]);

  const loginUrl = page.url();
  if (loginUrl.includes("/login") || loginUrl.includes("/challenge")) {
    await browser.close();
    throw new Error("Login failed — check SS_EMAIL and SS_PASSWORD in .env");
  }
  console.log("  ✓ Logged in\n");

  // ── Scrape order history ─────────────────────────────────────────────────
  // Build a map: wine name fragment → product URL
  // by iterating through account/orders pages
  console.log("  Indexing order history pages...");
  const productUrlMap = new Map<string, string>(); // normalized title → url

  let ordersPage = 1;
  let hasMoreOrders = true;

  while (hasMoreOrders) {
    await page.goto(`https://sommselect.com/account/orders?page=${ordersPage}`, { waitUntil: "networkidle2" });

    // Extract order links
    const orderLinks = await page.$$eval("a[href*='/account/orders/']", links =>
      links.map(l => (l as HTMLAnchorElement).href)
    );

    if (orderLinks.length === 0) {
      hasMoreOrders = false;
      break;
    }

    console.log(`    Page ${ordersPage}: ${orderLinks.length} orders`);

    for (const orderUrl of orderLinks) {
      await page.goto(orderUrl, { waitUntil: "networkidle2" });
      await sleep(800);

      // Extract product links from the order detail page
      // Shopify order pages list products with links back to product pages
      const products = await page.$$eval("a[href*='/products/']", links =>
        links.map(l => ({
          href: (l as HTMLAnchorElement).href,
          text: (l as HTMLAnchorElement).textContent?.trim() || "",
        }))
      );

      for (const { href, text } of products) {
        if (text && href.includes("sommselect.com/products/")) {
          productUrlMap.set(normalize(text), href);
        }
      }
    }

    ordersPage++;
    await sleep(DELAY_MS);

    // Check for next page button
    const nextBtn = await page.$("a[rel='next'], .pagination__next");
    if (!nextBtn) hasMoreOrders = false;
  }

  console.log(`  ✓ Indexed ${productUrlMap.size} product URLs from order history\n`);

  // ── Match wines to product URLs and fetch narratives ─────────────────────
  for (let i = 0; i < wines.length; i++) {
    const wine = wines[i];
    const label = `[${i + 1}/${wines.length}] ${wine.vintage || ""} ${wine.wine}`.trim();
    console.log(`\n  ⟳  ${label}`);

    // Find matching URL from order history index
    let matchedUrl: string | null = null;
    for (const [title, url] of productUrlMap) {
      if (nameMatches(wine, title)) {
        matchedUrl = url;
        break;
      }
    }

    if (!matchedUrl) {
      // Last resort: direct product page navigation via search
      await page.goto(`https://sommselect.com/search?q=${encodeURIComponent(wine.wine)}&type=product`, { waitUntil: "networkidle2" });
      await sleep(500);

      const firstResult = await page.$eval("a[href*='/products/']", (el: Element) => (el as HTMLAnchorElement).href).catch(() => null);
      if (firstResult) matchedUrl = firstResult;
    }

    if (!matchedUrl) {
      console.log("       ✗ Still not found");
      stillMissing.push(`${wine.vintage || ""} ${wine.wine}`.trim());
      stats.not_found++;
      await Deno.writeTextFile(LOG_FILE, JSON.stringify({
        ct_ibottle: wine.ct_ibottle, ct_iwine: wine.ct_iwine, wine: wine.wine,
        status: "not_found", timestamp: new Date().toISOString(),
      }) + "\n", { append: true });
      continue;
    }

    console.log(`       URL: ${matchedUrl}`);

    // Fetch the product page and extract narrative
    await page.goto(matchedUrl, { waitUntil: "networkidle2" });
    await sleep(800);

    const rawHtml = await page.content();
    const narrative = extractNarrativeFromHtml(rawHtml);

    if (!narrative) {
      console.log("       ✗ Page loaded but narrative not parseable");
      stats.errors++;
      continue;
    }

    console.log(`       ✓ Narrative: ${narrative.length} chars`);

    try {
      const embedText = [
        wine.wine,
        wine.vintage ? `Vintage ${wine.vintage}` : null,
        wine.producer,
        wine.varietal,
        wine.region,
        wine.country,
        wine.my_notes ? `My tasting notes: ${wine.my_notes}` : null,
        `SommSelect: ${narrative}`,
      ].filter(Boolean).join(". ");

      const embedding = await embed(embedText);
      await updateWine(wine.ct_iwine, narrative, matchedUrl, embedding);
      stats.found++;

      await Deno.writeTextFile(LOG_FILE, JSON.stringify({
        ct_ibottle: wine.ct_ibottle, ct_iwine: wine.ct_iwine, wine: wine.wine,
        status: "found", url: matchedUrl,
        narrative: narrative.substring(0, 500),
        timestamp: new Date().toISOString(),
      }) + "\n", { append: true });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`       ✗ Error: ${msg}`);
      stats.errors++;
    }

    await sleep(DELAY_MS);
  }

  await browser.close();

  // ── Report ────────────────────────────────────────────────────────────────
  const report = `# SommSelect Playwright Fallback Report
Generated: ${new Date().toISOString()}

## Results
| Result    | Count |
|-----------|-------|
| Found     | ${stats.found} |
| Not Found | ${stats.not_found} |
| Errors    | ${stats.errors} |

## Still Missing
${stillMissing.length === 0
  ? "_None — complete coverage achieved_"
  : stillMissing.map(w => `- ${w}`).join("\n")}

## Notes
Wines still missing are likely too old for SommSelect to have retained any
product page. Consider manually writing a note for these wines if the
SommSelect narrative is important for your records.
`;
  await Deno.writeTextFile(REPORT_FILE, report);

  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Found: ${stats.found}  |  Not found: ${stats.not_found}  |  Errors: ${stats.errors}`);
  console.log(`  Report: ${REPORT_FILE}`);
  if (stillMissing.length > 0) {
    console.log(`\n  ${stillMissing.length} wines have no recoverable SommSelect page.`);
  }
}

function extractNarrativeFromHtml(html: string): string | null {
  const parts: string[] = [];

  // JSON-LD
  const jsonLdMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of jsonLdMatches) {
    try {
      const json = JSON.parse(block.replace(/<script[^>]*>|<\/script>/g, ""));
      if (json["@type"] === "Product" && json.description) {
        parts.push(cleanHtml(json.description));
      }
    } catch { /* skip */ }
  }

  // og:description
  const ogMatch = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/);
  if (ogMatch) parts.push(ogMatch[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

  // Product description divs
  for (const pattern of [
    /class="[^"]*product[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /class="[^"]*rte[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ]) {
    const m = html.match(pattern);
    if (m) {
      const t = cleanHtml(m[1]);
      if (t.length > 100) parts.push(t);
    }
  }

  const combined = [...new Set(parts)].filter(p => p.length > 50).join("\n\n").trim();
  return combined.length > 100 ? combined : null;
}

main().catch(err => {
  console.error("Fatal:", err);
  Deno.exit(1);
});
