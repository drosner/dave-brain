-- ============================================================
-- Dave Brain — Wine System Schema
-- Run in Supabase SQL Editor in this order:
--   1. This file (01_schema.sql)
--   2. 02_functions.sql
--
-- Embedding model : text-embedding-3-large (3072 dimensions)
-- ============================================================

create extension if not exists vector;


-- ============================================================
-- TABLE 1: wine_inventory
-- One row per physical bottle. Populated nightly by n8n from
-- CellarTracker. Source of truth for what is in the cellar.
-- ============================================================
create table if not exists wine_inventory (
  id                bigserial primary key,
  ct_ibottle        bigint unique not null,   -- CT bottle ID  — upsert key
  ct_iwine          bigint not null,           -- CT wine ID    — join key for reactions/preferences

  -- Identity
  wine              text,
  vintage           int,
  producer          text,
  wine_type         text,       -- Red, White, Rosé, Sparkling, Dessert, Fortified
  color             text,
  varietal          text,       -- CT "Category" (Pinot Noir, Chardonnay …)
  appellation       text,
  region            text,
  country           text,
  locale            text,

  -- Physical location
  location          text,       -- Left Top / Right / Left Bottom / Fridge-57
  bin               text,

  -- Valuation
  purchase_price    numeric(10,2),
  valuation         numeric(10,2),

  -- Drinking window
  drink_from        int,
  drink_to          int,

  -- Scores
  ct_score          numeric(4,1),
  my_score          numeric(4,1),

  -- Tasting notes imported from CT
  my_notes          text,
  note_date         date,

  -- Soft-delete: set when bottle leaves CT export
  removed_at        timestamptz,

  -- Audit
  last_synced_at    timestamptz default now(),
  created_at        timestamptz default now(),
  raw_ct_row        jsonb,

  -- Vector (wine identity + notes embedded together)
  embedding         vector(3072)
);

create index if not exists wine_inventory_embedding_idx
  on wine_inventory using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists wine_inventory_iwine_idx     on wine_inventory (ct_iwine);
create index if not exists wine_inventory_vintage_idx   on wine_inventory (vintage);
create index if not exists wine_inventory_location_idx  on wine_inventory (location);
create index if not exists wine_inventory_drink_to_idx  on wine_inventory (drink_to);
create index if not exists wine_inventory_wine_type_idx on wine_inventory (wine_type);
create index if not exists wine_inventory_producer_idx  on wine_inventory (producer);
create index if not exists wine_inventory_country_idx   on wine_inventory (country);
create index if not exists wine_inventory_removed_idx   on wine_inventory (removed_at);


-- ============================================================
-- TABLE 2: wine_reactions
-- One row per drinking occasion. Captures how you felt about
-- a wine when you drank it. Multiple reactions per wine over time.
-- ============================================================
create table if not exists wine_reactions (
  id              bigserial primary key,
  ct_iwine        bigint not null,      -- links to wine_inventory.ct_iwine
  ct_ibottle      bigint,               -- specific bottle if known

  -- When / context
  reaction_date   date not null default current_date,
  occasion        text,                 -- "weeknight", "dinner party", "pairing with lamb"

  -- The raw reaction — captured conversationally, stored verbatim
  reaction_text   text not null,

  -- Structured fields extracted by Claude at capture time
  overall_rating  numeric(4,1),         -- 1–100, consistent with CT scale
  sentiment       text,                 -- loved | liked | neutral | disappointed | disliked
  would_buy_again boolean,

  -- Flavor and style signals extracted by Claude
  flavor_tags     text[],               -- ["dark fruit","iron","forest floor","long finish"]
  style_tags      text[],               -- ["earthy","structured","elegant","tannic","fresh"]

  -- Food pairing noted
  food_pairing    text,

  -- Wine identity denormalized for fast retrieval without join
  wine_name       text,
  producer        text,
  vintage         int,
  varietal        text,
  region          text,

  -- Vector embedding of full reaction text + wine context
  embedding       vector(3072),

  created_at      timestamptz default now()
);

create index if not exists wine_reactions_embedding_idx
  on wine_reactions using ivfflat (embedding vector_cosine_ops) with (lists = 50);
create index if not exists wine_reactions_iwine_idx    on wine_reactions (ct_iwine);
create index if not exists wine_reactions_date_idx     on wine_reactions (reaction_date desc);
create index if not exists wine_reactions_sentiment_idx on wine_reactions (sentiment);


-- ============================================================
-- TABLE 3: wine_preferences
-- Durable preference signals — explicit statements and inferences
-- from purchase patterns and reaction history.
-- Upserted, not appended — one row per subject+type combination.
-- ============================================================
create table if not exists wine_preferences (
  id                bigserial primary key,

  preference_type   text not null,
  -- Values: style | producer | region | varietal | appellation |
  --         country | avoid | seeking | price_range | pairing

  subject           text not null,
  -- e.g. "Walter Scott", "Willamette Valley", "Barolo",
  --      "heavily oaked Chardonnay", "structured Nebbiolo"

  sentiment         text not null,
  -- strong_like | like | neutral | dislike | avoid

  context           text,
  -- "especially with food", "for weeknights", "summer drinking"

  -- Confidence: 1.0 = explicit stated preference
  --             0.7 = inferred from repeated reactions
  --             0.4 = inferred from purchase patterns
  confidence        numeric(3,2) default 0.5 check (confidence between 0 and 1),

  source            text not null,
  -- stated | inferred_from_reactions | inferred_from_purchases

  -- Supporting evidence — reaction IDs or wine IDs that drove this inference
  evidence_ids      bigint[],

  -- Vector for semantic similarity in recommendation queries
  embedding         vector(3072),

  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),

  -- One preference row per subject+type combination
  unique (preference_type, subject)
);

create index if not exists wine_preferences_embedding_idx
  on wine_preferences using ivfflat (embedding vector_cosine_ops) with (lists = 20);
create index if not exists wine_preferences_type_idx      on wine_preferences (preference_type);
create index if not exists wine_preferences_sentiment_idx on wine_preferences (sentiment);
create index if not exists wine_preferences_confidence_idx on wine_preferences (confidence desc);


-- ============================================================
-- VIEWS
-- ============================================================

-- Active bottles in the cellar (not consumed/removed)
create or replace view active_wine_inventory as
  select * from wine_inventory
  where removed_at is null;

-- Bottles currently in their drinking window
create or replace view wines_in_window as
  select * from wine_inventory
  where removed_at is null
    and drink_from <= extract(year from current_date)
    and drink_to   >= extract(year from current_date)
  order by drink_to asc, ct_score desc;

-- Positive preference profile (for recommendation context)
create or replace view positive_preferences as
  select * from wine_preferences
  where sentiment in ('strong_like', 'like')
    and confidence >= 0.4
  order by confidence desc, updated_at desc;
