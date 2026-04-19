-- ============================================================
-- wine_inventory table for dave-brain / Supabase
-- Run this in the Supabase SQL Editor (supabase.com → your project → SQL Editor)
--
-- Embedding model : text-embedding-3-large (3072 dimensions)
-- Upsert key      : ct_ibottle  (one row per physical bottle)
-- Wine-level join : ct_iwine    (links to Notes, wine-level queries)
-- ============================================================

-- pgvector is already enabled in your brain project, but this is safe to re-run
create extension if not exists vector;


-- ============================================================
-- Main table
-- ============================================================
create table if not exists wine_inventory (

  id                bigserial primary key,

  -- CellarTracker bottle-level unique ID — upsert / dedup key
  ct_ibottle        bigint unique not null,

  -- CellarTracker wine-level ID — used for Notes join and wine-level queries
  ct_iwine          bigint not null,

  -- Core wine identity
  wine              text,           -- Full CT wine name string
  vintage           int,
  producer          text,
  wine_type         text,           -- Red, White, Rosé, Sparkling, Dessert, Fortified
  color             text,
  varietal          text,           -- CT "Category" field (Pinot Noir, Chardonnay, etc.)
  appellation       text,
  region            text,
  country           text,
  locale            text,           -- Sub-region / village

  -- Physical bottle location
  location          text,           -- Your tiered rules: Left Top / Right / Left Bottom / Fridge-57
  bin               text,

  -- Valuation
  purchase_price    numeric(10,2),
  valuation         numeric(10,2),

  -- Drinking window
  drink_from        int,
  drink_to          int,

  -- Scores
  ct_score          numeric(4,1),   -- CellarTracker community score
  my_score          numeric(4,1),   -- Your personal score

  -- Tasting notes (pulled from CT Notes table, joined on ct_iwine)
  my_notes          text,           -- All your notes for this wine concatenated
  note_date         date,           -- Most recent note date

  -- Soft-delete: set when bottle disappears from CT export; null = active in cellar
  removed_at        timestamptz,

  -- Audit
  last_synced_at    timestamptz default now(),
  created_at        timestamptz default now(),

  -- Full original CT row preserved for debugging / schema evolution
  raw_ct_row        jsonb,

  -- Vector — text-embedding-3-large = 3072 dimensions
  embedding         vector(3072)

);


-- ============================================================
-- Indexes
-- ============================================================

-- Vector similarity (cosine) — IVFFlat
-- lists=100 works well for a cellar of 500–5000 bottles
create index if not exists wine_inventory_embedding_idx
  on wine_inventory
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ct_iwine — for Notes joins and wine-level GROUP BY queries
create index if not exists wine_inventory_iwine_idx       on wine_inventory (ct_iwine);

-- Common filter columns
create index if not exists wine_inventory_vintage_idx     on wine_inventory (vintage);
create index if not exists wine_inventory_location_idx    on wine_inventory (location);
create index if not exists wine_inventory_drink_to_idx    on wine_inventory (drink_to);
create index if not exists wine_inventory_wine_type_idx   on wine_inventory (wine_type);
create index if not exists wine_inventory_producer_idx    on wine_inventory (producer);
create index if not exists wine_inventory_country_idx     on wine_inventory (country);
create index if not exists wine_inventory_removed_at_idx  on wine_inventory (removed_at);


-- ============================================================
-- View: active bottles only (removed_at is null)
-- ============================================================
create or replace view active_wine_inventory as
  select * from wine_inventory
  where removed_at is null;


-- ============================================================
-- Semantic search function
-- Called by the brain MCP or any LLM tool
--
-- Example:
--   select * from search_wine_inventory(
--     (select embedding from wine_inventory limit 1),  -- swap for a real query vector
--     10,
--     true
--   );
-- ============================================================
create or replace function search_wine_inventory(
  query_embedding   vector(3072),
  match_count       int     default 10,
  active_only       boolean default true
)
returns table (
  id              bigint,
  ct_ibottle      bigint,
  ct_iwine        bigint,
  wine            text,
  vintage         int,
  producer        text,
  wine_type       text,
  varietal        text,
  location        text,
  bin             text,
  drink_from      int,
  drink_to        int,
  my_notes        text,
  ct_score        numeric,
  my_score        numeric,
  similarity      float
)
language sql stable
as $$
  select
    i.id,
    i.ct_ibottle,
    i.ct_iwine,
    i.wine,
    i.vintage,
    i.producer,
    i.wine_type,
    i.varietal,
    i.location,
    i.bin,
    i.drink_from,
    i.drink_to,
    i.my_notes,
    i.ct_score,
    i.my_score,
    1 - (i.embedding <=> query_embedding) as similarity
  from wine_inventory i
  where
    (not active_only or i.removed_at is null)
    and i.embedding is not null
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
