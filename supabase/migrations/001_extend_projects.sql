-- 001_extend_projects.sql
-- Extends the existing projects table with missing columns
-- Run: paste into Supabase SQL Editor and click Run

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS description    text,
  ADD COLUMN IF NOT EXISTS category       text DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS location       text,
  ADD COLUMN IF NOT EXISTS started_at     date,
  ADD COLUMN IF NOT EXISTS target_date    date,
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz DEFAULT now();

-- Add category constraint
ALTER TABLE public.projects
  ADD CONSTRAINT projects_category_check
  CHECK (category IN (
    'house', 'workshop', 'aviation', 'tech', 'wine',
    'rental_property', 'personal', 'family'
  ));

-- Auto-update updated_at on any row change
CREATE TRIGGER update_projects_timestamp
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE public.projects IS
  'Named projects — anchor table for todos, milestones, people, and orders';
