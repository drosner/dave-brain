-- ============================================================
-- Helper RPC function for the soft-delete sweep
-- Run this in the Supabase SQL Editor AFTER running the DDL file
--
-- The n8n workflow calls this after every sync, passing the full
-- list of iBottle IDs that were present in today's CT export.
-- Any row NOT in that list and not already soft-deleted gets
-- removed_at stamped with the current time.
-- ============================================================

create or replace function soft_delete_removed_bottles(
  active_ibottles bigint[]
)
returns int          -- returns count of rows soft-deleted
language plpgsql
security definer
as $$
declare
  deleted_count int;
begin
  update wine_inventory
  set    removed_at = now()
  where  ct_ibottle != all(active_ibottles)
    and  removed_at is null;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
