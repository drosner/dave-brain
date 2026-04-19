-- Wine inventory v2 reset script
-- Architecture decisions:
--   * ct_iwine   = CellarTracker wine identifier (wine-level)
--   * ct_barcode = CellarTracker bottle identifier from the Bottles export (bottle-level)
--   * Embeddings live on wines
--   * Bottle sync, location, and soft-delete operate on ct_barcode

begin;

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Drop objects from prior versions without assuming whether they are tables, views, or materialized views.
do $$
declare
  obj text;
begin
  foreach obj in array array[
    'active_wine_inventory',
    'wine_inventory',
    'wines_in_window',
    'wine_preferences',
    'wine_reactions',
    'bottles',
    'wines'
  ]
  loop
    if exists (
      select 1 from pg_matviews
      where schemaname = 'public' and matviewname = obj
    ) then
      execute format('drop materialized view if exists public.%I cascade', obj);
    end if;

    if exists (
      select 1 from pg_views
      where schemaname = 'public' and viewname = obj
    ) then
      execute format('drop view if exists public.%I cascade', obj);
    end if;

    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = obj
        and c.relkind in ('r','p')
    ) then
      execute format('drop table if exists public.%I cascade', obj);
    end if;
  end loop;
end $$;

drop function if exists search_wines(text, integer);
drop function if exists search_bottles(text, integer);
drop function if exists search_wine_reactions(text, integer);
drop function if exists search_wine_preferences(text, integer);
drop function if exists cellar_summary();
drop function if exists soft_delete_removed_bottles(text[]);
drop function if exists infer_preferences_from_purchases();
drop function if exists touch_updated_at();

