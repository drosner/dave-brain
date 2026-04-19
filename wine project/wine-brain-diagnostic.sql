-- ============================================================
-- DIAGNOSTIC — run this first to see what exists
-- Copy all output and share with Claude
-- ============================================================

-- Tables
select
  table_name,
  (select count(*) from information_schema.columns c
   where c.table_name = t.table_name
   and c.table_schema = 'public') as column_count
from information_schema.tables t
where table_schema = 'public'
  and table_type = 'BASE TABLE'
  and table_name in ('wine_inventory','wine_reactions','wine_preferences')
order by table_name;

-- Columns on wine_inventory (so we can see which are missing)
select column_name, data_type, udt_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'wine_inventory'
order by ordinal_position;

-- Indexes
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('wine_inventory','wine_reactions','wine_preferences')
order by tablename, indexname;

-- Functions
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'soft_delete_removed_bottles',
    'search_wine_inventory',
    'search_wine_reactions',
    'search_wine_preferences',
    'cellar_summary',
    'infer_preferences_from_purchases'
  )
order by routine_name;

-- Views
select table_name
from information_schema.views
where table_schema = 'public'
  and table_name in (
    'active_wine_inventory',
    'wines_in_window',
    'positive_preferences'
  )
order by table_name;
