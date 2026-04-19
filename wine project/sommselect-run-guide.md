# SommSelect Narrative Batch Scraper — Run Guide

This is a one-time process. Run it once to backfill narrative pages for all
your SommSelect wines. After this, the nightly n8n workflow handles new purchases.

Files:
  sommselect-migration.sql   — add columns to wine_inventory (run first)
  sommselect-scrape.ts       — Phase 1: public URL scraper (run second)
  sommselect-playwright.ts   — Phase 2: authenticated fallback (run if needed)

───────────────────────────────────────────────────────────────
STEP 1 — Run the database migration  (2 minutes)
───────────────────────────────────────────────────────────────

1. Open Supabase → SQL Editor → New query
2. Open sommselect-migration.sql, copy all, paste, click Run
3. You should see "Success. No rows returned."

───────────────────────────────────────────────────────────────
STEP 2 — Seed SommSelect order numbers on your inventory
         (skip if wine_inventory already has sommselect_order_number set)
───────────────────────────────────────────────────────────────

The scraper finds SommSelect wines by looking for rows where
sommselect_order_number IS NOT NULL or narrative_status = 'pending'.

If your wine_inventory was populated from CellarTracker (no SS order
numbers yet), run this SQL to mark all rows as pending so the scraper
processes them all:

  UPDATE wine_inventory SET narrative_status = 'pending'
  WHERE removed_at IS NULL;

The scraper will try to find each wine on SommSelect by name. Wines
not from SommSelect will simply return not_found and be skipped gracefully.

───────────────────────────────────────────────────────────────
STEP 3 — Add credentials to your .env file on the Pi
───────────────────────────────────────────────────────────────

SSH into your Pi. Open ~/dave-brain/.env (or wherever you keep your env):

  nano ~/dave-brain/.env

Add these two lines (your SommSelect login credentials):

  SS_EMAIL=your-sommselect-email@gmail.com
  SS_PASSWORD=your-sommselect-password

The other variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
OPENROUTER_API_KEY) should already be in your .env from the main
wine brain setup.

Save: Ctrl+X, Y, Enter.

───────────────────────────────────────────────────────────────
STEP 4 — Copy the scripts to your Pi
───────────────────────────────────────────────────────────────

Copy sommselect-scrape.ts and sommselect-playwright.ts to your Pi.
If you use the dave-brain repo folder:

  scp sommselect-scrape.ts pi@raspberrypi.local:~/dave-brain/scripts/
  scp sommselect-playwright.ts pi@raspberrypi.local:~/dave-brain/scripts/

Or copy the files however you normally transfer files to the Pi
(Tailscale file sharing, USB drive, etc.)

───────────────────────────────────────────────────────────────
STEP 5 — Run Phase 1: Public URL scraper
───────────────────────────────────────────────────────────────

SSH into the Pi, navigate to the scripts folder:

  cd ~/dave-brain/scripts

Run the scraper:

  deno run \
    --allow-net \
    --allow-env \
    --allow-read \
    --allow-write \
    --env-file=../.env \
    sommselect-scrape.ts

What you'll see:
  - A list of wines being processed, one at a time
  - Each wine tries Strategy A (Shopify search) then Strategy B (slug URL)
  - ✓ means the narrative was found and written to Supabase
  - ✗ means it will be handled by Phase 2

This will take roughly 3-5 minutes per 100 wines due to the 2-second
polite delay between requests. A 300-bottle SommSelect history = ~15 min.

The script is RESUMABLE. If it stops for any reason, just run it again.
It reads scrape-log.jsonl and skips wines already successfully processed.

When done:
  - Check scrape-report.md for the hit rate and not-found list
  - Expected: 60-80% found via public URLs (more recent = higher hit rate)

───────────────────────────────────────────────────────────────
STEP 6 — Run Phase 2: Playwright authenticated scraper
         (only if Phase 1 left wines not_found)
───────────────────────────────────────────────────────────────

Phase 2 requires Puppeteer/Chromium. Install it first:

  # Install Chromium on the Pi (if not already installed)
  sudo apt update && sudo apt install -y chromium-browser

  # Tell Puppeteer to use system Chromium
  export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

Then run:

  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
  deno run \
    --allow-net \
    --allow-env \
    --allow-read \
    --allow-write \
    --allow-run \
    --env-file=../.env \
    sommselect-playwright.ts

What this does:
  - Launches headless Chromium
  - Logs into SommSelect with your credentials
  - Iterates through your full order history (all pages)
  - Builds an index of product URLs from your orders
  - Matches not-found wines to product URLs via fuzzy name matching
  - Fetches and parses each narrative
  - Updates Supabase

This will take 10-30 minutes depending on how many orders you have
and how many wines are in the not-found list.

When done:
  - Check scrape-report-playwright.md for results

───────────────────────────────────────────────────────────────
WHAT HAPPENS IN SUPABASE
───────────────────────────────────────────────────────────────

After both phases, wine_inventory will have:

  sommselect_narrative    — the full producer story + tasting notes + 
                            serving guidance from SommSelect
  sommselect_product_url  — the canonical SommSelect product page URL
  narrative_status        — 'found' or 'not_found'
  embedding               — regenerated vector that NOW INCLUDES the
                            SommSelect narrative in the embedding text

This means semantic searches via the MCP tool will use the richer
narrative context. "Find me something earthy and volcanic from Sicily"
will now match the Calabretta Nerello Mascalese because the narrative
says "active volcano", "volcanic soils", "sandy pumice" — language
that wasn't in the CellarTracker data at all.

───────────────────────────────────────────────────────────────
TROUBLESHOOTING
───────────────────────────────────────────────────────────────

"No wines found" when running Phase 1
  → wine_inventory is empty or has no SommSelect-flagged rows
  → Run the seed SQL in Step 2 to mark all rows as pending

"Login failed" in Phase 2
  → Check SS_EMAIL and SS_PASSWORD in your .env
  → Verify you can log in manually at sommselect.com with those credentials

Phase 1 hit rate is very low (< 30%)
  → Most of your SommSelect purchases are older and pages are delisted
  → Run Phase 2 — the authenticated order history scraper will find them

Deno "Permission denied" error
  → Make sure you included all --allow-* flags listed in the run commands above

Puppeteer install fails on Pi
  → Use system Chromium: sudo apt install chromium-browser
  → Set PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser before running
