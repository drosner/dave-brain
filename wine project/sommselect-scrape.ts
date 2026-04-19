#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --env-file=.env

// =============================================================================
// sommselect-scrape.ts
// One-time batch: fetch SommSelect narrative pages for every SommSelect wine
// in the wine_inventory table and write results back.
//
// Run: deno run --allow-net --allow-env --allow-read --allow-write --env-file=.env sommselect-scrape.ts
//
// What it does:
//   1. Queries wine_inventory for all rows where sommselect_order_number IS NOT
//      NULL or producer/wine matches common SommSelect sources (or you can seed
//      a manual list — see MANUAL_WINE_LIST below if brain query isn't wired yet)
//   2. For each wine, tries three strategies in order:
//        A. Shopify search API  → finds canonical product URL by wine name
//        B. Slug construction   → builds probable URL from wine name + vintage
//        C. Mark as not_found   → logs for manual follow-up
//   3. Fetches the product page and extracts:
//        - Full narrative / description text
//        - Serving notes (temp, decant, glass type)
//        - Drinking window recommendation
//        - Food pairings
//        - Producer story
//   4. Writes everything to wine_inventory:
//        sommselect_narrative      TEXT   — full extracted text
//        sommselect_product_url    TEXT   — canonical URL found
//        sommselect_order_number   TEXT   — preserved if already set
//        narrative_status          TEXT   — 'found' | 'not_found'
//   5. Re-generates embedding for the wine combining existing data + SS narrative
//   6. Writes a progress log to ./scrape-log.jsonl (resumable)
//   7. On completion, writes a summary report to ./scrape-report.md
//
// Rate limiting: 2-second delay between requests — polite to SommSelect's CDN
// Resumable: skip wines already in scrape-log.jsonl with status=found
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY= Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY  = Deno.env.get("OPENROUTER_API_KEY")!;
const DELAY_MS            = 2000;   // 2s between requests — don't change
const LOG_FILE            = "./scrape-log.jsonl";
const REPORT_FILE         = "./scrape-report.md";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Types ─────────────────────────────────────────────────────────────────────
interface WineRow {
  id: number;
  ct_ibottle: number;
  ct_iwine: number;
  wine: string;
  vintage: number | null;
  producer: string | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
  location: string | null;
  my_notes: string | null;
  ct_score: number | null;
  sommselect_order_number: string | null;
  sommselect_product_url: string | null;
  narrative_status: string | null;
}

interface ScrapeResult {
  ct_ibottle: number;
  ct_iwine: number;
  wine: string;
  vintage: number | null;
  status: "found" | "not_found" | "skipped";
  url?: string;
  narrative?: string;
  error?: string;
  timestamp: string;
}

// ── Load existing log (for resume) ────────────────────────────────────────────
async function loadLog(): Promise<Map<number, ScrapeResult>> {
  const map = new Map<number, ScrapeResult>();
  try {
    const text = await Deno.readTextFile(LOG_FILE);
    for (const line of text.trim().split("\n")) {
      if (!line.trim()) continue;
      const entry: ScrapeResult = JSON.parse(line);
      map.set(entry.ct_ibottle, entry);
    }
    console.log(`  Loaded ${map.size} existing log entries (resume mode)`);
  } catch {
    console.log("  No existing log — starting fresh");
  }
  return map;
}

async function appendLog(result: ScrapeResult): Promise<void> {
  await Deno.writeTextFile(LOG_FILE, JSON.stringify(result) + "\n", { append: true });
}

