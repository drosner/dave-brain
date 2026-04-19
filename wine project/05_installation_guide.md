# Wine Brain — Complete Installation Guide
# CellarTracker + Wine Reactions + AI Recommendations

This guide installs the complete wine intelligence system in your dave-brain.
When done you will have:
  • Nightly automatic sync of your CellarTracker cellar into Supabase
  • A preference profile that learns from what you buy and what you drink
  • MCP tools so Claude can answer "what should I open tonight?" and
    "find me new wines that match my palate"

Total time: approximately 45 minutes.

Files included (run/install in this order):
  01_schema.sql               — database tables and views
  02_functions.sql            — database helper functions
  03_n8n_workflow.json        — nightly sync automation
  04_wine_brain_mcp_index.ts  — MCP tools Edge Function

═══════════════════════════════════════════════════════════════
PART 1 — DATABASE SETUP  (15 minutes)
Run two SQL files in your Supabase project.
═══════════════════════════════════════════════════════════════

STEP 1 — Open your Supabase project
  1. Go to https://supabase.com and sign in.
  2. Click your dave-brain project.
  3. In the left sidebar click "SQL Editor".

STEP 2 — Run the schema file
  1. Click "New query" (top left of SQL editor).
  2. Open 01_schema.sql in any text editor.
  3. Select all (Cmd+A / Ctrl+A), copy, paste into the SQL editor.
  4. Click the green Run button.
  5. You should see: "Success. No rows returned."
  If you see an error, stop and send the error text before continuing.

STEP 3 — Run the functions file
  1. Click "New query" again.
  2. Open 02_functions.sql, copy all, paste into editor.
  3. Click Run.
  4. You should see: "Success. No rows returned."

STEP 4 — Confirm tables were created
  1. In the left sidebar click "Table Editor".
  2. You should see three new tables:
       wine_inventory      — your cellar bottles (populated by n8n nightly)
       wine_reactions      — your tasting experiences (populated via MCP tool)
       wine_preferences    — your preference profile (auto-built over time)
  3. All three will be empty — that is correct.


═══════════════════════════════════════════════════════════════
PART 2 — DEPLOY THE MCP EDGE FUNCTION  (15 minutes)
This adds wine tools to your brain accessible from Claude.
═══════════════════════════════════════════════════════════════

STEP 5 — Get your brain repo on your computer
  If you don't already have the dave-brain repo checked out locally:
    - Open Terminal (Mac) or PowerShell (Windows)
    - Run: git clone https://github.com/drosner/dave-brain
    - Run: cd dave-brain

STEP 6 — Create the new Edge Function folder
  In Terminal, from inside the dave-brain folder, run:
    mkdir -p supabase/functions/wine-brain-mcp

STEP 7 — Copy the MCP file into place
  Copy 04_wine_brain_mcp_index.ts into the folder you just created
  and rename it to index.ts:

  Mac/Linux:
    cp /path/to/04_wine_brain_mcp_index.ts supabase/functions/wine-brain-mcp/index.ts

  Windows (PowerShell):
    Copy-Item "C:\path\to\04_wine_brain_mcp_index.ts" "supabase\functions\wine-brain-mcp\index.ts"

STEP 8 — Install Supabase CLI (if not already installed)
  Mac:   brew install supabase/tap/supabase
  Other: https://supabase.com/docs/guides/cli/getting-started

  Confirm it works: supabase --version

STEP 9 — Log in and link your project
  Run: supabase login
  (This opens a browser to authenticate — click Allow)

  Then link to your project. You need your Project Reference ID,
  which you find in Supabase → Project Settings → General.
  It looks like: abcdefghijklmnop (a 20-character string)

  Run: supabase link --project-ref YOUR_PROJECT_REF_ID

STEP 10 — Set the Edge Function secrets
  The function needs your OpenRouter key and a secure access key.
  For MCP_ACCESS_KEY, make up any long random string (e.g. wine-brain-2026-xk9q)
  and save it somewhere — you'll need it when connecting Claude.

  Run these commands one at a time:
    supabase secrets set OPENROUTER_API_KEY=sk-or-your-key-here
    supabase secrets set MCP_ACCESS_KEY=your-chosen-access-key-here

  Note: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are automatically
  available inside Edge Functions — you don't need to set them.

STEP 11 — Deploy the function
  Run: supabase functions deploy wine-brain-mcp

  You should see: "Deployed successfully."

  Your function URL will be:
    https://YOUR_PROJECT_REF.supabase.co/functions/v1/wine-brain-mcp

