# Wine Brain — Master Project Summary & Todo
*Generated April 19, 2026*

---

## What We Are Building

A personal wine intelligence system fully integrated into your dave-brain
architecture. It has three interconnected layers:

**Layer 1 — Inventory Sync**
Your CellarTracker cellar syncs nightly into a Supabase table
(`wine_inventory`) with structured data and vector embeddings. Every bottle
is searchable by natural language via MCP tools connected to Claude.

**Layer 2 — Preference Learning**
Two additional tables (`wine_reactions`, `wine_preferences`) capture your
tasting experiences and build a preference profile over time. Purchase patterns
are inferred automatically. Explicit preferences can be stated conversationally.

**Layer 3 — SommSelect Narrative Enrichment**
SommSelect's sommelier-written producer narratives are scraped and stored
alongside each wine. This dramatically enriches the semantic search — queries
like "something volcanic and structured" or "aged like Nebbiolo but not
Piedmont" work because the narrative vocabulary is embedded.

**End state:** Claude can answer "what should I open Saturday for a dinner
party?" by cross-referencing your inventory, drinking windows, past reactions,
stated preferences, and SommSelect narratives — all in one query.

---

## Files Produced in This Project

### Database (SQL)
| File | Purpose |
|------|---------|
| `01_schema.sql` | Creates wine_inventory, wine_reactions, wine_preferences tables + views |
| `02_functions.sql` | Postgres RPC functions: search, soft-delete, preference inference, cellar summary |
| `sommselect-migration.sql` | Adds sommselect_narrative, sommselect_product_url, narrative_status columns |

### n8n Workflow
| File | Purpose |
|------|---------|
| `03_n8n_workflow.json` | Nightly CellarTracker sync: fetch → parse → embed → upsert → soft-delete → infer preferences |

### MCP Edge Function
| File | Purpose |
|------|---------|
| `04_wine_brain_mcp_index.ts` | 8 MCP tools: search_wine, list_cellar, cellar_summary, what_to_drink, log_wine_reaction, set_wine_preference, get_my_preferences, recommend_wine |

### SommSelect Batch Scraper
| File | Purpose |
|------|---------|
| `sommselect-scrape.ts` | Phase 1: public URL scraper — finds narratives via Shopify search + slug |
| `sommselect-playwright.ts` | Phase 2: authenticated fallback — logs in, indexes order history, scrapes remaining |

---

## TODO LIST

---

### OBJECTIVE 1 — Database Setup
**Time: ~10 minutes**
**Where: Supabase SQL Editor or Supabase CLI**

The right long-term approach is the Supabase CLI so all schema changes are
version-controlled. Do this once and all future changes use `supabase db push`.

#### Steps

**1a. Set up migration files in your repo**

SSH into your Pi, navigate to dave-brain repo, run this script:

```bash
cd ~/dave-brain
mkdir -p supabase/migrations

BASE=$(date +%Y%m%d)000

cp ~/path/to/01_schema.sql             supabase/migrations/${BASE}001_wine_schema.sql
cp ~/path/to/02_functions.sql          supabase/migrations/${BASE}002_wine_functions.sql
cp ~/path/to/sommselect-migration.sql  supabase/migrations/${BASE}003_sommselect_migration.sql

ls supabase/migrations/${BASE}*
```

**1b. Push migrations to Supabase**

```bash
# Link to your project (one-time if not already done)
supabase link --project-ref zujvqteqcusephuwuqhe

# Run all migrations
supabase db push
```

**1c. Verify in Supabase**

Go to supabase.com → your project → Table Editor.
Confirm these tables exist:
- `wine_inventory`
- `wine_reactions`
- `wine_preferences`

And that `wine_inventory` has these columns:
- `sommselect_narrative`
- `sommselect_product_url`
- `narrative_status`

---

### OBJECTIVE 2 — Nightly CellarTracker Sync (n8n)
**Time: ~15 minutes**
**Where: Raspberry Pi .env file + n8n browser UI**

Syncs your full CellarTracker bottle inventory every night at 10pm. Generates
vector embeddings via OpenRouter. Soft-deletes consumed bottles. Infers
preferences from purchase patterns.

#### Steps

**2a. Add environment variables to Pi**

```bash
nano ~/n8n/.env
```

Add at the bottom (replace placeholder values):
```
CT_USER=your_cellartracker_handle
CT_PASSWORD=your_cellartracker_password
SUPABASE_URL=https://zujvqteqcusephuwuqhe.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...your_service_role_key
OPENROUTER_API_KEY=sk-or-...your_openrouter_key
```

Save: Ctrl+X → Y → Enter