create table wines (
  id bigint generated always as identity primary key,
  ct_iwine bigint not null unique,
  wine text,
  vintage integer,
  producer text,
  wine_type text,
  color text,
  varietal text,
  master_varietal text,
  designation text,
  vineyard text,
  appellation text,
  region text,
  sub_region text,
  country text,
  locale text,
  bottle_size text,
  drink_from integer,
  drink_to integer,
  ct_display_name text generated always as (
    btrim(
      coalesce(case when vintage is not null and vintage <> 0 then vintage::text || ' ' else '' end, '') ||
      coalesce(case when producer is not null then producer || ' ' else '' end, '') ||
      coalesce(wine, '')
    )
  ) stored,
  my_notes text,
  note_date date,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table bottles (
  id bigint generated always as identity primary key,
  ct_barcode text not null unique,
  ct_iwine bigint not null references wines(ct_iwine) on update cascade on delete restrict,
  bottle_state text,
  location text,
  bin text,
  store text,
  purchase_date date,
  delivery_date date,
  bottle_cost numeric(12,2),
  bottle_cost_currency text,
  bottle_note text,
  purchase_note text,
  consumption_date date,
  consumption_type text,
  consumption_note text,
  consumption_revenue numeric(12,2),
  consumption_revenue_currency text,
  raw_ct_row jsonb,
  removed_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wine_reactions (
  id bigint generated always as identity primary key,
  ct_iwine bigint references wines(ct_iwine) on update cascade on delete set null,
  ct_barcode text references bottles(ct_barcode) on update cascade on delete set null,
  reaction_type text not null check (reaction_type in ('like','dislike','neutral','tasting_note','rating','pairing','purchase_signal')),
  sentiment text check (sentiment in ('positive','negative','neutral')),
  rating numeric(4,2),
  wine_name text,
  producer text,
  vintage integer,
  notes text,
  source text not null default 'manual',
  evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ct_iwine is not null or ct_barcode is not null or wine_name is not null)
);

create table wine_preferences (
  id bigint generated always as identity primary key,
  preference_type text not null check (preference_type in ('producer','varietal','appellation','region','country','wine_type','wine')),
  subject text not null,
  sentiment text not null check (sentiment in ('positive','negative','neutral')),
  confidence numeric(5,2) not null default 0.50,
  source text not null,
  context text,
  evidence_ids bigint[] not null default '{}',
  last_observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (preference_type, subject, source)
);

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger wines_touch_updated_at
before update on wines
for each row execute function touch_updated_at();

create trigger bottles_touch_updated_at
before update on bottles
for each row execute function touch_updated_at();

create trigger wine_reactions_touch_updated_at
before update on wine_reactions
for each row execute function touch_updated_at();

create trigger wine_preferences_touch_updated_at
before update on wine_preferences
for each row execute function touch_updated_at();

create index idx_wines_producer on wines(producer);
create index idx_wines_varietal on wines(varietal);
create index idx_wines_region on wines(region);
create index idx_wines_country on wines(country);
create index idx_wines_display_name_trgm on wines using gin (ct_display_name gin_trgm_ops);
create index idx_wines_embedding on wines using hnsw (embedding vector_cosine_ops);

create index idx_bottles_ct_iwine on bottles(ct_iwine);
create index idx_bottles_location on bottles(location);
create index idx_bottles_bin on bottles(bin);
create index idx_bottles_removed_at on bottles(removed_at);
create index idx_bottles_last_synced_at on bottles(last_synced_at);

create index idx_wine_reactions_ct_iwine on wine_reactions(ct_iwine);
create index idx_wine_reactions_ct_barcode on wine_reactions(ct_barcode);
create index idx_wine_preferences_lookup on wine_preferences(preference_type, subject);

create or replace function search_wines(query_text text, match_count integer default 10)
returns table (
  ct_iwine bigint,
  wine text,
  vintage integer,
  producer text,
  wine_type text,
  varietal text,
  appellation text,
  region text,
  country text,
  location_count bigint,
  bottle_count bigint,
  score real
)
language sql
stable
as $$
  with matched as (
    select
      w.ct_iwine,
      w.wine,
      w.vintage,
      w.producer,
      w.wine_type,
      w.varietal,
      w.appellation,
      w.region,
      w.country,
      similarity(coalesce(w.ct_display_name, ''), coalesce(query_text, '')) as score
    from wines w
    where query_text is null
       or query_text = ''
       or w.ct_display_name ilike '%' || query_text || '%'
       or coalesce(w.producer, '') ilike '%' || query_text || '%'
       or coalesce(w.varietal, '') ilike '%' || query_text || '%'
       or coalesce(w.appellation, '') ilike '%' || query_text || '%'
  )
  select
    m.ct_iwine,
    m.wine,
    m.vintage,
    m.producer,
    m.wine_type,
    m.varietal,
    m.appellation,
    m.region,
    m.country,
    count(distinct b.location) filter (where b.removed_at is null) as location_count,
    count(*) filter (where b.removed_at is null) as bottle_count,
    m.score
  from matched m
  left join bottles b on b.ct_iwine = m.ct_iwine
  group by 1,2,3,4,5,6,7,8,9,12
  order by m.score desc nulls last, bottle_count desc, producer nulls last, wine nulls last
  limit greatest(match_count, 1);
$$;

create or replace function search_bottles(query_text text, match_count integer default 25)
returns table (
  ct_barcode text,
  ct_iwine bigint,
  wine text,
  vintage integer,
  producer text,
  location text,
  bin text,
  purchase_date date,
  bottle_cost numeric,
  removed_at timestamptz,
  score real
)
language sql
stable
as $$
  select
    b.ct_barcode,
    b.ct_iwine,
    w.wine,
    w.vintage,
    w.producer,
    b.location,
    b.bin,
    b.purchase_date,
    b.bottle_cost,
    b.removed_at,
    greatest(
      similarity(coalesce(b.ct_barcode, ''), coalesce(query_text, '')),
      similarity(coalesce(w.ct_display_name, ''), coalesce(query_text, '')),
      similarity(coalesce(b.location, ''), coalesce(query_text, '')),
      similarity(coalesce(b.bin, ''), coalesce(query_text, ''))
    ) as score
  from bottles b
  join wines w on w.ct_iwine = b.ct_iwine
  where query_text is null
     or query_text = ''
     or b.ct_barcode ilike '%' || query_text || '%'
     or w.ct_display_name ilike '%' || query_text || '%'
     or coalesce(b.location, '') ilike '%' || query_text || '%'
     or coalesce(b.bin, '') ilike '%' || query_text || '%'
  order by score desc nulls last, b.removed_at nulls first, w.producer nulls last, w.wine nulls last
  limit greatest(match_count, 1);
$$;

create or replace function search_wine_reactions(query_text text, match_count integer default 25)
returns table (
  id bigint,
  ct_iwine bigint,
  ct_barcode text,
  reaction_type text,
  sentiment text,
  rating numeric,
  notes text,
  source text,
  created_at timestamptz
)
language sql
stable
as $$
  select
    wr.id,
    wr.ct_iwine,
    wr.ct_barcode,
    wr.reaction_type,
    wr.sentiment,
    wr.rating,
    wr.notes,
    wr.source,
    wr.created_at
  from wine_reactions wr
  where query_text is null
     or query_text = ''
     or coalesce(wr.notes, '') ilike '%' || query_text || '%'
     or coalesce(wr.wine_name, '') ilike '%' || query_text || '%'
     or coalesce(wr.producer, '') ilike '%' || query_text || '%'
     or coalesce(wr.ct_barcode, '') ilike '%' || query_text || '%'
  order by wr.created_at desc
  limit greatest(match_count, 1);
$$;

create or replace function search_wine_preferences(query_text text, match_count integer default 25)
returns table (
  id bigint,
  preference_type text,
  subject text,
  sentiment text,
  confidence numeric,
  source text,
  context text,
  updated_at timestamptz
)
language sql
stable
as $$
  select
    wp.id,
    wp.preference_type,
    wp.subject,
    wp.sentiment,
    wp.confidence,
    wp.source,
    wp.context,
    wp.updated_at
  from wine_preferences wp
  where query_text is null
     or query_text = ''
     or wp.subject ilike '%' || query_text || '%'
     or coalesce(wp.context, '') ilike '%' || query_text || '%'
  order by wp.updated_at desc
  limit greatest(match_count, 1);
$$;

create or replace function cellar_summary()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'active_bottles', count(*) filter (where removed_at is null),
    'removed_bottles', count(*) filter (where removed_at is not null),
    'unique_wines', count(distinct ct_iwine) filter (where removed_at is null),
    'locations', coalesce(jsonb_agg(distinct location) filter (where removed_at is null and location is not null), '[]'::jsonb)
  )
  from bottles;
