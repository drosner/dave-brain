// ============================================================
// Dave Brain — Wine MCP Tools
// Supabase Edge Function: supabase/functions/wine-brain-mcp/index.ts
//
// Deploy: supabase functions deploy wine-brain-mcp
//
// Tools exposed:
//   search_wine           — semantic search over inventory
//   list_cellar           — structured filter query
//   cellar_summary        — aggregate stats
//   what_to_drink         — bottles in current drinking window
//   log_wine_reaction     — capture a tasting experience
//   set_wine_preference   — record an explicit preference
//   get_my_preferences    — return preference profile
//   recommend_wine        — AI-powered recommendation using all three layers
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;   // same key used by open-brain-mcp

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

// ── Tool definitions (returned in list_tools response) ────────────────────────
const TOOLS = [
  {
    name: "search_wine",
    description: "Semantic search over your wine inventory. Use natural language: 'earthy Oregon Pinot', 'structured Barolo for dinner', 'something from Walter Scott'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language wine query" },
        match_count: { type: "number", description: "Number of results (default 8)" },
        active_only: { type: "boolean", description: "Only in-cellar bottles (default true)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_cellar",
    description: "Structured filter query over the cellar. Filter by type, country, location, vintage range, or drinking window.",
    inputSchema: {
      type: "object",
      properties: {
        wine_type: { type: "string", description: "Red, White, Rosé, Sparkling, etc." },
        country: { type: "string" },
        region: { type: "string" },
        producer: { type: "string" },
        varietal: { type: "string" },
        location: { type: "string", description: "Left Top, Right, Left Bottom, Fridge-57" },
        vintage_min: { type: "number" },
        vintage_max: { type: "number" },
        in_window: { type: "boolean", description: "Only bottles in current drinking window" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "cellar_summary",
    description: "Aggregate stats on the cellar: total bottles, valuation, breakdown by type/location/country, bottles in drinking window, top producers, reaction count, preference profile summary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "what_to_drink",
    description: "Returns bottles currently in their drinking window, ordered by urgency (soonest end of window first). Optionally filter by wine type or occasion.",
    inputSchema: {
      type: "object",
      properties: {
        wine_type: { type: "string" },
        limit: { type: "number", description: "Max results (default 15)" },
      },
    },
  },
  {
    name: "log_wine_reaction",
    description: "Capture your reaction to a wine you just drank. Provide a free-form description — Claude will extract structure (rating, sentiment, flavor/style tags). This builds your preference profile over time.",
    inputSchema: {
      type: "object",
      properties: {
        ct_iwine: { type: "number", description: "CellarTracker wine ID (from search_wine results)" },
        ct_ibottle: { type: "number", description: "CellarTracker bottle ID if known" },
        reaction_text: { type: "string", description: "Your free-form tasting note or reaction" },
        occasion: { type: "string", description: "e.g. weeknight, dinner party, paired with lamb" },
        overall_rating: { type: "number", description: "1–100 score if you want to assign one" },
        wine_name: { type: "string", description: "Wine name (for context if ct_iwine not known)" },
        producer: { type: "string" },
        vintage: { type: "number" },
        varietal: { type: "string" },
        region: { type: "string" },
      },
      required: ["reaction_text"],
    },
  },
  {
    name: "set_wine_preference",
    description: "Record an explicit wine preference. Use when you want to tell Claude something durable: 'I love structured Barolos', 'avoid heavily oaked Chardonnay', 'I'm seeking more Jura wines'.",
    inputSchema: {
      type: "object",
      properties: {
        preference_type: { type: "string", description: "style | producer | region | varietal | appellation | country | avoid | seeking" },
        subject: { type: "string", description: "e.g. 'Walter Scott', 'Willamette Valley', 'heavily oaked Chardonnay'" },
        sentiment: { type: "string", description: "strong_like | like | neutral | dislike | avoid" },
        context: { type: "string", description: "Optional context: 'especially with food', 'for weeknights'" },
      },
      required: ["preference_type", "subject", "sentiment"],
    },
  },
  {
    name: "get_my_preferences",
    description: "Returns your full wine preference profile: explicit preferences, inferences from purchases, inferences from reactions. Use before making recommendations.",
    inputSchema: {
      type: "object",
      properties: {
        sentiment_filter: { type: "string", description: "Filter by sentiment: strong_like | like | avoid. Omit for all." },
        source_filter: { type: "string", description: "Filter by source: stated | inferred_from_reactions | inferred_from_purchases" },
      },
    },
  },
  {
    name: "recommend_wine",
    description: "AI-powered wine recommendation using your inventory, reactions, and preference profile together. For opening tonight, pairing with a dish, or discovering new wines to buy.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "e.g. 'something for Saturday dinner party', 'a wine to pair with duck confit', 'new producers to try in Burgundy'" },
        context: { type: "string", description: "Additional context about the occasion" },
        from_inventory: { type: "boolean", description: "true = recommend from what you own (default). false = recommend new wines to buy." },
      },
      required: ["query"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handle_search_wine(input: Record<string, unknown>) {
  const query = input.query as string;
  const match_count = (input.match_count as number) || 8;
  const active_only = input.active_only !== false;

  const queryEmbedding = await embed(query);

  const { data, error } = await supabase.rpc("search_wine_inventory", {
    query_embedding: `[${queryEmbedding.join(",")}]`,
    match_count,
    active_only,
  });
  if (error) throw error;
  return data;
}

async function handle_list_cellar(input: Record<string, unknown>) {
  const limit = (input.limit as number) || 20;
  const currentYear = new Date().getFullYear();

  let query = supabase
    .from("wine_inventory")
    .select("ct_ibottle,ct_iwine,wine,vintage,producer,wine_type,varietal,region,country,location,bin,drink_from,drink_to,ct_score,my_score,purchase_price,my_notes")
    .is("removed_at", null)
    .limit(limit);

  if (input.wine_type) query = query.ilike("wine_type", `%${input.wine_type}%`);
  if (input.country) query = query.ilike("country", `%${input.country}%`);
  if (input.region) query = query.ilike("region", `%${input.region}%`);
  if (input.producer) query = query.ilike("producer", `%${input.producer}%`);
  if (input.varietal) query = query.ilike("varietal", `%${input.varietal}%`);
  if (input.location) query = query.ilike("location", `%${input.location}%`);
  if (input.vintage_min) query = query.gte("vintage", input.vintage_min);
  if (input.vintage_max) query = query.lte("vintage", input.vintage_max);
  if (input.in_window) {
    query = query.lte("drink_from", currentYear).gte("drink_to", currentYear);
  }

  const { data, error } = await query.order("vintage", { ascending: false });
  if (error) throw error;
  return data;
}

async function handle_cellar_summary(_input: Record<string, unknown>) {
  const { data, error } = await supabase.rpc("cellar_summary");
  if (error) throw error;
  return data;
}

async function handle_what_to_drink(input: Record<string, unknown>) {
  const limit = (input.limit as number) || 15;
  const currentYear = new Date().getFullYear();

  let query = supabase
    .from("wine_inventory")
    .select("ct_ibottle,ct_iwine,wine,vintage,producer,wine_type,varietal,region,location,bin,drink_from,drink_to,ct_score,my_score,my_notes")
    .is("removed_at", null)
    .lte("drink_from", currentYear)
    .gte("drink_to", currentYear)
    .order("drink_to", { ascending: true })
    .limit(limit);

  if (input.wine_type) query = query.ilike("wine_type", `%${input.wine_type}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function handle_log_wine_reaction(input: Record<string, unknown>) {
  const reactionText = input.reaction_text as string;

  // Extract structured fields using OpenRouter Claude
  const extractRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-3-haiku",
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: `Extract structured data from this wine tasting reaction. Return valid JSON only.

Reaction: "${reactionText}"
Wine: ${input.wine_name || "unknown"} ${input.vintage || ""} ${input.producer || ""}

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
    try {
      extracted = JSON.parse(extractData.choices[0].message.content);
    } catch { /* use empty if parse fails */ }
  }

  // Build embedding text for the reaction
  const embedText = [
    reactionText,
    input.wine_name,
    input.vintage ? `Vintage ${input.vintage}` : null,
    input.producer,
    input.varietal,
    input.region,
    input.occasion ? `Occasion: ${input.occasion}` : null,
    extracted.sentiment ? `Sentiment: ${extracted.sentiment}` : null,
    extracted.flavor_tags ? `Flavors: ${(extracted.flavor_tags as string[]).join(", ")}` : null,
    extracted.style_tags ? `Style: ${(extracted.style_tags as string[]).join(", ")}` : null,
  ].filter(Boolean).join(". ");

  const reactionEmbedding = await embed(embedText);

  const reactionRow = {
    ct_iwine: (input.ct_iwine as number) || null,
    ct_ibottle: (input.ct_ibottle as number) || null,
    reaction_date: new Date().toISOString().slice(0, 10),
    occasion: (input.occasion as string) || null,
    reaction_text: reactionText,
    overall_rating: (input.overall_rating as number) || extracted.overall_rating || null,
    sentiment: extracted.sentiment || null,
    would_buy_again: extracted.would_buy_again || null,
    flavor_tags: extracted.flavor_tags || [],
    style_tags: extracted.style_tags || [],
    food_pairing: extracted.food_pairing || null,
    wine_name: (input.wine_name as string) || null,
    producer: (input.producer as string) || null,
    vintage: (input.vintage as number) || null,
    varietal: (input.varietal as string) || null,
    region: (input.region as string) || null,
    embedding: `[${reactionEmbedding.join(",")}]`,
  };

  const { data, error } = await supabase.from("wine_reactions").insert(reactionRow).select("id").single();
  if (error) throw error;

  // If strong sentiment, update preference table
  if (extracted.sentiment === "loved" || extracted.sentiment === "disliked") {
    const prefSentiment = extracted.sentiment === "loved" ? "strong_like" : "dislike";
    const subjects: { type: string; subject: string }[] = [];
    if (input.producer) subjects.push({ type: "producer", subject: input.producer as string });
    if (input.region) subjects.push({ type: "region", subject: input.region as string });
    if (input.varietal) subjects.push({ type: "varietal", subject: input.varietal as string });

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

  return {
    message: "Reaction logged successfully.",
    reaction_id: data.id,
    extracted_sentiment: extracted.sentiment,
    extracted_tags: [...(extracted.flavor_tags as string[] || []), ...(extracted.style_tags as string[] || [])],
  };
}

async function handle_set_wine_preference(input: Record<string, unknown>) {
  const subject = input.subject as string;
  const prefText = `${input.sentiment} ${input.preference_type}: ${subject}. ${input.context || ""}`;
  const prefEmbedding = await embed(prefText);

  const { error } = await supabase.from("wine_preferences").upsert({
    preference_type: input.preference_type,
    subject,
    sentiment: input.sentiment,
    context: input.context || null,
    confidence: 1.0,                     // explicitly stated = full confidence
    source: "stated",
    embedding: `[${prefEmbedding.join(",")}]`,
    updated_at: new Date().toISOString(),
  }, { onConflict: "preference_type,subject" });

  if (error) throw error;
  return { message: `Preference recorded: ${input.sentiment} → ${subject}` };
}

async function handle_get_my_preferences(input: Record<string, unknown>) {
  let query = supabase
    .from("wine_preferences")
    .select("preference_type,subject,sentiment,context,confidence,source,updated_at")
    .order("confidence", { ascending: false });

  if (input.sentiment_filter) query = query.eq("sentiment", input.sentiment_filter);
  if (input.source_filter) query = query.eq("source", input.source_filter);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function handle_recommend_wine(input: Record<string, unknown>) {
  const query = input.query as string;
  const fromInventory = input.from_inventory !== false;

  // Embed the query once, fan out to all three tables in parallel
  const queryEmbedding = await embed(query);
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  const [invResult, reactResult, prefResult] = await Promise.all([
    fromInventory
      ? supabase.rpc("search_wine_inventory", { query_embedding: vectorStr, match_count: 8, active_only: true })
      : Promise.resolve({ data: [], error: null }),
    supabase.rpc("search_wine_reactions", { query_embedding: vectorStr, match_count: 6 }),
    supabase.rpc("search_wine_preferences", { query_embedding: vectorStr, match_count: 10 }),
  ]);

  if (invResult.error) throw invResult.error;
  if (reactResult.error) throw reactResult.error;
  if (prefResult.error) throw prefResult.error;

  // Return all three layers — the calling LLM synthesizes the recommendation
  return {
    query,
    from_inventory: fromInventory,
    inventory_matches: invResult.data || [],
    reaction_matches: reactResult.data || [],
    preference_matches: prefResult.data || [],
    instructions: "Use all three layers to form a recommendation. Inventory matches are bottles available now. Reaction matches show past experiences with similar wines. Preference matches show known preferences relevant to this query. Synthesize into a ranked, explained recommendation.",
  };
}

// ── Request router ────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  search_wine: handle_search_wine,
  list_cellar: handle_list_cellar,
  cellar_summary: handle_cellar_summary,
  what_to_drink: handle_what_to_drink,
  log_wine_reaction: handle_log_wine_reaction,
  set_wine_preference: handle_set_wine_preference,
  get_my_preferences: handle_get_my_preferences,
  recommend_wine: handle_recommend_wine,
};

// ── MCP HTTP handler ──────────────────────────────────────────────────────────

serve(async (req: Request) => {

  if (req.method === "GET") {
    // Tool discovery
    return new Response(JSON.stringify({ tools: TOOLS }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    const body = await req.json();
    const { tool, input = {} } = body;

    const handler = HANDLERS[tool];
    if (!handler) {
      return new Response(JSON.stringify({ error: `Unknown tool: ${tool}` }), { status: 400 });
    }

    try {
      const result = await handler(input as Record<string, unknown>);
      return new Response(JSON.stringify({ result }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), { status: 500 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