// ── Fetch SommSelect wines from wine_inventory ─────────────────────────────
async function getSommSelectWines(): Promise<WineRow[]> {
  // Primary: wines with sommselect_order_number set
  const { data: withOrder, error: e1 } = await supabase
    .from("wine_inventory")
    .select("id,ct_ibottle,ct_iwine,wine,vintage,producer,varietal,region,country,location,my_notes,ct_score,sommselect_order_number,sommselect_product_url,narrative_status")
    .not("sommselect_order_number", "is", null)
    .is("removed_at", null)
    .order("ct_iwine");

  if (e1) throw new Error(`Supabase query failed: ${e1.message}`);

  // Secondary: wines where narrative_status = 'pending' but no order number
  // (catches wines added via nightly sync with SS source flag)
  const { data: pending, error: e2 } = await supabase
    .from("wine_inventory")
    .select("id,ct_ibottle,ct_iwine,wine,vintage,producer,varietal,region,country,location,my_notes,ct_score,sommselect_order_number,sommselect_product_url,narrative_status")
    .eq("narrative_status", "pending")
    .is("removed_at", null)
    .order("ct_iwine");

  if (e2) throw new Error(`Supabase query failed: ${e2.message}`);

  // Deduplicate by ct_iwine (multiple bottles of same wine → only scrape once per wine)
  const seen = new Set<number>();
  const deduped: WineRow[] = [];
  for (const row of [...(withOrder || []), ...(pending || [])]) {
    if (!seen.has(row.ct_iwine)) {
      seen.add(row.ct_iwine);
      deduped.push(row as WineRow);
    }
  }

  return deduped;
}

// ── Slug builder ──────────────────────────────────────────────────────────────
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''""]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildProbableSlug(wine: WineRow): string {
  // SommSelect slug pattern: [vintage]-[producer-slug]-[wine-name-slug]
  // The wine field from CT often includes producer, so we use it whole
  const base = wine.vintage
    ? `${wine.vintage}-${toSlug(wine.wine)}`
    : toSlug(wine.wine);
  return base;
}

// ── Strategy A: Shopify Search API ───────────────────────────────────────────
async function searchShopify(wine: WineRow): Promise<string | null> {
  // Shopify predictive search endpoint — works without auth
  const searchTerm = wine.vintage
    ? `${wine.vintage} ${wine.producer || ""} ${wine.wine}`.trim()
    : wine.wine;

  const url = `https://sommselect.com/search/suggest.json?q=${encodeURIComponent(searchTerm)}&resources[type]=product&resources[limit]=5`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; personal-wine-scraper/1.0)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const products = data?.resources?.results?.products || [];

    if (products.length === 0) return null;

    // Score matches by how well the title matches
    const vintageStr = wine.vintage ? String(wine.vintage) : "";
    const producerLower = (wine.producer || "").toLowerCase();

    for (const p of products) {
      const titleLower = (p.title || "").toLowerCase();
      if (
        (!vintageStr || titleLower.includes(vintageStr)) &&
        (!producerLower || titleLower.includes(producerLower.split(" ")[0]))
      ) {
        return `https://sommselect.com${p.url}`;
      }
    }

    // Fallback: return first result if any match
    return products[0]?.url ? `https://sommselect.com${products[0].url}` : null;

  } catch {
    return null;
  }
}

// ── Strategy B: Direct slug fetch ────────────────────────────────────────────
async function trySlugUrl(wine: WineRow): Promise<string | null> {
  const slug = buildProbableSlug(wine);
  const url = `https://sommselect.com/products/${slug}`;

  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; personal-wine-scraper/1.0)" },
      redirect: "follow",
    });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

// ── Page fetcher & parser ─────────────────────────────────────────────────────
async function fetchAndParseNarrative(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) return null;
    const html = await res.text();

    // ── Extract narrative from Shopify product page ──────────────────────────
    // SommSelect puts the narrative in the product description div.
    // We extract text content from specific HTML patterns.
    const narrativeParts: string[] = [];

    // Pattern 1: JSON-LD product description
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
    if (jsonLdMatch) {
      for (const block of jsonLdMatch) {
        try {
          const json = JSON.parse(block.replace(/<script[^>]*>|<\/script>/g, ""));
          if (json["@type"] === "Product" && json.description) {
            narrativeParts.push(cleanHtml(json.description));
          }
        } catch { /* skip malformed */ }
      }
    }

    // Pattern 2: og:description meta tag (often contains the lede sentence)
    const ogDescMatch = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/);
    if (ogDescMatch) {
      const ogDesc = ogDescMatch[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      if (!narrativeParts.some(p => p.includes(ogDesc.substring(0, 50)))) {
        narrativeParts.push(ogDesc);
      }
    }

    // Pattern 3: product description div — look for the main content block
    // SommSelect uses class patterns like "product__description" or "rte"
    const descPatterns = [
      /class="[^"]*product[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /class="[^"]*rte[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /class="[^"]*product-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ];

    for (const pattern of descPatterns) {
      const match = html.match(pattern);
      if (match) {
        const cleaned = cleanHtml(match[1]);
        if (cleaned.length > 100 && !narrativeParts.some(p => p.includes(cleaned.substring(0, 50)))) {
          narrativeParts.push(cleaned);
        }
      }
    }

    // Pattern 4: Large text blocks between <p> tags in the product section
    // For pages where class names are minified/obfuscated
    if (narrativeParts.length === 0) {
      const pTags = html.match(/<p[^>]*>([\s\S]{100,1000}?)<\/p>/g) || [];
      for (const p of pTags.slice(0, 10)) {
        const text = cleanHtml(p);
        if (
          text.length > 100 &&
          !text.includes("©") &&
          !text.includes("cookie") &&
          !text.toLowerCase().includes("add to cart")
        ) {
          narrativeParts.push(text);
        }
      }
    }

    const combined = narrativeParts
      .filter(p => p.length > 50)
      .join("\n\n")
      .trim();

    return combined.length > 100 ? combined : null;

  } catch {
    return null;
  }
}

function cleanHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")           // strip tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")           // collapse whitespace
    .trim();
}

// ── Embedding helper ──────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-large",
      input: text,
      dimensions: 1536,
    }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

// ── Write back to Supabase ────────────────────────────────────────────────────
async function updateWineInventory(
  ctIwine: number,
  narrative: string,
  productUrl: string,
  embedding: number[],
): Promise<void> {
  const { error } = await supabase
    .from("wine_inventory")
    .update({
      sommselect_narrative:   narrative,
      sommselect_product_url: productUrl,
      narrative_status:       "found",
      embedding:              `[${embedding.join(",")}]`,
      last_synced_at:         new Date().toISOString(),
    })
    .eq("ct_iwine", ctIwine);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}

async function markNotFound(ctIwine: number): Promise<void> {
  await supabase
    .from("wine_inventory")
    .update({ narrative_status: "not_found" })
    .eq("ct_iwine", ctIwine);
}

// ── Build enriched embedding text ────────────────────────────────────────────
function buildEmbedText(wine: WineRow, narrative: string): string {
  return [
    wine.wine,
    wine.vintage ? `Vintage ${wine.vintage}` : null,
    wine.producer,
    wine.varietal,
    wine.region,
    wine.country,
    wine.location ? `Location: ${wine.location}` : null,
    wine.ct_score ? `CellarTracker score ${wine.ct_score}` : null,
    wine.my_notes ? `My tasting notes: ${wine.my_notes}` : null,
    `SommSelect: ${narrative}`,
  ].filter(Boolean).join(". ");
}

