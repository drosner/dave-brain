-- ============================================================
-- Add SommSelect narrative columns to wine_inventory
-- Run in Supabase SQL Editor before running the scraper scripts
-- ============================================================

alter table wine_inventory
  add column if not exists sommselect_narrative    text,
  add column if not exists sommselect_product_url  text,
  add column if not exists sommselect_order_number text,
  add column if not exists narrative_status        text default 'pending';

-- Index for querying by status
create index if not exists wine_inventory_narrative_status_idx
  on wine_inventory (narrative_status);

-- ============================================================
-- After running the nightly n8n sync, the sommselect_order_number
-- column will be populated from Gmail order confirmation emails.
--
-- For the one-time batch scrape, you can also seed the column
-- manually if needed. The scraper will process any rows where:
--   - sommselect_order_number IS NOT NULL, OR
--   - narrative_status = 'pending'
-- ============================================================
