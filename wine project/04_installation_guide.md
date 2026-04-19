# Wine Inventory Sync — Installation Guide

This sets up a nightly automated sync from CellarTracker into your Supabase
brain database, with vector embeddings on every bottle for AI-powered search.

You will need about 30 minutes and the three files that came with this guide:

  01_wine_inventory_ddl.sql       — creates the database table
  03_soft_delete_function.sql     — creates a helper database function
  02_cellartracker_n8n_workflow.json  — the automation workflow

---

https://www.cellartracker.com/xlquery.asp?User=DaveInPA&Password=rosner9698&Format=csv&Table=Bottles&BottleState=1


## PART 1 — Set up the Supabase database (10 minutes)

These steps run two SQL files in your existing Supabase project (the same one
that powers dave-brain).

### Step 1 — Open Supabase

1. Go to https://supabase.com and sign in.
2. Click your dave-brain project.
3. In the left sidebar, click **SQL Editor**.

### Step 2 — Run the table DDL

1. Click **New query** (top left of the SQL editor).
2. Open the file **01_wine_inventory_ddl.sql** in any text editor
   (right-click → Open with → TextEdit / Notepad).
3. Select all the text (Cmd+A or Ctrl+A), copy it.
4. Paste it into the Supabase SQL editor.
5. Click the green **Run** button (or press Cmd+Enter / Ctrl+Enter).
6. You should see "Success. No rows returned" at the bottom.
   If you see an error, send it to Dave for review before continuing.

### Step 3 — Run the helper function

1. Click **New query** again.
2. Open **03_soft_delete_function.sql**, copy all text, paste into the editor.
3. Click **Run**.
4. You should again see "Success. No rows returned."

### Step 4 — Verify the table exists

1. In the left sidebar click **Table Editor**.
2. You should now see **wine_inventory** in the list of tables.
3. Click it — it will be empty for now. That is correct.

---

## PART 2 — Add credentials to n8n (10 minutes)

n8n needs to know your CellarTracker password and API keys so the workflow
can fetch data and write to Supabase. These are stored as secure environment
variables on your Raspberry Pi — they are never visible in the workflow itself.

### Step 5 — Find your Supabase keys

1. In Supabase, go to **Project Settings** (gear icon, bottom of left sidebar).
2. Click **API** in the settings menu.
3. You need two values — copy each one and paste into a temporary note:
   - **Project URL** — looks like `https://xxxxxxxxxx.supabase.co`
   - **service_role** key — the long string under "Project API keys",
     labelled "service_role". Click the eye icon to reveal it.
     ⚠️  This key has full database access — treat it like a password.

### Step 6 — Find your OpenRouter API key

1. Go to https://openrouter.ai and sign in.
2. Click your account icon (top right) → **API Keys**.
3. Copy your existing key, or click **Create Key** to make a new one
   labelled "n8n-wine-sync".

### Step 7 — SSH into the Raspberry Pi and add the variables

If you already have a terminal open on the Pi (or via Tailscale), run:

```
nano ~/n8n/.env
```

Add these lines at the bottom of the file (replace the placeholder values):

```
CT_USER=your_cellartracker_handle
CT_PASSWORD=your_cellartracker_password
SUPABASE_URL=https://xxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...your_service_role_key...
OPENROUTER_API_KEY=sk-or-...your_openrouter_key...
```

Save and exit: press **Ctrl+X**, then **Y**, then **Enter**.

Then restart n8n so it picks up the new variables:

```
cd ~/n8n && docker compose restart
```

Wait about 30 seconds for n8n to come back up.

---

## PART 3 — Import and activate the workflow (10 minutes)

### Step 8 — Open n8n

Open your browser and go to your n8n instance.
(Typically http://raspberrypi.local:5678 or your Tailscale address.)

### Step 9 — Import the workflow

1. In n8n, click **Workflows** in the left sidebar.
2. Click the **+** button (top right) → **Import from file**.
3. Choose the file **02_cellartracker_n8n_workflow.json**.
4. The workflow will open showing a chain of connected nodes.

### Step 10 — Run a test

Before activating the nightly schedule, run it once manually to verify
everything works.

1. Click the **Test workflow** button (▶ triangle, top right area).
2. Watch the nodes light up one by one as they execute.
3. The run will take 3–10 minutes depending on how many bottles are in
   your cellar (each bottle gets an embedding call to OpenRouter).
4. When complete, all nodes should show a green checkmark.
   If any node shows a red X, click it to see the error message.

### Step 11 — Verify data arrived in Supabase

1. Go back to Supabase → **Table Editor** → **wine_inventory**.
2. You should now see rows — one per bottle in your cellar.
3. Spot-check a few rows to confirm wine names, vintages, and locations
   look correct.
4. The **embedding** column will show a long array of numbers — that is normal.

### Step 12 — Activate the nightly schedule

1. Back in n8n, with the workflow open, toggle the **Active** switch
   (top right of the workflow editor) to ON.
2. The workflow will now run automatically every night at 10pm.

---

## What happens each night

1. n8n fetches your full in-stock bottle list from CellarTracker.
2. n8n fetches your tasting notes and merges them onto each bottle.
3. Each bottle gets a vector embedding (a numerical fingerprint of the wine's
   description + your notes) via OpenRouter.
4. Each bottle is upserted into Supabase — new bottles are added, existing
   bottles are updated with any changes.
5. Bottles that have disappeared from CellarTracker (consumed or sold) get a
   "removed_at" timestamp rather than being deleted — history is preserved.
6. A log entry is written to your brain confirming the sync completed.

---

## Troubleshooting

**Node turns red on "Fetch CT Bottles"**
→ CellarTracker credentials are wrong. Double-check CT_USER and CT_PASSWORD
  in the .env file. Your CT handle is shown in the top-right of the CT website
  when logged in.

**Node turns red on "OpenRouter Embedding"**
→ OPENROUTER_API_KEY is wrong or has no credits. Check https://openrouter.ai
  to confirm the key is active and has a balance.

**Node turns red on "Upsert → Supabase"**
→ Either SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is wrong, or the DDL in
  Part 1 was not run successfully. Re-run the SQL files and try again.

**"Success. No rows returned" changed to an error when running SQL**
→ Copy the exact error text and send to Dave — do not try to fix SQL manually.

**Workflow ran but wine_inventory table is still empty**
→ The parse step may have found no data. Open the "Parse CSV + Merge Notes"
  node after a test run, click "Output", and check whether any items appear.
  If zero items, CellarTracker returned an empty or malformed file.

---

## Ongoing maintenance

- The workflow runs itself nightly — no action needed.
- If you change your CellarTracker password, update CT_PASSWORD in the .env
  file and restart Docker as in Step 7.
- If you see a sync log in your brain each morning, everything is working.
