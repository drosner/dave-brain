-- 007_people_email_unique.sql
-- Adds unique constraint on people.email to enable safe upsert from ingestion scripts
-- NULLs are treated as distinct by Postgres, so contacts without email won't conflict

ALTER TABLE public.people
  ADD CONSTRAINT people_email_unique UNIQUE (email);