$$;

create or replace function soft_delete_removed_bottles(active_barcodes text[])
returns jsonb
language plpgsql
as $$
declare
  affected_count integer;
begin
  update bottles
     set removed_at = now(),
         last_synced_at = now()
   where removed_at is null
     and not (ct_barcode = any(coalesce(active_barcodes, array[]::text[])));

  get diagnostics affected_count = row_count;

  return jsonb_build_object('soft_deleted', affected_count);
end;
$$;

create or replace function infer_preferences_from_purchases()
returns jsonb
language plpgsql
as $$
declare
  upserted_count integer := 0;
begin
  insert into wine_preferences (
    preference_type,
    subject,
    sentiment,
    confidence,
    source,
    context,
    last_observed_at
  )
  select
    'producer' as preference_type,
    w.producer as subject,
    'positive' as sentiment,
    least(0.95, 0.40 + (count(*)::numeric * 0.05)) as confidence,
    'purchase_inference' as source,
    'Inferred from currently owned bottles.' as context,
    now() as last_observed_at
  from bottles b
  join wines w on w.ct_iwine = b.ct_iwine
  where b.removed_at is null
    and w.producer is not null
  group by w.producer
  on conflict (preference_type, subject, source)
  do update set
    sentiment = excluded.sentiment,
    confidence = excluded.confidence,
    context = excluded.context,
    last_observed_at = excluded.last_observed_at,
    updated_at = now();

  get diagnostics upserted_count = row_count;

  return jsonb_build_object('preference_upserts', upserted_count);
end;
$$;

commit;
