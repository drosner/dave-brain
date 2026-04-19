-- ============================================================
-- wine_inventory table for dave-brain / Supabase
-- Embedding model: text-embedding-3-large (3072 dimensions)
-- Sync source: CellarTracker xlquery.asp nightly
-- ============================================================

-- Enable pgvector (already present in dave-brain, but idempotent)
create extension if not exists vector;

-- ============================================================
-- Main table
-- ============================================================
create table if not exists wine_inventory (
  id                  bigserial primary key,

  -- CellarTracker stable wine ID — dedup/upsert key
  ct_iwine            bigint unique not null,

  -- Core identity
  wine                text,           -- Full CT wine name string
  vintage             int,
  producer            text,
  wine_type           text,           -- Red, White, Rosé, Sparkling, Dessert, Fortified, etc.
  color               text,           -- CT "Color" field
  varietal            text,           -- CT "Category" (Pinot Noir, Chardonnay, etc.)
  appellation         text,
  region              text,
  country             text,
  locale              text,           -- CT "Locale" (sub-region / village)

  -- Cellar logistics
  qty                 int default 0,
  location            text,           -- Your tiered location rules (Left Top, Right, Left Bottom, Fridge-57)
  bin                 text,

  -- Valuation & drinking window
  price               numeric(10,2),
  valuation           numeric(10,2),
  drink_from          int,
  drink_to            int,

  -- Scores
  ct_score            numeric(4,1),   -- CellarTracker community score
  my_score            numeric(4,1),   -- Your personal score

  -- Tasting notes (embedded into vector context)
  my_notes            text,           -- Concatenated from CT Notes table, matched on ct_iwine
  note_date           date,           -- Most recent note date

  -- Soft-delete support
  removed_at          timestamptz,    -- Set when wine disappears from CT export; null = active

  -- Audit
  last_synced_at      timestamptz default now(),
  created_at          timestamptz default now(),

  -- Full original CT row preserved for schema evolution / debugging
  raw_ct_row          jsonb,

  -- Vector — text-embedding-3-large = 3072 dimensions
  embedding           vector(3072)
);

-- ============================================================
-- Indexes
-- ============================================================

-- Vector similarity search (cosine) — IVFFlat
-- lists = 100 is appropriate for a cellar of ~500–5000 wines
create index if not exists wine_inventory_embedding_idx
  on wine_inventory
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Common filter/sort columns
create index if not exists wine_inventory_vintage_idx     on wine_inventory (vintage);
create index if not exists wine_inventory_location_idx    on wine_inventory (location);
create index if not exists wine_inventory_drink_to_idx    on wine_inventory (drink_to);
create index if not exists wine_inventory_wine_type_idx   on wine_inventory (wine_type);
create index if not exists wine_inventory_producer_idx    on wine_inventory (producer);
create index if not exists wine_inventory_country_idx     on wine_inventory (country);
create index if not exists wine_inventory_removed_at_idx  on wine_inventory (removed_at);  -- filter active bottles quickly

-- ============================================================
-- Convenience view: active inventory only
-- ============================================================
create or replace view active_wine_inventory as
  select * from wine_inventory
  where removed_at is null
    and qty > 0;

-- ============================================================
-- Helper function: semantic search
-- Usage: select * from search_wine_inventory('earthy Oregon Pinot', 10);
-- ============================================================
create or replace function search_wine_inventory(
  query_embedding vector(3072),
  match_count     int default 10,
  active_only     boolean default true
)
returns table (
  id          bigint,
  wine        text,
  vintage     int,
  producer    text,
  wine_type   text,
  varietal    text,
  location    text,
  qty         int,
  drink_from  int,
  drink_to    int,
  my_notes    text,
  ct_score    numeric,
  my_score    numeric,
  similarity  float
)
language sql stable
as $$
  select
    i.id,
    i.wine,
    i.vintage,
    i.producer,
    i.wine_type,
    i.varietal,
    i.location,
    i.qty,
    i.drink_from,
    i.drink_to,
    i.my_notes,
    i.ct_score,
    i.my_score,
    1 - (i.embedding <=> query_embedding) as similarity
  from wine_inventory i
  where
    (not active_only or (i.removed_at is null and i.qty > 0))
    and i.embedding is not null
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
