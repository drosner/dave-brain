-- 003_todos.sql
-- Standalone todos table — tasks, reminders, deadlines for anything
-- project_id is optional — most todos won't be project-related
-- Run: paste into Supabase SQL Editor and click Run

CREATE TABLE IF NOT EXISTS public.todos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  task        text NOT NULL,
  status      text DEFAULT 'open',
  priority    text DEFAULT 'medium',
  due_date    date,
  reminder_at timestamptz,
  area        text DEFAULT 'personal',
  project_id  uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  person_id   uuid REFERENCES public.people(id) ON DELETE SET NULL,
  notes       text,
  metadata    jsonb DEFAULT '{}'::jsonb,

  CONSTRAINT todos_status_check CHECK (status IN (
    'open', 'in_progress', 'done', 'cancelled'
  )),
  CONSTRAINT todos_priority_check CHECK (priority IN (
    'high', 'medium', 'low'
  )),
  CONSTRAINT todos_area_check CHECK (area IN (
    'house', 'workshop', 'aviation', 'tech', 'wine',
    'rental_property', 'personal', 'family', 'work'
  ))
);

-- Auto-update updated_at
CREATE TRIGGER update_todos_timestamp
  BEFORE UPDATE ON public.todos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS todos_status_idx    ON public.todos (status);
CREATE INDEX IF NOT EXISTS todos_due_date_idx  ON public.todos (due_date);
CREATE INDEX IF NOT EXISTS todos_project_idx   ON public.todos (project_id);
CREATE INDEX IF NOT EXISTS todos_area_idx      ON public.todos (area);

COMMENT ON TABLE public.todos IS
  'Standalone tasks, reminders, deadlines — optionally linked to a project or person';
