-- ============================================================
-- Dave Brain — Wine System Functions
-- Run AFTER 01_schema.sql
-- ============================================================


-- ============================================================
-- FUNCTION: soft_delete_removed_bottles
-- Called nightly by n8n after the upsert sweep.
-- Stamps removed_at on any bottle not in today's CT export.
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


-- ============================================================
-- FUNCTION: search_wine_inventory
-- Semantic search over inventory. Called by MCP search_wine tool.
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


-- ============================================================
-- FUNCTION: search_wine_reactions
-- Semantic search over past drinking reactions.
-- Called by MCP recommend_wine tool to find past parallels.
-- ============================================================
create or replace function search_wine_reactions(
  query_embedding vector(3072),
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


-- ============================================================
-- FUNCTION: search_wine_preferences
-- Semantic search over preference profile.
-- Used to find relevant preference signals for a recommendation.
-- ============================================================
create or replace function search_wine_preferences(
  query_embedding vector(3072),
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


-- ============================================================
-- FUNCTION: cellar_summary
-- Returns aggregate stats. Called by MCP cellar_summary tool.
-- ============================================================
create or replace function cellar_summary()
returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'total_bottles',      (select count(*) from active_wine_inventory),
    'total_valuation',    (select round(sum(valuation)::numeric, 2) from active_wine_inventory),
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
        select producer, count(*) as bottles, round(avg(ct_score)::numeric,1) as avg_ct_score
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


-- ============================================================
-- FUNCTION: infer_preferences_from_purchases
-- Called nightly by n8n after the bottle upsert sweep.
-- Scans inventory for purchase patterns → writes/updates
-- wine_preferences rows with source='inferred_from_purchases'.
-- ============================================================
create or replace function infer_preferences_from_purchases()
returns int   -- count of preference rows written/updated
language plpgsql security definer
as $$
declare
  upserted int := 0;
begin
  -- Regions with 3+ bottles and avg purchase price > $40 → positive signal
  insert into wine_preferences (preference_type, subject, sentiment, confidence, source, context, updated_at)
  select
    'region',
    region,
    case when avg_price > 80 then 'strong_like' else 'like' end,
    least(0.4 + (bottle_count::numeric / 50), 0.75),  -- confidence grows with volume, caps at 0.75
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
  on conflict (preference_type, subject)
  do update set
    confidence  = excluded.confidence,
    context     = excluded.context,
    updated_at  = now();

  get diagnostics upserted = row_count;

  -- Producers with 4+ bottles → positive signal
  insert into wine_preferences (preference_type, subject, sentiment, confidence, source, context, updated_at)
  select
    'producer',
    producer,
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
  on conflict (preference_type, subject)
  do update set
    confidence  = excluded.confidence,
    context     = excluded.context,
    updated_at  = now();

  -- Varietals with 6+ bottles
  insert into wine_preferences (preference_type, subject, sentiment, confidence, source, context, updated_at)
  select
    'varietal',
    varietal,
    'like',
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
  on conflict (preference_type, subject)
  do update set
    confidence  = excluded.confidence,
    context     = excluded.context,
    updated_at  = now();

  return upserted;
end;
$$;
