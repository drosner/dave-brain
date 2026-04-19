-- ============================================================
-- Wine Brain — Database Schema
-- Project: dave-brain (zujvqteqcusephuwuqhe)
-- Generated: 2026-04-19
-- ============================================================
-- Run order: 01_schema.sql → 02_functions.sql
-- Requires: pgvector extension enabled in Supabase
-- ============================================================

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- TABLE: wine_inventory
-- Populated nightly by n8n CellarTracker sync workflow.
-- One row per bottle in the cellar.
-- ============================================================
CREATE TABLE IF NOT EXISTS wine_inventory (
  id                      bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  ct_barcode              bigint NOT NULL,               -- CellarTracker iBottle barcode ID
  ct_iwine                bigint NOT NULL,               -- CellarTracker wine ID
  wine                    text,                          -- Full wine name
  vintage                 integer,
  producer                text,
  wine_type               text,                          -- Red, White, Rosé, Sparkling, etc.
  color                   text,
  varietal                text,
  appellation             text,
  region                  text,
  country                 text,
  locale                  text,
  location                text,                          -- Left Top | Right | Left Bottom | Fridge-57
  bin                     text,
  purchase_price          numeric,
  valuation               numeric,
  drink_from              integer,                       -- Year
  drink_to                integer,                       -- Year
  ct_score                numeric,
  my_score                numeric,
  my_notes                text,
  note_date               date,
  sommselect_narrative    text,
  sommselect_product_url  text,
  sommselect_order_number text,
  narrative_status        text DEFAULT 'pending',        -- pending | complete
  removed_at              timestamptz,                   -- Set when bottle leaves cellar; NULL = in cellar
  last_synced_at          timestamptz DEFAULT now(),
  created_at              timestamptz DEFAULT now(),
  raw_ct_row              jsonb,                         -- Full raw row from CellarTracker CSV
  embedding               vector(1536)                   -- text-embedding-3-small of wine metadata
);

-- Indexes for common filter patterns
CREATE INDEX IF NOT EXISTS idx_wine_inventory_producer    ON wine_inventory (producer);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_region      ON wine_inventory (region);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_country     ON wine_inventory (country);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_varietal    ON wine_inventory (varietal);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_location    ON wine_inventory (location);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_vintage     ON wine_inventory (vintage);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_removed_at  ON wine_inventory (removed_at);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_ct_iwine    ON wine_inventory (ct_iwine);
CREATE INDEX IF NOT EXISTS idx_wine_inventory_ct_barcode  ON wine_inventory (ct_barcode);

-- Vector similarity index (IVFFlat — tune lists after bulk load)
CREATE INDEX IF NOT EXISTS idx_wine_inventory_embedding
  ON wine_inventory USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);


-- ============================================================
-- TABLE: wine_reactions
-- Tasting notes and reactions logged via MCP tool.
-- Drives preference inference and recommendation context.
-- ============================================================
CREATE TABLE IF NOT EXISTS wine_reactions (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  ct_iwine        bigint NOT NULL,                       -- CellarTracker wine ID
  ct_ibottle      bigint,                                -- CellarTracker bottle ID (optional)
  reaction_date   date NOT NULL DEFAULT CURRENT_DATE,
  occasion        text,                                  -- weeknight | dinner party | paired with lamb, etc.
  reaction_text   text NOT NULL,                         -- Free-form tasting note
  overall_rating  numeric,                               -- 1–100
  sentiment       text,                                  -- loved | liked | neutral | disappointed | disliked
  would_buy_again boolean,
  flavor_tags     text[],                                -- e.g. {dark fruit, iron, tobacco}
  style_tags      text[],                                -- e.g. {structured, earthy, long finish}
  food_pairing    text,
  wine_name       text,
  producer        text,
  vintage         integer,
  varietal        text,
  region          text,
  embedding       vector(1536),                          -- Embedding of full reaction context
  created_at      timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wine_reactions_ct_iwine   ON wine_reactions (ct_iwine);
CREATE INDEX IF NOT EXISTS idx_wine_reactions_sentiment  ON wine_reactions (sentiment);
CREATE INDEX IF NOT EXISTS idx_wine_reactions_date       ON wine_reactions (reaction_date);

-- Vector index
CREATE INDEX IF NOT EXISTS idx_wine_reactions_embedding
  ON wine_reactions USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);


-- ============================================================
-- TABLE: wine_preferences
-- Preference profile: built from stated preferences,
-- reactions, and purchase pattern inference.
-- ============================================================
CREATE TABLE IF NOT EXISTS wine_preferences (
  id               bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  preference_type  text NOT NULL,   -- style | producer | region | varietal | appellation | country | avoid | seeking
  subject          text NOT NULL,   -- e.g. 'Walter Scott', 'Willamette Valley', 'heavily oaked Chardonnay'
  sentiment        text NOT NULL,   -- strong_like | like | neutral | dislike | avoid
  context          text,            -- e.g. 'especially with food', 'for weeknights'
  confidence       numeric DEFAULT 0.5,
                                    -- 1.0 = stated explicitly
                                    -- 0.7 = inferred from reactions
                                    -- 0.4–0.75 = inferred from purchases
  source           text NOT NULL,   -- stated | inferred_from_reactions | inferred_from_purchases
  evidence_ids     bigint[],        -- IDs of wine_reactions rows that drove this inference
  embedding        vector(1536),
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),

  UNIQUE (preference_type, subject)  -- Upsert key
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wine_preferences_type       ON wine_preferences (preference_type);
CREATE INDEX IF NOT EXISTS idx_wine_preferences_sentiment  ON wine_preferences (sentiment);
CREATE INDEX IF NOT EXISTS idx_wine_preferences_source     ON wine_preferences (source);
CREATE INDEX IF NOT EXISTS idx_wine_preferences_confidence ON wine_preferences (confidence DESC);

-- Vector index
CREATE INDEX IF NOT EXISTS idx_wine_preferences_embedding
  ON wine_preferences USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

ALTER TABLE wine_inventory
  ADD COLUMN IF NOT EXISTS purchase_price numeric,
  ADD COLUMN IF NOT EXISTS ct_avg_price numeric;