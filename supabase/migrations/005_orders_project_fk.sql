-- 005_orders_project_fk.sql
-- Adds a proper project_id UUID foreign key to orders
-- Keeps existing 'project' text field intact so scripts don't break
-- Backfill script to map text -> UUID comes later
-- Run: paste into Supabase SQL Editor and click Run

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS orders_project_id_idx ON public.orders (project_id);

COMMENT ON COLUMN public.orders.project_id IS
  'FK to projects table. Coexists with legacy project text field during migration.';
