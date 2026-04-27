import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPTransport } from '@hono/mcp';
import { createClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';

const app = new Hono();

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey =
  Deno.env.get('WINE_BRAIN_SUPABASE_SERVICE_ROLE_KEY') ??
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  Deno.env.get('SUPABASE_ANON_KEY');
const mcpBearerToken = Deno.env.get('MCP_BEARER_TOKEN');

if (!supabaseServiceRoleKey) {
  throw new Error('Missing Supabase key for wine-brain-mcp');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

function requireAuth(c: any, next: any) {
  if (!mcpBearerToken) return next();
  const auth = c.req.header('authorization') || '';
  if (auth !== `Bearer ${mcpBearerToken}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
}

app.use('*', requireAuth);

function fmtBottle(row: any) {
  return [
    `barcode=${row.ct_barcode}`,
    row.vintage ? `${row.vintage}` : null,
    row.producer,
    row.wine,
    row.location ? `location=${row.location}` : null,
    row.bin ? `bin=${row.bin}` : null,
    row.removed_at ? `removed=${row.removed_at}` : 'active',
  ].filter(Boolean).join(' | ');
}

function fmtWine(row: any) {
  return [
    `iWine=${row.ct_iwine}`,
    row.vintage ? `${row.vintage}` : null,
    row.producer,
    row.wine,
    row.bottle_count != null ? `bottles=${row.bottle_count}` : null,
    row.location_count != null ? `locations=${row.location_count}` : null,
  ].filter(Boolean).join(' | ');
}

function buildServer() {
  const server = new McpServer({
    name: 'cellartracker-inventory',
    version: '2.0.0',
  });

  server.registerTool(
    'cellar_summary',
    {
      title: 'Cellar Summary',
      description: 'Return a summary of active bottles, removed bottles, unique wines, and locations.',
      inputSchema: {},
    },
    async () => {
      const { data, error } = await supabase.rpc('cellar_summary');
      if (error) throw error;
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.registerTool(
    'search_wines',
    {
      title: 'Search Wines',
      description: 'Search canonical wine records by wine name, producer, varietal, or appellation.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit = 10 }) => {
      const { data, error } = await supabase.rpc('search_wines', {
        query_text: query,
        match_count: limit,
      });
      if (error) throw error;
      const text = (data || []).map(fmtWine).join('\n') || 'No matching wines found.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'search_bottles',
    {
      title: 'Search Bottles',
      description: 'Search bottle inventory by barcode, wine text, location, or bin.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, limit = 25 }) => {
      const { data, error } = await supabase.rpc('search_bottles', {
        query_text: query,
        match_count: limit,
      });
      if (error) throw error;
      const text = (data || []).map(fmtBottle).join('\n') || 'No matching bottles found.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'list_cellar',
    {
      title: 'List Cellar',
      description: 'List active bottles with optional filters for location, producer, and drinkability window.',
      inputSchema: {
        location: z.string().optional(),
        producer: z.string().optional(),
        in_window: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ location, producer, in_window = false, limit = 100 }) => {
      const currentYear = new Date().getUTCFullYear();
      let query = supabase
        .from('bottles')
        .select(`
          ct_barcode,
          ct_iwine,
          location,
          bin,
          purchase_date,
          bottle_cost,
          removed_at,
          wines:wines!bottles_ct_iwine_fkey (
            wine,
            vintage,
            producer,
            drink_from,
            drink_to
          )
        `)
        .is('removed_at', null)
        .limit(limit)
        .order('purchase_date', { ascending: false });

      if (location) query = query.eq('location', location);
      if (producer) query = query.eq('wines.producer', producer);
      if (in_window) {
        query = query.lte('wines.drink_from', currentYear).gte('wines.drink_to', currentYear);
      }

      const { data, error } = await query;
      if (error) throw error;

      const text = (data || []).map((row: any) => {
        const wine = Array.isArray(row.wines) ? row.wines[0] : row.wines;
        return fmtBottle({ ...row, ...wine });
      }).join('\n') || 'No bottles found.';

      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'what_to_drink',
    {
      title: 'What To Drink',
      description: 'Return active bottles that appear to be in their drinking window.',
      inputSchema: {
        location: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ location, limit = 20 }) => {
      const currentYear = new Date().getUTCFullYear();
      let query = supabase
        .from('bottles')
        .select(`
          ct_barcode,
          location,
          bin,
          wines:wines!bottles_ct_iwine_fkey (
            ct_iwine,
            wine,
            vintage,
            producer,
            drink_from,
            drink_to
          )
        `)
        .is('removed_at', null)
        .lte('wines.drink_from', currentYear)
        .gte('wines.drink_to', currentYear)
        .limit(limit);

      if (location) query = query.eq('location', location);

      const { data, error } = await query;
      if (error) throw error;

      const text = (data || []).map((row: any) => {
        const wine = Array.isArray(row.wines) ? row.wines[0] : row.wines;
        return fmtBottle({ ...row, ...wine });
      }).join('\n') || 'No bottles currently in window.';

      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'log_wine_reaction',
    {
      title: 'Log Wine Reaction',
      description: 'Log a reaction tied to a wine, a bottle, or freeform wine text.',
      inputSchema: {
        ct_iwine: z.number().int().optional(),
        ct_barcode: z.string().optional(),
        wine_name: z.string().optional(),
        producer: z.string().optional(),
        vintage: z.number().int().optional(),
        reaction_type: z.enum(['like', 'dislike', 'neutral', 'tasting_note', 'rating', 'pairing', 'purchase_signal']),
        sentiment: z.enum(['positive', 'negative', 'neutral']).optional(),
        rating: z.number().min(0).max(100).optional(),
        notes: z.string().optional(),
        source: z.string().optional(),
      },
    },
    async (args) => {
      const { data, error } = await supabase.from('wine_reactions').insert({
        ct_iwine: args.ct_iwine ?? null,
        ct_barcode: args.ct_barcode ?? null,
        wine_name: args.wine_name ?? null,
        producer: args.producer ?? null,
        vintage: args.vintage ?? null,
        reaction_type: args.reaction_type,
        sentiment: args.sentiment ?? null,
        rating: args.rating ?? null,
        notes: args.notes ?? null,
        source: args.source ?? 'manual',
      }).select().single();
      if (error) throw error;
      return { content: [{ type: 'text', text: `Logged reaction ${data.id}.` }] };
    },
  );

  server.registerTool(
    'set_wine_preference',
    {
      title: 'Set Wine Preference',
      description: 'Create or update a wine preference record.',
      inputSchema: {
        preference_type: z.enum(['producer', 'varietal', 'appellation', 'region', 'country', 'wine_type', 'wine']),
        subject: z.string().min(1),
        sentiment: z.enum(['positive', 'negative', 'neutral']),
        confidence: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
        context: z.string().optional(),
      },
    },
    async ({ preference_type, subject, sentiment, confidence = 0.8, source = 'manual', context }) => {
      const { data, error } = await supabase
        .from('wine_preferences')
        .upsert({
          preference_type,
          subject,
          sentiment,
          confidence,
          source,
          context: context ?? null,
          last_observed_at: new Date().toISOString(),
        }, {
          onConflict: 'preference_type,subject,source',
        })
        .select()
        .single();
      if (error) throw error;
      return { content: [{ type: 'text', text: `Saved preference ${data.id}.` }] };
    },
  );

  server.registerTool(
    'search_reactions',
    {
      title: 'Search Reactions',
      description: 'Search saved wine reactions.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, limit = 25 }) => {
      const { data, error } = await supabase.rpc('search_wine_reactions', {
        query_text: query,
        match_count: limit,
      });
      if (error) throw error;
      const text = (data || []).map((row: any) => {
        return [
          `reaction=${row.id}`,
          row.ct_barcode ? `barcode=${row.ct_barcode}` : null,
          row.ct_iwine ? `iWine=${row.ct_iwine}` : null,
          row.reaction_type,
          row.sentiment,
          row.rating != null ? `rating=${row.rating}` : null,
          row.notes,
        ].filter(Boolean).join(' | ');
      }).join('\n') || 'No reactions found.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'upsert_bottles_batch',
    {
      title: 'Upsert Bottles Batch',
      description: 'Bulk upsert wine and bottle records from a CellarTracker export. Upserts wines table on ct_iwine, then bottles table on ct_barcode. Use after a CellarTracker CSV export to sync inventory.',
      inputSchema: {
        bottles: z.array(z.object({
          // identity
          ct_barcode: z.string(),
          ct_iwine: z.number().int(),
          // wine-level fields
          wine: z.string(),
          vintage: z.number().int().nullable().optional(),
          producer: z.string().nullable().optional(),
          wine_type: z.string().nullable().optional(),
          color: z.string().nullable().optional(),
          varietal: z.string().nullable().optional(),
          master_varietal: z.string().nullable().optional(),
          designation: z.string().nullable().optional(),
          vineyard: z.string().nullable().optional(),
          appellation: z.string().nullable().optional(),
          region: z.string().nullable().optional(),
          sub_region: z.string().nullable().optional(),
          country: z.string().nullable().optional(),
          locale: z.string().nullable().optional(),
          bottle_size: z.string().nullable().optional(),
          drink_from: z.number().int().nullable().optional(),
          drink_to: z.number().int().nullable().optional(),
          // bottle-level fields
          location: z.string().nullable().optional(),
          bin: z.string().nullable().optional(),
          store: z.string().nullable().optional(),
          purchase_date: z.string().nullable().optional(),
          bottle_cost: z.number().nullable().optional(),
          bottle_cost_currency: z.string().nullable().optional(),
          bottle_note: z.string().nullable().optional(),
          // full raw row — stores valuation, critic scores, community data, etc.
          raw_ct_row: z.record(z.unknown()).nullable().optional(),
        })).min(1).max(2000),
      },
    },
    async ({ bottles }) => {
      // Upsert unique wines first (keyed on ct_iwine)
      const wineMap = new Map<number, Record<string, unknown>>();
      for (const b of bottles) {
        if (!wineMap.has(b.ct_iwine)) {
          wineMap.set(b.ct_iwine, {
            ct_iwine: b.ct_iwine,
            wine: b.wine,
            vintage: b.vintage ?? null,
            producer: b.producer ?? null,
            wine_type: b.wine_type ?? null,
            color: b.color ?? null,
            varietal: b.varietal ?? null,
            master_varietal: b.master_varietal ?? null,
            designation: b.designation ?? null,
            vineyard: b.vineyard ?? null,
            appellation: b.appellation ?? null,
            region: b.region ?? null,
            sub_region: b.sub_region ?? null,
            country: b.country ?? null,
            locale: b.locale ?? null,
            bottle_size: b.bottle_size ?? null,
            drink_from: b.drink_from ?? null,
            drink_to: b.drink_to ?? null,
          });
        }
      }

      const wineRows = Array.from(wineMap.values());
      const { error: wineErr } = await supabase
        .from('wines')
        .upsert(wineRows, { onConflict: 'ct_iwine', ignoreDuplicates: false });
      if (wineErr) throw new Error(`wines upsert failed: ${wineErr.message}`);

      const bottleRows = bottles.map((b) => ({
        ct_barcode: b.ct_barcode,
        ct_iwine: b.ct_iwine,
        location: b.location ?? null,
        bin: b.bin ?? null,
        store: b.store ?? null,
        purchase_date: b.purchase_date ?? null,
        bottle_cost: b.bottle_cost ?? null,
        bottle_cost_currency: b.bottle_cost_currency ?? null,
        bottle_note: b.bottle_note ?? null,
        raw_ct_row: b.raw_ct_row ?? null,
        removed_at: null,
        last_synced_at: new Date().toISOString(),
      }));

      const { error: bottleErr } = await supabase
        .from('bottles')
        .upsert(bottleRows, { onConflict: 'ct_barcode', ignoreDuplicates: false });
      if (bottleErr) throw new Error(`bottles upsert failed: ${bottleErr.message}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            wines_upserted: wineRows.length,
            bottles_upserted: bottleRows.length,
          }),
        }],
      };
    },
  );

  server.registerTool(
    'search_preferences',
    {
      title: 'Search Preferences',
      description: 'Search inferred or manual wine preferences.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, limit = 25 }) => {
      const { data, error } = await supabase.rpc('search_wine_preferences', {
        query_text: query,
        match_count: limit,
      });
      if (error) throw error;
      const text = (data || []).map((row: any) => {
        return [
          `preference=${row.id}`,
          row.preference_type,
          row.subject,
          row.sentiment,
          `confidence=${row.confidence}`,
          `source=${row.source}`,
        ].join(' | ');
      }).join('\n') || 'No preferences found.';
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}

app.all('*', async (c) => {
  const server = buildServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
