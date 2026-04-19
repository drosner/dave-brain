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