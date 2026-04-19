-- ============================================================
-- WINE BRAIN — Complete Repair Script
-- Safe to run regardless of what already exists.
-- Every statement uses IF NOT EXISTS or CREATE OR REPLACE.
-- Fixes the IVFFlat dimension error by using HNSW indexes.
-- ============================================================

create extension if not exists vector;

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists wine_inventory (
  id                bigserial primary key,
  ct_ibottle        bigint unique not null,
  ct_iwine          bigint not null,
  wine              text,
  vintage           int,
  producer          text,
  wine_type         text,
  color             text,
  varietal          text,
  appellation       text,
  region            text,
  country           text,
  locale            text,
  location          text,
  bin               text,
  purchase_price    numeric(10,2),
  valuation         numeric(10,2),
  drink_from        int,
  drink_to          int,
  ct_score          numeric(4,1),
  my_score          numeric(4,1),
  my_notes          text,
  note_date         date,
  sommselect_narrative    text,
  sommselect_product_url  text,
  sommselect_order_number text,
  narrative_status        text default 'pending',
  removed_at        timestamptz,
  last_synced_at    timestamptz default now(),
  created_at        timestamptz default now(),
  raw_ct_row        jsonb,
  embedding         vector(1536)
);

create table if not exists wine_reactions (
  id              bigserial primary key,
  ct_iwine        bigint not null,
  ct_ibottle      bigint,
  reaction_date   date not null default current_date,
  occasion        text,
  reaction_text   text not null,
  overall_rating  numeric(4,1),
  sentiment       text,
  would_buy_again boolean,
  flavor_tags     text[],
  style_tags      text[],
  food_pairing    text,
  wine_name       text,
  producer        text,
  vintage         int,
  varietal        text,
  region          text,
  embedding       vector(1536),
  created_at      timestamptz default now()
);

create table if not exists wine_preferences (
  id                bigserial primary key,
  preference_type   text not null,
  subject           text not null,
  sentiment         text not null,
  context           text,
  confidence        numeric(3,2) default 0.5 check (confidence between 0 and 1),
  source            text not null,
  evidence_ids      bigint[],
  embedding         vector(1536),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  unique (preference_type, subject)
);

-- ============================================================
-- ADD MISSING COLUMNS (safe if already exist)
-- ============================================================

alter table wine_inventory
  add column if not exists sommselect_narrative    text,
  add column if not exists sommselect_product_url  text,
  add column if not exists sommselect_order_number text,
  add column if not exists narrative_status        text default 'pending';

-- ============================================================
-- INDEXES — drop any broken IVFFlat, create HNSW
-- HNSW has no dimension limit and better recall than IVFFlat
-- ============================================================

-- wine_inventory
drop index if exists wine_inventory_embedding_idx;
create index if not exists wine_inventory_embedding_idx
  on wine_inventory
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists wine_inventory_iwine_idx
  on wine_inventory (ct_iwine);
create index if not exists wine_inventory_vintage_idx
  on wine_inventory (vintage);
create index if not exists wine_inventory_location_idx
  on wine_inventory (location);
create index if not exists wine_inventory_drink_to_idx
  on wine_inventory (drink_to);
create index if not exists wine_inventory_wine_type_idx
  on wine_inventory (wine_type);
create index if not exists wine_inventory_producer_idx
  on wine_inventory (producer);
create index if not exists wine_inventory_country_idx
  on wine_inventory (country);
create index if not exists wine_inventory_removed_idx
  on wine_inventory (removed_at);
create index if not exists wine_inventory_narrative_status_idx
  on wine_inventory (narrative_status);

-- wine_reactions
drop index if exists wine_reactions_embedding_idx;
create index if not exists wine_reactions_embedding_idx
  on wine_reactions
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists wine_reactions_iwine_idx
  on wine_reactions (ct_iwine);
create index if not exists wine_reactions_date_idx
  on wine_reactions (reaction_date desc);