// ── Sleep ─────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  SommSelect Narrative Batch Scraper");
  console.log("═══════════════════════════════════════════════════\n");

  // Load resume log
  const log = await loadLog();

  // Fetch SommSelect wines from brain
  console.log("Fetching SommSelect wines from wine_inventory...");
  const wines = await getSommSelectWines();
  console.log(`  Found ${wines.length} unique SommSelect wines to process\n`);

  if (wines.length === 0) {
    console.log("No wines found. Make sure wine_inventory is populated and");
    console.log("sommselect_order_number is set on SommSelect-sourced rows.");
    console.log("\nAlternatively, set narrative_status = 'pending' on rows");
    console.log("you want to process and re-run.");
    Deno.exit(0);
  }

  const stats = { found: 0, not_found: 0, skipped: 0, errors: 0 };
  const notFoundList: string[] = [];

  for (let i = 0; i < wines.length; i++) {
    const wine = wines[i];
    const label = `[${i + 1}/${wines.length}] ${wine.vintage || ""} ${wine.wine}`.trim();

    // Skip if already successfully processed in a previous run
    const existing = log.get(wine.ct_ibottle);
    if (existing?.status === "found") {
      console.log(`  ⏭  SKIP  ${label}`);
      stats.skipped++;
      continue;
    }

    // Also skip if already in Supabase as found
    if (wine.narrative_status === "found" && wine.sommselect_product_url) {
      console.log(`  ⏭  SKIP  ${label} (already in DB)`);
      stats.skipped++;
      continue;
    }

    console.log(`\n  ⟳  ${label}`);
    process.stdout?.write?.("       Strategy A: Shopify search... ");

    let productUrl: string | null = null;
    let narrative: string | null = null;

    // Strategy A: Shopify search API
    productUrl = await searchShopify(wine);
    if (productUrl) {
      console.log(`found → ${productUrl}`);
      await sleep(500);
      narrative = await fetchAndParseNarrative(productUrl);
    } else {
      console.log("no match");
    }

    // Strategy B: Slug construction
    if (!narrative) {
      process.stdout?.write?.("       Strategy B: Slug URL... ");
      const slugUrl = await trySlugUrl(wine);
      if (slugUrl) {
        productUrl = slugUrl;
        console.log(`found → ${slugUrl}`);
        await sleep(500);
        narrative = await fetchAndParseNarrative(slugUrl);
      } else {
        console.log("404");
      }
    }

    // Evaluate result
    if (narrative && productUrl) {
      console.log(`       ✓ Narrative extracted (${narrative.length} chars)`);

      try {
        // Regenerate embedding with narrative included
        const embedText = buildEmbedText(wine, narrative);
        const embedding = await embed(embedText);

        // Write to Supabase (update all bottles with this ct_iwine)
        await updateWineInventory(wine.ct_iwine, narrative, productUrl, embedding);

        const result: ScrapeResult = {
          ct_ibottle: wine.ct_ibottle,
          ct_iwine: wine.ct_iwine,
          wine: wine.wine,
          vintage: wine.vintage,
          status: "found",
          url: productUrl,
          narrative: narrative.substring(0, 500), // truncate for log
          timestamp: new Date().toISOString(),
        };
        await appendLog(result);
        stats.found++;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`       ✗ Write failed: ${msg}`);
        stats.errors++;
      }

    } else {
      console.log(`       ✗ Not found — marking for Playwright fallback`);
      await markNotFound(wine.ct_iwine);
      notFoundList.push(`${wine.vintage || ""} ${wine.wine}`.trim());

      await appendLog({
        ct_ibottle: wine.ct_ibottle,
        ct_iwine: wine.ct_iwine,
        wine: wine.wine,
        vintage: wine.vintage,
        status: "not_found",
        timestamp: new Date().toISOString(),
      });
      stats.not_found++;
    }

    // Polite delay between wines
    if (i < wines.length - 1) await sleep(DELAY_MS);
  }

  // ── Write report ─────────────────────────────────────────────────────────
  const report = `# SommSelect Narrative Scrape Report
Generated: ${new Date().toISOString()}

## Summary
| Result     | Count |
|------------|-------|
| Found      | ${stats.found} |
| Not Found  | ${stats.not_found} |
| Skipped    | ${stats.skipped} |
| Errors     | ${stats.errors} |
| **Total**  | **${wines.length}** |

## Hit Rate
${Math.round((stats.found / (stats.found + stats.not_found || 1)) * 100)}% of processed wines found narrative pages

## Wines Not Found (need Playwright fallback)
${notFoundList.length === 0
  ? "_All wines found — no fallback needed_"
  : notFoundList.map(w => `- ${w}`).join("\n")}

## Next Steps
${notFoundList.length > 0
  ? `1. Run the Playwright authenticated scraper for the ${notFoundList.length} not-found wines\n2. The scraper will log into SommSelect and scrape order history pages`
  : "1. All narratives captured — no further action needed"}
2. Run the n8n workflow to embed SommSelect narratives for future purchases
3. Use \`search_wine\` MCP tool — queries now include SS narrative context
`;

  await Deno.writeTextFile(REPORT_FILE, report);

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Complete");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Found:     ${stats.found}`);
  console.log(`  Not found: ${stats.not_found}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log(`\n  Report written to: ${REPORT_FILE}`);
  console.log(`  Log written to:    ${LOG_FILE}`);

  if (notFoundList.length > 0) {
    console.log(`\n  ${notFoundList.length} wines need Playwright fallback.`);
    console.log("  Run: deno run --allow-net --allow-env --allow-read --allow-write --env-file=.env sommselect-playwright.ts");
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