Restart n8n:
```bash
cd ~/n8n && docker compose restart
```

Wait 30 seconds.

**2b. Import workflow into n8n**

1. Open n8n (http://raspberrypi.local:5678 or Tailscale address)
2. Workflows → + → Import from file
3. Select `03_n8n_workflow.json`

**2c. Run manual test**

1. Click Test workflow (▶ triangle)
2. Wait 5–15 minutes (one embedding call per bottle)
3. All nodes should show green checkmarks

**2d. Verify data in Supabase**

Go to Supabase → Table Editor → `wine_inventory`
Confirm rows are present with wine names, vintages, locations.
Check `wine_preferences` — should have rows inferred from purchases.

**2e. Activate schedule**

Toggle Active switch ON in n8n. Runs nightly at 10pm.

#### What the workflow does each night
1. Fetches all in-stock bottles from CellarTracker (`Table=Bottles&BottleState=1`)
2. Fetches your tasting notes (`Table=Notes`) and merges onto each bottle
3. Generates a vector embedding per bottle via OpenRouter (`text-embedding-3-large`)
4. Upserts each bottle into `wine_inventory` (new bottles added, existing updated)
5. Soft-deletes any bottle no longer in CT export (stamps `removed_at`)
6. Runs `infer_preferences_from_purchases()` — writes purchase-pattern preferences
7. Logs sync completion to dave-brain

---

### OBJECTIVE 3 — Wine MCP Tools (Edge Function)
**Time: ~15 minutes**
**Where: dave-brain repo + Supabase CLI + Claude settings**

Deploys 8 MCP tools to a new Supabase Edge Function `wine-brain-mcp`.
Connects to Claude so you can query your cellar conversationally.

#### Steps

**3a. Create the Edge Function folder**

```bash
cd ~/dave-brain
mkdir -p supabase/functions/wine-brain-mcp
cp ~/path/to/04_wine_brain_mcp_index.ts supabase/functions/wine-brain-mcp/index.ts
```

**3b. Set Edge Function secrets**

Choose a strong access key (e.g. `wine-brain-2026-xk9q`) and save it —
you'll need it in Step 3d.

```bash
supabase secrets set OPENROUTER_API_KEY=sk-or-your-key-here
supabase secrets set MCP_ACCESS_KEY=your-chosen-access-key
```

**3c. Deploy**

```bash
supabase functions deploy wine-brain-mcp
```

You should see: "Deployed successfully."

Your function URL:
`https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/wine-brain-mcp`

**3d. Connect to Claude**

1. Claude.ai → Settings → Connectors (or MCP Servers)
2. Add new MCP server:
   - URL: `https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/wine-brain-mcp`
   - Auth: Bearer `your-chosen-access-key`
3. Save

#### The 8 tools available after setup
| Tool | What it does |
|------|-------------|
| `search_wine` | Semantic search: "earthy Oregon Pinot", "structured Barolo" |
| `list_cellar` | Structured filters: type, region, location, vintage range |
| `cellar_summary` | Stats: total bottles, valuation, by-type/location breakdown |
| `what_to_drink` | Bottles in current drinking window, ordered by urgency |
| `log_wine_reaction` | Capture a tasting experience — builds preference profile |
| `set_wine_preference` | Explicit preference: "I love Jura", "avoid oaked Chardonnay" |
| `get_my_preferences` | View full preference profile |
| `recommend_wine` | AI recommendation using inventory + reactions + preferences |

#### Example conversations after setup
```
"What Walter Scott wines do I have in the Left Bottom?"
"What needs to be drunk in the next two years?"
"I just opened the 2019 Justice — incredible, dark fruit, long finish, 95 points"
"Based on what I drink, suggest new producers to try in Burgundy"
"Something for Saturday dinner, six guests, serving lamb"
```

---

### OBJECTIVE 4 — SommSelect Narrative Backfill (One-Time)
**Time: 20–60 minutes depending on cellar size**
**Where: Raspberry Pi terminal**

One-time batch process to scrape SommSelect's sommelier narratives for every
SommSelect wine in your inventory. Runs in two phases. After this, the nightly
n8n workflow handles new purchases automatically.

#### Steps

**4a. Seed inventory rows for scraping**

In Supabase SQL Editor, run:
```sql
UPDATE wine_inventory SET narrative_status = 'pending' WHERE removed_at IS NULL;
```

This tells the scraper to try every wine. Non-SommSelect wines will return
not_found gracefully.

**4b. Add SommSelect credentials to .env**

```bash
nano ~/dave-brain/.env
```

Add:
```
SS_EMAIL=your-sommselect-login-email
SS_PASSWORD=your-sommselect-password
```

Save: Ctrl+X → Y → Enter

**4c. Copy scripts to Pi**

```bash
# From your local machine
scp sommselect-scrape.ts pi@raspberrypi.local:~/dave-brain/scripts/
scp sommselect-playwright.ts pi@raspberrypi.local:~/dave-brain/scripts/
```

**4d. Run Phase 1 — public URL scraper**

```bash
cd ~/dave-brain/scripts

deno run \
  --allow-net \
  --allow-env \
  --allow-read \
  --allow-write \
  --env-file=../.env \
  sommselect-scrape.ts
```

- Tries Shopify search API then slug construction per wine
- 2-second delay between requests (~15 min for 300 wines)
- Fully resumable — re-run safely if interrupted
- Progress log: `scrape-log.jsonl`
- Results: `scrape-report.md`

Expected hit rate: 60–80% of wines found (higher for recent purchases).

**4e. Run Phase 2 — authenticated fallback (if Phase 1 left not_found wines)**

Install Chromium if not present:
```bash
sudo apt update && sudo apt install -y chromium-browser
```

Run:
```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
deno run \
  --allow-net \
  --allow-env \
  --allow-read \
  --allow-write \
  --allow-run \
  --env-file=../.env \
  sommselect-playwright.ts
```

- Logs into SommSelect once, session persists for entire run
- Indexes your full order history (all pages)
- Matches remaining wines to product URLs via fuzzy name matching
- Results: `scrape-report-playwright.md`

**4f. Verify in Supabase**

Go to Table Editor → `wine_inventory`.
Filter by `narrative_status = 'found'` — should show most of your cellar.
Click a row and confirm `sommselect_narrative` has real prose text.

---

### OBJECTIVE 5 — Ongoing Usage (No Setup Required)
**Time: Continuous**

Once Objectives 1–4 are complete, the system runs itself. Here's the
day-to-day usage pattern:

**Nightly (automatic):** n8n syncs CellarTracker at 10pm, updates inventory,
infers preferences. You see a log entry in dave-brain each morning.

**When you drink a wine:** Tell Claude:
> "I just opened the 2018 Walter Scott Koosah — beautiful tension, red
> fruit, earthy, long finish. Paired with salmon. 93 points."

Claude logs the reaction, extracts flavor/style tags, infers preferences,
updates your preference profile.

**When you want a recommendation:**
> "What should I open Saturday? Dinner party, 6 guests, serving duck confit."

Claude queries inventory (drinking window, location), reactions (past
experience with similar occasions), preferences (your known style signals),
and synthesizes a ranked recommendation with reasoning.

**When you want to explore new wines:**
> "Based on my palate, what producers should I be looking at from the
> 2022 Willamette Valley vintage?"

Claude uses your preference profile as context and reasons from there.

---

## Preference Learning — How It Works

Your preference profile (`wine_preferences` table) is built from three sources:

| Source | Confidence | How |
|--------|-----------|-----|
| Stated ("I love Barolo") | 1.0 | `set_wine_preference` MCP tool |
| Reactions ("loved" a wine) | 0.7 | `log_wine_reaction` auto-infers |
| Purchase patterns | 0.4–0.75 | Nightly n8n inference from inventory |

Stated preferences always win. The system never contradicts what you explicitly tell it.

---

## Architecture Summary

```
CellarTracker ──────── n8n (nightly) ──────────────────────────┐
                                                                 ▼
SommSelect ─── Deno scraper (one-time) ──────► wine_inventory (Supabase + pgvector)
                                                       │
Tasting reactions ── MCP log_wine_reaction ──► wine_reactions
                                                       │
Stated preferences ── MCP set_preference ──► wine_preferences
                                                       │
                              wine-brain-mcp Edge Function
                                                       │
                                                   Claude
                                        (search, recommend, advise)
```

---

## Quick Reference — Environment Variables Needed

| Variable | Where used | Where to get it |
|----------|-----------|----------------|
| `CT_USER` | n8n | Your CellarTracker handle (top-right when logged in) |
| `CT_PASSWORD` | n8n | Your CellarTracker password |
| `SUPABASE_URL` | n8n, Deno scripts | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | n8n, Deno scripts | Supabase → Project Settings → API |
| `OPENROUTER_API_KEY` | n8n, Edge Function, Deno scripts | openrouter.ai → API Keys |
| `MCP_ACCESS_KEY` | Edge Function, Claude settings | You choose — any strong string |
| `SS_EMAIL` | Playwright script only | Your SommSelect login email |
| `SS_PASSWORD` | Playwright script only | Your SommSelect password |