create index if not exists wine_reactions_sentiment_idx
  on wine_reactions (sentiment);

-- wine_preferences
drop index if exists wine_preferences_embedding_idx;
create index if not exists wine_preferences_embedding_idx
  on wine_preferences
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists wine_preferences_type_idx
  on wine_preferences (preference_type);
create index if not exists wine_preferences_sentiment_idx
  on wine_preferences (sentiment);
create index if not exists wine_preferences_confidence_idx
  on wine_preferences (confidence desc);

-- ============================================================
-- VIEWS
-- ============================================================

create or replace view active_wine_inventory as
  select * from wine_inventory
  where removed_at is null;

create or replace view wines_in_window as
  select * from wine_inventory
  where removed_at is null
    and drink_from <= extract(year from current_date)
    and drink_to   >= extract(year from current_date)
  order by drink_to asc, ct_score desc;

create or replace view positive_preferences as
  select * from wine_preferences
  where sentiment in ('strong_like','like')
    and confidence >= 0.4
  order by confidence desc, updated_at desc;

-- ============================================================
-- FUNCTIONS
-- ============================================================

create or replace function soft_delete_removed_bottles(
  active_ibottles bigint[]
)
returns int
language plpgsql security definer
as $$
declare deleted_count int;
begin
  update wine_inventory
  set    removed_at = now()
  where  ct_ibottle != all(active_ibottles)
    and  removed_at is null;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function search_wine_inventory(
  query_embedding   vector(1536),
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
  region          text,
  country         text,
  location        text,
  bin             text,
  drink_from      int,
  drink_to        int,
  my_notes        text,
  ct_score        numeric,
  my_score        numeric,
  purchase_price  numeric,
  similarity      float
)
language sql stable
as $$
  select
    i.id, i.ct_ibottle, i.ct_iwine,
    i.wine, i.vintage, i.producer, i.wine_type, i.varietal,
    i.region, i.country, i.location, i.bin,
    i.drink_from, i.drink_to, i.my_notes,
    i.ct_score, i.my_score, i.purchase_price,
    1 - (i.embedding <=> query_embedding) as similarity
  from wine_inventory i
  where (not active_only or i.removed_at is null)
    and i.embedding is not null
  order by i.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function search_wine_reactions(
  query_embedding vector(1536),
  match_count     int default 10
)
returns table (
  id              bigint,
  ct_iwine        bigint,
  wine_name       text,
  producer        text,
  vintage         int,
  varietal        text,
  region          text,
  reaction_date   date,
  occasion        text,
  reaction_text   text,
  overall_rating  numeric,
  sentiment       text,
  flavor_tags     text[],
  style_tags      text[],
  food_pairing    text,
  similarity      float
)
language sql stable
as $$
  select
    r.id, r.ct_iwine, r.wine_name, r.producer, r.vintage,
    r.varietal, r.region, r.reaction_date, r.occasion,
    r.reaction_text, r.overall_rating, r.sentiment,
    r.flavor_tags, r.style_tags, r.food_pairing,
    1 - (r.embedding <=> query_embedding) as similarity
  from wine_reactions r
  where r.embedding is not null
  order by r.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function search_wine_preferences(
  query_embedding vector(1536),
  match_count     int default 15
)
returns table (
  id                bigint,
  preference_type   text,
  subject           text,
  sentiment         text,
  context           text,
  confidence        numeric,
  source            text,
  similarity        float
)
language sql stable
as $$
  select
    p.id, p.preference_type, p.subject, p.sentiment,
    p.context, p.confidence, p.source,
    1 - (p.embedding <=> query_embedding) as similarity
  from wine_preferences p
  where p.embedding is not null
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function cellar_summary()
returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'total_bottles',      (select count(*) from active_wine_inventory),
    'total_valuation',    (select round(sum(valuation)::numeric,2) from active_wine_inventory),
    'in_drinking_window', (select count(*) from wines_in_window),
    'by_type', (
      select jsonb_object_agg(wine_type, cnt)
      from (
        select wine_type, count(*) as cnt
        from active_wine_inventory
        where wine_type is not null
        group by wine_type order by cnt desc
      ) t
    ),
    'by_location', (
      select jsonb_object_agg(location, cnt)
      from (
        select location, count(*) as cnt
        from active_wine_inventory
        where location is not null
        group by location order by cnt desc
      ) t
    ),
    'by_country', (
      select jsonb_object_agg(country, cnt)
      from (
        select country, count(*) as cnt
        from active_wine_inventory
        where country is not null
        group by country order by cnt desc limit 10
      ) t
    ),
    'top_producers', (
      select jsonb_agg(row_to_json(t))
      from (
        select producer, count(*) as bottles,
               round(avg(ct_score)::numeric,1) as avg_ct_score
        from active_wine_inventory
        where producer is not null
        group by producer order by bottles desc limit 10
      ) t
    ),
    'reactions_logged',   (select count(*) from wine_reactions),
    'preferences_stored', (select count(*) from wine_preferences),
    'strong_likes', (
      select jsonb_agg(subject order by confidence desc)
      from wine_preferences
      where sentiment = 'strong_like' limit 10
    ),
    'avoids', (
      select jsonb_agg(subject)
      from wine_preferences
      where sentiment = 'avoid'
    )
  );