STEP 12 — Test the deployment
  In your browser, open:
    https://YOUR_PROJECT_REF.supabase.co/functions/v1/wine-brain-mcp

  You will get a 401 Unauthorized — that is correct and confirms it deployed.
  (It requires the auth header which the browser doesn't send.)

STEP 13 — Add wine-brain-mcp to Claude
  1. In Claude.ai, go to Settings → Connectors (or MCP Servers).
  2. Add a new MCP server:
       URL:  https://YOUR_PROJECT_REF.supabase.co/functions/v1/wine-brain-mcp
       Auth: Bearer YOUR_MCP_ACCESS_KEY
  3. Save. Claude will now have access to all eight wine tools.


═══════════════════════════════════════════════════════════════
PART 3 — SET UP NIGHTLY SYNC IN N8N  (15 minutes)
═══════════════════════════════════════════════════════════════

STEP 14 — Add credentials to your Pi
  SSH into the Pi (or open a terminal if you're on it directly).
  Open the n8n environment file:
    nano ~/n8n/.env

  Add these lines at the bottom (replace placeholder values):
    CT_USER=your_cellartracker_handle
    CT_PASSWORD=your_cellartracker_password
    SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=eyJ...your_service_role_key
    OPENROUTER_API_KEY=sk-or-your-openrouter-key

  Your CellarTracker handle is shown top-right when logged in to CT.
  Your Supabase keys are in Supabase → Project Settings → API.
  The service_role key is the longer one — click the eye to reveal it.

  Save: Ctrl+X, then Y, then Enter.

  Restart n8n to pick up the new variables:
    cd ~/n8n && docker compose restart

  Wait 30 seconds.

STEP 15 — Import the workflow
  1. Open n8n in your browser (http://raspberrypi.local:5678 or Tailscale address).
  2. Click "Workflows" in the left sidebar.
  3. Click the + button → "Import from file".
  4. Select 03_n8n_workflow.json.
  5. The workflow opens showing a chain of connected nodes.

STEP 16 — Run first test
  Before activating the schedule, run it manually once:
  1. Click the "Test workflow" button (▶ triangle, top right).
  2. Watch nodes light up in sequence. This will take 5–15 minutes
     depending on how many bottles are in your cellar.
  3. All nodes should show green checkmarks when done.

STEP 17 — Verify data in Supabase
  1. Go to Supabase → Table Editor → wine_inventory.
  2. You should see rows — one per bottle in your CT cellar.
  3. Check that wine names, vintages, and locations look correct.
  4. Go to wine_preferences — you should see rows populated by
     the purchase inference step (regions, producers, varietals).

STEP 18 — Activate the schedule
  In n8n, toggle the Active switch (top right) to ON.
  The workflow will now run every night at 10pm automatically.


═══════════════════════════════════════════════════════════════
PART 4 — USING THE WINE TOOLS WITH CLAUDE  (ongoing)
═══════════════════════════════════════════════════════════════

Once connected, you can talk to Claude naturally:

  SEARCHING YOUR CELLAR
  "What Walter Scott wines do I have?"
  "Show me all my Barolos in their drinking window"
  "What's in the Fridge-57?"
  "Find something earthy from France under $60"

  DRINKING WINDOW
  "What should I open this weekend?"
  "What needs to be drunk in the next two years?"
  "Suggest a red for tonight with lamb"

  LOGGING A REACTION (builds your preference profile)
  "I just opened the 2019 Walter Scott Justice — incredible dark fruit,
   iron, long finish. Probably a 95. Paired with duck confit."

  STATING PREFERENCES
  "Remember that I've gone off heavily oaked Chardonnay"
  "I'm really into Jura wines lately — seeking more"
  "Add that I strongly prefer structured Nebbiolo"

  GETTING RECOMMENDATIONS
  "Based on what I drink and buy, suggest some new producers I should try"
  "I'm hosting a dinner party Saturday — 6 guests, serving beef short ribs.
   What should I open from the cellar?"
  "I want to buy a case of something new. Based on my palate, what should
   I be looking at from the 2022 vintage?"

  CELLAR OVERVIEW
  "Give me a summary of my cellar"
  "How many bottles do I have and what's the total valuation?"
  "What are my strongest preferences based on what I buy?"


═══════════════════════════════════════════════════════════════
TROUBLESHOOTING
═══════════════════════════════════════════════════════════════

SQL errors during Part 1
  → Copy the exact error and review before re-running.
  → Most common cause: running functions file before schema file.
  → Fix: run 01_schema.sql first, then 02_functions.sql.

"supabase: command not found" in Step 8
  → CLI not installed. Follow the link in Step 8 for your OS.

"Project not linked" error in Step 9
  → Run: supabase link --project-ref YOUR_PROJECT_REF_ID
  → Project ref is in Supabase → Project Settings → General.

Edge Function returns 500 on first call
  → Most likely cause: secrets not set correctly.
  → Re-run the supabase secrets set commands in Step 10.
  → Then redeploy: supabase functions deploy wine-brain-mcp

n8n node "Fetch CT Bottles" turns red
  → CT_USER or CT_PASSWORD wrong in .env
  → Your CT handle is shown top-right of cellartracker.com when logged in.

n8n "OpenRouter Embedding" node turns red
  → OPENROUTER_API_KEY wrong or has no credits.
  → Check https://openrouter.ai for key status and balance.

wine_preferences table is empty after first n8n run
  → Normal if cellar is small. The inference rules require:
     3+ bottles from a region at avg >$40 purchase price
     4+ bottles from a producer
     6+ bottles of a varietal
  → Your collection should populate this — if still empty after
     first run, open the "Infer Preferences from Purchases" node
     in n8n and check the response body for a SQL error.

Claude doesn't see the wine tools
  → Confirm the MCP server URL and Bearer token in Claude Settings.
  → The URL must be exact: https://PROJECT_REF.supabase.co/functions/v1/wine-brain-mcp
  → The Bearer token must match what you set as MCP_ACCESS_KEY.


═══════════════════════════════════════════════════════════════
HOW THE PREFERENCE LEARNING WORKS
═══════════════════════════════════════════════════════════════

Your preference profile is built from three sources, each with
a confidence score:

  confidence 1.0 — Things you explicitly told Claude
                   ("I love structured Barolos")
                   Source: stated

  confidence 0.7 — Inferences from strong reactions
                   (You logged "loved" → Walter Scott → producer
                    preference written automatically)
                   Source: inferred_from_reactions

  confidence 0.4–0.75 — Inferences from what you buy
                   (You own 18 bottles from Willamette Valley →
                    positive region preference inferred)
                   Source: inferred_from_purchases

Over time as you log reactions, the reaction-based signals
strengthen and the purchase-based signals get corroborated.
Claude uses all three layers together when making recommendations.
