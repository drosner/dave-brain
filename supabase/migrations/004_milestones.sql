-- 004_milestones.sql
-- Standalone milestones table — key dates and deadlines for anything
-- project_id is optional — milestones can exist outside of projects
-- Run: paste into Supabase SQL Editor and click Run

CREATE TABLE IF NOT EXISTS public.milestones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  name        text NOT NULL,
  description text,
  target_date date,
  actual_date date,
  status      text DEFAULT 'upcoming',
  area        text DEFAULT 'personal',
  project_id  uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  notes       text,
  metadata    jsonb DEFAULT '{}'::jsonb,

  CONSTRAINT milestones_status_check CHECK (status IN (
    'upcoming', 'at_risk', 'complete', 'missed', 'cancelled'
  )),
  CONSTRAINT milestones_area_check CHECK (area IN (
    'house', 'workshop', 'aviation', 'tech', 'wine',
    'rental_property', 'personal', 'family', 'work'
  ))
);

-- Auto-update updated_at
CREATE TRIGGER update_milestones_timestamp
  BEFORE UPDATE ON public.milestones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS milestones_status_idx     ON public.milestones (status);
CREATE INDEX IF NOT EXISTS milestones_target_date_idx ON public.milestones (target_date);
CREATE INDEX IF NOT EXISTS milestones_project_idx    ON public.milestones (project_id);
CREATE INDEX IF NOT EXISTS milestones_area_idx       ON public.milestones (area);

COMMENT ON TABLE public.milestones IS
  'Key dates and deadlines — optionally linked to a project. Distinct from todos: checkpoints not action items';
