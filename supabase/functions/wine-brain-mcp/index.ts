

04_wine_brain_mcp_index.ts
ts


05_installation_guide.md
288 lines

md

we are building a new thing that allows us to store and access and manage my wine inventory using my brain.see the attached installation guide and i just completed deploying the MCP tools.What is the next step to do?

  3 :00 PM
Based on the installation guide, you just completed Part 2(deploying the MCP Edge Function).The next step is Part 3 — Set Up Nightly Sync in n8n, starting with Step 14.

Here's what you need to do:

Step 14 — Add credentials to your Pi

SSH into the Pi and edit your n8n environment file:

bash
nano ~/n8n/.env
Add these lines(you'll need to fill in the actual values):

CT_USER = your_cellartracker_handle
CT_PASSWORD = your_cellartracker_password
SUPABASE_URL = https://zujvqteqcusephuwuqhe.supabase.co
  SUPABASE_SERVICE_ROLE_KEY = eyJ...your_service_role_key
OPENROUTER_API_KEY = sk - or - your - openrouter - key
A few notes specific to your setup:

  Your Supabase project ref is zujvqteqcusephuwuqhe(already know this)
Your CellarTracker handle is shown top - right when logged into CT
Your Supabase service role key is in Project Settings → API(the longer key)
After saving, restart n8n: cd ~/n8n && docker compose restart, then wait 30 seconds
One heads - up: I have a note flagging that your Supabase service role key and OpenRouter key were accidentally exposed in chat earlier today — you should rotate both before entering them here if you haven't already:

Supabase: Project Settings → API → regenerate service role key
OpenRouter: openrouter.ai / keys → revoke and create new key
Once that's done, proceed to Step 15 — importing 03_n8n_workflow.json into n8n. Do you have that file ready?

i've got the n8n nightly workflow running that will sync the CT inventory with my wine brain. What is next

3:01 PM
Part 3 is done — you're ready for Part 4, but there's one prerequisite first.

Before you can use the wine tools with Claude, you need to connect the wine - brain - mcp server to Claude(Step 13 from Part 2, which you may have skipped since you were focused on deployment).

  Step 13 — Add wine - brain - mcp to Claude

In Claude.ai, go to Settings → Connectors
Add a new MCP server:
URL: https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/wine-brain-mcp
Auth: Bearer + whatever you set as MCP_ACCESS_KEY in Step 10
Save
Once connected, you can verify it's working by asking me something like:

"Give me a summary of my cellar"

or

"What Walter Scott wines do I have?"

If the tools are live, I'll be able to query your inventory directly. If you get an error, the most likely culprits are the Bearer token not matching your MCP_ACCESS_KEY, or the secrets not having been set correctly in Step 10 — both are easy fixes.

Do you have the MCP_ACCESS_KEY you set handy ?

  summarize all the Walter SCott wines i have

3:01 PM

Used Wine Brain integration, loaded tools
Used Wine Brain integration, loaded tools
Hitting a schema error — the MCP function is referencing a column ct_ibottle that doesn't exist in your wine_inventory table. This is likely a mismatch between the schema file (01_schema.sql) and the MCP code (04_wine_brain_mcp_index.ts).

Quick fix: Check what columns your wine_inventory table actually has:

Go to Supabase → Table Editor → wine_inventory
Look at the column names — specifically what the bottle ID column is called(likely id or iWine or similar)
The MCP code expects ct_ibottle but your schema probably named it differently.Once you share what the actual column names are, I can help you either patch the schema or the MCP function to align them.

  Alternatively, if wine_inventory is empty(sync hasn't run yet or errored), the n8n workflow may also be inserting into the wrong column names — worth checking Table Editor → wine_inventory to see if there are any rows at all.


index.ts
ts

give me the supabase query that tells you what the latest schema is, then update the MCP tools accordingly, then we need to create a DDL file that gets stored on github.attached is the latest index script for hte mcp tools.

3:05 PM
Let me read the uploaded index.ts first, then query your actual schema.


  Viewed 2 files
Viewed 2 files
Good.Now I can see exactly what columns the MCP code expects.Let me query Supabase to get the actual schema, then I'll reconcile and produce the fixed files.

The key query to run in your Supabase SQL Editor is:

sql
SELECT
table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN('wine_inventory', 'wine_reactions', 'wine_preferences')
ORDER BY table_name, ordinal_position;
Run that and paste the results back here.While you do that, let me note what the MCP code expects vs what's likely actually there so I know exactly what to fix:

Columns referenced in index.ts that caused the error:

Table	Column MCP expects	Likely issue
wine_inventory	ct_ibottle	Probably doesn't exist — n8n sync likely used a different name
wine_inventory	ct_iwine	Same — may be id or wine_id
wine_reactions	ct_ibottle, ct_iwine	Same mismatch
Once you paste the schema query results, I'll:

Fix index.ts to match your actual column names
Generate a clean 01_schema.sql DDL file that reflects reality
Both files will be ready to commit to GitHub
Go ahead and run that query.


| table_name | column_name | data_type | is_nullable | column_default | | ---------------- | ----------------------- | ------------------------ | ----------- | -------------------------------------------- | | wine_inventory | id

pasted

how do i generate the DDL file directly from Supabase ?

  3 : 19 PM
The easiest way to generate the DDL directly from Supabase is via the SQL Editor using this query, which reconstructs CREATE TABLE statements from the information schema:

sql
SELECT
'CREATE TABLE ' || table_name || ' (' || E'\n' ||
  string_agg(
    '  ' || column_name || ' ' ||
    CASE 
      WHEN data_type = 'bigint' THEN 'bigint'
      WHEN data_type = 'integer' THEN 'integer'
      WHEN data_type = 'numeric' THEN 'numeric'
      WHEN data_type = 'text' THEN 'text'
      WHEN data_type = 'boolean' THEN 'boolean'
      WHEN data_type = 'date' THEN 'date'
      WHEN data_type = 'jsonb' THEN 'jsonb'
      WHEN data_type = 'ARRAY' THEN 'text[]'
      WHEN data_type = 'timestamp with time zone' THEN 'timestamptz'
      WHEN data_type = 'USER-DEFINED' THEN 'vector(1536)'
      ELSE data_type
    END ||
    CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
  CASE WHEN column_default IS NOT NULL 
      THEN ' DEFAULT ' || column_default 
      ELSE '' 
    END,
    E',\n' ORDER BY ordinal_position
  ) || E'\n);'
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN('wine_inventory', 'wine_reactions', 'wine_preferences')
GROUP BY table_name
ORDER BY table_name;
That said, the better approach for a proper versioned DDL is to use the Supabase CLI to dump it directly — this captures everything including indexes, constraints, RLS policies, and functions that the information schema query misses:

bash
supabase db dump--schema public - f supabase / migrations /01_schema.sql
Run that from your dave - brain repo directory on your local machine(you're already linked from Step 9). This produces a clean, complete, deployable SQL file.

Then to also capture your functions(cellar_summary, search_wine_inventory, etc.):

  bash
supabase db dump--schema public--data - only=false - f supabase / migrations /01_schema.sql
Once you have that file, I'll simultaneously produce the corrected index.ts — because I can already see the fix needed from your schema:

The issue: wine_inventory has no ct_ibottle column — it uses id(auto - increment) and ct_barcode instead.The MCP code references ct_ibottle in list_cellar and what_to_drink select statements.wine_reactions correctly has ct_ibottle so that table is fine.

Run the CLI dump and paste or share the output, and I'll fix index.ts and produce the DDL file for GitHub in one shot.

PS C: \dave - brain > supabase db dump--schema public - f supabase / migrations /01_schema.sql
Cannot find project ref.Have you run supabase link ?
  Try rerunning the command with --debug to troubleshoot the error.

3: 21 PM
You need to re - link the project.Run this:

powershell
supabase link--project - ref zujvqteqcusephuwuqhe
It will prompt for your database password(the one you set when creating the Supabase project — not the service role key).Once linked, re - run the dump:

powershell
supabase db dump--schema public - f supabase / migrations /01_schema.sql
While you do that, I already have everything I need from your schema output to fix index.ts right now — the issue is clear and I don't need to wait for the dump. Let me produce both files in parallel.


Read the skill file for docx(not needed here) - actually let me just build the files directly
Read the skill file for docx(not needed here) - actually let me just build the files directly
Now let me produce the fixed index.ts.The changes are:

  Remove ct_ibottle from wine_inventory SELECT statements in list_cellar and what_to_drink(it doesn't exist there — only in wine_reactions)
Add ct_barcode to those selects since that's the actual CT identifier on the inventory table
Keep ct_ibottle on wine_reactions(it exists there and is correct)

Edited 2 files, ran a command
Edited 2 files, ran a command
Now verify the fix looks right and no other ct_ibottle references on wine_inventory remain:


    Check all ct_ibottle and wine_inventory references
Check all ct_ibottle and wine_inventory references
Clean — ct_ibottle now only appears in wine_reactions context(lines 220, 230, 285 are all inside log_wine_reaction), which is correct since that table does have the column.Now build the DDL file:


    Created a file, ran a command, read a file
Created a file, ran a command, read a file
Both files are ready.Here's what was done:

index.ts fix — two SELECT statements in list_cellar and what_to_drink referenced ct_ibottle on wine_inventory, which doesn't exist. Replaced with id, ct_barcode (the actual columns). The ct_ibottle references in log_wine_reaction are untouched — that column correctly exists on wine_reactions.

01_schema.sql — hand - crafted DDL from your actual schema output, with:

All 3 tables with correct column names, types, nullability, and defaults
Indexes for all common filter patterns(producer, region, varietal, location, etc.)
IVFFlat vector indexes for all 3 embedding columns
Inline comments documenting the tiered location system, confidence scoring, etc.
To deploy:

Replace supabase / functions / wine - brain - mcp / index.ts with the fixed file
Run supabase functions deploy wine - brain - mcp
Put 01_schema.sql at supabase / migrations /01_schema.sql and commit
Once redeployed, the Walter Scott query will work.Want me to try it now, or do you want to redeploy first ?


  Index
TS 

01 schema
Code · SQL 




Claude is AI and can make mistakes.Please double - check responses.
  Index · TS
Copy

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function errResponse(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
      dimensions: 1536,
    }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "wine-brain", version: "1.0.0" });

// ══════════════════════════════════════════════════════════════════════════════
// Tool 1: search_wine
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "search_wine",
  {
    title: "Search Wine",
    description: "Semantic search over your wine inventory. Use natural language: 'earthy Oregon Pinot', 'structured Barolo for dinner', 'something from Walter Scott'.",
    inputSchema: {
      query: z.string().describe("Natural language wine query"),
      match_count: z.number().optional().default(8).describe("Number of results (default 8)"),
      active_only: z.boolean().optional().default(true).describe("Only in-cellar bottles (default true)"),
    },
  },
  async ({ query, match_count, active_only }) => {
    try {
      const queryEmbedding = await embed(query);
      const { data, error } = await supabase.rpc("search_wine_inventory", {
        query_embedding: `[${queryEmbedding.join(",")}]`,
        match_count: match_count ?? 8,
        active_only: active_only ?? true,
      });
      if (error) return errResponse(`Search error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: `No wines found for "${query}".` }] };

      const lines = data.map((w: Record<string, unknown>, i: number) => {
        const parts = [
          `${i + 1}. ${w.wine} ${w.vintage || ""} — ${w.producer || ""}`,
          `   ${w.varietal || ""} | ${w.region || ""}, ${w.country || ""}`,
          `   Location: ${w.location || "?"}${w.bin ? ` / Bin: ${w.bin}` : ""}`,
        ];
        if (w.drink_from || w.drink_to) parts.push(`   Drink: ${w.drink_from || "?"}–${w.drink_to || "?"}`);
        if (w.ct_score) parts.push(`   CT Score: ${w.ct_score}`);
        if (w.my_notes) parts.push(`   Notes: ${String(w.my_notes).slice(0, 120)}`);
        return parts.join("\n");
      });

      return { content: [{ type: "text" as const, text: `Found ${data.length} wine(s):\n\n${lines.join("\n\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Tool 2: list_cellar
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "list_cellar",
  {
    title: "List Cellar",
    description: "Structured filter query over the cellar. Filter by type, country, region, producer, varietal, location, vintage range, or drinking window.",
    inputSchema: {
      wine_type: z.string().optional().describe("Red, White, Rosé, Sparkling, etc."),
      country: z.string().optional(),
      region: z.string().optional(),
      producer: z.string().optional(),
      varietal: z.string().optional(),
      location: z.string().optional().describe("Left Top, Right, Left Bottom, Fridge-57"),
      vintage_min: z.number().optional(),
      vintage_max: z.number().optional(),
      in_window: z.boolean().optional().describe("Only bottles in current drinking window"),
      limit: z.number().optional().default(20),
    },
  },
  async ({ wine_type, country, region, producer, varietal, location, vintage_min, vintage_max, in_window, limit }) => {
    try {
      const currentYear = new Date().getFullYear();
      let q = supabase
        .from("wine_inventory")
        .select("id,ct_barcode,ct_iwine,wine,vintage,producer,wine_type,varietal,region,country,location,bin,drink_from,drink_to,ct_score,my_score,purchase_price,my_notes")
        .is("removed_at", null)
        .limit(limit ?? 20);

      if (wine_type) q = q.ilike("wine_type", `%${wine_type}%`);
      if (country) q = q.ilike("country", `%${country}%`);
      if (region) q = q.ilike("region", `%${region}%`);
      if (producer) q = q.ilike("producer", `%${producer}%`);
      if (varietal) q = q.ilike("varietal", `%${varietal}%`);
      if (location) q = q.ilike("location", `%${location}%`);
      if (vintage_min) q = q.gte("vintage", vintage_min);
      if (vintage_max) q = q.lte("vintage", vintage_max);
      if (in_window) q = q.lte("drink_from", currentYear).gte("drink_to", currentYear);

      const { data, error } = await q.order("vintage", { ascending: false });
      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: "No bottles found matching those filters." }] };

      const lines = data.map((w: Record<string, unknown>, i: number) => {
        const price = w.purchase_price ? ` | $${w.purchase_price}` : "";
        const window = (w.drink_from || w.drink_to) ? ` | Drink: ${w.drink_from || "?"}–${w.drink_to || "?"}` : "";
        return `${i + 1}. ${w.wine} ${w.vintage || ""} — ${w.producer || ""} | ${w.location || "?"}${w.bin ? `/${w.bin}` : ""}${window}${price}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} bottle(s):\n\n${lines.join("\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Tool 3: cellar_summary
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "cellar_summary",
  {
    title: "Cellar Summary",
    description: "Aggregate stats on the cellar: total bottles, valuation, breakdown by type/location/country, bottles in drinking window, top producers, reaction count, preference profile summary.",
    inputSchema: {},
  },
  async () => {
    try {
      const { data, error } = await supabase.rpc("cellar_summary");
      if (error) return errResponse(`Error: ${error.message}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Tool 4: what_to_drink
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "what_to_drink",
  {
    title: "What to Drink",
    description: "Returns bottles currently in their drinking window, ordered by urgency (soonest end of window first). Optionally filter by wine type or occasion.",
    inputSchema: {
      wine_type: z.string().optional(),
      limit: z.number().optional().default(15),
    },
  },
  async ({ wine_type, limit }) => {
    try {
      const currentYear = new Date().getFullYear();
      let q = supabase
        .from("wine_inventory")
        .select("id,ct_barcode,ct_iwine,wine,vintage,producer,wine_type,varietal,region,location,bin,drink_from,drink_to,ct_score,my_score,my_notes")
        .is("removed_at", null)
        .lte("drink_from", currentYear)
        .gte("drink_to", currentYear)
        .order("drink_to", { ascending: true })
        .limit(limit ?? 15);

      if (wine_type) q = q.ilike("wine_type", `%${wine_type}%`);

      const { data, error } = await q;
      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: "No bottles currently in drinking window." }] };

      const lines = data.map((w: Record<string, unknown>, i: number) => {
        const urgency = w.drink_to ? ` ⚠️ drink by ${w.drink_to}` : "";
        return `${i + 1}. ${w.wine} ${w.vintage || ""} — ${w.producer || ""} | ${w.location || "?"}${w.bin ? `/${w.bin}` : ""}${urgency}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} bottle(s) in drinking window:\n\n${lines.join("\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Tool 5: log_wine_reaction
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "log_wine_reaction",
  {
    title: "Log Wine Reaction",
    description: "Capture your reaction to a wine you just drank. Provide a free-form description — Claude will extract structure (rating, sentiment, flavor/style tags). This builds your preference profile over time.",
    inputSchema: {
      reaction_text: z.string().describe("Your free-form tasting note or reaction"),
      ct_iwine: z.number().optional().describe("CellarTracker wine ID (from search_wine results)"),
      ct_ibottle: z.number().optional().describe("CellarTracker bottle ID if known"),
      occasion: z.string().optional().describe("e.g. weeknight, dinner party, paired with lamb"),
      overall_rating: z.number().optional().describe("1–100 score if you want to assign one"),
      wine_name: z.string().optional().describe("Wine name (for context if ct_iwine not known)"),
      producer: z.string().optional(),
      vintage: z.number().optional(),
      varietal: z.string().optional(),
      region: z.string().optional(),
    },
  },
  async ({ reaction_text, ct_iwine, ct_ibottle, occasion, overall_rating, wine_name, producer, vintage, varietal, region }) => {
    try {
      // Extract structured fields using OpenRouter
      const extractRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [{
            role: "user",
            content: `Extract structured data from this wine tasting reaction. Return valid JSON only.
 
Reaction: "${reaction_text}"
Wine: ${wine_name || "unknown"} ${vintage || ""} ${producer || ""}
 
Return JSON with these fields (null if not determinable):
{
  "sentiment": "loved|liked|neutral|disappointed|disliked",
  "overall_rating": null or number 1-100,
  "would_buy_again": null or true/false,
  "flavor_tags": ["array","of","flavor","descriptors"],
  "style_tags": ["array","of","style","descriptors","like","earthy","structured","fresh"],
  "food_pairing": null or "food mentioned"
}`,
          }],
        }),
      });

      let extracted: Record<string, unknown> = {};
      if (extractRes.ok) {
        const extractData = await extractRes.json();
        try { extracted = JSON.parse(extractData.choices[0].message.content); } catch { /* use empty */ }
      }

      const embedText = [
        reaction_text,
        wine_name,
        vintage ? `Vintage ${vintage}` : null,
        producer,
        varietal,
        region,
        occasion ? `Occasion: ${occasion}` : null,
        extracted.sentiment ? `Sentiment: ${extracted.sentiment}` : null,
        extracted.flavor_tags ? `Flavors: ${(extracted.flavor_tags as string[]).join(", ")}` : null,
        extracted.style_tags ? `Style: ${(extracted.style_tags as string[]).join(", ")}` : null,
      ].filter(Boolean).join(". ");

      const reactionEmbedding = await embed(embedText);

      const reactionRow = {
        ct_iwine: ct_iwine || null,
        ct_ibottle: ct_ibottle || null,
        reaction_date: new Date().toISOString().slice(0, 10),
        occasion: occasion || null,
        reaction_text,
        overall_rating: overall_rating || extracted.overall_rating || null,
        sentiment: extracted.sentiment || null,
        would_buy_again: extracted.would_buy_again || null,
        flavor_tags: extracted.flavor_tags || [],
        style_tags: extracted.style_tags || [],
        food_pairing: extracted.food_pairing || null,
        wine_name: wine_name || null,
        producer: producer || null,
        vintage: vintage || null,
        varietal: varietal || null,
        region: region || null,
        embedding: `[${reactionEmbedding.join(",")}]`,
      };

      const { data, error } = await supabase.from("wine_reactions").insert(reactionRow).select("id").single();
      if (error) return errResponse(`Failed to log reaction: ${error.message}`);

      // If strong sentiment, update preference table
      if (extracted.sentiment === "loved" || extracted.sentiment === "disliked") {
        const prefSentiment = extracted.sentiment === "loved" ? "strong_like" : "dislike";
        const subjects: { type: string; subject: string }[] = [];
        if (producer) subjects.push({ type: "producer", subject: producer });
        if (region) subjects.push({ type: "region", subject: region });
        if (varietal) subjects.push({ type: "varietal", subject: varietal });

        for (const { type, subject } of subjects) {
          const prefEmbedding = await embed(`${prefSentiment} ${type}: ${subject}`);
          await supabase.from("wine_preferences").upsert({
            preference_type: type,
            subject,
            sentiment: prefSentiment,
            confidence: 0.7,
            source: "inferred_from_reactions",
            context: `Inferred from reaction logged ${new Date().toISOString().slice(0, 10)}`,
            evidence_ids: [data.id],
            embedding: `[${prefEmbedding.join(",")}]`,
            updated_at: new Date().toISOString(),
          }, { onConflict: "preference_type,subject" });
        }
      }

      const tags = [...(extracted.flavor_tags as string[] || []), ...(extracted.style_tags as string[] || [])];
      return { content: [{ type: "text" as const, text: `Reaction logged successfully.\nSentiment: ${extracted.sentiment || "not detected"}\nTags: ${tags.join(", ") || "none"}\nID: ${data.id}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Tool 6: set_wine_preference
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "set_wine_preference",
  {
    title: "Set Wine Preference",
    description: "Record an explicit wine preference. Use when you want to tell Claude something durable: 'I love structured Barolos', 'avoid heavily oaked Chardonnay', 'I'm seeking more Jura wines'.",
    inputSchema: {
      preference_type: z.string().describe("style | producer | region | varietal | appellation | country | avoid | seeking"),
      subject: z.string().describe("e.g. 'Walter Scott', 'Willamette Valley', 'heavily oaked Chardonnay'"),
      sentiment: z.string().describe("strong_like | like | neutral | dislike | avoid"),
      context: z.string().optional().describe("Optional context: 'especially with food', 'for weeknights'"),
    },
  },
  async ({ preference_type, subject, sentiment, context }) => {
    try {
      const prefText = `${sentiment} ${preference_type}: ${subject}. ${context || ""}`;
      const prefEmbedding = await embed(prefText);

      const { error } = await supabase.from("wine_preferences").upsert({
        preference_type,
        subject,
        sentiment,
        context: context || null,
        confidence: 1.0,
        source: "stated",
        embedding: `[${prefEmbedding.join(",")}]`,
        updated_at: new Date().toISOString(),
      }, { onConflict: "preference_type,subject" });

      if (error) return errResponse(`Failed to save preference: ${error.message}`);
      return { content: [{ type: "text" as const, text: `Preference recorded: ${sentiment} → ${subject}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Tool 7: get_my_preferences
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "get_my_preferences",
  {
    title: "Get My Wine Preferences",
    description: "Returns your full wine preference profile: explicit preferences, inferences from purchases, inferences from reactions. Use before making recommendations.",
    inputSchema: {
      sentiment_filter: z.string().optional().describe("Filter by sentiment: strong_like | like | avoid. Omit for all."),
      source_filter: z.string().optional().describe("Filter by source: stated | inferred_from_reactions | inferred_from_purchases"),
    },
  },
  async ({ sentiment_filter, source_filter }) => {
    try {
      let q = supabase
        .from("wine_preferences")
        .select("preference_type,subject,sentiment,context,confidence,source,updated_at")
        .order("confidence", { ascending: false });

      if (sentiment_filter) q = q.eq("sentiment", sentiment_filter);
      if (source_filter) q = q.eq("source", source_filter);

      const { data, error } = await q;
      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: "No preferences on record yet." }] };

      const lines = data.map((p: Record<string, unknown>) => {
        const conf = p.confidence ? ` (confidence: ${p.confidence})` : "";
        const ctx = p.context ? ` — ${p.context}` : "";
        return `• [${p.source}] ${p.sentiment} → ${p.preference_type}: ${p.subject}${ctx}${conf}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} preference(s):\n\n${lines.join("\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Tool 8: recommend_wine
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  "recommend_wine",
  {
    title: "Recommend Wine",
    description: "AI-powered wine recommendation using your inventory, reactions, and preference profile together. For opening tonight, pairing with a dish, or discovering new wines to buy.",
    inputSchema: {
      query: z.string().describe("e.g. 'something for Saturday dinner party', 'a wine to pair with duck confit', 'new producers to try in Burgundy'"),
      context: z.string().optional().describe("Additional context about the occasion"),
      from_inventory: z.boolean().optional().default(true).describe("true = recommend from what you own (default). false = recommend new wines to buy."),
    },
  },
  async ({ query, context, from_inventory }) => {
    try {
      const fromInventory = from_inventory !== false;
      const queryEmbedding = await embed(query);
      const vectorStr = `[${queryEmbedding.join(",")}]`;

      const [invResult, reactResult, prefResult] = await Promise.all([
        fromInventory
          ? supabase.rpc("search_wine_inventory", { query_embedding: vectorStr, match_count: 8, active_only: true })
          : Promise.resolve({ data: [], error: null }),
        supabase.rpc("search_wine_reactions", { query_embedding: vectorStr, match_count: 6 }),
        supabase.rpc("search_wine_preferences", { query_embedding: vectorStr, match_count: 10 }),
      ]);

      if (invResult.error) return errResponse(`Inventory search error: ${invResult.error.message}`);
      if (reactResult.error) return errResponse(`Reaction search error: ${reactResult.error.message}`);
      if (prefResult.error) return errResponse(`Preference search error: ${prefResult.error.message}`);

      const sections = [
        `Query: ${query}`,
        context ? `Context: ${context}` : null,
        `\n── Inventory Matches (${(invResult.data || []).length}) ──`,
        ...(invResult.data || []).map((w: Record<string, unknown>, i: number) =>
          `${i + 1}. ${w.wine} ${w.vintage || ""} — ${w.producer || ""} | ${w.location || "?"}${w.bin ? `/${w.bin}` : ""} | Drink: ${w.drink_from || "?"}–${w.drink_to || "?"}`
        ),
        `\n── Relevant Past Reactions (${(reactResult.data || []).length}) ──`,
        ...(reactResult.data || []).map((r: Record<string, unknown>, i: number) =>
          `${i + 1}. ${r.wine_name || "?"} ${r.vintage || ""} | ${r.sentiment || "?"} | ${String(r.reaction_text || "").slice(0, 100)}`
        ),
        `\n── Relevant Preferences (${(prefResult.data || []).length}) ──`,
        ...(prefResult.data || []).map((p: Record<string, unknown>) =>
          `• ${p.sentiment} → ${p.preference_type}: ${p.subject}`
        ),
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text" as const, text: sections }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ── Hono App ──────────────────────────────────────────────────────────────────

const app = new Hono();

app.all("*", async (c) => {
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);






