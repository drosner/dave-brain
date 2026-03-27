-- 002_people.sql
-- Standalone contacts table: vendors, contractors, friends, family
-- Not just project-related — anyone Dave interacts with
-- Run: paste into Supabase SQL Editor and click Run

CREATE TABLE IF NOT EXISTS public.people (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  name         text NOT NULL,
  type         text DEFAULT 'contact',
  company      text,
  email        text,
  phone        text,
  location     text,
  notes        text,
  metadata     jsonb DEFAULT '{}'::jsonb,

  CONSTRAINT people_type_check CHECK (type IN (
    'vendor', 'contractor', 'professional',
    'friend', 'family', 'colleague', 'contact'
  ))
);

-- Junction table: many people can be on many projects, each with a role
CREATE TABLE IF NOT EXISTS public.project_people (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  role        text,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (project_id, person_id)
);

-- Auto-update updated_at
CREATE TRIGGER update_people_timestamp
  BEFORE UPDATE ON public.people
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS people_name_idx ON public.people (name);
CREATE INDEX IF NOT EXISTS people_type_idx ON public.people (type);
CREATE INDEX IF NOT EXISTS project_people_project_idx ON public.project_people (project_id);
CREATE INDEX IF NOT EXISTS project_people_person_idx ON public.project_people (person_id);

COMMENT ON TABLE public.people IS
  'Contacts: vendors, contractors, friends, family — optionally linked to projects via project_people';
COMMENT ON TABLE public.project_people IS
  'Junction: links people to projects with a role (architect, supplier, collaborator, etc.)';