$$;

create or replace function infer_preferences_from_purchases()
returns int
language plpgsql security definer
as $$
declare upserted int := 0;
begin
  -- Regions with 3+ bottles and avg purchase price > $40
  insert into wine_preferences
    (preference_type, subject, sentiment, confidence, source, context, updated_at)
  select
    'region', region,
    case when avg_price > 80 then 'strong_like' else 'like' end,
    least(0.4 + (bottle_count::numeric / 50), 0.75),
    'inferred_from_purchases',
    'Based on ' || bottle_count || ' bottles, avg $' || round(avg_price::numeric,0),
    now()
  from (
    select region, count(*) as bottle_count, avg(purchase_price) as avg_price
    from active_wine_inventory
    where region is not null and purchase_price > 0
    group by region
    having count(*) >= 3 and avg(purchase_price) > 40
  ) t
  on conflict (preference_type, subject) do update set
    confidence = excluded.confidence,
    context    = excluded.context,
    updated_at = now();

  get diagnostics upserted = row_count;

  -- Producers with 4+ bottles
  insert into wine_preferences
    (preference_type, subject, sentiment, confidence, source, context, updated_at)
  select
    'producer', producer,
    case when avg_price > 80 then 'strong_like' else 'like' end,
    least(0.4 + (bottle_count::numeric / 40), 0.75),
    'inferred_from_purchases',
    'Based on ' || bottle_count || ' bottles purchased',
    now()
  from (
    select producer, count(*) as bottle_count, avg(purchase_price) as avg_price
    from active_wine_inventory
    where producer is not null and purchase_price > 0
    group by producer
    having count(*) >= 4
  ) t
  on conflict (preference_type, subject) do update set
    confidence = excluded.confidence,
    context    = excluded.context,
    updated_at = now();

  -- Varietals with 6+ bottles
  insert into wine_preferences
    (preference_type, subject, sentiment, confidence, source, context, updated_at)
  select
    'varietal', varietal, 'like',
    least(0.35 + (bottle_count::numeric / 60), 0.65),
    'inferred_from_purchases',
    'Based on ' || bottle_count || ' bottles in cellar',
    now()
  from (
    select varietal, count(*) as bottle_count
    from active_wine_inventory
    where varietal is not null
    group by varietal
    having count(*) >= 6
  ) t
  on conflict (preference_type, subject) do update set
    confidence = excluded.confidence,
    context    = excluded.context,
    updated_at = now();

  return upserted;
end;
$$;
